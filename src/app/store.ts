import { getBridge, rpc, type Bootstrap, type SystemInfo } from "./api";
import type { BridgeEvent } from "./bridge";
import type { AfterLaunch, GameLine, GameSnapshot, InstanceSummary, JvmPresetInfo, LoginChallenge, PublicAccount, Settings, TaskSnapshot } from "./types";

/**
 * The interface's copy of what the core knows. Core events are folded in here; views subscribe to the topics they
 * draw and never talk to the transport for state — only for actions.
 */

export type Topic =
  | "ready"
  | "connection"
  | "settings"
  | "instances"
  | "accounts"
  | "task"
  | "tasks"
  | "task-log"
  | "game"
  | "games"
  | "game-lines"
  | "login"
  | "after-launch"
  | "game-exit-ui";

export interface LoginEvent {
  loginId: string;
  status: "done" | "error" | "cancelled";
  account?: PublicAccount;
  error?: string;
  reason?: string;
}

const MAX_TASK_LOG = 400;
const MAX_GAME_LINES = 4000;

type Handler = (payload?: never) => void;

export class Store {
  ready = false;
  connected = false;
  coreVersion = "";
  settings!: Settings;
  system!: SystemInfo;
  jvmPresets: JvmPresetInfo[] = [];
  instances: InstanceSummary[] = [];
  accounts: PublicAccount[] = [];
  selectedAccount: string | null = null;
  readonly tasks = new Map<string, TaskSnapshot>();
  readonly taskLogs = new Map<string, string[]>();
  readonly games = new Map<string, GameSnapshot>();
  readonly gameLines = new Map<string, GameLine[]>();
  /** The challenge of a Microsoft sign-in in progress, kept so a closed dialog can show it again. */
  pendingLogin?: { loginId: string; challenge: LoginChallenge; startedAt: number };

  private readonly handlers = new Map<Topic, Set<Handler>>();
  private attached = false;
  private bootstrapped = false;
  private instanceTimer?: ReturnType<typeof setTimeout>;
  private accountTimer?: ReturnType<typeof setTimeout>;

  // ------------------------------------------------------------------------------------------ subscription

  on<T = unknown>(topic: Topic, handler: (payload: T) => void): () => void {
    const set = this.handlers.get(topic) ?? new Set();
    set.add(handler as Handler);
    this.handlers.set(topic, set);
    return () => set.delete(handler as Handler);
  }

  emit(topic: Topic, payload?: unknown) {
    for (const handler of [...(this.handlers.get(topic) ?? [])]) {
      try {
        (handler as (payload?: unknown) => void)(payload);
      } catch (error) {
        console.error(`handler for ${topic} failed`, error);
      }
    }
  }

  // ------------------------------------------------------------------------------------------ lifecycle

  attach() {
    const bridge = getBridge();
    if (!bridge || this.attached) return;
    this.attached = true;
    bridge.on((event) => this.apply(event));
  }

  async bootstrap(): Promise<void> {
    this.attach();
    const data: Bootstrap = await rpc("app.bootstrap");
    this.settings = data.settings;
    this.system = data.system;
    this.jvmPresets = data.jvmPresets;
    this.instances = data.instances;
    this.accounts = data.accounts;
    this.selectedAccount = data.selectedAccount;
    this.tasks.clear();
    for (const task of data.tasks) this.tasks.set(task.id, task);
    this.games.clear();
    for (const game of data.games) this.games.set(game.id, game);
    this.connected = true;
    const first = !this.bootstrapped;
    this.bootstrapped = true;
    this.ready = true;
    if (first) this.emit("ready");
    for (const topic of ["settings", "instances", "accounts", "tasks", "games", "connection"] as Topic[]) this.emit(topic);
  }

  // ------------------------------------------------------------------------------------------ events

