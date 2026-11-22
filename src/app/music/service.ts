import { rpc, tryRpc } from "../api";
import { store } from "../store";
import { MusicPlayer, webAudioMeter, type AudioLike } from "./player";
import type { PlayMode } from "./queue";

/**
 * The page's one music player, made the first time it is needed (after the core's settings are known). It plays on while the
 * player browses, so it is not owned by any view; the views and the dock only look at its state.
 */

/** How long a volume or mode change waits before it is written to the settings (a wheel turn makes dozens). */
const SAVE_DELAY_MS = 700;

const storage = {
  getItem(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode: the queue is simply not remembered */
    }
  },
};

/** Covers come from the core as data URLs (the page may not read the pixels of images from other origins). */
async function decode(dataUrl: string): Promise<CanvasImageSource | null> {
  try {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    return image;
  } catch {
    return null;
  }
}

export function createMusicPlayer(): MusicPlayer {
  const audio = new Audio();
  audio.preload = "auto";
  let pending: { volume?: number; mode?: PlayMode } = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const music = store.settings.music;
  const player = new MusicPlayer({
    audio: audio as unknown as AudioLike,
    backend: {
      source: (id) => rpc("music.source", { id }),
      lyrics: (id) => rpc("music.lyrics", { id }),
      cover: async (url) => (await tryRpc("content.icon", { url })) ?? null,
    },
    meter: webAudioMeter,
    loadImage: decode,
    storage,
    persist: (patch) => {
      pending = { ...pending, ...patch };
      clearTimeout(timer);
      timer = setTimeout(() => {
        const music = pending;
        pending = {};
        void tryRpc("settings.update", { patch: { music } });
      }, SAVE_DELAY_MS);
    },
    initial: { volume: music.volume, mode: music.mode },
  });
  player.bindMediaKeys();
  return player;
}
