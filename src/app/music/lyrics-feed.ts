import type { LyricLine, LyricsState } from "../../space/lyrics3d";
import type { MusicPlayer } from "./player";

/**
 * What the 3D lyrics are told every frame (see `space/lyrics3d.ts`): the lines of the song being played and how far the singer has got.
 *
 *  - Lyrics with time stamps are handed over as they are.
 *  - Lyrics without them are spread evenly over the song, so that they still move on with the music.
 *  - A song without lyrics (or an instrumental, or lyrics still on their way) shows its title and artists in the middle instead.
 *
 * The same object is returned every frame (nothing is allocated while the music plays); `lines` keeps its identity until the song or its
 * lyrics change, which is how the layer knows to lay them out again.
 */
export class LyricsFeed {
  private readonly state: LyricsState = { id: 0, lines: null, index: -1, positionMs: 0, title: "", subtitle: "" };
  private songId = Number.NaN;
  private counter = 0;
  /** The lines the player has, and the evenly spread copy of them made for `spreadFor` milliseconds of song. */
  private spreadOf: readonly LyricLine[] | null = null;
  private spreadFor = 0;
  private spread: LyricLine[] | null = null;

  constructor(private readonly player: MusicPlayer) {}

  /** The state for this frame; null while no song is loaded. */
  read(): LyricsState | null {
    const player = this.player.state;
    const song = player.song;
    if (!song) {
      this.songId = Number.NaN;
      return null;
    }
    const state = this.state;
    if (song.id !== this.songId) {
      this.songId = song.id;
      state.id = ++this.counter;
    }
    state.positionMs = player.positionMs;
    state.title = song.name;
    const artists = song.artists.join(" / ");
    const lyrics = player.lyrics;
    state.subtitle = lyrics?.instrumental ? (artists ? `${artists}  ·  纯音乐` : "纯音乐") : artists;
    state.lines = null;
    state.index = -1;
    if (!lyrics || lyrics.instrumental || lyrics.lines.length === 0) return state;
    if (lyrics.timed) {
      state.lines = lyrics.lines;
      state.index = player.lyricIndex;
      return state;
    }
    // No time stamps: the song's length divided by the number of lines.
    const duration = player.durationMs || song.durationMs;
    if (!(duration > 0)) return state;
    const lines = this.spreadLines(lyrics.lines, duration);
    state.lines = lines;
    state.index = Math.max(-1, Math.min(lines.length - 1, Math.floor((player.positionMs / duration) * lines.length)));
    return state;
  }

  private spreadLines(lines: readonly LyricLine[], duration: number): LyricLine[] {
    // The player's own length sharpens as the audio loads; a few seconds of difference are not worth laying the lines out again.
    if (this.spread && this.spreadOf === lines && Math.abs(this.spreadFor - duration) < 2000) return this.spread;
    this.spreadOf = lines;
    this.spreadFor = duration;
    this.spread = lines.map((line, i) => ({ ...line, t: (i * duration) / lines.length }));
    return this.spread;
  }
}
