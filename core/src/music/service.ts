import type { SecretStore } from "../account/secrets";
import type { HttpClient } from "../net/http";
import { CookieJar, NeteaseClient, NeteaseError } from "./netease";
import type { MusicLevel, MusicLyrics, MusicPlaylist, MusicSong, MusicSource, MusicStatus, MusicTogetherRoom, MusicTogetherStatus, QrLogin, QrPoll, SearchResult } from "./types";

/**
 * What the interface talks to: the NetEase client plus the things a client should not have to know about, namely
 * where the login cookies are kept (the OS keychain through the secret store), how long answers may be reused, and
 * that two views asking for the same list at the same moment make one request.
 */

const COOKIE_KEY = "music.netease.cookies";
const MINUTE = 60_000;

export interface MusicServiceOptions {
  http: Pick<HttpClient, "request">;
  secrets: SecretStore;
  /** Sound quality to ask for (read on every call, so a settings change applies at once). */
  level: () => MusicLevel;
  base?: string;
  eapiBase?: string;
  publicKey?: string;
  now?: () => number;
}

interface Entry {
  at: number;
  value: unknown;
}

export class MusicService {
  private readonly jar = new CookieJar();
  private readonly client: NeteaseClient;
  private readonly now: () => number;
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private loaded?: Promise<void>;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly options: MusicServiceOptions) {
    this.now = options.now ?? Date.now;
    this.client = new NeteaseClient({
      http: options.http,
      cookies: this.jar,
      base: options.base,
      eapiBase: options.eapiBase,
      publicKey: options.publicKey,
      onCookies: () => this.persist(),
    });
  }

  /** Cookies are read from the secret store once, before the first request. */
  private ready(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const stored = await this.options.secrets.get(COOKIE_KEY);
        if (!stored) return;
        const parsed = JSON.parse(stored) as unknown;
        if (parsed && typeof parsed === "object") for (const [name, value] of Object.entries(parsed)) if (typeof value === "string") this.jar.absorb(`${name}=${value}`);
      } catch {
        /* a damaged cookie file means being logged out */
      }
    })();
    return this.loaded;
  }

  private persist(): void {
    const record = this.jar.toRecord();
    this.saving = this.saving
      .then(() => (Object.keys(record).length ? this.options.secrets.set(COOKIE_KEY, JSON.stringify(record)) : this.options.secrets.delete(COOKIE_KEY)))
      .catch(() => {});
  }

  /** Reuse an answer for `ttl` ms; concurrent callers share one request. */
  private async cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    await this.ready();
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < ttl) return hit.value as T;
    const running = this.pending.get(key);
    if (running) return running as Promise<T>;
    const promise = load()
      .then((value) => {
        this.cache.set(key, { at: this.now(), value });
        if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value as string);
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  private forget(): void {
    this.cache.clear();
  }

  // -------------------------------------------------------------------------------------------- account

  async status(signal?: AbortSignal, fresh = false): Promise<MusicStatus> {
    await this.ready();
    if (!this.jar.has("MUSIC_U")) return { loggedIn: false };
    if (fresh) this.cache.delete("account");
    try {
      const account = await this.cached("account", 10 * MINUTE, () => this.client.account(signal));
      return account ? { loggedIn: true, account } : { loggedIn: false };
    } catch (error) {
      // The cookie is probably still fine and the network is not; say "logged in" without a name rather than log out.
      if (error instanceof NeteaseError && error.code === 301) return { loggedIn: false };
      return { loggedIn: true };
    }
  }

  async qrStart(signal?: AbortSignal): Promise<QrLogin> {
    await this.ready();
    return this.client.qrStart(signal);
  }

  async qrPoll(key: string, signal?: AbortSignal): Promise<QrPoll> {
    await this.ready();
    const code = await this.client.qrCheck(key, signal);
    if (code === 803) {
      this.forget();
      await this.saving; // the login must be on disk before the interface is told about it
      return { state: "done", status: await this.status(signal, true) };
    }
    return { state: code === 800 ? "expired" : code === 802 ? "scanned" : "waiting" };
  }

  async logout(signal?: AbortSignal): Promise<MusicStatus> {
    await this.ready();
    try {
      await this.client.logout(signal);
    } catch {
      /* the cookies are gone locally either way */
    }
    await this.saving;
    this.forget();
    return { loggedIn: false };
  }

  // -------------------------------------------------------------------------------------------- lists

  search(keywords: string, kind: "song", limit?: number, offset?: number, signal?: AbortSignal): Promise<SearchResult<MusicSong>>;
  search(keywords: string, kind: "playlist", limit?: number, offset?: number, signal?: AbortSignal): Promise<SearchResult<MusicPlaylist>>;
  search(keywords: string, kind: "song" | "playlist", limit = 30, offset = 0, signal?: AbortSignal): Promise<SearchResult<MusicSong> | SearchResult<MusicPlaylist>> {
    const word = keywords.trim();
    if (!word) return Promise.resolve({ items: [], total: 0 });
    return this.cached<SearchResult<MusicSong> | SearchResult<MusicPlaylist>>(`search:${kind}:${limit}:${offset}:${word}`, 5 * MINUTE, () => (kind === "song" ? this.client.search(word, "song", limit, offset, signal) : this.client.search(word, "playlist", limit, offset, signal)));
  }

  playlist(id: number, signal?: AbortSignal): Promise<{ playlist: MusicPlaylist; songs: MusicSong[] }> {
    return this.cached(`playlist:${id}`, 10 * MINUTE, () => this.client.playlist(id, 300, signal));
  }

  recommendedPlaylists(signal?: AbortSignal): Promise<MusicPlaylist[]> {
    return this.cached("recommended", 30 * MINUTE, () => this.client.recommendedPlaylists(30, signal));
  }

  toplists(signal?: AbortSignal): Promise<MusicPlaylist[]> {
    return this.cached("toplists", 30 * MINUTE, () => this.client.toplists(signal));
  }

  async dailySongs(signal?: AbortSignal): Promise<MusicSong[]> {
    const status = await this.status(signal);
    if (!status.loggedIn) throw new NeteaseError("每日推荐需要先登录网易云音乐", 301);
    return this.cached("daily", 60 * MINUTE, () => this.client.dailySongs(signal));
  }

  async myPlaylists(signal?: AbortSignal): Promise<MusicPlaylist[]> {
    const status = await this.status(signal);
    if (!status.account) throw new NeteaseError("需要先登录网易云音乐", 301);
    const uid = status.account.id;
    return this.cached(`mine:${uid}`, 10 * MINUTE, () => this.client.userPlaylists(uid, signal));
  }

  // -------------------------------------------------------------------------------------------- one song

  /** The audio address is never reused: the addresses expire after a while. */
  async source(id: number, signal?: AbortSignal): Promise<MusicSource | undefined> {
    await this.ready();
    return this.client.source(id, this.options.level(), signal);
  }

  lyrics(id: number, signal?: AbortSignal): Promise<MusicLyrics> {
    return this.cached(`lyrics:${id}`, 6 * 60 * MINUTE, () => this.client.lyrics(id, signal));
  }

  /** One song's metadata, used when a listen-together room changes the current track. */
  async song(id: number, signal?: AbortSignal): Promise<MusicSong | undefined> {
    return this.cached(`song:${id}`, 10 * MINUTE, async () => (await this.client.songs([id], signal))[0]);
  }

  // -------------------------------------------------------------------------------------------- listen together

  private togetherRoom(data: unknown): MusicTogetherRoom | undefined {
    const root = data && typeof data === "object" ? data as Record<string, unknown> : {};
    const info = root.roomInfo && typeof root.roomInfo === "object" ? root.roomInfo as Record<string, unknown> : root;
    const rawId = info.roomId ?? root.roomId;
    const roomId = rawId === undefined || rawId === null ? "" : String(rawId);
    if (!roomId) return undefined;
    const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
    const users = Array.isArray(info.roomUsers)
      ? info.roomUsers.map((entry) => {
          const user = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
          return { userId: number(user.userId ?? user.id), nickname: String(user.nickname ?? user.name ?? ""), avatar: typeof user.avatarUrl === "string" ? user.avatarUrl : undefined };
        }).filter((user) => user.userId > 0)
      : [];
    const playingRaw = root.playingInfo && typeof root.playingInfo === "object" ? root.playingInfo as Record<string, unknown> : {};
    const playlist = root.playlistInfo && typeof root.playlistInfo === "object" ? root.playlistInfo as Record<string, unknown> : {};
    const playlistIds = Array.isArray((playlist.displayList as Record<string, unknown> | undefined)?.result)
      ? ((playlist.displayList as Record<string, unknown>).result as unknown[]).map(number).filter(Boolean)
      : [];
    return {
      roomId,
      inviterId: number(info.inviterId ?? root.inviterId),
      users,
      playlistIds,
      playing: {
        songId: number(playingRaw.trackId ?? playingRaw.songId),
        status: String(playingRaw.status ?? playingRaw.playStatus ?? ""),
        progressMs: number(playingRaw.progress),
      },
    };
  }

  async togetherStatus(signal?: AbortSignal): Promise<MusicTogetherStatus> {
    await this.ready();
    const account = await this.status(signal);
    if (!account.loggedIn) return { loggedIn: false, inRoom: false };
    try {
      const data = (await this.client.listenTogetherStatus(signal)).data;
      const root = data && typeof data === "object" ? data as Record<string, unknown> : {};
      if (!root.inRoom) return { loggedIn: true, inRoom: false };
      return { loggedIn: true, inRoom: true, room: this.togetherRoom(root) };
    } catch (error) {
      if (error instanceof NeteaseError && error.code === 301) return { loggedIn: false, inRoom: false };
      throw error;
    }
  }

  async togetherCreate(signal?: AbortSignal): Promise<MusicTogetherStatus> {
    const status = await this.status(signal);
    if (!status.loggedIn) throw new NeteaseError("一起听需要先登录网易云音乐", 301);
    const created = (await this.client.listenTogetherCreate(signal)).data;
    const room = this.togetherRoom(created);
    if (room) return { loggedIn: true, inRoom: true, room };
    return this.togetherStatus(signal);
  }

  async togetherAccept(roomId: string, inviterId: number, signal?: AbortSignal): Promise<MusicTogetherStatus> {
    const status = await this.status(signal);
    if (!status.loggedIn) throw new NeteaseError("一起听需要先登录网易云音乐", 301);
    await this.client.listenTogetherAccept(roomId, inviterId, signal);
    return this.togetherStatus(signal);
  }

  async togetherEnd(roomId: string, signal?: AbortSignal): Promise<MusicTogetherStatus> {
    await this.client.listenTogetherEnd(roomId, signal);
    return { loggedIn: true, inRoom: false };
  }

  async togetherHeartbeat(roomId: string, songId: number, playStatus: string, progress: number, signal?: AbortSignal): Promise<boolean> {
    await this.client.listenTogetherHeartbeat(roomId, songId, playStatus, progress, signal);
    return true;
  }

  async togetherPlay(roomId: string, command: { commandType: string; progress?: number; playStatus: string; formerSongId?: number; targetSongId?: number; clientSeq: number }, signal?: AbortSignal): Promise<boolean> {
    await this.client.listenTogetherPlay(roomId, command, signal);
    return true;
  }

  async togetherPlaylist(roomId: string, signal?: AbortSignal): Promise<number[]> {
    const data = (await this.client.listenTogetherPlaylist(roomId, signal)).data;
    const room = this.togetherRoom(data);
    return room?.playlistIds ?? [];
  }
}
