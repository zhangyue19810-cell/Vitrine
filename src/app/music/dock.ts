import type { DiscAction, DiscSpec } from "../../control-rail";
import { EDGE, discReserve, discRowMargin, type PlateGroup, type PlateSpec } from "../../rail/model";
import type { RailBus } from "../rail-bus";
import type { SceneHost } from "../scene-host";
import type { MusicPlayer, PlayerChange } from "./player";
import { MODE_LABEL } from "./queue";

/**
 * The music dock: the disc in the top-right corner of the picture, under the navigation bar (it spins while a song plays; click its label to play or
 * pause, drag along its rim to seek, turn the wheel over it for the volume) and, once something is queued, a row of plates
 * beside it — what is playing and the line being sung, previous, next, and the play mode. All of it is drawn in 3D by the
 * control rail; this class only decides what goes on it and does what the presses mean.
 */

const PART = "dock";
/** How long the volume stays on the note after the wheel stopped. */
const VOLUME_NOTE_MS = 1400;

export interface DockNav {
  /** The disc was clicked while nothing is queued: open the music page. */
  open(): void;
}

export class MusicDock {
  private big = false;
  private visible = true;
  private discKey = "";
  private plateKey = "";
  private coverStamp = 0;
  private volumeUntil = 0;
  private readonly off: () => void;

  constructor(
    private readonly host: SceneHost,
    private readonly bus: RailBus,
    private readonly player: MusicPlayer,
    private readonly nav: DockNav,
    private readonly now: () => number = () => performance.now(),
  ) {
    bus.onDisc((action) => this.onDisc(action));
    bus.set(PART, [], { press: (id) => this.press(id) });
    this.off = player.subscribe((change) => this.onChange(change));
    this.refresh();
  }

  dispose() {
    this.off();
  }

  /** The big disc of the music page, or the small one of the other pages. */
  setBig(big: boolean) {
    if (this.big === big) return;
    this.big = big;
    this.refresh();
  }

  /** Hide or show the whole dock (a game is running, a sheet covers the picture). */
  setVisible(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    this.refresh();
  }

  /** Called every frame: the disc's progress and loudness change continuously, the plates only on events. */
  frame() {
    this.updateDisc();
    if (this.volumeUntil && this.now() > this.volumeUntil) {
      this.volumeUntil = 0;
      this.updatePlates();
    }
  }

  private onChange(change: PlayerChange) {
    if (change === "cover") this.coverStamp++;
    if (change === "volume") this.volumeUntil = this.now() + VOLUME_NOTE_MS;
    if (change === "lyric" || change === "song" || change === "play" || change === "mode" || change === "queue" || change === "error" || change === "loading" || change === "volume" || change === "lyrics") this.updatePlates();
    this.updateDisc();
  }

  private refresh() {
    this.discKey = "";
    this.plateKey = "";
    this.updateDisc();
    this.updatePlates();
  }

  private updateDisc() {
    if (!this.visible) {
      if (this.discKey !== "hidden") {
        this.discKey = "hidden";
        this.host.setDisc(null);
      }
      return;
    }
    const state = this.player.state;
    const progress = state.durationMs > 0 ? Math.min(1, state.positionMs / state.durationMs) : null;
    const key = [this.coverStamp, Boolean(state.song), state.playing, progress === null ? -1 : Math.round(progress * 720), Math.round(state.level * 50), this.big].join("|");
    if (key === this.discKey) return;
    this.discKey = key;
    const spec: DiscSpec = { cover: state.cover, empty: !state.song, playing: state.playing, progress, level: state.level, big: this.big };
    this.host.setDisc(spec);
  }

  private updatePlates() {
    const groups = this.visible ? this.groups() : [];
    const key = JSON.stringify(groups);
    if (key === this.plateKey) return;
    this.plateKey = key;
    this.bus.set(PART, groups);
  }

  private groups(): PlateGroup[] {
    const state = this.player.state;
    const song = state.song;
    if (!song) return [];
    let text = "";
    if (this.volumeUntil && this.now() < this.volumeUntil) text = `音量 ${Math.round(state.volume * 100)}%`;
    else if (state.error) text = state.error;
    else if (state.loading) text = "正在缓冲…";
    else if (state.trial) text = "仅试听片段（会员歌曲）";
    else text = state.lyrics?.lines[state.lyricIndex]?.text ?? "";
    const note: PlateSpec = { id: "note", kind: "note", label: song.name, value: song.artists.join(" / "), text, width: this.big ? 300 : 240, height: 56 };
    const plates: PlateSpec[] = [note, { id: "prev", kind: "tab", label: "上一首", width: 62 }, { id: "next", kind: "tab", label: "下一首", width: 62 }, { id: "mode", kind: "tab", label: MODE_LABEL[state.mode], width: 88 }];
    return [{ id: "transport", dock: "top-right", offset: discReserve(this.big) - EDGE, margin: discRowMargin(this.big, 56), gap: 8, plates }];
  }

  private press(id: string) {
    if (id === "prev") this.player.prev();
    else if (id === "next") this.player.next();
    else if (id === "mode") this.player.cycleMode();
  }

  private onDisc(action: DiscAction) {
    const state = this.player.state;
    if (action.type === "toggle") {
      if (!state.song) this.nav.open();
      else this.player.toggle();
    } else if (action.type === "seek") {
      if (state.song) this.player.seekFraction(action.turn);
    } else {
      this.player.nudgeVolume(action.direction);
    }
  }
}
