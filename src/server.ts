import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { config } from "./config.ts";
import { run } from "./exec.ts";
import { pickEncoder } from "./encoder.ts";
import { onnxAvailable } from "./faces.ts";
import { isJsonContentType, rejectReason } from "./guard.ts";
import { parseUrls } from "./urls.ts";
import { usageSummary } from "./usage.ts";
import { addJobs, deleteJob, jobDir, listJobs, loadJobs, retryJob, reviewClip, type Review } from "./jobs.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mp4": "video/mp4",
  ".svg": "image/svg+xml",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!isJsonContentType(req.headers["content-type"])) throw new HttpError(415, "Send JSON (content-type: application/json).");
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request too large.");
  }
  if (!body) return {};
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

/** Serve a file with HTTP Range support so <video> can seek. */
async function sendFile(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "content-type": type,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${size}`,
      "accept-ranges": "bytes",
    });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes", "cache-control": "no-cache" });
  createReadStream(file).pipe(res);
}

/** Resolve `name` inside `dir`, refusing anything that escapes it. */
function inside(dir: string, name: string): string | undefined {
  const full = path.resolve(dir, name);
  return full.startsWith(path.resolve(dir) + path.sep) ? full : undefined;
}

async function toolVersion(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run(command, args);
    return stdout.split(/\r?\n/)[0].trim();
  } catch {
    return null;
  }
}

async function health() {
  const [ytDlp, ffmpeg, faces] = await Promise.all([
    toolVersion(config.ytDlp, ["--version"]),
    toolVersion(config.ffmpeg, ["-version"]),
    onnxAvailable() ? Promise.resolve("onnx") : toolVersion(config.python, ["-c", "import cv2; print(cv2.__version__)"]),
  ]);
  return {
    encoder: await pickEncoder(),
    ytDlp,
    ffmpeg: ffmpeg ? ffmpeg.replace(/^ffmpeg version (\S+).*/, "$1") : null,
    faces,
    reframe: config.reframe,
    gemini: Boolean(config.geminiApiKey),
    model: config.geminiModel,
    outputDir: config.outputDir,
    settings: {
      clipsPerVideo: config.clipsPerVideo,
      minClipSeconds: config.minClipSeconds,
      maxClipSeconds: config.maxClipSeconds,
      output: `${config.outputWidth}x${config.outputHeight}`,
      captions: config.burnCaptions,
    },
  };
}

const REVIEWS: readonly Review[] = ["unreviewed", "kept", "rejected"];

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const method = req.method ?? "GET";

  const refused = rejectReason({ method, host: req.headers.host, origin: req.headers.origin });
  if (refused) return sendJson(res, 403, { error: refused });

  if (parts[0] === "api") {
    if (method === "GET" && parts[1] === "health") return sendJson(res, 200, await health());
    if (method === "GET" && parts[1] === "usage") return sendJson(res, 200, usageSummary());
    if (method === "GET" && parts[1] === "jobs" && parts.length === 2) return sendJson(res, 200, listJobs());
    if (method === "POST" && parts[1] === "jobs" && parts.length === 2) {
      const urls = parseUrls((await readJson(req)).urls);
      if (!urls.length) return sendJson(res, 400, { error: "Paste at least one http(s) link." });
      return sendJson(res, 201, addJobs(urls));
    }
    if (parts[1] === "jobs" && parts[2]) {
      const id = parts[2];
      if (method === "POST" && parts[3] === "retry") {
        return retryJob(id) ? sendJson(res, 200, { ok: true }) : sendJson(res, 409, { error: "Job is running or missing." });
      }
      if (method === "DELETE" && parts.length === 3) {
        return (await deleteJob(id)) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "Not found" });
      }
      if (method === "POST" && parts[3] === "clips" && parts[4] && parts[5] === "review") {
        const review = (await readJson(req)).review as Review;
        if (!REVIEWS.includes(review)) return sendJson(res, 400, { error: "Invalid review." });
        const clip = await reviewClip(id, parts[4], review);
        return clip ? sendJson(res, 200, clip) : sendJson(res, 404, { error: "Not found" });
      }
    }
    return sendJson(res, 404, { error: "Unknown API route." });
  }

  if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" });

  if (parts[0] === "media" && parts[1] && parts[2]) {
    const file = /^clip-\d+\.mp4$/.test(parts[2]) && /^[\w-]+$/.test(parts[1]) ? inside(jobDir(parts[1]), parts[2]) : undefined;
    return file ? sendFile(req, res, file) : sendJson(res, 404, { error: "Not found" });
  }

  const file = inside(config.publicDir, parts.length ? parts.join("/") : "index.html");
  return file ? sendFile(req, res, file) : sendJson(res, 404, { error: "Not found" });
}

await loadJobs();

createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    if (!(error instanceof HttpError) && !(error instanceof SyntaxError)) console.error(error);
    const status = error instanceof HttpError ? error.status : error instanceof SyntaxError ? 400 : 500;
    if (!res.headersSent) sendJson(res, status, { error: error instanceof Error ? error.message : "Server error" });
    else res.end();
  });
}).listen(config.port, "127.0.0.1", () => {
  console.log(`oukos-clip running at http://localhost:${config.port}`);
  if (!config.geminiApiKey) console.warn("GEMINI_API_KEY is missing - add it to .env");
});
