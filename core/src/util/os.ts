import os from "node:os";

export type OsName = "windows" | "linux" | "osx";
export type OsArch = "x64" | "x86" | "arm64";

export interface OsInfo {
  name: OsName;
  arch: OsArch;
  /** Kernel / OS version string as Mojang's `os.version` rules expect (e.g. "10.0.22631"). */
  version: string;
}

export function currentOs(): OsInfo {
  const name: OsName = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "osx" : "linux";
  const arch: OsArch = process.arch === "arm64" ? "arm64" : process.arch === "ia32" ? "x86" : "x64";
  return { name, arch, version: os.release() };
}

export const classpathSeparator = (info: OsInfo = currentOs()) => (info.name === "windows" ? ";" : ":");

export const exeName = (base: string, info: OsInfo = currentOs()) => (info.name === "windows" ? `${base}.exe` : base);

export function totalMemoryMB(): number {
  return Math.round(os.totalmem() / 1048576);
}

export function freeMemoryMB(): number {
  return Math.round(os.freemem() / 1048576);
}

/** Mojang's runtime manifest uses its own platform keys. */
export function mojangRuntimePlatform(info: OsInfo = currentOs()): string {
  if (info.name === "windows") return info.arch === "arm64" ? "windows-arm64" : info.arch === "x86" ? "windows-x86" : "windows-x64";
  if (info.name === "osx") return info.arch === "arm64" ? "mac-os-arm64" : "mac-os";
  return info.arch === "x86" ? "linux-i386" : "linux";
}
