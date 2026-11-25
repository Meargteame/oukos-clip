import { config } from "./config.ts";
import { costOf, recordUsage, type Usage } from "./usage.ts";

export type GeminiPart =
  | { readonly text: string }
  | { readonly file_data: { readonly file_uri: string; readonly mime_type?: string } };

export interface GeminiRequest {
  readonly parts: readonly GeminiPart[];
  readonly schema: unknown;
  readonly systemInstruction?: string;
  /** Lower video resolution = ~3x fewer tokens; plenty for picking moments. */
  readonly lowMediaResolution?: boolean;
  readonly signal?: AbortSignal;
  /** Called with the billed tokens/cost of each successful HTTP response (even if its content is unusable). */
  readonly onUsage?: (usage: Usage) => void;
}

/**
 * A failure that will probably go away by itself (Google overloaded, rate limit,
 * network drop). The job queue re-queues jobs that fail with this instead of failing them.
 */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_ATTEMPTS = 7;
const REQUEST_TIMEOUT_MS = 4 * 60_000;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Cancelled."));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Cancelled."));
      },
      { once: true },
    );
  });
}

/**
 * Which model to use for each attempt: the main model twice, then rotate through
 * the fallbacks (they run on separate capacity, so they're often free when the main one is busy).
 */
export function modelForAttempt(models: readonly string[], attempt: number): string {
  if (attempt < 2 || models.length === 1) return models[0];
  return models[(attempt - 1) % models.length];
}

/** Wait before retry `attempt` (1-based): 2s, 4s, 8s ... capped at 60s, with jitter; honours Retry-After. */
export function backoffMs(attempt: number, retryAfterSeconds?: number): number {
  const base = Math.min(60_000, 2000 * 2 ** (attempt - 1));
  const jittered = base * (0.75 + Math.random() * 0.5);
  const hinted = retryAfterSeconds && Number.isFinite(retryAfterSeconds) ? Math.min(120, retryAfterSeconds) * 1000 : 0;
  return Math.max(jittered, hinted);
}

function describeNetworkError(error: unknown): string {
  const err = error as { message?: string; cause?: { code?: string; message?: string } };
  const cause = err.cause?.code ?? err.cause?.message;
  return `Network problem reaching Gemini (${cause ?? err.message ?? "unknown"}).`;
}

/** Call Gemini with a JSON response schema and return the parsed JSON. Retries overloads, rate limits and network errors. */
export async function generateJson(request: GeminiRequest): Promise<unknown> {
  if (!config.geminiApiKey) {
    throw new Error("No Gemini API key. Add it in Settings (or GEMINI_API_KEY in .env) and restart.");
  }
  // Less "thinking" = ~4x faster and ~3x cheaper with near-identical clip picks (measured).
  // Models that don't accept the setting get it dropped automatically (see the 400 handling below).
  const noThinkingSetting = new Set<string>();
  const bodyFor = (model: string) =>
    JSON.stringify({
      contents: [{ role: "user", parts: request.parts }],
      ...(request.systemInstruction
        ? { systemInstruction: { parts: [{ text: request.systemInstruction }] } }
        : {}),
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: request.schema,
        temperature: 0.4,
        ...(request.lowMediaResolution ? { mediaResolution: "MEDIA_RESOLUTION_LOW" } : {}),
        ...(config.geminiThinking && !noThinkingSetting.has(model)
          ? { thinkingConfig: { thinkingLevel: config.geminiThinking } }
          : {}),
      },
    });

  const models = [...new Set([config.geminiModel, ...config.geminiFallbackModels])];
  let lastError: Error | undefined;
  let retryAfter: number | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(backoffMs(attempt, retryAfter), request.signal);
    retryAfter = undefined;
    const model = modelForAttempt(models, attempt);

    let response: Response;
    try {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      response = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": config.geminiApiKey },
        body: bodyFor(model),
        signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
      });
    } catch (error) {
      if (request.signal?.aborted) throw new Error("Cancelled.");
      lastError = new TransientError(
        (error as Error)?.name === "TimeoutError" ? "Gemini took too long to answer." : describeNetworkError(error),
      );
      continue;
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 400);
      const message = `Gemini (${model}) error ${response.status}: ${detail}`;
      if (response.status === 400 && /thinking/i.test(detail) && !noThinkingSetting.has(model)) {
        // This model doesn't support the thinking setting - resend without it, no wait.
        noThinkingSetting.add(model);
        attempt--;
        continue;
      }
      if ((response.status === 404 || response.status === 410) && model !== config.geminiModel) {
        // A fallback model that this key can't use - drop it and move on without waiting.
        models.splice(models.indexOf(model), 1);
        attempt--;
        continue;
      }
      if (!RETRYABLE.has(response.status)) throw new Error(message);
      retryAfter = Number(response.headers.get("retry-after")) || undefined;
      lastError = new TransientError(
        response.status === 429
          ? "Gemini rate limit reached (too many requests)."
          : "Gemini is overloaded right now (high demand).",
      );
      continue;
    }

    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        toolUsePromptTokenCount?: number;
      };
    };
    // Record what this call was billed before anything can fail below.
    const meta = data.usageMetadata ?? {};
    const inputTokens = (meta.promptTokenCount ?? 0) + (meta.toolUsePromptTokenCount ?? 0);
    const outputTokens = (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0);
    const usage: Usage = { calls: 1, inputTokens, outputTokens, costUsd: costOf(inputTokens, outputTokens) };
    recordUsage(usage);
    request.onUsage?.(usage);

    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts
      ?.filter((part) => !part.thought)
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    if (data.promptFeedback?.blockReason) {
      throw new Error(`Gemini refused this video (${data.promptFeedback.blockReason}).`);
    }
    if (!text) {
      // Empty answers (e.g. MAX_TOKENS, OTHER) are usually one-offs; try again.
      lastError = new TransientError(`Gemini returned no answer (${candidate?.finishReason ?? "unknown reason"}).`);
      continue;
    }
    try {
      return JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    } catch {
      lastError = new TransientError("Gemini returned invalid JSON.");
      continue;
    }
  }
  throw lastError ?? new TransientError("Gemini request failed.");
}
