import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ensureDir, exists, hashBuffer, removeRecursive, setExecutable } from "../util/fsx";
import { ZipReader } from "../util/zip";
import type { LibraryFile } from "./version-json";

const NATIVE_EXT = /\.(dll|so|dylib|jnilib)$/i;
const MARKER = ".vitrine-natives";

/**
 * Extract native libraries into `dir` (flattened). The directory is reused when the set of native jars did
 * not change, so a running game keeps its loaded DLLs untouched on the next launch.
 */
export async function prepareNatives(librariesRoot: string, libraries: LibraryFile[], dir: string): Promise<{ extracted: number; reused: boolean }> {
  const natives = libraries.filter((lib) => lib.native);
  const signature = hashBuffer(natives.map((lib) => `${lib.path}:${lib.size ?? 0}:${lib.sha1 ?? ""}`).join("\n"), "sha1");
  const markerPath = join(dir, MARKER);
  if ((await exists(markerPath)) && (await readFile(markerPath, "utf8").catch(() => "")) === signature) return { extracted: 0, reused: true };
  await removeRecursive(dir).catch(() => {});
  await ensureDir(dir);
  let extracted = 0;
  for (const lib of natives) {
    const path = join(librariesRoot, lib.path);
    if (!(await exists(path))) throw new Error(`Native library is missing: ${lib.path}`);
    const zip = await ZipReader.open(path);
    try {
      for (const entry of zip.entries) {
        if (entry.isDirectory || entry.name.startsWith("META-INF/")) continue;
        if (lib.extractExclude.some((prefix) => entry.name.startsWith(prefix))) continue;
        if (!NATIVE_EXT.test(entry.name)) continue;
        const target = join(dir, basename(entry.name));
        await writeFile(target, await zip.read(entry));
        await setExecutable(target);
        extracted++;
      }
    } finally {
      zip.close();
    }
  }
  await writeFile(markerPath, signature);
  return { extracted, reused: false };
}

export async function listNatives(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [])).filter((name) => NATIVE_EXT.test(name));
}
