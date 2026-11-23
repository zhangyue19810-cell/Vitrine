import type { StageItem } from "../../archive-stage";
import type { PlateGroup, PlateSpec } from "../../rail/model";
import { rpc, tryRpc } from "../api";
import { Latest } from "../dom";
import { formatCount } from "../format";
import { toast } from "../modal";
import type { RailBus } from "../rail-bus";
import type { SceneHost } from "../scene-host";
import type { MusicPlaylist, MusicSong, MusicStatus } from "../types";
import { musicFontSample, type LoginPayload, type MusicPayload, type PlaylistPayload, type SongPayload } from "./faces";
import { MusicHud } from "./hud";
import type { MusicPlayer, PlayerChange } from "./player";
import { encodeQr } from "./qr";
import { ListenTogether } from "./together";

/**
 * The music page: a black hole with its accretion disk in deep space (`setWorld("cosmos")`; see `space/disk.ts`). Playlists and
 * songs are the archives, and they stand on an arc that comes out from the right edge of the picture while the pointer is there
 * (the camera moves aside to make room); the lyrics of the song that plays are drawn in the middle of the scene
 * (`space/lyrics3d.ts`). The plates of the Möbius ring and of the row are the debris of the disk: the same plates fly out from
 * where they stand to the hole. Everything that would be a button is a plate of the control rail: where the list comes from
 * (recommended, charts, the daily songs, the player's own playlists), a search field, and "back" once a playlist is open. The
 * first archive of the recommended list logs in to NetEase Cloud Music with a QR code (it is asked for by clicking it).
 *
 *   tab "音乐" ──▶ the ring regroups into the row (blank archives while the first list is fetched), the world fades in
 *   a source plate / a search ──▶ the archives are pulled apart, new ones fly in
 *   a playlist opened ──▶ same, its songs; "back" returns to the list it came from
 */

const PART = "music";
const PAGE = 30;
const COVER_CONCURRENCY = 4;
const POLL_MS = 1800;

type Source = "recommended" | "toplists" | "daily" | "mine" | "search";
type Entry = { kind: "login" } | { kind: "playlist"; playlist: MusicPlaylist } | { kind: "song"; song: MusicSong };

const loginOf = (state: LoginPayload["state"], extra: Partial<Omit<LoginPayload, "kind" | "state">> = {}): LoginPayload => ({ kind: "login", state, qr: null, message: "", nickname: "", ...extra });

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

/** A short, stable number for a payload: when it changes, the face is printed again. */
function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

interface Saved {
  entries: Entry[];
  source: Source;
}

export class MusicView {
  private active = false;
  private source: Source = "recommended";
  private entries: Entry[] = [];
  /** The lists we came from (a playlist was opened from them). */
  private stack: Saved[] = [];
  private selected = 0;
  private status: MusicStatus = { loggedIn: false };
  private query = "";
  private searchKind: "song" | "playlist" = "song";
  private loading = false;
  private readonly token = new Latest();
  private readonly covers = new Map<string, CanvasImageSource | null>();
  private coverQueue: string[] = [];
  private coverBusy = 0;
  private revisions: number[] = [];
  private login: LoginPayload = loginOf("idle");
  private qrKey = "";
  private pollTimer?: ReturnType<typeof setTimeout>;
  private readonly off: () => void;
  /** The words over the picture (what is playing, the lyrics, the controls); absent when there is no element to put them in. */
  private readonly hud?: MusicHud;
  /** The shared room around the same player; it keeps running while another tab is up. */
  private readonly together: ListenTogether;

  constructor(
    private readonly host: SceneHost,
    private readonly bus: RailBus,
    private readonly player: MusicPlayer,
    hudParent?: HTMLElement,
  ) {
    bus.set(PART, [], {
      press: (id, cell) => this.press(id, cell),
      field: (id, text) => id === "search" && (this.query = text),
      submit: (id) => id === "search" && this.search(),
    });
    this.off = player.subscribe((change) => this.onPlayer(change));
    this.together = new ListenTogether(player, () => this.renderPlates());
    if (hudParent) this.hud = new MusicHud(hudParent, player, host);
  }

  dispose() {
    this.off();
    this.together.dispose();
    this.hud?.dispose();
    this.stopPolling();
  }

