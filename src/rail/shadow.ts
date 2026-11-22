import * as THREE from "three";

/** A soft, rounded shadow: a blurred rounded rectangle on a transparent canvas (shared by the plates, the disc and the deck). */
export function softShadow(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.filter = "blur(10px)";
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.roundRect(26, 30, 76, 68, 18);
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A soft round shadow (blurred disc) for objects that stand on a plate. */
export function softDisc(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(128, 128, 40, 128, 128, 124);
  gradient.addColorStop(0, "rgba(0,0,0,0.9)");
  gradient.addColorStop(0.55, "rgba(0,0,0,0.5)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
