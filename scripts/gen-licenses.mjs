// Collects the licence texts of everything that is bundled into the desktop app into THIRD-PARTY-LICENSES.txt:
// the npm packages esbuild inlines into dist-electron/main.cjs plus the ones Vite inlines into the interface.
// Run after `npm install` (it reads node_modules):   node scripts/gen-licenses.mjs
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Keep in step with the imports of core/ electron/ and src/ (NOTICE lists the same set). */
const PACKAGES = ["three", "@kitlangton/rolling-number", "yauzl", "yazl", "pend", "buffer-crc32", "smol-toml", "https-proxy-agent", "agent-base", "debug", "ms"];

const out = [
  "Vitrine 琉匣 — licences of bundled third-party packages",
  "",
  "Vitrine itself: LICENSE. RhineLabUI (the interface this project is derived from): MIT, see LICENSE.",
  "MiSans fonts: Xiaomi, see public/fonts/NOTICE.txt and MiSans-license.pdf. Electron / Chromium: LICENSE and LICENSES.chromium.html",
  "in the Windows package. The npm packages below are reproduced with the licence file they ship with.",
  "",
];

for (const name of PACKAGES) {
  const dir = join(root, "node_modules", name);
  if (!existsSync(dir)) throw new Error(`${name} is not installed — run npm install first`);
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  const file = (await readdir(dir)).find((entry) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(entry));
  if (!file) throw new Error(`${name}: no licence file found`);
  const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? pkg.homepage ?? "";
  out.push("=".repeat(100), `${pkg.name} ${pkg.version} — ${pkg.license}`, repository.replace(/^git\+/, "").replace(/\.git$/, ""), "-".repeat(100));
  out.push((await readFile(join(dir, file), "utf8")).trim(), "");
}

await writeFile(join(root, "THIRD-PARTY-LICENSES.txt"), `${out.join("\n")}\n`);
console.log(`THIRD-PARTY-LICENSES.txt: ${PACKAGES.length} packages`);
