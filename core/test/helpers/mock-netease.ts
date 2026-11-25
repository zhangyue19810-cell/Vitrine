import { createHash, generateKeyPairSync } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { crc32, deflateSync } from "node:zlib";
import { eapiDecrypt, weapiDecrypt } from "../../src/music/crypto";

/**
 * A stand-in for music.163.com for the tests and the offline demo: it decrypts the same "weapi" envelope with a key pair
 * of its own (the client is told to use the matching public key), serves a small invented catalogue, and plays the
 * QR login through its states. Songs, artists and lyrics are made up; the audio is a synthesised tune per song.
 */

export interface MockSong {
  id: number;
  name: string;
  artists: string[];
  album: string;
  seconds: number;
  /** 1 = members only: guests get a preview or nothing. */
  fee: number;
  /** The playlist call gives no address for it, only the outer chain does. */
  outerOnly?: boolean;
  /** Removed from the shelf. */
  gone?: boolean;
}

export interface MockPlaylist {
  id: number;
  name: string;
  creator: string;
  songs: number[];
  note: string;
  /** Only returned to a logged in account. */
  mine?: boolean;
}

export interface MockNeteaseOptions {
  /** Length of the synthesised audio of every song; the catalogue's own length is used for the metadata. */
  audioSeconds?: number;
  /** Answer delay in ms (to see several requests overlap). */
  delayMs?: number;
  /** The QR code walks through "scanned" and "confirmed" by itself after these delays (the offline demo). */
  autoQr?: { scanAfterMs: number; confirmAfterMs: number };
}

export interface MockNetease {
  url: string;
  port: number;
  publicKey: string;
  songs: MockSong[];
  playlists: MockPlaylist[];
  /** Every call with its decrypted payload, in order. */
  calls: { path: string; payload: Record<string, unknown>; cookie: string; referer: string; userAgent: string }[];
  stats: { active: number; maxActive: number; outer: number };
  scan(key: string): void;
  confirm(key: string): void;
  /** The next answer of `path` carries this code instead (once). */
  failNext(path: string, code: number, message?: string): void;
  close(): Promise<void>;
}

const WORDS = ["档案馆的雨", "钢琴与铁轨", "夜航船", "苔藓与星", "玻璃海", "纸月亮", "回声列车", "薄荷色黎明", "旧地图", "灯塔守夜人", "风的形状", "冬眠", "雾中花园", "第七节车厢", "银河便利店", "潮汐表", "松针", "无人岛邮局", "云端工坊", "琥珀"];
const BANDS = ["风与档案", "霜降", "Kaze", "Paper Moon", "夜航", "小满乐队"];
const ALBUMS = ["琉匣", "玻璃海", "纸月亮", "第七节车厢"];

export function mockCatalogue(): { songs: MockSong[]; playlists: MockPlaylist[] } {
  const songs: MockSong[] = WORDS.map((name, i) => ({
    id: 1001 + i,
    name,
    artists: i % 5 === 3 ? [BANDS[i % BANDS.length], BANDS[(i + 2) % BANDS.length]] : [BANDS[i % BANDS.length]],
    album: ALBUMS[i % ALBUMS.length],
    seconds: 96 + ((i * 17) % 120),
    fee: i % 7 === 6 ? 1 : 0,
    outerOnly: i === 4,
    gone: i === 11,
  }));
  const ids = songs.map((song) => song.id);
  const playlists: MockPlaylist[] = [
    { id: 3001, name: "雨天的档案室", creator: "琉匣电台", songs: ids.slice(0, 8), note: "适合下雨天整理背包", },
    { id: 3002, name: "深夜航行", creator: "夜航", songs: ids.slice(4, 14), note: "凌晨两点的合成器" },
    { id: 3003, name: "整合包调试 BGM", creator: "Wind", songs: ids.slice(8, 20), note: "边跑游戏边听" },
    { id: 3004, name: "清晨的玻璃海", creator: "霜降", songs: ids.slice(0, 5), note: "新歌推荐" },
    { id: 3005, name: "纸月亮精选", creator: "Paper Moon", songs: ids.slice(10, 17), note: "编辑推荐" },
    { id: 3006, name: "无人岛邮局", creator: "小满乐队", songs: ids.slice(2, 9), note: "每天更新" },
    { id: 19723756, name: "琉匣飙升榜", creator: "琉匣电台", songs: ids.slice(0, 12), note: "每天更新" },
    { id: 3779629, name: "琉匣新歌榜", creator: "琉匣电台", songs: ids.slice(6, 18), note: "每周四更新" },
    { id: 5001, name: "我喜欢的音乐", creator: "演示用户", songs: ids.slice(1, 9), note: "", mine: true },
    { id: 5002, name: "写代码时听", creator: "演示用户", songs: ids.slice(9, 15), note: "", mine: true },
  ];
  return { songs, playlists };
}

