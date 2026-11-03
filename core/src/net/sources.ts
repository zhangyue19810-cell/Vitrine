/**
 * Official ↔ mirror URL routing.
 *
 * Mirrors follow BMCLAPI's documented layout (bmclapi2.bangbang93.com): the same Mojang paths at the
 * root, /assets for resources, /maven for every maven repository, and /<name>-meta for loader metadata.
 */

export type SourcePolicy = "official-first" | "mirror-first" | "official-only" | "mirror-only";

export interface SourceSettings {
  policy: SourcePolicy;
  /** Mirror root for game files and loaders. */
  mirrorBase: string;
  /** Policy for mod/modpack metadata and CDN files (Modrinth / CurseForge). */
  contentPolicy: SourcePolicy;
  /** Mirror root for Modrinth / CurseForge style content. */
  contentMirrorBase: string;
}

export const DEFAULT_SOURCES: SourceSettings = {
  policy: "mirror-first",
  mirrorBase: "https://bmclapi2.bangbang93.com",
  contentPolicy: "official-first",
  contentMirrorBase: "https://mod.mcimirror.top",
};

interface Rule {
  host: string;
  /** Path prefix on the official host that is replaced. */
  from: string;
  /** Replacement prefix on the mirror. */
  to: string;
}

const GAME_RULES: Rule[] = [
  { host: "launchermeta.mojang.com", from: "/", to: "/" },
  { host: "piston-meta.mojang.com", from: "/", to: "/" },
  { host: "piston-data.mojang.com", from: "/", to: "/" },
  { host: "launcher.mojang.com", from: "/", to: "/" },
  { host: "resources.download.minecraft.net", from: "/", to: "/assets/" },
  { host: "libraries.minecraft.net", from: "/", to: "/maven/" },
  { host: "files.minecraftforge.net", from: "/maven/", to: "/maven/" },
  { host: "maven.minecraftforge.net", from: "/", to: "/maven/" },
  { host: "maven.neoforged.net", from: "/releases/", to: "/maven/" },
  { host: "maven.fabricmc.net", from: "/", to: "/maven/" },
  { host: "meta.fabricmc.net", from: "/", to: "/fabric-meta/" },
  { host: "maven.quiltmc.org", from: "/repository/release/", to: "/maven/" },
  { host: "meta.quiltmc.org", from: "/", to: "/quilt-meta/" },
  { host: "authlib-injector.yushi.moe", from: "/", to: "/mirrors/authlib-injector/" },
];

const CONTENT_RULES: Rule[] = [
  { host: "api.modrinth.com", from: "/", to: "/modrinth/" },
  { host: "cdn.modrinth.com", from: "/", to: "/" },
  { host: "edge.forgecdn.net", from: "/files/", to: "/files/" },
  { host: "mediafilez.forgecdn.net", from: "/files/", to: "/files/" },
  { host: "api.curseforge.com", from: "/", to: "/curseforge/" },
];

/** Hosts whose legacy http:// URLs (old Forge/Mojang JSON) are safe to upgrade to https://. */
const UPGRADABLE = /(^|\.)(minecraft\.net|mojang\.com|minecraftforge\.net|fabricmc\.net|quiltmc\.(org|net)|neoforged\.net|modrinth\.com|forgecdn\.net|curseforge\.com|bangbang93\.com|mcimirror\.top)$/i;

export function upgradeScheme(url: string): string {
  if (!url.startsWith("http://")) return url;
  try {
    const parsed = new URL(url);
    if (UPGRADABLE.test(parsed.hostname)) {
      parsed.protocol = "https:";
      return parsed.toString();
    }
  } catch {
    /* fall through */
  }
  return url;
}

function applyRules(rules: Rule[], url: string, base: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const root = base.replace(/\/+$/, "");
  for (const rule of rules) {
    if (parsed.hostname.toLowerCase() !== rule.host) continue;
    if (!parsed.pathname.startsWith(rule.from)) continue;
    return `${root}${rule.to}${parsed.pathname.slice(rule.from.length)}${parsed.search}`;
  }
  return undefined;
}

export class SourceRouter {
  constructor(private readonly settings: () => SourceSettings) {}

  /** Mirror equivalent of an official game URL, if one is known. */
  toMirror(url: string): string | undefined {
    return applyRules(GAME_RULES, upgradeScheme(url), this.settings().mirrorBase);
  }

  toContentMirror(url: string): string | undefined {
    return applyRules(CONTENT_RULES, upgradeScheme(url), this.settings().contentMirrorBase);
  }

  private order(official: string, mirror: string | undefined, policy: SourcePolicy): string[] {
    switch (policy) {
      case "official-only":
        return [official];
      case "mirror-only":
        return [mirror ?? official];
      case "official-first":
        return mirror ? [official, mirror] : [official];
      case "mirror-first":
        return mirror ? [mirror, official] : [official];
    }
  }

  /** Candidate URLs for a game/loader file, ordered by the user's source policy. */
  candidates(url: string): string[] {
    const official = upgradeScheme(url);
    return this.order(official, this.toMirror(official), this.settings().policy);
  }

  /** Candidate URLs for a Modrinth/CurseForge request or CDN file. */
  contentCandidates(url: string): string[] {
    const official = upgradeScheme(url);
    return this.order(official, this.toContentMirror(official), this.settings().contentPolicy);
  }

  /** Candidates for a url that may be either kind; picks the right rule set by host. */
  any(url: string): string[] {
    return this.toContentMirror(url) !== undefined ? this.contentCandidates(url) : this.candidates(url);
  }
}
