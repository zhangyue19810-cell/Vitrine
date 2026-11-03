import WebSocket from "ws";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A minimal client for the development transport, shaped like the one the interface uses. */
export class RpcClient {
  readonly events: any[] = [];
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly waiters: { predicate: (event: any) => boolean; resolve: (event: any) => void }[] = [];
  private nextId = 1;

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.event) {
        this.events.push(message.event);
        for (const waiter of [...this.waiters]) {
          if (waiter.predicate(message.event)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            waiter.resolve(message.event);
          }
        }
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code, data: message.error.data }));
      else entry.resolve(message.result);
    });
  }

  static open(url: string, headers: Record<string, string> = {}): Promise<RpcClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      ws.once("open", () => resolve(new RpcClient(ws)));
      ws.once("unexpected-response", (_request, response) => reject(Object.assign(new Error(`HTTP ${response.statusCode}`), { status: response.statusCode })));
      ws.once("error", reject);
    });
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  abort(id: number) {
    this.ws.send(JSON.stringify({ abort: id }));
  }

  /** Resolve with the first event (already received or yet to come) matching the predicate. */
  waitFor(predicate: (event: any) => boolean, timeoutMs = 20_000, label = "event"): Promise<any> {
    const seen = this.events.find(predicate);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      });
    });
  }

  async waitForTask(taskId: string, states: string[] = ["done", "failed", "cancelled"], timeoutMs = 30_000) {
    const event = await this.waitFor((e) => e.type === "task" && e.task.id === taskId && states.includes(e.task.state), timeoutMs, `task ${taskId} to reach ${states.join("/")}`);
    return event.task;
  }

  close() {
    this.ws.terminate();
  }
}
