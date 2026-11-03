// Bundles the desktop shell (main process + preload) into dist-electron/. The core is bundled into main.cjs.
import { build } from "esbuild";
import { rm } from "node:fs/promises";

await rm(new URL("../dist-electron", import.meta.url), { recursive: true, force: true });
const result = await build({
  entryPoints: { main: "electron/main.ts", preload: "electron/preload.ts" },
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // `ws` is only used by the development transport, which the desktop app does not include.
  external: ["electron", "bufferutil", "utf-8-validate"],
  legalComments: "none",
  logLevel: "info",
  metafile: true,
});
const outputs = Object.entries(result.metafile.outputs).map(([file, info]) => `${file} ${(info.bytes / 1024).toFixed(0)} kB`);
console.log(outputs.join("\n"));
