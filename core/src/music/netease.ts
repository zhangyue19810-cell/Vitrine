import type { HttpClient } from "../net/http";
import { Semaphore } from "../util/async";
import { WEAPI_PUBLIC_KEY, eapiForm, weapi } from "./crypto";
import { buildLyrics } from "./lrc";
import type { MusicAccount, MusicLevel, MusicLyrics, MusicPlaylist, MusicSong, MusicSource, QrLogin, SearchResult } from "./types";

/**
 * Client of the NetEase Cloud Music web interface.
 *
 * This is the unofficial interface that music.163.com itself uses; it can change or be limited at any time, and the
 * client treats every answer as untrusted JSON. What it does is what the website does for a visitor: search, playlists,
 * charts, lyrics, the address of a song's audio and the QR code login. It never tries to get at songs the account has
 * no right to play: a member-only song for a guest is a 30 second preview (reported as `trial`) or nothing at all.
 */

export class NeteaseError extends Error {
  readonly name = "NeteaseError";
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

const MESSAGES: Record<number, string> = {
  301: "需要先登录网易云音乐",
  400: "网易云音乐没有接受这个请求",
  404: "网易云音乐里没有找到这个内容",
  405: "请求太频繁，请稍后再试",
  [-460]: "网易云音乐拒绝了这次请求（风控），请稍后重试或换一个网络",
  [-462]: "网易云音乐要求先做安全验证，请在官方客户端或网页上完成验证后再试",
  8821: "网易云音乐要求先做安全验证，请在官方客户端或网页上完成验证后再试",
};

export function describeCode(code: number, message?: string): string {
  return MESSAGES[code] ?? `网易云音乐返回了错误 ${code}${message ? `：${message}` : ""}`;
}

/** The cookies of music.163.com. Only a name and a value are kept; attributes matter to browsers, not to us. */
export class CookieJar {
  private readonly values = new Map<string, string>();

  constructor(initial?: Record<string, string>) {
    for (const [name, value] of Object.entries(initial ?? {})) if (name && typeof value === "string") this.values.set(name, value);
  }

