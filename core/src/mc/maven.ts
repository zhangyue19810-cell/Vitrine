/** Maven coordinates as used in version JSON, installer profiles and loader metadata. */

export interface MavenCoord {
  group: string;
  artifact: string;
  version: string;
  classifier?: string;
  extension: string;
}

/** `group:artifact:version[:classifier][@ext]` */
export function parseMaven(coord: string): MavenCoord {
  const [main, extension = "jar"] = coord.split("@");
  const parts = main.split(":");
  if (parts.length < 3) throw new Error(`Invalid maven coordinate: ${coord}`);
  const [group, artifact, version, classifier] = parts;
  return { group, artifact, version, classifier: classifier || undefined, extension };
}

export function mavenFileName(c: MavenCoord): string {
  return `${c.artifact}-${c.version}${c.classifier ? `-${c.classifier}` : ""}.${c.extension}`;
}

/** Path relative to a maven repository root: `com/mojang/brigadier/1.0.18/brigadier-1.0.18.jar`. */
export function mavenPath(coord: string | MavenCoord): string {
  const c = typeof coord === "string" ? parseMaven(coord) : coord;
  return `${c.group.replace(/\./g, "/")}/${c.artifact}/${c.version}/${mavenFileName(c)}`;
}

/** Library identity ignoring the version, used to let a loader's library replace vanilla's. */
export function mavenKey(coord: string): string {
  try {
    const c = parseMaven(coord);
    return `${c.group}:${c.artifact}${c.classifier ? `:${c.classifier}` : ""}${c.extension !== "jar" ? `@${c.extension}` : ""}`;
  } catch {
    return coord;
  }
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
