import { spawn } from "node:child_process";
import path from "node:path";

export interface RunOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
}

const MAX_STDERR = 64_000;

function lastLines(text: string, count = 6): string {
  return text.trim().split(/\r?\n/).slice(-count).join("\n");
}

/** Run a command without a shell and collect its output. Rejects on non-zero exit. */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Cancelled."));
      return;
    }
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const onAbort = () => child.kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > MAX_STDERR * 2) stderr = stderr.slice(-MAX_STDERR);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(
        error.code === "ENOENT"
          ? new Error(`"${command}" is not installed or not on PATH.`)
          : error,
      );
    });
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) reject(new Error("Cancelled."));
      else if (code === 0) resolve({ stdout, stderr });
      else {
        const name = path.basename(command);
        reject(new Error(`${name} failed (exit ${code}): ${lastLines(stderr) || "no output"}`));
      }
    });
  });
}
