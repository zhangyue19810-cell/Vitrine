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
  contentPolicy: "mirror-first",
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

/** Public entry points for the BMCLAPI layout. The canonical host sometimes hands large objects back to Mojang. */
const BMCL_DIRECT_FALLBACK = "https://bmclapi.bangbang93.com";
const isBmclHost = (hostname: string) => hostname === "bangbang93.com" || hostname.endsWith(".bangbang93.com");
/** Loader Maven artifacts are also available through these BMCLAPI mirrors, which avoid a poisoned DNS entry. */
const MAVEN_MIRROR_HOSTS = new Set(["maven.minecraftforge.net", "files.minecraftforge.net", "maven.neoforged.net", "maven.fabricmc.net", "maven.quiltmc.org"]);
const CERNET_BMCLAPI = "https://mirrors.cernet.edu.cn/bmclapi";
const NYIST_BMCLAPI = "https://mirror.nyist.edu.cn/bmclapi";

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

  private gameMirrorBases(): string[] {
    const primary = this.settings().mirrorBase.replace(/\/+$/, "");
    const bases = [primary];
    try {
      if (isBmclHost(new URL(primary).hostname.toLowerCase()) && !bases.includes(BMCL_DIRECT_FALLBACK)) bases.push(BMCL_DIRECT_FALLBACK);
    } catch {
      /* invalid custom base: use only the configured value */
    }
    return bases;
  }

  private gameMirrors(url: string): string[] {
    return this.gameMirrorBases().map((base) => applyRules(GAME_RULES, url, base)).filter((entry): entry is string => Boolean(entry));
  }

  /** Additional education-network mirrors for loader Maven artifacts. */
  private loaderMavenMirrors(official: string, translated: string): string[] {
    try {
      if (!MAVEN_MIRROR_HOSTS.has(new URL(official).hostname.toLowerCase())) return [];
      const parsed = new URL(translated);
      const marker = "/maven/";
      const at = parsed.pathname.indexOf(marker);
      if (at < 0) return [];
      const suffix = parsed.pathname.slice(at + marker.length);
      return [`${CERNET_BMCLAPI}/${suffix}${parsed.search}`, `${NYIST_BMCLAPI}/${suffix}${parsed.search}`];
    } catch {
      return [];
    }
  }

  private orderList(official: string, mirrors: string[], policy: SourcePolicy): string[] {
    const alternatives = [...new Set(mirrors.filter(Boolean))];
    switch (policy) {
      case "official-only":
        return [official];
      case "mirror-only":
        return alternatives.length ? alternatives : [official];
      case "official-first":
        return [official, ...alternatives];
      case "mirror-first":
        return [...alternatives, official];
    }
  }

  private order(official: string, mirror: string | undefined, policy: SourcePolicy): string[] {
    return this.orderList(official, mirror ? [mirror] : [], policy);
  }

  /** Candidate URLs for a game/loader file, ordered by the user's source policy. */
  candidates(url: string): string[] {
    const official = upgradeScheme(url);
    const translated = this.gameMirrors(official);
    const loaderMirrors = translated.flatMap((mirror) => this.loaderMavenMirrors(official, mirror));
    return this.orderList(official, [...translated, ...loaderMirrors], this.settings().policy);
  }

  /**
   * Candidate URLs for the Minecraft client jar. BMCLAPI's generic object path can redirect the
   * large client jar back to Mojang; the version endpoint is served from a different mirror pool.
   * Trying both known BMCL entry points first gives the downloader real alternatives when one
   * pool or the official CDN stalls.
   */
  clientCandidates(mcVersion: string, url: string): string[] {
    const official = upgradeScheme(url);
    const bases = this.gameMirrorBases();
    const direct = bases.flatMap((base) => {
      try {
        return isBmclHost(new URL(base).hostname.toLowerCase()) ? [`${base}/version/${encodeURIComponent(mcVersion)}/client`] : [];
      } catch {
        return [];
      }
    });
    return this.orderList(official, [...direct, ...this.gameMirrors(official)], this.settings().policy);
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
