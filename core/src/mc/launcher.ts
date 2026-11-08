import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { ensureDir, writeFileAtomic } from "../util/fsx";
import type { OsInfo } from "../util/os";
import { commandLineLength, quoteForArgFile } from "./launch-args";
import { cleanJavaEnv } from "../util/proc";

export interface SpawnParams {
  javaPath: string;
  /** Everything after the java executable (JVM args, main class, game args). */
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  os: OsInfo;
  javaMajor: number;
  /** Where to write the @argfile when the command line would be too long. */
  argFilePath?: string;
  /** Command prefix such as `gamemoderun` or `mangohud`. */
  wrapper?: string[];
}

export type GameLifecycle = "starting" | "window" | "running" | "exited";

export interface GameLine {
  time: number;
  stream: "stdout" | "stderr";
  text: string;
}

/** Window-creation hints printed by the game; the first one flips the state from starting to window. */
const WINDOW_HINTS = [
  /Backend library: LWJGL/,
  /LWJGL Version: /,
  /OpenAL initialized/,
  /Reloading ResourceManager/,
  /Created: \d+x\d+x\d+ minecraft:textures\/atlas/,
  /Starting up SoundSystem/,
];

export class GameProcess extends EventEmitter {
  readonly lines: GameLine[] = [];
  state: GameLifecycle = "starting";
  exitCode: number | null = null;
  signal: NodeJS.Signals | null = null;
  readonly startedAt = Date.now();
  endedAt?: number;
  pid?: number;
  usedArgFile = false;
  private child?: ChildProcess;
  private killTimer?: NodeJS.Timeout;
  private runningTimer?: NodeJS.Timeout;

  constructor(private readonly capacity = 6000) {
    super();
  }

  /** Resolve after the process has exited. */
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.state === "exited") return Promise.resolve({ code: this.exitCode, signal: this.signal });
    return new Promise((resolve) => this.once("exit", (code, signal) => resolve({ code, signal })));
  }

  get playTimeMs(): number {
    return (this.endedAt ?? Date.now()) - this.startedAt;
  }

  tail(count = 200): string[] {
    return this.lines.slice(-count).map((line) => line.text);
  }

  /** @internal */
  attach(child: ChildProcess) {
    this.child = child;
    this.pid = child.pid;
    const feed = (stream: "stdout" | "stderr") => {
      let pending = "";
      child[stream]?.setEncoding("utf8");
      child[stream]?.on("data", (chunk: string) => {
        pending += chunk;
        let index: number;
        while ((index = pending.search(/\r?\n/)) >= 0) {
          this.push(stream, pending.slice(0, index));
          pending = pending.slice(pending[index] === "\r" ? index + 2 : index + 1);
        }
        if (pending.length > 16384) {
          this.push(stream, pending);
          pending = "";
        }
      });
      child[stream]?.on("end", () => {
        if (pending) this.push(stream, pending);
        pending = "";
      });
    };
    feed("stdout");
    feed("stderr");
    // The window hints are best effort; after a while assume the game is up.
    this.runningTimer = setTimeout(() => this.setState("running"), 45_000);
    child.once("error", (error) => {
      this.push("stderr", `[Vitrine] 无法启动进程：${error.message}`);
      this.finish(-1, null);
    });
    child.once("close", (code, signal) => this.finish(code, signal));
  }

  private push(stream: "stdout" | "stderr", text: string) {
    const line: GameLine = { time: Date.now(), stream, text };
    this.lines.push(line);
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
    this.emit("line", line);
    if (this.state === "starting" && WINDOW_HINTS.some((hint) => hint.test(text))) this.setState("window");
  }

  private setState(state: GameLifecycle) {
    if (this.state === state || this.state === "exited") return;
    if (state === "running" && this.state === "window") {
      this.state = "running";
    } else {
      this.state = state;
    }
    this.emit("state", this.state);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null) {
    if (this.state === "exited") return;
    clearTimeout(this.runningTimer);
    clearTimeout(this.killTimer);
    this.exitCode = code;
    this.signal = signal;
    this.endedAt = Date.now();
    this.state = "exited";
    this.emit("state", "exited");
    this.emit("exit", code, signal);
  }

  /** Ask the game to stop; escalate to a hard kill if it does not exit in time. */
  kill(graceMs = 5000) {
    if (!this.child || this.state === "exited") return;
    this.child.kill("SIGTERM");
    this.killTimer = setTimeout(() => {
      try {
        this.child?.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, graceMs);
  }
}

/** Spawn the game. Returns immediately; use the events on the returned object to follow it. */
export async function spawnGame(params: SpawnParams): Promise<GameProcess> {
  const game = new GameProcess();
  let args = params.args;
  if (params.os.name === "windows" && params.javaMajor >= 9 && commandLineLength(params.javaPath, args) > 30_000 && params.argFilePath) {
    await ensureDir(dirname(params.argFilePath));
    await writeFileAtomic(params.argFilePath, args.map(quoteForArgFile).join("\n"));
    args = [`@${params.argFilePath}`];
    game.usedArgFile = true;
  }
  const wrapper = params.wrapper?.filter(Boolean) ?? [];
  const command = wrapper.length ? wrapper[0] : params.javaPath;
  const commandArgs = wrapper.length ? [...wrapper.slice(1), params.javaPath, ...args] : args;
  const child = spawn(command, commandArgs, {
    cwd: params.cwd,
    env: cleanJavaEnv(process.env, params.env, params.javaPath),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  game.attach(child);
  return game;
}
