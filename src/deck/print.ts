import * as THREE from "three";

/**
 * A plane's worth of 2D drawing: a canvas, the texture made of it, and a key that says what is on it, so that an object
 * asks for the same drawing every frame at no cost and a new one is printed only when its key changes. Sizes are logical
 * px; the canvas has `pixelRatio` times as many pixels.
 */
export class Print {
  readonly canvas = document.createElement("canvas");
  readonly texture: THREE.CanvasTexture;
  private key = "";

  constructor(
    readonly width: number,
    readonly height: number,
    private pixelRatio: number,
    mipmaps = false,
    anisotropy = 4,
  ) {
    this.resizeCanvas();
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = anisotropy;
    this.texture.generateMipmaps = mipmaps;
    this.texture.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
  }

  private resizeCanvas() {
    this.canvas.width = Math.max(1, Math.ceil(this.width * this.pixelRatio));
    this.canvas.height = Math.max(1, Math.ceil(this.height * this.pixelRatio));
  }

  /** Change the pixel ratio (the window moved to another screen); the next `paint` prints again. */
  setPixelRatio(pixelRatio: number) {
    if (pixelRatio === this.pixelRatio) return;
    this.pixelRatio = pixelRatio;
    this.resizeCanvas();
    this.key = "";
  }

  /** Print again at the next `paint`, whatever the key (fonts that arrived late). */
  invalidate() {
    this.key = "";
  }

  /** Draw with `draw(ctx, width, height)` in logical px unless `key` is what the canvas shows already. True when it drew. */
  paint(key: string, draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void): boolean {
    if (key === this.key) return false;
    this.key = key;
    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    ctx.save();
    draw(ctx, this.width, this.height);
    ctx.restore();
    this.texture.needsUpdate = true;
    return true;
  }

  dispose() {
    this.texture.dispose();
  }
}