  /** Called every frame: the words over the picture follow the song. `seeking` is the place on the black hole's track that is being dragged to. */
  frame(seeking: number | null) {
    if (this.active) this.hud?.frame(seeking);
  }

  get isActive() {
    return this.active;
  }

  /** A playlist is open: "back" returns to the list it came from. */
  get canGoBack() {
    return this.stack.length > 0;
  }

  // ───────────────────────────────────────────── entering, leaving ─────────────────────────────────────────────

  /** Come from the home ring: the archives regroup into the row (blank ones while the first list is fetched). From the row of a download category (`fromRow`) the archives are pulled apart and new ones gather instead. */
  async enter(fromRow = false) {
    this.active = true;
    // The music page is deep space: the archives orbit a black hole and the plates of the ring become the debris of its disk.
    this.host.stage?.setWorld("cosmos");
    this.hud?.show(true);
    this.stack = [];
    this.selected = 0;
    this.entries = [];
    this.revisions = [];
    this.source = "recommended";
    this.renderPlates();
    if (!fromRow) this.host.showRow(this.placeholders(), 0);
    await this.refreshStatus();
    void this.together.refresh();
    await this.load("recommended", fromRow ? "swap" : "replace");
  }

  leave() {
    this.active = false;
    this.host.stage?.setWorld("none");
    this.hud?.show(false);
    this.token.next();
    this.stopPolling();
    this.coverQueue = [];
    this.loading = false;
    this.bus.clear(PART);
  }

  // ───────────────────────────────────────────── the lists ─────────────────────────────────────────────

  private async refreshStatus() {
    const status = await tryRpc("music.status");
    if (status) this.applyStatus(status);
  }

  private applyStatus(status: MusicStatus) {
    this.status = status;
    if (status.loggedIn) {
      this.login = loginOf("done", { nickname: status.account?.nickname ?? "" });
      void this.together.refresh();
    } else if (this.login.state === "done") this.login = loginOf("idle");
  }

  private placeholders(): StageItem[] {
    return Array.from({ length: 8 }, (_, index): StageItem => {
      const payload: PlaylistPayload = { kind: "playlist", title: "正在加载…", creator: "", count: "—", plays: "—", description: "", note: "", cover: null };
      return { key: `music-placeholder:${index}`, revision: 0, payload };
    });
  }

  private async load(source: Source, mode: "replace" | "swap", query = "") {
    if (!this.active) return;
    const mine = this.token.next();
    this.source = source;
    this.stack = [];
    this.loading = true;
    this.renderPlates();
    if (mode === "swap") this.host.swapRow(null);
    let entries: Entry[] = [];
    try {
      if (source === "recommended") entries = [{ kind: "login" }, ...(await rpc("music.recommended")).map((playlist): Entry => ({ kind: "playlist", playlist }))];
      else if (source === "toplists") entries = (await rpc("music.toplists")).map((playlist): Entry => ({ kind: "playlist", playlist }));
      else if (source === "mine") entries = (await rpc("music.mine")).map((playlist): Entry => ({ kind: "playlist", playlist }));
      else if (source === "daily") entries = (await rpc("music.daily")).map((song): Entry => ({ kind: "song", song }));
      else {
        const result = await rpc("music.search", { kind: this.searchKind, query, limit: PAGE });
        entries = this.searchKind === "song" ? (result.items as MusicSong[]).map((song): Entry => ({ kind: "song", song })) : (result.items as MusicPlaylist[]).map((playlist): Entry => ({ kind: "playlist", playlist }));
      }
    } catch (error) {
      if (!this.token.isCurrent(mine)) return;
      toast(`音乐：${(error as Error).message}`, "error", 7000);
      entries = source === "recommended" || source === "toplists" ? [{ kind: "login" }] : [];
    }
    if (!this.token.isCurrent(mine) || !this.active) return;
    this.loading = false;
    if (!entries.length) entries = [{ kind: "login" }];
    this.show(entries, mode);
    this.renderPlates();
  }

