import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";

/** Tokens Gemini billed for one or more requests, and what that cost at the configured prices. */
export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface Ledger {
  days: Record<string, Usage>;
}

export const emptyUsage = (): Usage => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });

/** Price per token from the per-million prices in config. Thinking tokens are billed as output. */
export function costOf(inputTokens: number, outputTokens: number): number {
  return (inputTokens * config.geminiInputPricePerM + outputTokens * config.geminiOutputPricePerM) / 1_000_000;
}

export function addUsage(target: Usage, extra: Usage): void {
  target.calls += extra.calls;
  target.inputTokens += extra.inputTokens;
  target.outputTokens += extra.outputTokens;
  target.costUsd = Math.round((target.costUsd + extra.costUsd) * 1e6) / 1e6;
}

/** Local calendar day, e.g. "2026-11-19". */
export function dayKey(date = new Date()): string {
  return date.toLocaleDateString("en-CA");
}

const ledgerFile = () => path.join(config.dataDir, "usage.json");
let ledger: Ledger = { days: {} };
let saveChain: Promise<void> = Promise.resolve();

export async function loadUsage(): Promise<void> {
  try {
    ledger = JSON.parse(await readFile(ledgerFile(), "utf8")) as Ledger;
  } catch {
    ledger = { days: {} };
  }
}

/** Add one request's usage to today's total. Kept separately from jobs so deleted jobs still count. */
export function recordUsage(usage: Usage): void {
  const key = dayKey();
  ledger.days[key] ??= emptyUsage();
  addUsage(ledger.days[key], usage);
  const snapshot = JSON.stringify(ledger, null, 1);
  saveChain = saveChain
    .then(async () => {
      await writeFile(`${ledgerFile()}.tmp`, snapshot, "utf8");
      await rename(`${ledgerFile()}.tmp`, ledgerFile());
    })
    .catch((error: unknown) => console.error("Could not save usage:", error));
}

export function usageSummary() {
  const today = dayKey();
  const weekAgo = dayKey(new Date(Date.now() - 6 * 86_400_000));
  const last7 = emptyUsage();
  const all = emptyUsage();
  for (const [day, usage] of Object.entries(ledger.days)) {
    addUsage(all, usage);
    if (day >= weekAgo) addUsage(last7, usage);
  }
  return {
    today: ledger.days[today] ?? emptyUsage(),
    last7,
    all,
    days: ledger.days,
    pricing: {
      model: config.geminiModel,
      inputPerM: config.geminiInputPricePerM,
      outputPerM: config.geminiOutputPricePerM,
    },
  };
}
