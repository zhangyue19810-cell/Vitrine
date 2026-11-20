// Build a Windows NSIS setup executable from the portable app produced by package-win.mjs.
//
//   node scripts/package-win.mjs --no-build
//   node scripts/package-win-setup.mjs
//
// Requires makensis (NSIS) on PATH. The flat staging directory avoids an
// NSIS-on-Linux bug where File commands with absolute/subdirectory source paths
// crash the compiler; all source files are copied to a flat directory first.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = String(pkg.version);
const stageApp = join(root, ".stage", "pkg", "Vitrine");
const flatDir = join(root, ".stage", "setup-flat");
const releaseDir = join(root, "release");
const setupPath = join(releaseDir, `Vitrine-${version}-win-x64-setup.exe`);
const zipPath = join(releaseDir, `Vitrine-${version}-win-x64.zip`);
const iconSource = join(root, "build", "icon.ico");
const makensis = process.platform === "win32" ? "makensis.exe" : "makensis";

for (const required of [join(stageApp, "Vitrine.exe"), join(stageApp, "resources", "app.asar"), join(stageApp, "LICENSE.vitrine.txt"), iconSource]) {
  if (!existsSync(required)) throw new Error(`missing ${required}; run npm run dist:win first`);
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

const sourceFiles = (await walk(stageApp)).sort();
await rm(flatDir, { recursive: true, force: true });
await mkdir(flatDir, { recursive: true });

const groups = new Map();
for (const [index, source] of sourceFiles.entries()) {
  const rel = relative(stageApp, source).split(sep).join("/");
  const flat = `source-${String(index).padStart(3, "0")}.bin`;
  await copyFile(source, join(flatDir, flat));
  const slash = rel.lastIndexOf("/");
  const destDir = slash >= 0 ? rel.slice(0, slash).split("/").join("\\") : "";
  const destName = slash >= 0 ? rel.slice(slash + 1) : rel;
  const list = groups.get(destDir) ?? [];
  list.push({ flat, destName });
  groups.set(destDir, list);
}
await copyFile(join(stageApp, "LICENSE.vitrine.txt"), join(flatDir, "license.txt"));
await copyFile(iconSource, join(flatDir, "app.ico"));

const fileLines = [];
for (const [destDir, files] of groups) {
  fileLines.push(`  SetOutPath "${destDir ? `$INSTDIR\\${destDir}` : "$INSTDIR"}"`);
  for (const file of files) fileLines.push(`  File "/oname=${file.destName}" "${file.flat}"`);
}

const nsi = `Unicode true
Name "Vitrine 琉匣"
OutFile "installer-output.exe"
InstallDir "$LOCALAPPDATA\\Programs\\Vitrine"
InstallDirRegKey HKCU "Software\\Vitrine" "InstallDir"
RequestExecutionLevel user
SetCompressor zlib
BrandingText "Vitrine 琉匣 ${version}"
ShowInstDetails show
ShowUninstDetails show
Icon "app.ico"
UninstallIcon "app.ico"
LicenseData "license.txt"
VIProductVersion "${version}.0"
VIAddVersionKey /LANG=2052 "ProductName" "Vitrine 琉匣"
VIAddVersionKey /LANG=2052 "ProductVersion" "${version}"
VIAddVersionKey /LANG=2052 "FileDescription" "Vitrine 琉匣 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${version}"
VIAddVersionKey /LANG=2052 "CompanyName" "Vitrine contributors"
VIAddVersionKey /LANG=2052 "LegalCopyright" "MIT License"
Page license
Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles
Section "Install"
${fileLines.join("\n")}
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
  WriteRegStr HKCU "Software\\Vitrine" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Vitrine" "DisplayName" "Vitrine 琉匣"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Vitrine" "DisplayVersion" "${version}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Vitrine" "Publisher" "Vitrine contributors"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Vitrine" "DisplayIcon" "$INSTDIR\\Vitrine.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Vitrine" "UninstallString" '"$INSTDIR\\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Vitrine" "NoModify" 1
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Vitrine" "NoRepair" 1
  CreateDirectory "$SMPROGRAMS\\Vitrine"
  CreateShortcut "$SMPROGRAMS\\Vitrine\\Vitrine.lnk" "$INSTDIR\\Vitrine.exe"
  CreateShortcut "$SMPROGRAMS\\Vitrine\\卸载 Vitrine.lnk" "$INSTDIR\\Uninstall.exe"
  CreateShortcut "$DESKTOP\\Vitrine.lnk" "$INSTDIR\\Vitrine.exe"
SectionEnd
Section "Uninstall"
  Delete "$DESKTOP\\Vitrine.lnk"
  Delete "$SMPROGRAMS\\Vitrine\\Vitrine.lnk"
  Delete "$SMPROGRAMS\\Vitrine\\卸载 Vitrine.lnk"
  RMDir "$SMPROGRAMS\\Vitrine"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Vitrine"
  DeleteRegKey HKCU "Software\\Vitrine"
SectionEnd
`;
await writeFile(join(flatDir, "installer.nsi"), nsi, "utf8");
console.log(`[package-win-setup] compiling ${sourceFiles.length} files with NSIS`);
execFileSync(makensis, ["-V2", "installer.nsi"], { cwd: flatDir, stdio: "inherit" });
const built = join(flatDir, "installer-output.exe");
const info = await stat(built);
if (!info.size) throw new Error("NSIS produced an empty setup executable");
await mkdir(releaseDir, { recursive: true });
await copyFile(built, setupPath);

const sha256 = async (file) => {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("end", resolvePromise).on("error", reject));
  return hash.digest("hex");
};
const setupHash = await sha256(setupPath);
const lines = [`${setupHash}  ${basename(setupPath)}`];
if (existsSync(zipPath)) lines.push(`${await sha256(zipPath)}  ${basename(zipPath)}`);
await writeFile(join(releaseDir, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
console.log(`[package-win-setup] done: ${(info.size / 1048576).toFixed(1)} MB, sha256 ${setupHash}`);
