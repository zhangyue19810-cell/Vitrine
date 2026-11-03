import { spawn } from "node:child_process";
import { AbortError } from "./async";

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Last lines of combined stdout/stderr, for error messages. */
  tail: string[];
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  tailLines?: number;
  timeoutMs?: number;
}

/** Run a process to completion, streaming its output line by line. Rejects only on spawn errors or abort. */
export function runProcess(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new AbortError());
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tail: string[] = [];
    const limit = options.tailLines ?? 60;
    const push = (line: string) => {
      tail.push(line);
      if (tail.length > limit) tail.shift();
      options.onLine?.(line);
    };
    const feed = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return;
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        pending += chunk;
        let index: number;
        while ((index = pending.search(/\r?\n/)) >= 0) {
          push(pending.slice(0, index));
          pending = pending.slice(pending[index] === "\r" ? index + 2 : index + 1);
        }
      });
      stream.on("end", () => {
        if (pending) push(pending);
        pending = "";
      });
    };
    feed(child.stdout);
    feed(child.stderr);
    const onAbort = () => {
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : undefined;
    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) reject(new AbortError());
      else resolve({ code, signal, tail });
    });
  });
}
