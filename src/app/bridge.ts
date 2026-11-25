import type { CoreEvent } from "./types";

/**
 * The line between the interface and the core.
 *
 *  - In the desktop app the preload script exposes `window.vitrine` (Electron IPC; no port is ever opened).
 *  - In development the interface talks to `npm run dev:backend` over a WebSocket whose URL (with its random token)
 *    comes from the `?backend=` link the dev backend prints.
 *
 * Both carry the same request/response/event protocol, so everything above this file is transport-agnostic.
 */

export class RpcError extends Error {
  readonly name = "RpcError";
  constructor(
    message: string,
    readonly code: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export type BridgeEvent = CoreEvent | { type: "hello"; version: string } | { type: "bridge"; state: "open" | "closed" };
export type BridgeListener = (event: BridgeEvent) => void;

export interface Bridge {
  readonly kind: "electron" | "ws";
  readonly connected: boolean;
  call<T = unknown>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  on(listener: BridgeListener): () => void;
  /** Path of a dropped file (the desktop shell can resolve it; a browser cannot). */
  pathForFile(file: File): string | undefined;
  /** Window controls of the desktop shell. */
  window?: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
  };
  /** Focus / visibility of the real window, pushed by the desktop shell. */
  onWindowState?(listener: (state: { focused: boolean; visible: boolean }) => void): () => void;
}

/** What the Electron preload script exposes. */
export interface ElectronBridge {
  platform: string;
  call(id: number, method: string, params: Record<string, unknown>): Promise<{ ok: true; result: unknown } | { ok: false; error: { code: string; message: string; data?: unknown } }>;
  abort(id: number): void;
  onEvent(listener: (event: BridgeEvent) => void): () => void;
  pathForFile(file: File): string | undefined;
  windowControl?(action: "minimize" | "maximize" | "close"): void;
  /** Focus / visibility of the real window (document events are unreliable for a minimized window on some platforms). */
  onWindowState?(listener: (state: { focused: boolean; visible: boolean }) => void): () => void;
}

declare global {
  interface Window {
    vitrine?: ElectronBridge;
  }
}

abstract class BaseBridge implements Bridge {
  abstract readonly kind: "electron" | "ws";
  protected listeners = new Set<BridgeListener>();
  protected nextId = 1;
  connected = false;
  abstract call<T = unknown>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  pathForFile(_file: File): string | undefined {
    return undefined;
  }
  on(listener: BridgeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  protected emit(event: BridgeEvent) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("bridge listener failed", error);
      }
    }
  }
}

class IpcBridge extends BaseBridge {
  readonly kind = "electron" as const;
  window: Bridge["window"];
  onWindowState: Bridge["onWindowState"];
  constructor(private readonly native: ElectronBridge) {
    super();
    this.connected = true;
    native.onEvent((event) => this.emit(event));
    if (native.onWindowState) this.onWindowState = (listener) => native.onWindowState!(listener);
    if (native.windowControl) {
      const control = native.windowControl.bind(native);
      this.window = { minimize: () => control("minimize"), toggleMaximize: () => control("maximize"), close: () => control("close") };
    }
  }
  pathForFile(file: File) {
    try {
      return this.native.pathForFile(file) || undefined;
    } catch {
      return undefined;
    }
  }
  async call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new RpcError("已取消", "cancelled");
    const id = this.nextId++;
    const onAbort = () => this.native.abort(id);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const reply = await this.native.call(id, method, params);
      if (reply.ok) return reply.result as T;
      throw new RpcError(reply.error.message, reply.error.code, reply.error.data);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup?: () => void;
}

class WsBridge extends BaseBridge {
  readonly kind = "ws" as const;
  private socket?: WebSocket;
  private pending = new Map<number, Pending>();
  private retry = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private opened?: Promise<void>;
  private closedByUs = false;

  constructor(private readonly url: string) {
    super();
    this.connect();
  }

  private connect() {
    this.opened = new Promise<void>((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch (error) {
        console.error("cannot open backend socket", error);
        this.scheduleReconnect();
        resolve();
        return;
      }
      this.socket = ws;
      ws.onopen = () => {
        this.retry = 0;
        this.connected = true;
        resolve();
        this.emit({ type: "bridge", state: "open" });
      };
      ws.onmessage = (message) => {
        let data: { id?: number; result?: unknown; error?: { code: string; message: string; data?: unknown }; event?: BridgeEvent };
        try {
          data = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (data.event) return this.emit(data.event);
        if (typeof data.id !== "number") return;
        const entry = this.pending.get(data.id);
        if (!entry) return;
        this.pending.delete(data.id);
        entry.cleanup?.();
        if (data.error) entry.reject(new RpcError(data.error.message, data.error.code, data.error.data));
        else entry.resolve(data.result);
      };
      ws.onclose = () => {
        const wasConnected = this.connected;
        this.connected = false;
        resolve();
        for (const [id, entry] of this.pending) {
          entry.cleanup?.();
          entry.reject(new RpcError("与核心的连接已断开", "disconnected"));
          this.pending.delete(id);
        }
        if (wasConnected) this.emit({ type: "bridge", state: "closed" });
        if (!this.closedByUs) this.scheduleReconnect();
      };
      ws.onerror = () => {
        /* onclose follows */
      };
    });
  }

  private scheduleReconnect() {
    clearTimeout(this.timer);
    const delay = Math.min(5000, 400 * 2 ** this.retry++);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new RpcError("已取消", "cancelled");
    if (!this.connected) await Promise.race([this.opened, new Promise((resolve) => setTimeout(resolve, 4000))]);
    const socket = this.socket;
    if (!this.connected || !socket || socket.readyState !== WebSocket.OPEN) throw new RpcError("无法连接到核心，请确认 npm run dev:backend 正在运行", "disconnected");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (value: unknown) => void, reject };
      if (signal) {
        const onAbort = () => {
          socket.send(JSON.stringify({ abort: id }));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(id, entry);
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

/** The WebSocket URL a development page was opened with (kept for the tab's lifetime, then stripped from the address bar). */
function developmentBackend(): string | undefined {
  const KEY = "vitrine-backend";
  try {
    const url = new URL(location.href);
    const given = url.searchParams.get("backend");
    if (given) {
      sessionStorage.setItem(KEY, given);
      url.searchParams.delete("backend");
      history.replaceState(null, "", url.pathname + (url.search || "") + url.hash);
      return given;
    }
    return sessionStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function createBridge(): Bridge | undefined {
  if (window.vitrine) return new IpcBridge(window.vitrine);
  const url = developmentBackend();
  return url ? new WsBridge(url) : undefined;
}
