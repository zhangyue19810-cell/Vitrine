import type { SecretStore } from "../account/secrets";
import type { HttpClient } from "../net/http";
import { CookieJar, NeteaseClient, NeteaseError } from "./netease";
import type { MusicLevel, MusicLyrics, MusicPlaylist, MusicSong, MusicSource, MusicStatus, QrLogin, QrPoll, SearchResult } from "./types";

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
}
