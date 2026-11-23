import { rpc, tryRpc } from "../api";
import { html, onAll } from "../dom";
import { openDialog, toast } from "../modal";
import type { MusicSong, MusicTogetherRoom, MusicTogetherStatus } from "../types";
import type { MusicPlayer, PlayerChange } from "./player";

/**
 * NetEase "一起听" (listen together) around the existing player.
 *
 * The room itself lives in NetEase's service. This small controller owns the
 * room id, keeps the room alive with heartbeats, reports local play/pause and
 * track changes, and follows a remote track change when another member changes
 * the shared queue. It deliberately does not create a second audio player.
 */

const POLL_MS = 4_500;
const HEARTBEAT_MS = 5_000;

export class ListenTogether {
  private room?: MusicTogetherRoom;
  private seq = 1;
  private pollTimer?: ReturnType<typeof setInterval>;
  private applyingRemote = false;
  private refreshing = false;
  private readonly off: () => void;

  constructor(
    private readonly player: MusicPlayer,
    private readonly onChange: () => void = () => {},
  ) {
    this.off = player.subscribe((change) => this.onPlayer(change));
  }

  get label() {
    return this.room ? "一起听中" : "一起听";
  }

  get active() {
    return Boolean(this.room);
  }

  get currentRoom() {
    return this.room;
  }

