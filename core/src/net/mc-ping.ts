import { resolveSrv as dnsResolveSrv } from "node:dns/promises";
import { createConnection, type Socket } from "node:net";

/** One run of MOTD text with its formatting. */
export interface MotdSegment {
  text: string;
  /** CSS colour (named colours are converted to hex). */
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  obfuscated?: boolean;
}

export interface ServerStatus {
  /** Endpoint actually contacted (after SRV lookup). */
  host: string;
  port: number;
  version: { name: string; protocol: number };
  players: { online: number; max: number; sample: { name: string; id?: string }[] };
  motd: MotdSegment[];
  motdPlain: string;
  /** data: URL of the server icon. */
  icon?: string;
  latencyMs?: number;
  /** Looks like a modded (Forge / NeoForge / Fabric-compatible) server. */
  modded?: boolean;
  /** The server answered the old (pre-1.7) ping only. */
  legacy?: boolean;
  enforcesSecureChat?: boolean;
}

export interface PingOptions {
  timeoutMs?: number;
  /** Protocol number sent in the handshake; servers answer with their own version regardless. */
  protocol?: number;
  resolveSrv?: (name: string) => Promise<{ name: string; port: number }[]>;
  signal?: AbortSignal;
}

const COLORS: Record<string, string> = {
  black: "#000000", dark_blue: "#0000aa", dark_green: "#00aa00", dark_aqua: "#00aaaa", dark_red: "#aa0000", dark_purple: "#aa00aa", gold: "#ffaa00", gray: "#aaaaaa",
  dark_gray: "#555555", blue: "#5555ff", green: "#55ff55", aqua: "#55ffff", red: "#ff5555", light_purple: "#ff55ff", yellow: "#ffff55", white: "#ffffff",
};
const LEGACY_CODES: Record<string, string> = { "0": "black", "1": "dark_blue", "2": "dark_green", "3": "dark_aqua", "4": "dark_red", "5": "dark_purple", "6": "gold", "7": "gray", "8": "dark_gray", "9": "blue", a: "green", b: "aqua", c: "red", d: "light_purple", e: "yellow", f: "white" };

type Style = Omit<MotdSegment, "text">;

/** Turn text containing § formatting codes into segments. */
export function parseLegacyMotd(text: string, base: Style = {}): MotdSegment[] {
  const out: MotdSegment[] = [];
  let style: Style = { ...base };
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ text: buffer, ...style });
    buffer = "";
  };
  for (let i = 0; i < text.length; i++) {
    if ((text[i] === "§" || text[i] === "§") && i + 1 < text.length) {
      const code = text[++i].toLowerCase();
      flush();
      if (LEGACY_CODES[code]) style = { ...base, color: COLORS[LEGACY_CODES[code]] };
      else if (code === "l") style = { ...style, bold: true };
      else if (code === "o") style = { ...style, italic: true };
      else if (code === "n") style = { ...style, underline: true };
      else if (code === "m") style = { ...style, strike: true };
      else if (code === "k") style = { ...style, obfuscated: true };
      else if (code === "r") style = { ...base };
      continue;
    }
    buffer += text[i];
  }
  flush();
  return out;
}

/** Flatten a JSON chat component (string, object with extra, or array) into segments. */
export function parseChatComponent(component: unknown, inherited: Style = {}): MotdSegment[] {
  if (typeof component === "string") return parseLegacyMotd(component, inherited);
  if (Array.isArray(component)) return component.flatMap((entry) => parseChatComponent(entry, inherited));
  if (!component || typeof component !== "object") return [];
  const node = component as Record<string, unknown>;
  const style: Style = { ...inherited };
  if (typeof node.color === "string") style.color = node.color.startsWith("#") ? node.color : (COLORS[node.color] ?? inherited.color);
  for (const [key, field] of [["bold", "bold"], ["italic", "italic"], ["underlined", "underline"], ["strikethrough", "strike"], ["obfuscated", "obfuscated"]] as const) {
    if (typeof node[key] === "boolean") style[field] = node[key] as boolean;
  }
  const out: MotdSegment[] = [];
  const own = typeof node.text === "string" ? node.text : typeof node.translate === "string" ? node.translate : "";
  if (own) out.push(...parseLegacyMotd(own, style));
  if (Array.isArray(node.extra)) for (const child of node.extra) out.push(...parseChatComponent(child, style));
  return out;
}