  private apply(event: BridgeEvent) {
    switch (event.type) {
      case "hello":
        this.coreVersion = event.version;
        return;
      case "bridge":
        this.connected = event.state === "open";
        this.emit("connection");
        // A development backend that restarted knows nothing of our state: ask again.
        if (event.state === "open" && this.bootstrapped) void this.bootstrap().catch((error) => console.error("re-bootstrap failed", error));
        return;
      case "task":
        this.tasks.set(event.task.id, event.task);
        this.emit("task", event.task);
        this.emit("tasks");
        return;
      case "task-log": {
        const lines = this.taskLogs.get(event.id) ?? [];
        lines.push(...event.lines);
        if (lines.length > MAX_TASK_LOG) lines.splice(0, lines.length - MAX_TASK_LOG);
        this.taskLogs.set(event.id, lines);
        this.emit("task-log", event.id);
        return;
      }
      case "task-removed":
        this.tasks.delete(event.id);
        this.taskLogs.delete(event.id);
        this.emit("tasks");
        return;
      case "game":
        this.games.set(event.game.id, event.game);
        this.emit("game", event.game);
        this.emit("games");
        return;
      case "game-lines": {
        const lines = this.gameLines.get(event.id) ?? [];
        lines.push(...event.lines);
        if (lines.length > MAX_GAME_LINES) lines.splice(0, lines.length - MAX_GAME_LINES);
        this.gameLines.set(event.id, lines);
        this.emit("game-lines", event.id);
        return;
      }
      case "settings":
        this.settings = event.settings;
        this.emit("settings");
        return;
      case "instances":
        this.scheduleInstances();
        return;
      case "accounts":
        this.scheduleAccounts();
        return;
      case "login":
        if (this.pendingLogin?.loginId === event.loginId) this.pendingLogin = undefined;
        this.emit("login", event satisfies LoginEvent);
        return;
      case "after-launch":
        this.emit("after-launch", { mode: event.mode, gameId: event.gameId } satisfies { mode: AfterLaunch; gameId: string });
        return;
      case "game-exit-ui":
        this.emit("game-exit-ui", event.gameId);
        return;
    }
  }

  private scheduleInstances() {
    clearTimeout(this.instanceTimer);
    this.instanceTimer = setTimeout(async () => {
      try {
        this.instances = await rpc("instances.list");
        this.emit("instances");
      } catch (error) {
        console.error("instances refresh failed", error);
      }
    }, 60);
  }

  private scheduleAccounts() {
    clearTimeout(this.accountTimer);
    this.accountTimer = setTimeout(async () => {
      try {
        const list = await rpc("accounts.list");
        this.accounts = list.accounts;
        this.selectedAccount = list.selected;
        this.emit("accounts");
      } catch (error) {
        console.error("accounts refresh failed", error);
      }
    }, 60);
  }

  // ------------------------------------------------------------------------------------------ derived

  instance(id: string | undefined): InstanceSummary | undefined {
    return id ? this.instances.find((entry) => entry.id === id) : undefined;
  }

  get account(): PublicAccount | undefined {
    return this.accounts.find((entry) => entry.id === this.selectedAccount) ?? this.accounts[0];
  }

  /** Tasks in the order they were created, newest first. */
  taskList(): TaskSnapshot[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  activeTasks(): TaskSnapshot[] {
    return this.taskList().filter((task) => task.state === "queued" || task.state === "running");
  }

  /** Background work that is not a launch (launches have their own screen). */
  activeDownloads(): TaskSnapshot[] {
    return this.activeTasks().filter((task) => task.kind !== "launch");
  }

  gameList(): GameSnapshot[] {
    return [...this.games.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Games that have not exited yet (starting, window open, running). */
  liveGames(): GameSnapshot[] {
    return this.gameList().filter((game) => game.state !== "exited");
  }

  get gameRunning(): boolean {
    return this.liveGames().length > 0;
  }

  /** A launch task is preparing the game (or it is waiting for its slot). */
  get launching(): boolean {
    return this.activeTasks().some((task) => task.kind === "launch");
  }

  gameOf(instanceId: string): GameSnapshot | undefined {
    return this.liveGames().find((game) => game.instanceId === instanceId);
  }

  tasksOf(instanceId: string): TaskSnapshot[] {
    return this.taskList().filter((task) => task.instanceId === instanceId);
  }
}

export const store = new Store();