  /** Pick up a room that was left open in another session. */
  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const status = await tryRpc("music.togetherStatus");
      if (status) this.apply(status);
    } finally {
      this.refreshing = false;
    }
  }

  /** Open the room dashboard or the create/join form. */
  async openPanel() {
    const status = await tryRpc("music.togetherStatus");
    if (!status) return void toast("一起听暂时不可用：没有连接到网易云音乐", "error", 5000);
    this.apply(status);
    if (!status.loggedIn) return void toast("一起听需要先登录网易云音乐", "info", 4500);
    if (status.inRoom && status.room) return this.roomDialog(status.room);
    this.joinDialog();
  }

  dispose() {
    this.stopRoomTimers();
    this.off();
  }

  private apply(status: MusicTogetherStatus) {
    if (!status.loggedIn || !status.inRoom || !status.room) {
      this.room = undefined;
      this.stopRoomTimers();
      this.onChange();
      return;
    }
    const changed = this.room?.roomId !== status.room.roomId || this.room?.users.length !== status.room.users.length || this.room?.playing?.songId !== status.room.playing?.songId;
    this.room = status.room;
    this.startRoomTimers();
    if (changed) this.onChange();
    this.followRemote(status.room);
  }

  private startRoomTimers() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
  }

  private stopRoomTimers() {
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async poll() {
    if (!this.room) return this.stopRoomTimers();
    const status = await tryRpc("music.togetherStatus");
    if (!status) return;
    this.apply(status);
    if (!this.room) return;
    const state = this.player.state;
    if (!state.song) return;
    await tryRpc("music.togetherHeartbeat", {
      roomId: this.room.roomId,
      songId: state.song.id,
      playStatus: state.playing ? "PLAY" : "PAUSE",
      progress: Math.max(0, Math.round(state.positionMs)),
    });
  }

  private onPlayer(change: PlayerChange) {
    if (!this.room || this.applyingRemote) return;
    if (change !== "song" && change !== "play") return;
    const state = this.player.state;
    if (!state.song) return;
    const commandType = change === "song" ? "GOTO" : state.playing ? "PLAY" : "PAUSE";
    void tryRpc("music.togetherPlay", {
      roomId: this.room.roomId,
      commandType,
      progress: Math.max(0, Math.round(state.positionMs)),
      playStatus: change === "song" ? "PLAY" : state.playing ? "PLAY" : "PAUSE",
      formerSongId: state.song.id,
      targetSongId: state.song.id,
      clientSeq: this.seq++,
    });
  }

  /** A change made by another member is followed by the same local player. */
  private async followRemote(room: MusicTogetherRoom) {
    const playing = room.playing;
    if (!playing || !playing.songId || this.applyingRemote) return;
    const state = this.player.state;
    if (playing.songId !== state.song?.id) {
      const song = await tryRpc("music.song", { id: playing.songId });
      if (!song || this.applyingRemote) return;
      this.applyingRemote = true;
      this.player.playNow(song as MusicSong);
      window.setTimeout(() => {
        this.player.seekTo(Math.max(0, playing.progressMs));
        this.applyingRemote = false;
      }, 850);
      return;
    }
    if (playing.status === "PLAY" && !state.playing && !state.loading) this.player.toggle();
    else if (playing.status === "PAUSE" && state.playing) this.player.toggle();
    if (Math.abs(state.positionMs - playing.progressMs) > 5_000 && !state.loading) this.player.seekTo(playing.progressMs);
  }

  private joinDialog() {
    const body = document.createElement("div");
    body.className = "stack";
    body.innerHTML = html`
      <div class="notice"><div><b>一起听房间</b><div class="muted" style="margin-top:5px;line-height:1.7">创建后把「房间 ID」和「发起人 ID」发给朋友；对方两个都填上就能加入。房间里的换歌、播放和暂停会同步。</div></div></div>
      <label class="field">房间 ID<input class="input" data-room-input placeholder="例如 123456789" autocomplete="off" autofocus /></label>
      <label class="field">发起人 ID<input class="input" data-inviter-input placeholder="邀请人的网易云用户 ID" inputmode="numeric" autocomplete="off" /></label>`.value;
    const dialog = openDialog({
      eyebrow: "LISTEN TOGETHER",
      title: "一起听",
      size: "normal",
      body,
      cancelId: "close",
      buttons: [
        { id: "close", label: "关闭" },
        { id: "create", label: "创建房间", kind: "accent" },
        { id: "join", label: "加入房间", kind: "primary" },
      ],
      onButton: async (id) => {
        if (id === "close") return true;
        try {
          if (id === "create") {
            const status = await rpc("music.togetherCreate");
            this.apply(status);
            if (!status.room) {
              toast("房间已创建，但网易云还没有返回房间信息", "info", 5000);
              return true;
            }
            toast(`一起听房间已创建：${status.room.roomId}`, "ok", 5000);
            window.setTimeout(() => void this.openPanel(), 360);
            return true;
          }
          const roomId = body.querySelector<HTMLInputElement>("[data-room-input]")?.value.trim() ?? "";
          const inviterId = Number(body.querySelector<HTMLInputElement>("[data-inviter-input]")?.value.trim() ?? "");
          if (!roomId || !Number.isSafeInteger(inviterId) || inviterId <= 0) {
            toast("请填写房间 ID 和发起人 ID", "info", 3500);
            return false;
          }
          const status = await rpc("music.togetherAccept", { roomId, inviterId });
          this.apply(status);
          toast("已加入一起听房间", "ok", 3500);
          window.setTimeout(() => void this.openPanel(), 360);
          return true;
        } catch (error) {
          toast(`一起听失败：${(error as Error).message}`, "error", 6000);
          return false;
        }
      },
    });
    dialog.root.classList.add("listen-together-dialog");
  }

  private roomDialog(room: MusicTogetherRoom) {
    const body = document.createElement("div");
    body.className = "stack";
    const users = room.users.length ? room.users.map((user) => html`<div class="together-user"><span class="together-avatar">${user.nickname.slice(0, 1) || "♪"}</span><span>${user.nickname || `用户 ${user.userId}`}</span></div>`) : html`<div class="muted">等待朋友加入…</div>`;
    body.innerHTML = html`
      <div class="together-room">
        <div><div class="micro">ROOM ID</div><div class="together-code">${room.roomId}</div></div>
        <div><div class="micro">发起人 ID</div><div class="together-code small">${room.inviterId || "—"}</div></div>
      </div>
      <div class="notice"><div><b>房间成员</b><div class="together-users">${users}</div></div></div>
      <div class="muted" style="font-size:12px;line-height:1.7">一起听会同步换歌、播放/暂停和进度。把房间 ID 与发起人 ID 发给朋友即可邀请。</div>
      <div class="toolbar"><button class="btn sm soft" data-together-copy>复制邀请信息</button></div>`.value;
    onAll(body, "click", "[data-together-copy]", async () => {
      try {
        await navigator.clipboard.writeText(`一起听房间 ${room.roomId}，发起人 ID ${room.inviterId}`);
        toast("邀请信息已复制", "ok", 2600);
      } catch {
        toast("浏览器不允许写入剪贴板", "error", 3200);
      }
    });
    openDialog({
      eyebrow: "LISTEN TOGETHER",
      title: "一起听中",
      size: "normal",
      body,
      cancelId: "close",
      buttons: [
        { id: "close", label: "关闭" },
        { id: "end", label: "结束房间", kind: "danger" },
      ],
      onButton: async (id) => {
        if (id !== "end") return true;
        try {
          await rpc("music.togetherEnd", { roomId: room.roomId });
          this.room = undefined;
          this.stopRoomTimers();
          this.onChange();
          toast("一起听房间已结束", "ok", 3000);
          return true;
        } catch (error) {
          toast(`结束房间失败：${(error as Error).message}`, "error", 5000);
          return false;
        }
      },
    }).root.classList.add("listen-together-dialog");
  }
}