  get(name: string): string | undefined {
    return this.values.get(name);
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  clear(): void {
    this.values.clear();
  }

  /** "name=value" pairs for a Cookie header. */
  header(extra: Record<string, string> = {}): string {
    const merged = new Map(Object.entries(extra));
    for (const [name, value] of this.values) merged.set(name, value);
    return [...merged].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  /** Take in the Set-Cookie headers of a response. An empty value or an expiry in the past removes the cookie. Returns whether anything changed. */
  absorb(setCookie: string | string[] | undefined): boolean {
    if (!setCookie) return false;
    let changed = false;
    for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const parts = line.split(";").map((part) => part.trim());
      const eq = parts[0].indexOf("=");
      if (eq <= 0) continue;
      const name = parts[0].slice(0, eq);
      const value = parts[0].slice(eq + 1);
      const maxAge = parts.find((part) => /^max-age=/i.test(part));
      const expires = parts.find((part) => /^expires=/i.test(part));
      const expired = (maxAge && Number(maxAge.slice(8)) <= 0) || (expires && Date.parse(expires.slice(8)) < Date.now() - 1000);
      if (!value || expired) {
        changed = this.values.delete(name) || changed;
      } else if (this.values.get(name) !== value) {
        this.values.set(name, value);
        changed = true;
      }
    }
    return changed;
  }

  toRecord(): Record<string, string> {
    return Object.fromEntries(this.values);
  }
}

// ------------------------------------------------------------------------------------------------ normalising answers

type Json = Record<string, unknown>;
const rec = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

const NETEASE_HOST = /(^|\.)music\.(126\.net|163\.com)$/i;

/** https address of a cover, resized by the CDN so that it stays a small download. */
export function coverUrl(raw: string, size = 256): string {
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  if (NETEASE_HOST.test(url.hostname)) {
    url.protocol = "https:";
    if (/\.music\.126\.net$/i.test(url.hostname)) url.searchParams.set("param", `${size}y${size}`);
  }
  return url.toString();
}

/**
 * The address the interface may be given for playback: NetEase's own hosts (upgraded to https, the CDN answers on it) or
 * the very host the client talks to (the local stand-in of the tests and the demo). Anything else is dropped.
 */
export function playableUrl(raw: string, base: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (NETEASE_HOST.test(url.hostname)) {
    url.protocol = "https:";
    return url.toString();
  }
  return url.origin === new URL(base).origin ? url.toString() : undefined;
}

export function toSong(raw: unknown, privilege?: unknown): MusicSong | undefined {
  const song = rec(raw);
  const id = num(song.id);
  if (!id) return undefined;
  const album = rec(song.al ?? song.album);
  const priv = rec(privilege ?? song.privilege);
  const fee = num(priv.fee, num(song.fee));
  return {
    id,
    name: text(song.name),
    artists: arr(song.ar ?? song.artists)
      .map((artist) => text(rec(artist).name))
      .filter(Boolean),
    album: text(album.name),
    cover: coverUrl(text(album.picUrl) || text(song.picUrl)),
    durationMs: num(song.dt ?? song.duration),
    fee,
    unavailable: num(priv.st) < 0 || song.noCopyrightRcmd != null,
  };
}

export function toPlaylist(raw: unknown): MusicPlaylist | undefined {
  const list = rec(raw);
  const id = num(list.id);
  if (!id) return undefined;
  return {
    id,
    name: text(list.name),
    cover: coverUrl(text(list.coverImgUrl) || text(list.picUrl)),
    creator: text(rec(list.creator).nickname),
    trackCount: num(list.trackCount),
    playCount: num(list.playCount),
    description: text(list.description),
    note: text(list.copywriter) || text(list.updateFrequency),
  };
}

const songsOf = (items: unknown[], privileges?: Map<number, unknown>): MusicSong[] =>
  items.map((item) => toSong(item, privileges?.get(num(rec(item).id)))).filter((song): song is MusicSong => !!song);
const playlistsOf = (items: unknown[]): MusicPlaylist[] => items.map(toPlaylist).filter((list): list is MusicPlaylist => !!list);

// ------------------------------------------------------------------------------------------------ the client

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const MAX_BODY = 8 * 1024 * 1024;
const DETAIL_BATCH = 100;

export interface NeteaseClientOptions {
  http: Pick<HttpClient, "request">;
  cookies: CookieJar;
  /** Site root, `https://music.163.com` unless a test points it elsewhere. */
  base?: string;
  /** App-facing endpoint used by the listen-together room calls. */
  eapiBase?: string;
  /** RSA public key for the request envelope; tests pass their own. */
  publicKey?: string;
  /** Called after a response changed the cookies (so the service can store them). */
  onCookies?: () => void;
}

export class NeteaseClient {
  readonly base: string;
  readonly eapiBase: string;
  private readonly gate = new Semaphore(3);

  constructor(private readonly options: NeteaseClientOptions) {
    this.base = (options.base ?? "https://music.163.com").replace(/\/+$/, "");
    this.eapiBase = (options.eapiBase ?? "https://interfacepc.music.163.com").replace(/\/+$/, "");
  }

  get cookies(): CookieJar {
    return this.options.cookies;
  }