  private show(entries: Entry[], mode: "replace" | "swap") {
    this.entries = entries;
    this.selected = 0;
    const items = entries.map((entry, index) => this.itemOf(entry, index));
    this.revisions = items.map((item) => item.revision ?? 0);
    if (mode === "replace") this.host.replaceRow(items);
    else this.host.swapRow(items);
    void this.host.preloadFonts(musicFontSample(items.map((item) => item.payload as MusicPayload)));
    this.queueCovers();
  }

  /** The songs of the list on show, in order (what a press on a song puts in the player's queue). */
  private songs(): MusicSong[] {
    return this.entries.flatMap((entry) => (entry.kind === "song" ? [entry.song] : []));
  }

  // ───────────────────────────────────────────── archives ─────────────────────────────────────────────

  private itemOf(entry: Entry, index: number): StageItem {
    let payload: MusicPayload;
    let key: string;
    if (entry.kind === "login") {
      key = "music:login";
      payload = this.login;
    } else if (entry.kind === "playlist") {
      const playlist = entry.playlist;
      key = `playlist:${playlist.id}`;
      payload = { kind: "playlist", title: playlist.name, creator: playlist.creator, count: String(playlist.trackCount), plays: formatCount(playlist.playCount), description: playlist.description, note: playlist.note, cover: this.cover(playlist.cover) } satisfies PlaylistPayload;
    } else {
      const song = entry.song;
      const state = this.player.state;
      const current = state.song?.id === song.id;
      const lyrics = current && state.lyrics ? this.lyricsAround() : null;
      key = `song:${song.id}`;
      payload = {
        kind: "song",
        title: song.name,
        artists: song.artists.join(" / "),
        album: song.album,
        duration: clock(song.durationMs),
        number: index + 1,
        cover: this.cover(song.cover),
        badge: song.unavailable ? "无版权" : song.fee === 1 ? "会员" : "",
        playing: current,
        paused: current && !state.playing,
        lyrics,
        note: current ? (state.error || (state.trial ? "仅试听片段（会员歌曲）" : "")) : "",
      } satisfies SongPayload;
    }
    // The revision tells the stage to print the face again: it follows everything the face shows that can change.
    const revision = hash(
      JSON.stringify(payload, (name, value) => (name === "cover" || name === "avatar" ? (value === undefined ? 0 : value === null ? 1 : 2) : name === "qr" ? (value ? (value as boolean[][]).length : 0) : value)),
    );
    return { key, revision, payload };
  }

  private lyricsAround(): SongPayload["lyrics"] {
    const state = this.player.state;
    const lyrics = state.lyrics;
    if (!lyrics) return null;
    const lines = lyrics.lines;
    const at = lyrics.timed ? state.lyricIndex : 0;
    const text = (i: number) => (lines[i]?.text ?? "").trim();
    return {
      before: lyrics.timed ? [text(at - 2), text(at - 1)].filter(Boolean) : [],
      line: lyrics.timed ? text(at) : text(0),
      trans: lyrics.timed ? (lines[at]?.trans ?? "").trim() : "",
      after: [text(at + 1), text(at + 2)].filter(Boolean),
      timed: lyrics.timed,
      instrumental: lyrics.instrumental,
    };
  }

  /** The songs and the login card print again when the player, the login or a cover changed what they show. */
  private refreshItems() {
    if (!this.active) return;
    this.entries.forEach((entry, index) => {
      const item = this.itemOf(entry, index);
      if (item.revision === this.revisions[index]) return;
      this.revisions[index] = item.revision ?? 0;
      this.host.updateRow(index, item);
    });
  }

  private onPlayer(change: PlayerChange) {
    if (!this.active) return;
    if (change === "song" || change === "play" || change === "lyrics" || change === "lyric" || change === "error" || change === "loading" || change === "cover") this.refreshItems();
  }

  // ───────────────────────────────────────────── covers ─────────────────────────────────────────────

  /** undefined: not fetched yet (it will be), null: none to be had, or the decoded image. */
  private cover(url: string): CanvasImageSource | null | undefined {
    if (!url) return null;
    return this.covers.get(url);
  }

  private queueCovers() {
    for (const entry of this.entries) {
      const url = entry.kind === "song" ? entry.song.cover : entry.kind === "playlist" ? entry.playlist.cover : "";
      if (url && !this.covers.has(url) && !this.coverQueue.includes(url)) this.coverQueue.push(url);
    }
    this.pumpCovers();
  }

