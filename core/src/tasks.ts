import { randomUUID } from "node:crypto";
import type { Progress } from "./net/download";
import { isAbort } from "./util/async";

/**
 * Background work the interface can watch: installs, modpack imports, repairs, updates, launches.
 *
 * Progress is the expensive part of the event stream (a download run reports many times a second, with one entry
 * per download lane), so how often it is published follows what the player is looking at: full detail while the
 * window is focused, a trickle while it is in the background, almost nothing while it is hidden.
 */

export type TaskState = "queued" | "running" | "done" | "failed" | "cancelled";
export type TaskKind = "install" | "modpack" | "content" | "repair" | "launch" | "java" | "export" | "update" | "import" | "other";
export type UiLevel = "active" | "background" | "hidden";

export interface TaskStage {
  id: string;
  label: string;
  state: "pending" | "active" | "done";
}

export interface TaskSnapshot {
  id: string;
  kind: TaskKind;
  title: string;
  instanceId?: string;
  state: TaskState;
  stage?: string;
  /** Human-readable name of the current stage. */
  stageLabel?: string;
  stageDetail?: string;
  stages: TaskStage[];
  /** Latest download progress; `lanes` is only filled while the interface is in the foreground. */
  progress?: Progress;
  /** 0..1 when it can be worked out. */
  fraction?: number;
  warnings: string[];
  error?: string;
  errorCode?: string;
  result?: unknown;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

export type TaskEvent = { type: "task"; task: TaskSnapshot } | { type: "task-log"; id: string; lines: string[] } | { type: "task-removed"; id: string };

export interface TaskContext {
  readonly id: string;
  readonly signal: AbortSignal;
  /** Declare the stages up front so the interface can draw the whole pipeline. */
  plan(stages: { id: string; label: string }[]): void;
  stage(id: string, detail?: string): void;
  progress(progress: Progress, stage?: string): void;
  log(line: string): void;
  warn(message: string): void;
  setTitle(title: string): void;
}

export interface TaskSpec<T> {
  kind: TaskKind;
  title: string;
  instanceId?: string;
  /** Launch tasks run immediately; everything else waits for a free slot. */
  lane?: "install" | "launch";
  run(context: TaskContext): Promise<T>;
}

const PROGRESS_INTERVAL: Record<UiLevel, number> = { active: 120, background: 700, hidden: 4000 };
const MAX_LOG = 400;
const MAX_FINISHED = 100;

interface Entry {
  snapshot: TaskSnapshot;
  controller: AbortController;
  log: string[];
  pendingLog: string[];
  pendingProgress?: Progress;
  lastPublished: number;
  timer?: NodeJS.Timeout;
  spec: TaskSpec<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  settled: Promise<void>;
  markSettled: () => void;
}

function fractionOf(progress: Progress | undefined): number | undefined {
  if (!progress) return undefined;
  if (progress.bytesTotal > 0) return Math.min(1, progress.bytesDone / progress.bytesTotal);
  if (progress.totalFiles > 0) return Math.min(1, (progress.doneFiles + progress.skippedFiles + progress.failedFiles) / progress.totalFiles);
  return undefined;
}

export class TaskManager {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(event: TaskEvent) => void>();
  private level: UiLevel = "active";
  private running = 0;

  constructor(private readonly options: { maxConcurrent?: number; now?: () => number; /** stage id → label for stages that are not part of a declared plan */ labels?: Record<string, string> } = {}) {}

  private now() {
    return (this.options.now ?? Date.now)();
  }

