import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type MinecraftRootMove = "moved" | "missing" | "not-directory" | "target-exists";

/** Compare paths the way the current platform does without resolving symlinks. */
export function sameRootPath(left: string, right: string, caseInsensitive = false): boolean {
  const normalize = (value: string) => resolve(value).replace(/[\\/]+$/, "");
  const a = normalize(left);
  const b = normalize(right);
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Move a launcher-owned Minecraft folder to a visible location without replacing anything on the target.
 * Rename is attempted first (instant on the same volume); cross-volume moves fall back to a recursive copy.
 * The source is only removed after the copy has completed successfully.
 */
export async function moveMinecraftRoot(source: string, target: string): Promise<MinecraftRootMove> {
  let info;
  try {
    info = await stat(source);
  } catch {
    return "missing";
  }
  if (!info.isDirectory()) return "not-directory";
  try {
    if ((await stat(target)).isDirectory()) return "target-exists";
    return "target-exists";
  } catch {
    /* target does not exist yet */
  }
  await mkdir(dirname(target), { recursive: true });
  try {
    await rename(source, target);
    return "moved";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  try {
    await cp(source, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await rm(source, { recursive: true, force: true });
  return "moved";
}