  private pumpCovers() {
    while (this.active && this.coverBusy < COVER_CONCURRENCY && this.coverQueue.length) {
      const url = this.coverQueue.shift()!;
      if (this.covers.has(url)) continue;
      this.coverBusy++;
      void this.fetchCover(url).then((image) => {
        this.coverBusy--;
        this.covers.set(url, image);
        this.refreshItems();
        this.pumpCovers();
      });
    }
  }

  /** Covers cannot be read into a texture from their own origin, so the core fetches them and hands back a data URL. */
  private async fetchCover(url: string): Promise<HTMLImageElement | null> {
    try {
      const data = await tryRpc("content.icon", { url });
      if (!data) return null;
      const image = new Image();
      image.src = data;
      await image.decode();
      return image;
    } catch {
      return null;
    }
  }

  // ───────────────────────────────────────────── what the stage reports ─────────────────────────────────────────────

  onSelect(index: number) {
    this.selected = index;
  }

  /** The selected archive was clicked again (or Enter): open the playlist, play the song, get the login code. */
  activate(index = this.selected) {
    const entry = this.entries[index];
    if (!entry) return;
    if (entry.kind === "playlist") void this.open(entry.playlist);
    else if (entry.kind === "song") this.playSong(entry.song);
    else if (this.login.state === "idle" || this.login.state === "expired" || this.login.state === "error") void this.startLogin();
  }

  /** A button printed on the pulled-out archive was clicked. */
  handleAction(id: string, index: number) {
    const entry = this.entries[index];
    if (!entry) return;
    if (entry.kind === "song") {
      if (id === "play") this.playSong(entry.song);
      else if (id === "next") {
        this.player.playNext(entry.song);
        toast(`“${entry.song.name}”会在当前歌曲之后播放`, "ok", 2600);
      }
    } else if (entry.kind === "playlist") {
      if (id === "open") void this.open(entry.playlist);
      else if (id === "playAll") void this.playAll(entry.playlist);
    } else if (id === "refresh") void this.startLogin();
    else if (id === "logout") void this.logout();
  }

  step(direction: number) {
    this.host.stage?.step(direction);
  }

  focusSearch() {
    this.bus.focusField(PART, "search");
  }

  private playSong(song: MusicSong) {
    const state = this.player.state;
    if (state.song?.id === song.id) return this.player.toggle();
    if (song.unavailable) return void toast("这首歌暂时没有版权，换一首吧", "info", 3200);
    const songs = this.songs();
    this.player.playList(songs, Math.max(0, songs.findIndex((entry) => entry.id === song.id)));
  }

  private async open(playlist: MusicPlaylist) {
    if (!this.active) return;
    const mine = this.token.next();
    this.stack.push({ entries: this.entries, source: this.source });
    this.loading = true;
    this.host.swapRow(null);
    this.renderPlates();
    try {
      const data = await rpc("music.playlist", { id: playlist.id });
      if (!this.token.isCurrent(mine) || !this.active) return;
      this.loading = false;
      this.show(data.songs.map((song): Entry => ({ kind: "song", song })), "swap");
    } catch (error) {
      if (!this.token.isCurrent(mine)) return;
      this.loading = false;
      toast(`打开歌单失败：${(error as Error).message}`, "error", 6000);
      this.back();
    }
    this.renderPlates();
  }

  private async playAll(playlist: MusicPlaylist) {
    try {
      const data = await rpc("music.playlist", { id: playlist.id });
      const songs = data.songs.filter((song) => !song.unavailable);
      if (!songs.length) return void toast("这个歌单里没有可以播放的歌曲", "info", 3200);
      this.player.playList(songs, 0);
    } catch (error) {
      toast(`播放失败：${(error as Error).message}`, "error", 6000);
    }
  }

  /** Back from an opened playlist to the list it was opened from. */
  back() {
    const saved = this.stack.pop();
    if (!saved) return;
    this.token.next();
    this.loading = false;
    this.source = saved.source;
    this.host.swapRow(null);
    this.show(saved.entries, "swap");
    this.renderPlates();
  }

  // ───────────────────────────────────────────── logging in ─────────────────────────────────────────────