export function parseAddress(address: string): { host: string; port?: number } {
  const text = address.trim();
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracket) return { host: bracket[1], port: bracket[2] ? Number(bracket[2]) : undefined };
  const colon = text.lastIndexOf(":");
  if (colon > 0 && text.indexOf(":") === colon && /^\d+$/.test(text.slice(colon + 1))) return { host: text.slice(0, colon), port: Number(text.slice(colon + 1)) };
  return { host: text };
}

// ---------------------------------------------------------------------------------------------- wire format

function writeVarInt(value: number): Buffer {
  const out: number[] = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return Buffer.from(out);
}

function readVarInt(buffer: Buffer, offset: number): { value: number; size: number } | undefined {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buffer.length) return undefined;
    const byte = buffer[offset + i];
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return { value, size: i + 1 };
  }
  throw new Error("VarInt is too long");
}

const packet = (id: number, ...parts: Buffer[]) => {
  const body = Buffer.concat([writeVarInt(id), ...parts]);
  return Buffer.concat([writeVarInt(body.length), body]);
};

const string = (value: string) => {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([writeVarInt(bytes.length), bytes]);
};

const MAX_PACKET = 4 * 1024 * 1024;

class PacketStream {
  private chunks: Buffer[] = [];
  private waiting: { resolve: (value: { id: number; payload: Buffer }) => void; reject: (error: Error) => void }[] = [];
  private failure?: Error;
  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => {
      this.chunks.push(chunk);
      this.pump();
    });
    const fail = (error: Error) => {
      this.failure = error;
      for (const waiter of this.waiting.splice(0)) waiter.reject(error);
    };
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("服务器关闭了连接")));
  }
  private take(): { id: number; payload: Buffer } | undefined {
    const buffer = Buffer.concat(this.chunks);
    this.chunks = [buffer];
    const length = readVarInt(buffer, 0);
    if (!length) return undefined;
    if (length.value < 0 || length.value > MAX_PACKET) throw new Error("服务器返回了异常的数据包");
    if (buffer.length < length.size + length.value) return undefined;
    const body = buffer.subarray(length.size, length.size + length.value);
    this.chunks = [Buffer.from(buffer.subarray(length.size + length.value))];
    const id = readVarInt(body, 0);
    if (!id) throw new Error("数据包格式错误");
    return { id: id.value, payload: Buffer.from(body.subarray(id.size)) };
  }
  private pump() {
    while (this.waiting.length) {
      let next;
      try {
        next = this.take();
      } catch (error) {
        const waiter = this.waiting.shift()!;
        waiter.reject(error as Error);
        continue;
      }
      if (!next) return;
      this.waiting.shift()!.resolve(next);
    }
  }
  next(): Promise<{ id: number; payload: Buffer }> {
    if (this.failure && !this.chunks.some((chunk) => chunk.length)) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.pump();
    });
  }
}

