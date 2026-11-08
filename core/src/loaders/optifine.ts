import { dirname, join } from "node:path";
import { ensureDir } from "../util/fsx";
import { runProcess } from "../util/proc";
import { ZipReader } from "../util/zip";
import type { GameEnv } from "../mc/files";
import type { VersionJson } from "../mc/types";
import { librariesDir } from "../mc/version-json";
import { mavenPath } from "../mc/maven";
import type { InstallHooks } from "./forge-installer";

export interface OptiFineParams {
  env: GameEnv;
  installerJar: string;
  mcVersion: string;
  /** "HD_U" */
  type: string;
  /** "I6" */
  patch: string;
  minecraftJar: string;
  vanilla: VersionJson;
  javaPath: string;
  signal?: AbortSignal;
  hooks?: InstallHooks;
}

/**
 * Standalone OptiFine, the way its own installer does it: patch the vanilla jar into
 * `libraries/optifine/OptiFine/<id>/`, add its launch wrapper and a LaunchWrapper-based profile.
 */
export async function installOptiFine(params: OptiFineParams): Promise<VersionJson> {
  const { env } = params;
  const id = `${params.mcVersion}_${params.type}_${params.patch}`;
  const libName = `optifine:OptiFine:${id}`;
  const target = join(librariesDir(env.root), mavenPath(libName));
  params.hooks?.stage?.("optifine-patch");
  await ensureDir(dirname(target));
  const result = await runProcess(
    params.javaPath,
    ["-cp", params.installerJar, "optifine.Patcher", params.minecraftJar, params.installerJar, target],
    { signal: params.signal, javaPath: params.javaPath, onLine: params.hooks?.output },
  );
  if (result.code !== 0) throw new Error(`OptiFine patching failed (exit ${result.code}): ${result.tail.slice(-6).join(" | ")}`);

  const libraries: { name: string }[] = [{ name: libName }];
  const zip = await ZipReader.open(params.installerJar);
  try {
    const wrapper = zip.find((entry) => /^launchwrapper-of-([\w.\-]+)\.jar$/.test(entry.name));
    if (wrapper) {
      const version = /^launchwrapper-of-([\w.\-]+)\.jar$/.exec(wrapper.name)![1];
      const name = `optifine:launchwrapper-of:${version}`;
      const dest = join(librariesDir(env.root), mavenPath(name));
      await ensureDir(dirname(dest));
      await zip.extractTo(dirname(dest), { map: (entry) => (entry === wrapper ? `launchwrapper-of-${version}.jar` : undefined) });
      libraries.push({ name });
    } else {
      libraries.push({ name: "net.minecraft:launchwrapper:1.12" });
    }
  } finally {
    zip.close();
  }
  const modern = Boolean(params.vanilla.arguments);
  return {
    id: `${params.mcVersion}-OptiFine_${params.type}_${params.patch}`,
    inheritsFrom: params.mcVersion,
    type: params.vanilla.type ?? "release",
    mainClass: "net.minecraft.launchwrapper.Launch",
    libraries: libraries as VersionJson["libraries"],
    ...(modern
      ? { arguments: { game: ["--tweakClass", "optifine.OptiFineTweaker"] } }
      : { minecraftArguments: `${params.vanilla.minecraftArguments ?? ""} --tweakClass optifine.OptiFineTweaker`.trim() }),
  };
}