  onEvent(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: TaskEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a broken listener must not stop the work */
      }
    }
  }

  /** Called by the interface when its visibility or focus changes. */
  setUiLevel(level: UiLevel) {
    if (this.level === level) return;
    this.level = level;
    // Becoming visible again: bring the interface up to date at once.
    if (level !== "hidden") for (const entry of this.entries.values()) if (entry.snapshot.state === "running") this.publish(entry, true);
  }

  getUiLevel(): UiLevel {
    return this.level;
  }

  list(): TaskSnapshot[] {
    return [...this.entries.values()].map((entry) => entry.snapshot).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): (TaskSnapshot & { log: string[] }) | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const snapshot: TaskSnapshot = { ...entry.snapshot, stages: entry.snapshot.stages.map((stage) => ({ ...stage })), warnings: [...entry.snapshot.warnings] };
    // A foreground details page polls this method; return the freshest queued progress even when
    // event publication is throttled while the window is unfocused or hidden.
    if (snapshot.state === "running" && entry.pendingProgress) {
      snapshot.progress = entry.pendingProgress;
      snapshot.fraction = fractionOf(entry.pendingProgress);
    }
    return { ...snapshot, log: [...entry.log] };
  }

  /** Start a task. `promise` settles with the task's result; ignoring it is safe. */
  start<T>(spec: TaskSpec<T>): { id: string; promise: Promise<T> } {
    const id = randomUUID();
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => {});
    let markSettled!: () => void;
    const settled = new Promise<void>((res) => (markSettled = res));
    const entry: Entry = {
      snapshot: { id, kind: spec.kind, title: spec.title, instanceId: spec.instanceId, state: "queued", stages: [], warnings: [], createdAt: this.now() },
      controller: new AbortController(),
      log: [],
      pendingLog: [],
      lastPublished: 0,
      spec: spec as TaskSpec<unknown>,
      resolve,
      reject,
      settled,
      markSettled,
    };
    this.entries.set(id, entry);
    this.publish(entry, true);
    this.pump();
    return { id, promise: promise as Promise<T> };
  }

  private pump() {
    const limit = this.options.maxConcurrent ?? 2;
    for (const entry of this.entries.values()) {
      if (entry.snapshot.state !== "queued") continue;
      const launch = entry.spec.lane === "launch";
      if (!launch && this.running >= limit) continue;
      if (!launch) this.running++;
      void this.execute(entry, !launch);
    }
  }

  private async execute(entry: Entry, counted: boolean) {
    const { snapshot } = entry;
    if (entry.controller.signal.aborted) {
      if (counted) this.running--;
      return this.finish(entry, "cancelled");
    }
    snapshot.state = "running";
    snapshot.startedAt = this.now();
    this.publish(entry, true);
    const context: TaskContext = {
      id: snapshot.id,
      signal: entry.controller.signal,
      plan: (stages) => {
        snapshot.stages = stages.map((stage) => ({ ...stage, state: "pending" }));
        this.publish(entry, true);
      },
      stage: (stage, detail) => {
        const base = stage.split(":")[0];
        if (snapshot.stage !== base) {
          // Only a stage that is part of the plan moves the pipeline; extras (fallback installers…) just change the label.
          if (snapshot.stages.some((item) => item.id === base)) {
            let reached = false;
            for (const item of snapshot.stages) {
              if (item.id === base) {
                item.state = "active";
                reached = true;
              } else if (!reached) item.state = "done";
              else item.state = "pending";
            }
          }
          // progress from the previous stage is meaningless for the next one
          snapshot.progress = undefined;
          snapshot.fraction = undefined;
          entry.pendingProgress = undefined;
        }
        snapshot.stage = base;
        snapshot.stageLabel = snapshot.stages.find((item) => item.id === base)?.label ?? this.options.labels?.[base] ?? base;
        snapshot.stageDetail = detail ?? (stage.includes(":") ? stage.split(":").slice(1).join(":") : undefined);
        this.publish(entry, true);
      },
      progress: (progress, stage) => {
        if (stage && snapshot.stage !== stage.split(":")[0]) context.stage(stage);
        entry.pendingProgress = progress;
        this.publish(entry, false);
      },
      log: (line) => {
        entry.log.push(line);
        if (entry.log.length > MAX_LOG) entry.log.splice(0, entry.log.length - MAX_LOG);
        entry.pendingLog.push(line);
        this.publish(entry, false);
      },
      warn: (message) => {
        snapshot.warnings.push(message);
        if (snapshot.warnings.length > 50) snapshot.warnings.shift();
        context.log(`⚠ ${message}`);
        this.publish(entry, true);
      },
      setTitle: (title) => {
        snapshot.title = title;
        this.publish(entry, true);
      },
    };
    try {
      const result = await entry.spec.run(context);
      snapshot.result = result;
      for (const stage of snapshot.stages) stage.state = "done";
      if (counted) this.running--;
      this.finish(entry, entry.controller.signal.aborted && snapshot.result === undefined ? "cancelled" : "done");
      entry.resolve(result);
    } catch (error) {
      if (counted) this.running--;
      const aborted = isAbort(error) || entry.controller.signal.aborted;
      if (!aborted) {
        snapshot.error = (error as Error)?.message ?? String(error);
        const code = (error as { code?: unknown; reason?: unknown })?.reason ?? (error as { code?: unknown })?.code ?? (error as Error)?.name;
        snapshot.errorCode = typeof code === "string" ? code : undefined;
        entry.log.push(`✖ ${snapshot.error}`);
        entry.pendingLog.push(`✖ ${snapshot.error}`);
      }
      this.finish(entry, aborted ? "cancelled" : "failed");
      entry.reject(error);
    }
    this.pump();
  }

  private finish(entry: Entry, state: TaskState) {
    const { snapshot } = entry;
    snapshot.state = state;
    snapshot.endedAt = this.now();
    if (state === "done") snapshot.fraction = 1;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    // Final progress is worth keeping (totals for the summary) but the lanes are all idle by now.
    if (entry.pendingProgress) snapshot.progress = { ...entry.pendingProgress, lanes: [] };
    else if (snapshot.progress) snapshot.progress = { ...snapshot.progress, lanes: [] };
    entry.pendingProgress = undefined;
    this.publish(entry, true);
    entry.markSettled();
    this.trim();
  }

  private trim() {
    const finished = [...this.entries.values()].filter((entry) => ["done", "failed", "cancelled"].includes(entry.snapshot.state)).sort((a, b) => (a.snapshot.endedAt ?? 0) - (b.snapshot.endedAt ?? 0));
    while (finished.length > MAX_FINISHED) {
      const old = finished.shift()!;
      this.entries.delete(old.snapshot.id);
      this.emit({ type: "task-removed", id: old.snapshot.id });
    }
  }

  private publish(entry: Entry, immediate: boolean) {
    const interval = PROGRESS_INTERVAL[this.level];
    const wait = immediate ? 0 : entry.lastPublished + interval - this.now();
    if (wait > 0) {
      entry.timer ??= setTimeout(() => {
        entry.timer = undefined;
        this.publish(entry, true);
      }, wait);
      entry.timer.unref?.();
      return;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    entry.lastPublished = this.now();
    const { snapshot } = entry;
    if (entry.pendingProgress && snapshot.state === "running") {
      const progress = entry.pendingProgress;
      snapshot.progress = this.level === "active" ? progress : { ...progress, lanes: [] };
      snapshot.fraction = fractionOf(progress);
    }
    if (entry.pendingLog.length && this.level !== "hidden") this.emit({ type: "task-log", id: snapshot.id, lines: entry.pendingLog.splice(0) });
    else if (entry.pendingLog.length > MAX_LOG) entry.pendingLog.splice(0, entry.pendingLog.length - MAX_LOG);
    this.emit({ type: "task", task: { ...snapshot, stages: snapshot.stages.map((stage) => ({ ...stage })), warnings: [...snapshot.warnings] } });
  }

  /** Ask a task to stop. Queued tasks are cancelled at once; running ones when their work notices the signal. */
  async cancel(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry || ["done", "failed", "cancelled"].includes(entry.snapshot.state)) return false;
    entry.controller.abort();
    if (entry.snapshot.state === "queued") {
      this.finish(entry, "cancelled");
      entry.reject(Object.assign(new Error("已取消"), { name: "AbortError" }));
    }
    return true;
  }

  cancelAll() {
    for (const entry of this.entries.values()) void this.cancel(entry.snapshot.id);
  }

  /** Resolve once every task has finished (cancelled ones included). */
  async idle(): Promise<void> {
    for (;;) {
      const open = [...this.entries.values()].filter((entry) => !["done", "failed", "cancelled"].includes(entry.snapshot.state));
      if (!open.length) return;
      await Promise.all(open.map((entry) => entry.settled));
    }
  }

  /** Forget finished tasks (the "clear list" button). Returns the ids removed. */
  clearFinished(): string[] {
    const removed: string[] = [];
    for (const entry of [...this.entries.values()]) {
      if (!["done", "failed", "cancelled"].includes(entry.snapshot.state)) continue;
      this.entries.delete(entry.snapshot.id);
      removed.push(entry.snapshot.id);
      this.emit({ type: "task-removed", id: entry.snapshot.id });
    }
    return removed;
  }
}
