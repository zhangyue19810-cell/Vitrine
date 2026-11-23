/** Plain data the music service hands to the interface. Everything is JSON, nothing refers back to the service. */

export interface MusicSong {
  id: number;
  name: string;
  artists: string[];
  album: string;
  /** https cover address (may be empty). The interface loads it through `content.icon`. */
  cover: string;
  durationMs: number;
  /** NetEase's fee class: 0 free, 1 VIP, 4 bought album, 8 free in low quality. */
  fee: number;
  /** Taken off the shelf or without a licence in this region: playing it is pointless. */
  unavailable: boolean;
}

export interface MusicPlaylist {
  id: number;
  name: string;
  cover: string;
  creator: string;
  trackCount: number;
  playCount: number;
  description: string;
  /** The editorial line under a recommended playlist, or the update note of a chart. */
  note: string;
}

export interface MusicAccount {
  id: number;
  nickname: string;
  avatar: string;
  /** 0 not a member. */
  vipType: number;
}

export type MusicLevel = "standard" | "higher" | "exhigh";

export interface MusicStatus {
  loggedIn: boolean;
  account?: MusicAccount;
}

export interface MusicSource {
  url: string;
  /** Bit rate in bit/s as the service reports it (0 when unknown). */
  bitrate: number;
  /** True when the service offers only a short preview of the song (members' songs for a guest). */
  trial: boolean;
}

export interface LyricLine {
  /** Start in milliseconds. */
  t: number;
  text: string;
  trans?: string;
}

export interface MusicLyrics {
  lines: LyricLine[];
  /** False when the text carries no time stamps (the lines then all have `t` = −1). */
  timed: boolean;
  instrumental: boolean;
  hasTranslation: boolean;
}

export type QrState = "waiting" | "scanned" | "expired" | "done";

export interface QrLogin {
  key: string;
  /** What the QR code must encode. */
  url: string;
}

export interface QrPoll {
  state: QrState;
  /** Set once with the first poll that sees `done`. */
  status?: MusicStatus;
}

export interface SearchResult<T> {
  items: T[];
  total: number;
}

export interface MusicTogetherUser {
  userId: number;
  nickname: string;
  avatar?: string;
}

export interface MusicTogetherPlaying {
  songId: number;
  status: string;
  progressMs: number;
}

export interface MusicTogetherRoom {
  roomId: string;
  inviterId: number;
  users: MusicTogetherUser[];
  playing?: MusicTogetherPlaying;
  playlistIds: number[];
}

export interface MusicTogetherStatus {
  loggedIn: boolean;
  inRoom: boolean;
  room?: MusicTogetherRoom;
}