  /** One weapi call. `accept` lists answer codes besides 200 that are not errors. */
  async call(path: string, payload: Json, signal?: AbortSignal, accept: number[] = []): Promise<Json> {
    const jar = this.options.cookies;
    const csrf = jar.get("__csrf") ?? "";
    const form = weapi({ ...payload, csrf_token: csrf }, { publicKey: this.options.publicKey ?? WEAPI_PUBLIC_KEY });
    const release = await this.gate.acquire(signal);
    try {
      const response = await this.options.http.request(`${this.base}/weapi/${path}?csrf_token=${encodeURIComponent(csrf)}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          referer: `${this.base}/`,
          "user-agent": BROWSER_UA,
          cookie: jar.header({ __remember_me: "true", os: "pc", appver: "2.10.13" }),
        },
        body: new URLSearchParams({ params: form.params, encSecKey: form.encSecKey }).toString(),
        signal,
        timeoutMs: 15_000,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) {
          response.body.destroy();
          throw new NeteaseError("网易云音乐的回应太大了", 413);
        }
        chunks.push(chunk as Buffer);
      }
      if (jar.absorb(response.headers["set-cookie"])) this.options.onCookies?.();
      if (response.status < 200 || response.status >= 300) throw new NeteaseError(`网易云音乐返回了 HTTP ${response.status}`, response.status);
      let json: Json;
      try {
        json = rec(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        throw new NeteaseError("网易云音乐的回应不是有效的数据", 502);
      }
      const code = num(json.code, 200);
      if (code !== 200 && !accept.includes(code)) throw new NeteaseError(describeCode(code, text(json.message) || text(json.msg)), code);
      return json;
    } finally {
      release();
    }
  }

  /** App-facing eapi call, used by the listen-together room endpoints. */
  private async eapi(path: string, payload: Json, signal?: AbortSignal, accept: number[] = []): Promise<Json> {
    const jar = this.options.cookies;
    const csrf = jar.get("__csrf") ?? "";
    const header: Json = {
      osver: jar.get("osver") ?? "Microsoft-Windows-10-Professional-build-19045-64bit",
      deviceId: jar.get("deviceId") ?? "vitrine",
      os: "pc",
      appver: "3.1.17.204416",
      versioncode: "140",
      mobilename: "",
      buildver: String(Date.now()).slice(0, 10),
      resolution: "1920x1080",
      __csrf: csrf,
      channel: "netease",
      requestId: `${Date.now()}_${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`,
    };
    const musicU = jar.get("MUSIC_U");
    const musicA = jar.get("MUSIC_A");
    if (musicU) header.MUSIC_U = musicU;
    if (musicA) header.MUSIC_A = musicA;
    const form = eapiForm(path, { ...payload, header });
    const release = await this.gate.acquire(signal);
    try {
      const response = await this.options.http.request(`${this.eapiBase}/eapi/${path.replace(/^\/api\//, "")}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          referer: `${this.base}/`,
          "user-agent": BROWSER_UA,
          cookie: jar.header({ __remember_me: "true", os: "pc", appver: "3.1.17.204416" }),
        },
        body: new URLSearchParams({ params: form.params }).toString(),
        signal,
        timeoutMs: 15_000,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) {
          response.body.destroy();
          throw new NeteaseError("网易云音乐的回应太大了", 413);
        }
        chunks.push(chunk as Buffer);
      }
      if (jar.absorb(response.headers["set-cookie"])) this.options.onCookies?.();
      if (response.status < 200 || response.status >= 300) throw new NeteaseError(`网易云音乐返回了 HTTP ${response.status}`, response.status);
      let json: Json;
      try {
        json = rec(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        throw new NeteaseError("网易云音乐的回应不是有效的数据", 502);
      }
      const code = num(json.code, 200);
      if (code !== 200 && !accept.includes(code)) throw new NeteaseError(describeCode(code, text(json.message) || text(json.msg)), code);
      return json;
    } finally {
      release();
    }
  }

  // -------------------------------------------------------------------------------------------- listen together

  /** The state of the account's current listen-together room. */
  async listenTogetherStatus(signal?: AbortSignal): Promise<Json> {
    return this.call("listen/together/status/get", {}, signal);
  }

  async listenTogetherCreate(signal?: AbortSignal): Promise<Json> {
    return this.eapi("/api/listen/together/room/create", { refer: "songplay_more" }, signal);
  }

  async listenTogetherAccept(roomId: string, inviterId: number, signal?: AbortSignal): Promise<Json> {
    return this.eapi("/api/listen/together/play/invitation/accept", { refer: "inbox_invite", roomId, inviterId }, signal);
  }

  async listenTogetherCheck(roomId: string, signal?: AbortSignal): Promise<Json> {
    return this.eapi("/api/listen/together/room/check", { roomId }, signal);
  }

  async listenTogetherEnd(roomId: string, signal?: AbortSignal): Promise<Json> {
    return this.eapi("/api/listen/together/end/v2", { roomId }, signal);
  }

  async listenTogetherHeartbeat(roomId: string, songId: number, playStatus: string, progress: number, signal?: AbortSignal): Promise<Json> {
    return this.eapi("/api/listen/together/heartbeat", { roomId, songId, playStatus, progress }, signal);
  }

  async listenTogetherPlay(
    roomId: string,
    command: { commandType: string; progress?: number; playStatus: string; formerSongId?: number; targetSongId?: number; clientSeq: number },
    signal?: AbortSignal,
  ): Promise<Json> {
    return this.eapi("/api/listen/together/play/command/report", {
      roomId,
      commandInfo: JSON.stringify({
        commandType: command.commandType,
        progress: command.progress ?? 0,
        playStatus: command.playStatus,
        formerSongId: command.formerSongId ?? -1,
        targetSongId: command.targetSongId ?? -1,
        clientSeq: command.clientSeq,
      }),
    }, signal);
  }

  async listenTogetherPlaylist(roomId: string, signal?: AbortSignal): Promise<Json> {
    return this.eapi("/api/listen/together/sync/playlist/get", { roomId }, signal);
  }

  // -------------------------------------------------------------------------------------------- finding music

  async search(keywords: string, kind: "song", limit?: number, offset?: number, signal?: AbortSignal): Promise<SearchResult<MusicSong>>;
  async search(keywords: string, kind: "playlist", limit?: number, offset?: number, signal?: AbortSignal): Promise<SearchResult<MusicPlaylist>>;
  async search(keywords: string, kind: "song" | "playlist", limit = 30, offset = 0, signal?: AbortSignal): Promise<SearchResult<MusicSong> | SearchResult<MusicPlaylist>> {
    const data = rec((await this.call("cloudsearch/get/web", { s: keywords, type: kind === "song" ? 1 : 1000, limit, offset, total: true }, signal)).result);
    if (kind === "song") return { items: songsOf(arr(data.songs)), total: num(data.songCount) };
    return { items: playlistsOf(arr(data.playlists)), total: num(data.playlistCount) };
  }

  async songs(ids: number[], signal?: AbortSignal): Promise<MusicSong[]> {
    const out: MusicSong[] = [];
    for (let i = 0; i < ids.length; i += DETAIL_BATCH) {
      const batch = ids.slice(i, i + DETAIL_BATCH);
      const data = await this.call("v3/song/detail", { c: JSON.stringify(batch.map((id) => ({ id }))) }, signal);
      const privileges = new Map(arr(data.privileges).map((entry) => [num(rec(entry).id), entry] as const));
      out.push(...songsOf(arr(data.songs), privileges));
    }
    const order = new Map(ids.map((id, index) => [id, index] as const));
    return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  /** A playlist and its first `limit` songs in the playlist's order. */
  async playlist(id: number, limit = 300, signal?: AbortSignal): Promise<{ playlist: MusicPlaylist; songs: MusicSong[] }> {
    const data = await this.call("v6/playlist/detail", { id, n: 100_000, s: 8 }, signal);
    const raw = rec(data.playlist);
    const playlist = toPlaylist(raw);
    if (!playlist) throw new NeteaseError(describeCode(404), 404);
    const ids = arr(raw.trackIds)
      .map((entry) => num(rec(entry).id))
      .filter(Boolean);
    const privileges = new Map(arr(data.privileges).map((entry) => [num(rec(entry).id), entry] as const));
    const songs = songsOf(arr(raw.tracks), privileges);
    const have = new Set(songs.map((song) => song.id));
    const wanted = (ids.length ? ids : songs.map((song) => song.id)).slice(0, limit);
    const missing = wanted.filter((songId) => !have.has(songId));
    if (missing.length) songs.push(...(await this.songs(missing, signal)));
    const order = new Map(wanted.map((songId, index) => [songId, index] as const));
    return {
      playlist,
      songs: songs.filter((song) => order.has(song.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!),
    };
  }

  async recommendedPlaylists(limit = 30, signal?: AbortSignal): Promise<MusicPlaylist[]> {
    return playlistsOf(arr((await this.call("personalized/playlist", { limit, total: true, n: 1000 }, signal)).result));
  }

  async toplists(signal?: AbortSignal): Promise<MusicPlaylist[]> {
    return playlistsOf(arr((await this.call("toplist", {}, signal)).list));
  }

  /** The songs picked for the logged-in account today. */
  async dailySongs(signal?: AbortSignal): Promise<MusicSong[]> {
    const data = rec((await this.call("v1/discovery/recommend/songs", { total: true }, signal)).data);
    return songsOf(arr(data.dailySongs));
  }

  async userPlaylists(uid: number, signal?: AbortSignal): Promise<MusicPlaylist[]> {
    return playlistsOf(arr((await this.call("user/playlist", { uid, limit: 100, offset: 0, includeVideo: true }, signal)).playlist));
  }

  // -------------------------------------------------------------------------------------------- one song

  /**
   * Where the audio of a song can be fetched. `undefined` when the account cannot play it. A song the service offers
   * only as a preview is returned with `trial: true` so the interface can say so instead of cutting off silently.
   */
  async source(id: number, level: MusicLevel = "exhigh", signal?: AbortSignal): Promise<MusicSource | undefined> {
    const data = await this.call("song/enhance/player/url/v1", { ids: `[${id}]`, level, encodeType: "flac" }, signal);
    const entry = rec(arr(data.data)[0]);
    const url = playableUrl(text(entry.url), this.base);
    if (url) return { url, bitrate: num(entry.br), trial: entry.freeTrialInfo != null };
    // No address, and no preview offered either: the song is not playable for this account, but the website's
    // outer chain player is allowed to try for songs that are free (it answers with a redirect or a 404 page).
    if (entry.freeTrialInfo != null) return undefined;
    return this.outerSource(id, signal);
  }

  /** The address the website's own "outer chain" player redirects to; it only exists for songs that are free to play. */
  private async outerSource(id: number, signal?: AbortSignal): Promise<MusicSource | undefined> {
    try {
      const response = await this.options.http.request(`${this.base}/song/media/outer/url?id=${id}.mp3`, {
        headers: { range: "bytes=0-0", referer: `${this.base}/`, "user-agent": BROWSER_UA },
        signal,
        timeoutMs: 10_000,
        maxRedirects: 4,
      });
      response.body.destroy();
      const url = playableUrl(response.url, this.base);
      if ((response.status === 200 || response.status === 206) && url && new URL(url).pathname !== "/song/media/outer/url") return { url, bitrate: 0, trial: false };
    } catch {
      /* no outer address either */
    }
    return undefined;
  }

  async lyrics(id: number, signal?: AbortSignal): Promise<MusicLyrics> {
    return buildLyrics((await this.call("song/lyric", { id, lv: -1, kv: -1, tv: -1 }, signal)) as Parameters<typeof buildLyrics>[0]);
  }

  // -------------------------------------------------------------------------------------------- the account

  /** The logged-in account, or `undefined` for a guest. */
  async account(signal?: AbortSignal): Promise<MusicAccount | undefined> {
    const data = await this.call("w/nuser/account/get", {}, signal);
    const account = rec(data.account);
    const profile = rec(data.profile);
    const id = num(profile.userId) || num(account.id);
    if (!id) return undefined;
    return { id, nickname: text(profile.nickname), avatar: coverUrl(text(profile.avatarUrl), 128), vipType: num(account.vipType) };
  }

  async qrStart(signal?: AbortSignal): Promise<QrLogin> {
    const key = text((await this.call("login/qrcode/unikey", { type: 1 }, signal)).unikey);
    if (!key) throw new NeteaseError("没能取得登录二维码", 502);
    return { key, url: `${this.base}/login?codekey=${key}` };
  }

  /** 800 expired, 801 waiting, 802 scanned and waiting for the phone to confirm, 803 logged in (cookies are now in the jar). */
  async qrCheck(key: string, signal?: AbortSignal): Promise<800 | 801 | 802 | 803> {
    const data = await this.call("login/qrcode/client/login", { key, type: 1 }, signal, [800, 801, 802, 803]);
    const code = num(data.code) as 800 | 801 | 802 | 803;
    if (code === 803) {
      // The answer repeats the cookies in its body; take them in case the headers were stripped on the way.
      if (this.options.cookies.absorb(text(data.cookie).split(/;\s*(?=[A-Za-z_]+=)/).filter((part) => !/^(path|domain|expires|max-age|secure|httponly|samesite)\b/i.test(part)))) this.options.onCookies?.();
    }
    return code;
  }

  async logout(signal?: AbortSignal): Promise<void> {
    try {
      await this.call("logout", {}, signal);
    } finally {
      this.options.cookies.clear();
      this.options.onCookies?.();
    }
  }
}
