import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { Core } from "./core";
import type { CoreEvent } from "./events";
import { buildRpc, describeError, type RpcTable } from "./rpc";

/**
 * Development / headless transport: the interface talks to the core over a local WebSocket.
 * The packaged desktop app uses Electron IPC instead and never opens a port.
 *
 * Because anything on the machine (including web pages in the player's browser) can try to connect to a local port,
 * every connection needs the random token, a loopback Host header (DNS-rebinding defence) and — when the browser
 * sends one — an allowed Origin.
 */

export interface WsServerOptions {
  core: Core;
  table?: RpcTable;
  port?: number;
  host?: string;
  /** Shared secret; random when omitted. */
  token?: string;
  /** Origins allowed to connect. Default: any page served from localhost / 127.0.0.1 (the Vite dev server). */
  allowedOrigins?: (string | RegExp)[];
}

export interface WsServer {
  port: number;
  token: string;
  url: string;
  clients(): number;
  close(): Promise<void>;
}

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const MAX_PAYLOAD = 8 * 1024 * 1024;
const BACKPRESSURE_BYTES = 1024 * 1024;

const replacer = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function originAllowed(origin: string | undefined, allowed: (string | RegExp)[] | undefined): boolean {
  if (origin === undefined) return true; // not a browser (tests, scripts)
  if (allowed) return allowed.some((entry) => (typeof entry === "string" ? entry === origin : entry.test(origin)));
  return LOOPBACK_ORIGIN.test(origin);
}

function hostAllowed(request: IncomingMessage, port: number): boolean {
  const host = (request.headers.host ?? "").toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

export async function startWsServer(options: WsServerOptions): Promise<WsServer> {
  const { core } = options;
  const table = options.table ?? buildRpc(core);
  const token = options.token ?? randomBytes(24).toString("base64url");
  const http = createServer((request, response) => {
    // Nothing is served over plain HTTP; this only exists so the WebSocket upgrade has somewhere to happen.
    response.writeHead(request.url === "/health" ? 200 : 404, { "content-type": "text/plain" });
    response.end(request.url === "/health" ? "ok" : "not found");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const sockets = new Set<WebSocket>();

  const reject = (socket: import("node:stream").Duplex, status: number, reason: string) => {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  http.on("upgrade", (request, socket, head) => {
    const port = (http.address() as AddressInfo).port;
    if (!hostAllowed(request, port)) return reject(socket, 403, "Forbidden");
    if (!originAllowed(request.headers.origin, options.allowedOrigins)) return reject(socket, 403, "Forbidden");
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (!sameToken(url.searchParams.get("token") ?? "", token)) return reject(socket, 401, "Unauthorized");
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  const send = (ws: WebSocket, message: unknown) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(message, replacer));
  };

  wss.on("connection", (ws) => {
    sockets.add(ws);
    const pending = new Map<number, AbortController>();
    send(ws, { event: { type: "hello", version: core.version } });
    ws.on("message", (data) => {
      let message: { id?: unknown; method?: unknown; params?: unknown; abort?: unknown };
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (typeof message.abort === "number") {
        pending.get(message.abort)?.abort();
        return;
      }
      const { id, method } = message;
      if (typeof id !== "number" || typeof method !== "string") return;
      const handler = Object.hasOwn(table, method) ? table[method] : undefined;
      if (!handler) return send(ws, { id, error: { code: "no-method", message: `未知的方法：${method}` } });
      const controller = new AbortController();
      pending.set(id, controller);
      const params = message.params && typeof message.params === "object" && !Array.isArray(message.params) ? (message.params as Record<string, unknown>) : {};
      Promise.resolve()
        .then(() => handler(params, { signal: controller.signal }))
        .then(
          (result) => send(ws, { id, result: result === undefined ? null : result }),
          (error) => send(ws, { id, error: describeError(error) }),
        )
        .finally(() => pending.delete(id));
    });
    ws.on("close", () => {
      sockets.delete(ws);
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    });
    ws.on("error", () => {});
  });

  const off = core.on((event: CoreEvent) => {
    const droppable = event.type === "game-lines" || (event.type === "task" && event.task.state === "running");
    for (const ws of sockets) {
      if (droppable && ws.bufferedAmount > BACKPRESSURE_BYTES) continue;
      send(ws, { event });
    }
  });

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject2) => {
    http.once("error", reject2);
    http.listen(options.port ?? 0, host, resolve);
  });
  const port = (http.address() as AddressInfo).port;
  return {
    port,
    token,
    url: `ws://127.0.0.1:${port}/?token=${token}`,
    clients: () => sockets.size,
    close: () =>
      new Promise<void>((resolve) => {
        off();
        for (const ws of sockets) ws.terminate();
        wss.close(() => http.close(() => resolve()));
        http.closeAllConnections?.();
      }),
  };
}
