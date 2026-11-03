// Builds a portable Windows x64 package from this checkout — works from Linux, macOS or Windows:
//
//   node scripts/package-win.mjs [--no-build]
//
//   ELECTRON_ZIP=<path>      use this electron-v<ver>-win32-x64.zip instead of downloading it
//   ELECTRON_MIRROR=<url>    download mirror (default GitHub; in China e.g. https://npmmirror.com/mirrors/electron/)
//
// Result: release/Vitrine-<version>-win-x64.zip containing Vitrine/Vitrine.exe, resources/app.asar and the Electron runtime.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { copyFile, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import * as ResEdit from "resedit";
import yauzl from "yauzl";
import yazl from "yazl";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const electronVersion = String(pkg.devDependencies.electron).replace(/^[^\d]*/, "");
const skipBuild = process.argv.includes("--no-build");
const releaseDir = join(root, "release");
const stage = join(root, ".stage");
const appName = "Vitrine";
const outDir = join(stage, "pkg", appName);
const zipName = `${appName}-${pkg.version}-win-x64.zip`;

const log = (message) => console.log(`[package-win] ${message}`);

// ------------------------------------------------------------------------------------------------ helpers

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function extractZip(zipPath, dest) {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      zip.on("error", reject);
      zip.on("end", resolvePromise);
      zip.on("entry", (entry) => {
        const target = resolve(dest, entry.fileName);
        if (target !== resolve(dest) && !target.startsWith(resolve(dest) + sep)) return reject(new Error(`unsafe path in archive: ${entry.fileName}`));
        if (entry.fileName.endsWith("/")) return void mkdir(target, { recursive: true }).then(() => zip.readEntry(), reject);
        void mkdir(dirname(target), { recursive: true }).then(() => {
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return reject(streamError);
            pipeline(stream, createWriteStream(target)).then(() => zip.readEntry(), reject);
          });
        }, reject);
      });
      zip.readEntry();
    });
  });
}

async function electronZip() {
  if (process.env.ELECTRON_ZIP) return resolve(process.env.ELECTRON_ZIP);
  const file = `electron-v${electronVersion}-win32-x64.zip`;
  const cached = join(root, ".cache", "electron", file);
  if (existsSync(cached)) return cached;
  const mirror = (process.env.ELECTRON_MIRROR ?? "https://github.com/electron/electron/releases/download/").replace(/\/?$/, "/");
  const url = `${mirror}v${electronVersion}/${file}`;
  log(`downloading ${url}`);
  await mkdir(dirname(cached), { recursive: true });
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(`${cached}.part`));
  await rename(`${cached}.part`, cached);
  return cached;
}

async function sha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

// ------------------------------------------------------------------------------------------------ steps

if (!skipBuild) {
  log("building the interface and the desktop shell");
  run("npm", ["run", "build"]);
}
for (const required of ["dist/index.html", "dist-electron/main.cjs", "dist-electron/preload.cjs", "build/icon.png", "build/icon.ico"]) {
  if (!existsSync(join(root, required))) throw new Error(`missing ${required} — run without --no-build (and node scripts/make-icons.mjs)`);
}

await rm(stage, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// 1. the application, as an asar
const appSrc = join(stage, "app");
await mkdir(appSrc, { recursive: true });
await writeFile(
  join(appSrc, "package.json"),
  JSON.stringify({ name: "vitrine", productName: appName, version: pkg.version, description: pkg.description, main: "dist-electron/main.cjs", license: pkg.license, author: "Vitrine contributors" }, null, 2),
);
await cp(join(root, "dist"), join(appSrc, "dist"), { recursive: true, filter: (source) => !source.endsWith(".map") });
await cp(join(root, "dist-electron"), join(appSrc, "dist-electron"), { recursive: true });
await mkdir(join(appSrc, "build"), { recursive: true });
await copyFile(join(root, "build", "icon.png"), join(appSrc, "build", "icon.png"));

log(`unpacking Electron ${electronVersion}`);
await extractZip(await electronZip(), outDir);
await rename(join(outDir, "electron.exe"), join(outDir, `${appName}.exe`));
await rm(join(outDir, "resources", "default_app.asar"), { force: true });

const asar = await import("@electron/asar");
await (asar.createPackage ?? asar.default.createPackage)(appSrc, join(outDir, "resources", "app.asar"));
await copyFile(join(root, "build", "icon.png"), join(outDir, "resources", "icon.png"));

// 2. slim the runtime: keep the languages the interface can use
for (const file of await readdir(join(outDir, "locales"))) if (!["en-US.pak", "zh-CN.pak", "zh-TW.pak"].includes(file)) await rm(join(outDir, "locales", file));

// 3. executable: icon and version resources
log("patching Vitrine.exe (icon, version info)");
{
  const exePath = join(outDir, `${appName}.exe`);
  const exe = ResEdit.NtExecutable.from(await readFile(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const iconFile = ResEdit.Data.IconFile.from(await readFile(join(root, "build", "icon.ico")));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (!groups.length) throw new Error("Electron's exe has no icon group to replace");
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groups[0].id, groups[0].lang, iconFile.icons.map((item) => item.data));
  const [info] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const [major = 0, minor = 0, patch = 0] = pkg.version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (const language of info.getAllLanguagesForStringValues()) {
    info.setStringValues(language, {
      FileDescription: "Vitrine 琉匣 — Minecraft 启动器",
      ProductName: "Vitrine 琉匣",
      CompanyName: "Vitrine",
      LegalCopyright: "MIT License",
      OriginalFilename: `${appName}.exe`,
      InternalName: appName,
      FileVersion: pkg.version,
      ProductVersion: pkg.version,
    });
    info.setFileVersion(major, minor, patch, 0, language.lang);
    info.setProductVersion(major, minor, patch, 0, language.lang);
  }
  info.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  await writeFile(exePath, Buffer.from(exe.generate()));
}

// 4. documents — plain text gets CRLF line endings and a BOM, so Notepad shows the Chinese text correctly
const windowsText = async (from, to) => writeFile(join(outDir, to), `﻿${(await readFile(from, "utf8")).replace(/^﻿/, "").replace(/\r?\n/g, "\r\n")}`);
await windowsText(join(root, "docs", "WINDOWS-README.txt"), "使用说明.txt");
await windowsText(join(root, "LICENSE"), "LICENSE.vitrine.txt");
await windowsText(join(root, "NOTICE"), "NOTICE.txt");
await windowsText(join(root, "THIRD-PARTY-LICENSES.txt"), "THIRD-PARTY-LICENSES.txt"); // node scripts/gen-licenses.mjs

// 5. zip it (deflate level 9)
await mkdir(releaseDir, { recursive: true });
const zipPath = join(releaseDir, zipName);
await rm(zipPath, { force: true });
log(`compressing → ${relative(root, zipPath)}`);
{
  const zip = new yazl.ZipFile();
  const files = (await walk(dirname(outDir))).sort();
  for (const file of files) {
    const name = relative(dirname(outDir), file).split(sep).join("/");
    zip.addFile(file, name, { compress: true, compressionLevel: 9, mode: name.endsWith(".exe") || name.endsWith(".dll") ? 0o100755 : 0o100644 });
  }
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(zipPath));
}
const size = (await stat(zipPath)).size;
const digest = await sha256(zipPath);
await writeFile(join(releaseDir, "SHA256SUMS.txt"), `${digest}  ${basename(zipPath)}\n`);
log(`done: ${basename(zipPath)} — ${(size / 1048576).toFixed(1)} MB, sha256 ${digest}`);
