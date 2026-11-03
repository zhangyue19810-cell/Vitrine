import { appendFile } from "node:fs/promises";
import { ensureDir } from "./fsx";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  time: number;
  level: LogLevel;
  scope: string;
  message: string;
}

/** In-memory ring buffer plus optional file sink. Cheap enough to call from hot paths. */
export class Logger {
  private entries: LogEntry[] = [];
  private listeners = new Set<(entry: LogEntry) => void>();
  private fileReady = false;
  constructor(
    private file?: string,
    private capacity = 2000,
    private minLevel: LogLevel = "info",
  ) {}

  on(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  tail(count = 200): LogEntry[] {
    return this.entries.slice(-count);
  }

  scope(name: string) {
    return {
      debug: (message: string) => this.write("debug", name, message),
      info: (message: string) => this.write("info", name, message),
      warn: (message: string) => this.write("warn", name, message),
      error: (message: string) => this.write("error", name, message),
    };
  }

  private write(level: LogLevel, scope: string, message: string) {
    const order: LogLevel[] = ["debug", "info", "warn", "error"];
    if (order.indexOf(level) < order.indexOf(this.minLevel)) return;
    const entry: LogEntry = { time: Date.now(), level, scope, message };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        /* a broken listener must not break logging */
      }
    }
    if (this.file) void this.append(entry);
  }

  private async append(entry: LogEntry) {
    try {
      if (!this.fileReady) {
        await ensureDir(dirname(this.file!));
        this.fileReady = true;
      }
      const stamp = new Date(entry.time).toISOString();
      await appendFile(this.file!, `${stamp} [${entry.level}] ${entry.scope}: ${entry.message}\n`);
    } catch {
      /* logging must never throw */
    }
  }
}

export type ScopedLog = ReturnType<Logger["scope"]>;

export const nullLog: ScopedLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