// ------------------------------------------------------------------------------------------------ pictures and sound

function crcChunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, tail]);
}

/** A square cover: two colours blended diagonally with a few soft rings. Deterministic per id. */
export function mockCover(id: number, size = 160): Buffer {
  const hue = (id * 47) % 360;
  const mix = (h: number, l: number): [number, number, number] => {
    const c = (1 - Math.abs(2 * l - 1)) * 0.65;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  };
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      const ring = 0.5 + 0.5 * Math.sin(Math.hypot(x - size * 0.62, y - size * 0.4) * 0.22 + id);
      const [r, g, b] = mix((hue + 60 * t + 20 * ring) % 360, 0.38 + 0.3 * (1 - t) + 0.06 * ring);
      const at = y * stride + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crcChunk("IHDR", header), crcChunk("IDAT", deflateSync(raw)), crcChunk("IEND", Buffer.alloc(0))]);
}

/** A small pentatonic arpeggio, different for every song, as a 16 bit mono WAV. */
export function mockWav(seed: number, seconds: number, rate = 16000): Buffer {
  const total = Math.floor(seconds * rate);
  const out = Buffer.alloc(44 + total * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + total * 2, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(total * 2, 40);
  const scale = [0, 2, 4, 7, 9];
  const root = 196 * 2 ** ((seed % 7) / 12);
  const step = 0.22 + (seed % 3) * 0.04;
  const ring = 4;
  for (let i = 0; i < total; i++) {
    const t = i / rate;
    const current = Math.floor(t / step);
    let sample = 0;
    for (let n = Math.max(0, current - ring + 1); n <= current; n++) {
      const age = t - n * step;
      const note = scale[(n * 3 + seed) % 5] + 12 * (((n >> 2) + seed) % 2);
      const freq = root * 2 ** (note / 12);
      const envelope = Math.min(1, age * 80) * Math.exp(-age * 3.2);
      sample += envelope * (Math.sin(2 * Math.PI * freq * age) + 0.3 * Math.sin(4 * Math.PI * freq * age)) * 0.22;
    }
    out.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sample * 32767))), 44 + i * 2);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the server

function lrcFor(song: MockSong): { lrc: string; tlyric: string } {
  const stamp = (ms: number) => `[${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}]`;
  const lines = ["在安静的档案室里", `翻开《${song.name}》的第一页`, "玻璃后面有光慢慢移动", "每一格抽屉都藏着一个夏天", "我们把名字写在标签上", "等风把它们读出来", "再远的路也有下一站", "把灯留给归来的人"];
  const english = ["In the quiet archive room", `Turning to the first page of "${song.name}"`, "Light drifts slowly behind the glass", "Every drawer hides a summer", "We write our names on the labels", "And wait for the wind to read them", "Even the longest road has a next stop", "Leave the light on for those who return"];
  const lrc = [`{"t":0,"c":[{"tx":"作词: "},{"tx":"${song.artists[0]}"}]}`, `{"t":1000,"c":[{"tx":"作曲: "},{"tx":"${song.artists[0]}"}]}`, ...lines.map((line, i) => `${stamp(4000 + i * 3500)}${line}`)];
  const tlyric = english.map((line, i) => `${stamp(4000 + i * 3500)}${line}`);
  return { lrc: lrc.join("\n"), tlyric: tlyric.join("\n") };
}

