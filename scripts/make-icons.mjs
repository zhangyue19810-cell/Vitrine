// Renders build/icon.svg into build/icon.png (512 px) and a multi-size build/icon.ico (PNG-compressed entries).
import { Resvg } from "@resvg/resvg-js";
import { readFile, writeFile } from "node:fs/promises";

const svg = await readFile(new URL("../build/icon.svg", import.meta.url));
const render = (size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const images = SIZES.map((size) => ({ size, data: Buffer.from(render(size)) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);
const entries = [];
let offset = 6 + 16 * images.length;
for (const { size, data } of images) {
  const entry = Buffer.alloc(16);
  entry[0] = size === 256 ? 0 : size;
  entry[1] = size === 256 ? 0 : size;
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(data.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += data.length;
}
await writeFile(new URL("../build/icon.ico", import.meta.url), Buffer.concat([header, ...entries, ...images.map((image) => image.data)]));
await writeFile(new URL("../build/icon.png", import.meta.url), Buffer.from(render(512)));
console.log(`icons: ${SIZES.join(", ")} px → build/icon.ico, build/icon.png`);
