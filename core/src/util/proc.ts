import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";
import { AbortError } from "./async";

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Last lines of combined stdout/stderr, for error messages. */
  tail: string[];
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  tailLines?: number;
  timeoutMs?: number;
  /**
   * This process is a JVM. Ambient launcher options (JAVA_TOOL_OPTIONS, _JAVA_OPTIONS,
   * JDK_JAVA_OPTIONS, CLASSPATH…) are stripped and JAVA_HOME is pointed at the selected
   * JDK, so a broken machine-wide Java setup cannot stop installers or the game.
   */
  javaPath?: string;
}

const JAVA_BOOTSTRAP_ENV = new Set([
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "JAVA_OPTS",
  "JRE_OPTIONS",
  "CLASSPATH",
  "BOOTCLASSPATH",
]);

/** The home a `java` executable belongs to, or undefined for PATH lookups such as `java`. */
export function javaHomeFromExecutable(executable: string): string | undefined {
  const parent = dirname(executable);
  if (!executable || executable === basename(executable) || parent === "." || parent === "/" || /^[A-Za-z]:[\\/]?$/.test(parent)) return undefined;
  return basename(parent).toLowerCase() === "bin" ? dirname(parent) : parent;
}

/**
 * Build an environment for a JVM process. Extra values are explicit user/instance settings and
 * survive the cleanup; only inherited ambient JVM flags are removed.
 */
export function cleanJavaEnv(
  base: NodeJS.ProcessEnv = process.env,
  extra?: NodeJS.ProcessEnv,
  javaPath?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (JAVA_BOOTSTRAP_ENV.has(key.toUpperCase())) delete env[key];
  }
  if (extra) Object.assign(env, extra);
  const explicitHome = extra && Object.keys(extra).some((key) => key.toUpperCase() === "JAVA_HOME");
  const home = javaPath ? javaHomeFromExecutable(javaPath) : undefined;
  if (home && !explicitHome) env.JAVA_HOME = home;
  return env;
}

/** Run a process to completion, streaming its output line by line. Rejects only on spawn errors or abort. */
export function runProcess(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new AbortError());
    const env = options.javaPath
      ? cleanJavaEnv(process.env, options.env, options.javaPath)
      : { ...process.env, ...options.env };
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
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