export async function startMockNetease(options: MockNeteaseOptions = {}): Promise<MockNetease> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const { songs, playlists } = mockCatalogue();
  const calls: MockNetease["calls"] = [];
  const stats = { active: 0, maxActive: 0, outer: 0 };
  const failures = new Map<string, { code: number; message?: string }>();
  type TogetherRoom = { roomId: string; inviterId: number; users: { userId: number; nickname: string }[]; songId: number; playStatus: string; progress: number; playlistIds: number[] };
  let together: TogetherRoom | undefined;
  const togetherInfo = () => together ? {
    roomInfo: { roomId: together.roomId, inviterId: together.inviterId, roomUsers: together.users },
    playingInfo: { trackId: together.songId, status: together.playStatus, progress: together.progress },
    playlistInfo: { displayList: { result: together.playlistIds } },
  } : null;
  const audioSeconds = options.audioSeconds ?? 30;
  const sockets = new Set<import("node:net").Socket>();

  const logins = new Map<string, { state: "waiting" | "scanned" | "confirmed"; created: number }>();
  let keyCounter = 0;
  const TOKEN = "mock-music-u-0123456789abcdef";

  const songJson = (song: MockSong) => ({
    id: song.id,
    name: song.name,
    ar: song.artists.map((name, i) => ({ id: 9000 + i, name })),
    al: { id: 7000 + (song.id % 4), name: song.album, picUrl: `${base()}/cover/${song.id}.png` },
    dt: song.seconds * 1000,
    fee: song.fee,
  });
  const privilegeJson = (song: MockSong) => ({ id: song.id, fee: song.fee, st: song.gone ? -200 : 0, pl: song.gone ? 0 : 320000 });
  const playlistJson = (list: MockPlaylist) => ({
    id: list.id,
    name: list.name,
    coverImgUrl: `${base()}/cover/${list.id}.png`,
    picUrl: `${base()}/cover/${list.id}.png`,
    creator: { nickname: list.creator },
    trackCount: list.songs.length,
    playCount: 120_000 + list.id * 7,
    description: `${list.name}（演示数据）`,
    copywriter: list.note,
    updateFrequency: list.note,
  });
  const songById = (id: number) => songs.find((song) => song.id === id);

  let server!: http.Server;
  const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const loggedIn = (cookie: string) => cookie.includes(`MUSIC_U=${TOKEN}`);

  const routes: Record<string, (payload: Record<string, any>, cookie: string, respond: { cookies: string[] }) => unknown> = {
    "cloudsearch/get/web": (p) => {
      const word = String(p.s ?? "").toLowerCase();
      const offset = Number(p.offset ?? 0);
      const limit = Number(p.limit ?? 30);
      if (p.type === 1000) {
        const hits = playlists.filter((list) => !list.mine && list.name.toLowerCase().includes(word));
        return { code: 200, result: { playlists: hits.slice(offset, offset + limit).map(playlistJson), playlistCount: hits.length } };
      }
      const hits = songs.filter((song) => song.name.toLowerCase().includes(word) || song.artists.some((artist) => artist.toLowerCase().includes(word)));
      return { code: 200, result: { songs: hits.slice(offset, offset + limit).map(songJson), songCount: hits.length } };
    },
    "v6/playlist/detail": (p) => {
      const list = playlists.find((entry) => entry.id === Number(p.id));
      if (!list) return { code: 404 };
      const members = list.songs.map(songById).filter((song): song is MockSong => !!song);
      // Like the real service: the full list of ids, but only the first songs in full.
      return { code: 200, playlist: { ...playlistJson(list), trackIds: members.map((song) => ({ id: song.id })), tracks: members.slice(0, 4).map(songJson) }, privileges: members.slice(0, 4).map(privilegeJson) };
    },
    "v3/song/detail": (p) => {
      const wanted = (JSON.parse(String(p.c)) as { id: number }[]).map((entry) => songById(entry.id)).filter((song): song is MockSong => !!song);
      return { code: 200, songs: wanted.map(songJson), privileges: wanted.map(privilegeJson) };
    },
    "personalized/playlist": () => ({ code: 200, result: playlists.filter((list) => list.id >= 3001 && list.id < 3100).map(playlistJson) }),
    toplist: () => ({ code: 200, list: playlists.filter((list) => list.id > 10_000).map(playlistJson) }),
    "v1/discovery/recommend/songs": (_p, cookie) => (loggedIn(cookie) ? { code: 200, data: { dailySongs: songs.slice(2, 10).map(songJson) } } : { code: 301, message: "需要登录" }),
    "user/playlist": (_p, cookie) => (loggedIn(cookie) ? { code: 200, playlist: playlists.filter((list) => list.mine).map(playlistJson) } : { code: 301 }),
    "w/nuser/account/get": (_p, cookie) => (loggedIn(cookie) ? { code: 200, account: { id: 424242, vipType: 11 }, profile: { userId: 424242, nickname: "演示用户", avatarUrl: `${base()}/cover/424242.png` } } : { code: 200, account: null, profile: null }),
    "song/enhance/player/url/v1": (p, cookie) => {
      const id = Number(String(p.ids).replace(/[^\d]/g, ""));
      const song = songById(id);
      if (!song || song.gone) return { code: 200, data: [{ id, url: null, code: 404, freeTrialInfo: null }] };
      if (song.fee === 1 && !loggedIn(cookie)) return { code: 200, data: [{ id, url: `${base()}/audio/${id}.wav`, br: 128000, code: 200, freeTrialInfo: { start: 0, end: 30 } }] };
      if (song.outerOnly) return { code: 200, data: [{ id, url: null, code: 200, freeTrialInfo: null }] };
      return { code: 200, data: [{ id, url: `${base()}/audio/${id}.wav`, br: 320000, size: 1000, type: "wav", freeTrialInfo: null, level: p.level }] };
    },
    "song/lyric": (p) => {
      const song = songById(Number(p.id));
      if (!song) return { code: 200, nolyric: true };
      if (song.id === 1003) return { code: 200, lrc: { lyric: "没有时间轴的歌词\n第二行\n第三行" } };
      if (song.id === 1005) return { code: 200, nolyric: true };
      const { lrc, tlyric } = lrcFor(song);
      return { code: 200, lrc: { lyric: lrc }, tlyric: { lyric: tlyric } };
    },
    "login/qrcode/unikey": () => {
      const key = `mockkey-${++keyCounter}-${createHash("sha1").update(String(Date.now())).digest("hex").slice(0, 8)}`;
      logins.set(key, { state: "waiting", created: Date.now() });
      return { code: 200, unikey: key };
    },
    "login/qrcode/client/login": (p, _cookie, respond) => {
      const login = logins.get(String(p.key));
      if (!login) return { code: 800, message: "二维码不存在或已过期" };
      if (options.autoQr) {
        const age = Date.now() - login.created;
        if (age >= options.autoQr.confirmAfterMs) login.state = "confirmed";
        else if (age >= options.autoQr.scanAfterMs) login.state = "scanned";
      }
      if (login.state === "waiting") return { code: 801, message: "等待扫码" };
      if (login.state === "scanned") return { code: 802, message: "授权中" };
      respond.cookies.push(`MUSIC_U=${TOKEN}; Max-Age=15552000; Path=/; HttpOnly`, "__csrf=mockcsrf0123; Max-Age=15552000; Path=/");
      return { code: 803, message: "授权登录成功", cookie: `MUSIC_U=${TOKEN}; Max-Age=15552000; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Path=/;;__csrf=mockcsrf0123; Max-Age=15552000; Path=/` };
    },
    logout: (_p, _c, respond) => {
      respond.cookies.push("MUSIC_U=; Max-Age=0; Path=/", "__csrf=; Max-Age=0; Path=/");
      return { code: 200 };
    },
    "listen/together/status/get": (_p, cookie) => {
      if (!loggedIn(cookie)) return { code: 301, message: "需要登录" };
      return { code: 200, data: together ? { inRoom: true, ...togetherInfo() } : { inRoom: false } };
    },
  };

  // The production client prefers the current web-player route and falls
  // back to the historical one; both should exercise the same fixture.
  routes["cloudsearch/pc"] = routes["cloudsearch/get/web"];

  const audioCache = new Map<number, Buffer>();
  const wavOf = (id: number) => {
    let data = audioCache.get(id);
    if (!data) audioCache.set(id, (data = mockWav(id, audioSeconds)));
    return data;
  };

  server = http.createServer(async (req, res) => {
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    res.on("close", () => stats.active--);
    try {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      const url = new URL(req.url ?? "/", "http://mock");
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "range", "access-control-expose-headers": "content-range, accept-ranges, content-length" };
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors).end();
        return;
      }
      const audio = /^\/audio\/(\d+)\.(?:wav|mp3)$/.exec(url.pathname);
      if (audio) {
        const data = wavOf(Number(audio[1]));
        const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
        if (range) {
          const start = range[1] ? Number(range[1]) : 0;
          const end = Math.min(data.length - 1, range[2] ? Number(range[2]) : data.length - 1);
          res.writeHead(206, { ...cors, "content-type": "audio/wav", "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${data.length}`, "content-length": end - start + 1 });
          res.end(data.subarray(start, end + 1));
        } else {
          res.writeHead(200, { ...cors, "content-type": "audio/wav", "accept-ranges": "bytes", "content-length": data.length });
          res.end(data);
        }
        return;
      }
      const cover = /^\/cover\/(\d+)\.png$/.exec(url.pathname);
      if (cover) {
        res.writeHead(200, { ...cors, "content-type": "image/png" });
        res.end(mockCover(Number(cover[1])));
        return;
      }
      if (url.pathname === "/song/media/outer/url") {
        stats.outer++;
        const id = Number(/^(\d+)/.exec(url.searchParams.get("id") ?? "")?.[1]);
        const song = songById(id);
        if (song && !song.gone && song.fee === 0) res.writeHead(302, { location: `/audio/${id}.wav` }).end();
        else res.writeHead(302, { location: "/404" }).end();
        return;
      }
      if (req.method === "POST" && url.pathname.startsWith("/eapi/")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        let request: { url: string; data: any };
        try {
          request = eapiDecrypt(form.get("params") ?? "") as { url: string; data: any };
        } catch {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code: 400, message: "bad eapi envelope" }));
          return;
        }
        const route = request.url.replace(/^\/api\//, "");
        const data = request.data && typeof request.data === "object" ? request.data : {};
        if (route === "listen/together/room/create") {
          const roomId = String(Date.now()).slice(-10);
          together = { roomId, inviterId: 424242, users: [{ userId: 424242, nickname: "演示用户" }], songId: 1001, playStatus: "PAUSE", progress: 0, playlistIds: [1001, 1002, 1003] };
        } else if (route === "listen/together/play/invitation/accept") {
          const roomId = String(data.roomId ?? "");
          const inviterId = Number(data.inviterId ?? 424242);
          together = { roomId: roomId || String(Date.now()).slice(-10), inviterId, users: [{ userId: inviterId || 424242, nickname: "邀请人" }, { userId: 424243, nickname: "我" }], songId: 1001, playStatus: "PAUSE", progress: 0, playlistIds: [1001, 1002, 1003] };
        } else if (route === "listen/together/end/v2") {
          together = undefined;
        } else if (route === "listen/together/heartbeat" && together) {
          together.songId = Number(data.songId) || together.songId;
          together.playStatus = String(data.playStatus || together.playStatus);
          together.progress = Number(data.progress) || together.progress;
        } else if (route === "listen/together/play/command/report" && together) {
          try {
            const info = JSON.parse(String(data.commandInfo ?? "{}"));
            if (info.targetSongId > 0) together.songId = Number(info.targetSongId);
            if (info.playStatus) together.playStatus = String(info.playStatus);
            if (info.progress !== undefined) together.progress = Number(info.progress) || 0;
          } catch { /* ignore malformed demo command */ }
        } else if (route === "listen/together/room/check") {
          if (!together) {
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code: 404, message: "房间不存在" }));
            return;
          }
        } else if (route === "listen/together/sync/playlist/get") {
          if (!together) {
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code: 404, message: "房间不存在" }));
            return;
          }
        }
        const body = route === "listen/together/sync/playlist/get"
          ? { code: 200, data: { playlist: { displayList: { result: together?.playlistIds ?? [] } } } }
          : { code: 200, data: route === "listen/together/room/create" || route === "listen/together/play/invitation/accept" || route === "listen/together/room/check" ? togetherInfo() : {} };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
        return;
      }
      const match = /^\/weapi\/(.+)$/.exec(url.pathname);
      if (req.method === "POST" && match) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        let payload: Record<string, unknown>;
        try {
          payload = weapiDecrypt({ params: form.get("params") ?? "", encSecKey: form.get("encSecKey") ?? "" }, privateKey) as Record<string, unknown>;
        } catch {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code: 400, message: "bad envelope" }));
          return;
        }
        const cookie = String(req.headers.cookie ?? "");
        calls.push({ path: match[1], payload, cookie, referer: String(req.headers.referer ?? ""), userAgent: String(req.headers["user-agent"] ?? "") });
        const failure = failures.get(match[1]);
        if (failure) {
          failures.delete(match[1]);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code: failure.code, message: failure.message }));
          return;
        }
        const route = routes[match[1]];
        const respond = { cookies: [] as string[] };
        const body = route ? route(payload, cookie, respond) : { code: 404, message: "no such interface" };
        res.writeHead(200, { "content-type": "application/json", ...(respond.cookies.length ? { "set-cookie": respond.cookies } : {}) });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    publicKey,
    songs,
    playlists,
    calls,
    stats,
    scan: (key) => {
      const login = logins.get(key);
      if (login && login.state === "waiting") login.state = "scanned";
    },
    confirm: (key) => {
      const login = logins.get(key);
      if (login) login.state = "confirmed";
    },
    failNext: (path, code, message) => void failures.set(path, { code, message }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