function connect(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error("已取消"), { name: "AbortError" }));
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("连接超时"));
    }, timeoutMs);
    const onAbort = () => {
      socket.destroy();
      reject(Object.assign(new Error("已取消"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface RawStatus {
  version?: { name?: string; protocol?: number };
  players?: { online?: number; max?: number; sample?: { name?: string; id?: string }[] };
  description?: unknown;
  favicon?: string;
  enforcesSecureChat?: boolean;
  modinfo?: unknown;
  forgeData?: unknown;
  "forge-data"?: unknown;
}

function toStatus(raw: RawStatus, host: string, port: number): ServerStatus {
  const motd = parseChatComponent(raw.description ?? "");
  const favicon = typeof raw.favicon === "string" && raw.favicon.startsWith("data:image/") ? raw.favicon : undefined;
  return {
    host,
    port,
    version: { name: String(raw.version?.name ?? "?"), protocol: Number(raw.version?.protocol ?? -1) },
    players: {
      online: Number(raw.players?.online ?? 0),
      max: Number(raw.players?.max ?? 0),
      sample: (raw.players?.sample ?? []).filter((entry) => entry && typeof entry.name === "string").map((entry) => ({ name: entry.name as string, id: entry.id })),
    },
    motd,
    motdPlain: motd.map((segment) => segment.text).join("").replace(/\s+$/g, ""),
    icon: favicon,
    modded: Boolean(raw.modinfo || raw.forgeData || raw["forge-data"]),
    enforcesSecureChat: typeof raw.enforcesSecureChat === "boolean" ? raw.enforcesSecureChat : undefined,
  };
}

async function modernPing(host: string, port: number, sendHost: string, options: Required<Pick<PingOptions, "timeoutMs" | "protocol">> & { signal?: AbortSignal }): Promise<ServerStatus> {
  const socket = await connect(host, port, options.timeoutMs, options.signal);
  try {
    const stream = new PacketStream(socket);
    const portBytes = Buffer.alloc(2);
    portBytes.writeUInt16BE(port);
    socket.write(Buffer.concat([packet(0x00, writeVarInt(options.protocol), string(sendHost), portBytes, writeVarInt(1)), packet(0x00)]));
    const response = await withTimeout(stream.next(), options.timeoutMs, "服务器没有响应");
    if (response.id !== 0x00) throw new Error("服务器返回了意料之外的数据包");
    const length = readVarInt(response.payload, 0);
    if (!length) throw new Error("状态响应格式错误");
    const text = response.payload.subarray(length.size, length.size + length.value).toString("utf8");
    const status = toStatus(JSON.parse(text) as RawStatus, host, port);
    // The ping packet measures round-trip time; servers that skip it still gave us a status.
    const payload = Buffer.alloc(8);
    payload.writeBigInt64BE(BigInt(Date.now()));
    const started = performance.now();
    socket.write(packet(0x01, payload));
    try {
      const pong = await withTimeout(stream.next(), Math.min(options.timeoutMs, 3000), "no pong");
      if (pong.id === 0x01) status.latencyMs = Math.max(1, Math.round(performance.now() - started));
    } catch {
      /* no latency, status is still valid */
    }
    return status;
  } finally {
    socket.destroy();
  }
}

/** The pre-1.7 ping (0xFE 0x01), still answered by many old servers. */
async function legacyPing(host: string, port: number, options: { timeoutMs: number; signal?: AbortSignal }): Promise<ServerStatus> {
  const socket = await connect(host, port, options.timeoutMs, options.signal);
  try {
    const started = performance.now();
    socket.write(Buffer.from([0xfe, 0x01]));
    const data = await withTimeout(
      new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        socket.on("data", (chunk) => {
          chunks.push(chunk);
          const all = Buffer.concat(chunks);
          if (all.length >= 3 && all[0] === 0xff && all.length >= 3 + all.readUInt16BE(1) * 2) resolve(all);
        });
        socket.on("close", () => (chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error("服务器关闭了连接"))));
        socket.on("error", reject);
      }),
      options.timeoutMs,
      "服务器没有响应",
    );
    if (data[0] !== 0xff) throw new Error("不是 Minecraft 服务器");
    const chars = data.readUInt16BE(1);
    const text = Buffer.from(data.subarray(3, 3 + chars * 2)).swap16().toString("utf16le");
    if (!text.startsWith("§1\u0000")) throw new Error("服务器返回了无法识别的旧版状态");
    const [, protocol, version, motd, online, max] = text.split("\u0000");
    const segments = parseLegacyMotd(motd ?? "");
    return {
      host,
      port,
      version: { name: version ?? "?", protocol: Number(protocol) || -1 },
      players: { online: Number(online) || 0, max: Number(max) || 0, sample: [] },
      motd: segments,
      motdPlain: segments.map((segment) => segment.text).join(""),
      latencyMs: Math.max(1, Math.round(performance.now() - started)),
      legacy: true,
    };
  } finally {
    socket.destroy();
  }
}

/** Query a server the way the game's server list does: SRV lookup, status request, ping. */
export async function pingServer(address: string, options: PingOptions = {}): Promise<ServerStatus> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const parsed = parseAddress(address);
  if (!parsed.host) throw new Error("服务器地址不能为空");
  let host = parsed.host;
  let port = parsed.port ?? 25565;
  // The game only consults SRV records when no port was typed.
  if (parsed.port === undefined && !/^\d+\.\d+\.\d+\.\d+$/.test(parsed.host) && !parsed.host.includes(":")) {
    try {
      const records = await withTimeout((options.resolveSrv ?? dnsResolveSrv)(`_minecraft._tcp.${parsed.host}`), Math.min(timeoutMs, 3000), "SRV timeout");
      if (records[0]) {
        host = records[0].name.replace(/\.$/, "");
        port = records[0].port;
      }
    } catch {
      /* no SRV record: use the host as typed */
    }
  }
  const modernOptions = { timeoutMs, protocol: options.protocol ?? 765, signal: options.signal };
  try {
    return await modernPing(host, port, parsed.host, modernOptions);
  } catch (error) {
    if ((error as Error).name === "AbortError" || (error as NodeJS.ErrnoException).code === "ECONNREFUSED" || /连接超时/.test((error as Error).message)) throw error;
    try {
      return await legacyPing(host, port, { timeoutMs, signal: options.signal });
    } catch {
      throw error;
    }
  }
}
