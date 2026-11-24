import { assetUrl } from "../asset-url";
import { WORLD_SCENES, WORLD_SWITCH_MS } from "../worlds";

/**
 * The DOM fallback for the home carousel.
 *
 * WebGL gets the curved eight-panel carousel. If WebGL is unavailable (or the
 * stage has released the GPU for a running game) this version keeps the same
 * three-at-a-time composition in plain DOM: one complete card in the middle
 * and half cards at the sides, floating on the dark room rather than filling
 * the viewport with a wallpaper texture.
 */
export class WorldBackdrop {
  private readonly cards: [HTMLElement, HTMLElement, HTMLElement];
  private readonly layers: [HTMLElement, HTMLElement, HTMLElement];
  private readonly reduced = matchMedia("(prefers-reduced-motion: reduce)");
  private index = 0;
  private timer = 0;
  private swapTimer = 0;

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = `
      <div class="world-backdrop-stage">
        <div class="world-backdrop-card is-prev"><div class="world-backdrop-layer"></div></div>
        <div class="world-backdrop-card is-current"><div class="world-backdrop-layer"></div></div>
        <div class="world-backdrop-card is-next"><div class="world-backdrop-layer"></div></div>
      </div>`;
    this.cards = [...root.querySelectorAll<HTMLElement>(".world-backdrop-card")] as [HTMLElement, HTMLElement, HTMLElement];
    this.layers = [...root.querySelectorAll<HTMLElement>(".world-backdrop-layer")] as [HTMLElement, HTMLElement, HTMLElement];
    this.paint();
    this.timer = window.setInterval(() => this.advance(), WORLD_SWITCH_MS);
  }

  private paint() {
    const previous = (this.index + WORLD_SCENES.length - 1) % WORLD_SCENES.length;
    const next = (this.index + 1) % WORLD_SCENES.length;
    const scenes = [WORLD_SCENES[previous], WORLD_SCENES[this.index], WORLD_SCENES[next]];
    for (let i = 0; i < this.layers.length; i++) {
      this.layers[i].style.backgroundImage = `url("${assetUrl(scenes[i].src)}")`;
    }
  }

  private advance() {
    if (this.reduced.matches || this.root.closest(".reduce-motion")) return;
    if (this.swapTimer) return;
    this.root.classList.add("is-shifting");
    this.swapTimer = window.setTimeout(() => {
      this.index = (this.index + 1) % WORLD_SCENES.length;
      this.paint();
      this.root.classList.remove("is-shifting");
      this.swapTimer = 0;
    }, 300);
  }

  dispose() {
    window.clearInterval(this.timer);
    window.clearTimeout(this.swapTimer);
    this.root.replaceChildren();
  }
}