  private async startLogin() {
    this.stopPolling();
    this.setLogin(loginOf("loading"));
    try {
      const qr = await rpc("music.qrStart");
      this.qrKey = qr.key;
      this.setLogin(loginOf("waiting", { qr: encodeQr(qr.url).modules }));
      this.schedulePoll();
    } catch (error) {
      this.setLogin(loginOf("error", { message: (error as Error).message }));
    }
  }

  private schedulePoll() {
    this.stopPolling();
    const key = this.qrKey;
    this.pollTimer = setTimeout(async () => {
      if (!this.active || key !== this.qrKey) return;
      const result = await tryRpc("music.qrPoll", { key });
      if (!this.active || key !== this.qrKey) return;
      if (!result) return this.schedulePoll();
      if (result.state === "done") {
        if (result.status) this.applyStatus(result.status);
        this.setLogin(loginOf("done", { nickname: result.status?.account?.nickname ?? this.login.nickname }));
        toast(`已登录网易云音乐${this.login.nickname ? `：${this.login.nickname}` : ""}`, "ok", 4000);
        this.renderPlates();
        return;
      }
      if (result.state === "expired") return this.setLogin({ ...this.login, state: "expired", qr: null, message: "" });
      if (result.state === "scanned") this.setLogin({ ...this.login, state: "scanned", message: "" });
      this.schedulePoll();
    }, POLL_MS);
  }

  private stopPolling() {
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private setLogin(login: LoginPayload) {
    this.login = login;
    this.refreshItems();
  }

  private async logout() {
    this.stopPolling();
    const status = await tryRpc("music.logout");
    this.applyStatus(status ?? { loggedIn: false });
    this.setLogin(loginOf("idle"));
    toast("已退出网易云音乐", "info", 3000);
    this.renderPlates();
  }

  // ───────────────────────────────────────────── the plates ─────────────────────────────────────────────

  private press(id: string, cell?: number) {
    if (id === "back") return this.back();
    if (id === "together") return void this.together.openPanel();
    if (id === "kind") {
      this.searchKind = cell === 1 ? "playlist" : "song";
      this.renderPlates();
      if (this.query.trim() && this.source === "search") this.search();
      return;
    }
    if (id === "recommended" || id === "toplists" || id === "daily" || id === "mine") {
      if ((id === "daily" || id === "mine") && !this.status.loggedIn) {
        toast("登录网易云音乐后才能用这个来源：点第一张“扫码登录”档案", "info", 4200);
        if (this.source !== "recommended" || this.stack.length) void this.load("recommended", "swap");
        return;
      }
      if (this.source === id && !this.stack.length) return;
      void this.load(id, "swap");
    }
  }

  private search() {
    const query = this.query.trim();
    if (!query) return;
    void this.load("search", "swap", query);
  }

  private renderPlates() {
    if (!this.active) return;
    const asks = !this.status.loggedIn;
    const here = (source: Source) => this.source === source && !this.stack.length;
    const plates: PlateSpec[] = [];
    if (this.stack.length) plates.push({ id: "back", kind: "tab", label: "‹ 返回", width: 78 });
    plates.push(
      { id: "recommended", kind: "tab", label: "推荐", active: here("recommended"), width: 70 },
      { id: "toplists", kind: "tab", label: "排行榜", active: here("toplists"), width: 88 },
      { id: "daily", kind: "tab", label: "每日推荐", value: asks ? "登录" : undefined, active: here("daily"), width: asks ? 136 : 100 },
      { id: "mine", kind: "tab", label: "我的歌单", value: asks ? "登录" : undefined, active: here("mine"), width: asks ? 136 : 100 },
      { id: "search", kind: "field", label: "搜索", text: this.query, placeholder: this.searchKind === "song" ? "搜索歌曲 / 歌手" : "搜索歌单", width: 230, focused: false },
      { id: "kind", kind: "segments", label: "", options: ["歌曲", "歌单"], selected: this.searchKind === "song" ? 0 : 1, width: 104 },
      { id: "together", kind: "tab", label: this.together.label, active: this.together.active, width: 88 },
    );
    const groups: PlateGroup[] = [{ id: "sources", dock: "bottom", margin: 52, gap: 8, plates }];
    this.bus.set(PART, groups);
  }
}
