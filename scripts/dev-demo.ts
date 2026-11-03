/**
 * Demo backend for interface work and browser tests: the real core, but every network source is a local fake
 * (a Mojang + BMCLAPI mirror, Fabric meta, a small Modrinth) and the game root is pre-filled with a few instances,
 * mods, worlds, servers and an account. Nothing here touches the internet and nothing from this file ships.
 *
 *   npm run dev:demo
 *   VITRINE_DEMO_DIR=…  where the demo lives (default: <tmp>/vitrine-demo, wiped on every start unless VITRINE_DEMO_KEEP=1)
 *   VITRINE_PORT / VITRINE_TOKEN / VITRINE_WEB   as for dev:backend
 *   VITRINE_DEMO_SPEED=150000   bytes per second per connection for mod downloads (so progress is visible)
 *
 * Demo instances (all start through a real JVM running a tiny stand-in for Minecraft, see core/test/helpers/fake-game.ts):
 *   生存 1.21.1       vanilla, keeps running (shows the "game is running" state)
 *   Fabric 轻量 1.21.1  Fabric + 14 mods, dies with OutOfMemoryError (shows crash analysis with a one-click fix)
 *   机械动力·天空岛     NeoForge-style pack with 64 mods, incomplete (repair), exits with code 3
 *   1.8.9 PVP         needs Java 8, which this machine lacks (shows the "no suitable Java" path)
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { Core } from "../core/src/core";
import { versionDir, versionJsonPath } from "../core/src/mc/version-json";
import { nbt, writeNbt } from "../core/src/world/nbt";
import { addServer } from "../core/src/world/servers";
import { startWsServer } from "../core/src/ws-server";
import { buildFakeGameJar } from "../core/test/helpers/fake-game";
import { startFakeMojang, zipBuffer, type FakeVersionSpec } from "../core/test/helpers/fake-mojang";
import { bytes, serveBytes, sha1, startMock } from "../core/test/helpers/mock-server";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha512 = (data: Buffer) => createHash("sha512").update(data).digest("hex");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const dir = process.env.VITRINE_DEMO_DIR ?? join(tmpdir(), "vitrine-demo");
const speed = Number(process.env.VITRINE_DEMO_SPEED ?? 150_000);
if (process.env.VITRINE_DEMO_KEEP !== "1") await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });

// ------------------------------------------------------------------------------------------------ small image maker

function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const at = y * stride + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A blocky "landscape": sky gradient, a sun, rows of terrain cubes. */
function landscape(hue: number): (x: number, y: number) => [number, number, number] {
  const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  return (x, y) => {
    const h = (x / 8) | 0;
    const ground = 190 + Math.round(Math.sin(h * 0.7 + hue) * 20 + Math.sin(h * 0.23 + hue * 2) * 30);
    if (y > ground) {
      const cell = ((x >> 3) + (y >> 3)) & 1;
      return y > ground + 12 ? [110 + cell * 12, 84 + cell * 8, 62] : [78 + cell * 10, 150 - hue * 4 + cell * 12, 70];
    }
    const t = y / 220;
    const sun = (x - 520) ** 2 + (y - 70) ** 2 < 900;
    return sun ? [255, 244, 190] : [mix(120 + hue * 6, 190, t), mix(170, 220, t), mix(235, 250, t)];
  };
}

const solid = (r: number, g: number, b: number) => png(16, 16, (x, y) => [r - ((x ^ y) & 4) * 3, g - ((x ^ y) & 4) * 3, b]);

// ------------------------------------------------------------------------------------------------ fake game network

const gameJar = await buildFakeGameJar(dir);
const RELEASES = ["1.21.4", "1.21.3", "1.21.1", "1.20.6", "1.20.4", "1.20.1", "1.19.4", "1.18.2", "1.16.5", "1.12.2", "1.8.9"];
const javaFor = (id: string) => (["1.8.9", "1.12.2", "1.16.5"].includes(id) ? 8 : ["1.18.2", "1.19.4", "1.20.1", "1.20.4"].includes(id) ? 17 : 21);
const specs: FakeVersionSpec[] = [
  { id: "25w05a", type: "snapshot", javaMajor: 21, assetCount: 2 },
  ...RELEASES.map((id): FakeVersionSpec => ({
    id,
    javaMajor: javaFor(id),
    assetCount: id === "1.21.1" ? 60 : 3,
    legacy: id === "1.8.9",
    ...(id === "1.21.1" || id === "1.8.9" ? { clientJar: gameJar, mainClass: "FakeMain" } : {}),
  })),
];
const mojang = await startFakeMojang(specs);

// Fabric: a meta service for every supported version plus the loader jars.
const loaderBuilds = ["0.16.9", "0.16.5", "0.15.11"];
const loaderJars = new Map<string, { jar: Buffer; intermediary: Buffer }>();
for (const mc of RELEASES) {
  mojang.add(`/fabric-meta/v2/versions/loader/${mc}`, JSON.stringify(loaderBuilds.map((version) => ({ loader: { version, stable: true } }))));
  mojang.add(`/quilt-meta/v3/versions/loader/${mc}`, JSON.stringify([{ loader: { version: "0.27.1" } }]));
  const intermediary = await zipBuffer({ "mappings/mappings.tiny": `intermediary ${mc}` });
  mojang.add(`/maven/net/fabricmc/intermediary/${mc}/intermediary-${mc}.jar`, intermediary);
  for (const build of loaderBuilds) {
    const jar = loaderJars.get(build)?.jar ?? (await zipBuffer({ "fabric.mod.json": JSON.stringify({ id: "fabricloader", version: build }) }));
    loaderJars.set(build, { jar, intermediary });
    mojang.add(`/maven/net/fabricmc/fabric-loader/${build}/fabric-loader-${build}.jar`, jar);
    mojang.add(
      `/fabric-meta/v2/versions/loader/${mc}/${build}/profile/json`,
      JSON.stringify({
        id: `fabric-loader-${build}-${mc}`,
        inheritsFrom: mc,
        type: "release",
        // The stand-in game's entry point, so "Fabric" instances can really start in this demo.
        mainClass: "FakeMain",
        arguments: { game: [], jvm: [] },
        libraries: [
          { name: `net.fabricmc:fabric-loader:${build}`, url: "https://maven.fabricmc.net/", sha1: sha1(jar), size: jar.length },
          { name: `net.fabricmc:intermediary:${mc}`, url: "https://maven.fabricmc.net/", sha1: sha1(intermediary), size: intermediary.length },
        ],
      }),
    );
  }
}
mojang.add("/fabric-meta/v2/versions/game", JSON.stringify(RELEASES.map((version) => ({ version, stable: true }))));
mojang.add("/quilt-meta/v3/versions/game", JSON.stringify(RELEASES.map((version) => ({ version, stable: true }))));
const xml = (versions: string[]) => `<?xml version="1.0"?><metadata><versioning><versions>${versions.map((v) => `<version>${v}</version>`).join("")}</versions></versioning></metadata>`;
mojang.add("/maven/net/minecraftforge/forge/maven-metadata.xml", xml(["1.20.1-47.3.0", "1.20.1-47.2.0", "1.21.1-52.0.40", "1.12.2-14.23.5.2860", "1.8.9-11.15.1.2318-1.8.9"]));
mojang.add("/maven/net/neoforged/neoforge/maven-metadata.xml", xml(["21.1.77", "21.1.172", "21.4.20"]));
mojang.add("/maven/net/neoforged/forge/maven-metadata.xml", xml(["1.20.1-47.1.106"]));
mojang.add("/optifine/1.21.1", JSON.stringify([{ mcversion: "1.21.1", patch: "J1", type: "HD_U", filename: "OptiFine_1.21.1_HD_U_J1.jar" }]));

// The NeoForge jar the pack instance names as a library, so it can really "install" and start.
const neoJar = await zipBuffer({ "META-INF/neoforge.mods.toml": "x" });
mojang.add("/maven/net/neoforged/neoforge/21.1.77/neoforge-21.1.77.jar", neoJar);

// ------------------------------------------------------------------------------------------------ mods

interface JarSpec {
  id: string;
  version: string;
  name: string;
  description?: string;
  authors?: string[];
  depends?: Record<string, string>;
  size?: number;
  seed?: number;
  icon?: Buffer;
}

const fabricJar = (spec: JarSpec) =>
  zipBuffer({
    "fabric.mod.json": JSON.stringify({
      schemaVersion: 1,
      id: spec.id,
      version: spec.version,
      name: spec.name,
      description: spec.description ?? `${spec.name} — 演示用模组`,
      authors: spec.authors ?? ["Demo"],
      environment: "client",
      depends: { fabricloader: ">=0.15.0", minecraft: "~1.21.1", ...(spec.depends ?? {}) },
      ...(spec.icon ? { icon: "icon.png" } : {}),
    }),
    ...(spec.icon ? { "icon.png": spec.icon } : {}),
    "padding.bin": bytes(spec.size ?? 4000, spec.seed ?? 1),
  });

const neoJarOf = (spec: JarSpec & { requires?: string[] }) => {
  const deps = [
    ...["neoforge", "minecraft"].map(
      (id) => `[[dependencies.${spec.id}]]\nmodId="${id}"\ntype="required"\nversionRange="[${id === "minecraft" ? "1.21.1" : "21.1.0"},)"\nordering="NONE"\nside="BOTH"\n`,
    ),
    ...(spec.requires ?? []).map((id) => `[[dependencies.${spec.id}]]\nmodId="${id}"\ntype="required"\nversionRange="[0,)"\nordering="AFTER"\nside="BOTH"\n`),
  ].join("\n");
  const toml = `modLoader="javafml"\nloaderVersion="[4,)"\nlicense="MIT"\n\n[[mods]]\nmodId="${spec.id}"\nversion="${spec.version}"\ndisplayName="${spec.name}"\ndescription='''${spec.description ?? `${spec.name} — 演示用模组`}'''\nauthors="${(spec.authors ?? ["Demo"]).join(", ")}"\n\n${deps}`;
  return zipBuffer({ "META-INF/neoforge.mods.toml": toml, "padding.bin": bytes(spec.size ?? 4000, spec.seed ?? 1) });
};

// ------------------------------------------------------------------------------------------------ fake Modrinth

type ProjectType = "mod" | "modpack" | "resourcepack" | "shader";
interface Project {
  id: string;
  slug: string;
  title: string;
  type: ProjectType;
  summary: string;
  author: string;
  downloads: number;
  categories: string[];
  requires?: string;
}
const CATALOG: Project[] = [
  { id: "AANobbMI", slug: "sodium", title: "Sodium", type: "mod", summary: "现代化的渲染引擎，大幅提升帧率并修复画面问题。", author: "jellysquid3", downloads: 52_300_000, categories: ["optimization", "fabric"] },
  { id: "gvQqBUqZ", slug: "lithium", title: "Lithium", type: "mod", summary: "优化游戏逻辑、物理与 AI 的通用服务端/客户端优化。", author: "jellysquid3", downloads: 31_100_000, categories: ["optimization", "fabric"] },
  { id: "YL57xq9U", slug: "iris", title: "Iris Shaders", type: "mod", summary: "与 Sodium 配合的光影加载器，兼容 OptiFine 光影包。", author: "coderbot", downloads: 28_900_000, categories: ["decoration", "fabric"], requires: "AANobbMI" },
  { id: "P7dR8mSH", slug: "fabric-api", title: "Fabric API", type: "mod", summary: "Fabric 模组的基础接口库。", author: "modmuss50", downloads: 120_000_000, categories: ["library", "fabric"] },
  { id: "mOgUt4GM", slug: "modmenu", title: "Mod Menu", type: "mod", summary: "在游戏内查看与配置已安装的模组。", author: "Prospector", downloads: 60_800_000, categories: ["utility", "fabric"] },
  { id: "uXXizFIs", slug: "ferrite-core", title: "FerriteCore", type: "mod", summary: "显著降低内存占用的优化模组。", author: "malte0811", downloads: 22_400_000, categories: ["optimization", "fabric"] },
  { id: "NNAgCjsB", slug: "entityculling", title: "Entity Culling", type: "mod", summary: "不渲染看不见的实体，提升大量实体场景的帧率。", author: "tr7zw", downloads: 15_000_000, categories: ["optimization", "fabric"] },
  { id: "LQ3K71Q1", slug: "dynamic-fps", title: "Dynamic FPS", type: "mod", summary: "窗口失焦时自动降低帧率，省电省显存。", author: "juliand665", downloads: 6_900_000, categories: ["utility", "fabric"] },
  { id: "EsAfCjCV", slug: "appleskin", title: "AppleSkin", type: "mod", summary: "在饥饿条上显示食物饱和度与恢复量。", author: "squeek502", downloads: 14_200_000, categories: ["utility", "fabric"] },
  { id: "1bokaNcj", slug: "xaeros-minimap", title: "Xaero's Minimap", type: "mod", summary: "好用的小地图，支持路径点与实体雷达。", author: "xaero96", downloads: 18_500_000, categories: ["utility", "fabric"] },
  { id: "nvQzSEkH", slug: "jade", title: "Jade", type: "mod", summary: "鼠标指向方块与实体时显示详细信息。", author: "Snownee", downloads: 21_000_000, categories: ["utility", "fabric"] },
  { id: "9s6osm5g", slug: "cloth-config", title: "Cloth Config API", type: "mod", summary: "许多模组使用的配置界面库。", author: "shedaniel", downloads: 40_000_000, categories: ["library", "fabric"] },
  { id: "skyward", slug: "skyward-fabric", title: "机械动力·天空岛", type: "modpack", summary: "以齿轮、传动与天空岛为主题的 Fabric 整合包（演示，160 个模组）。", author: "Vitrine Demo", downloads: 3_400_000, categories: ["adventure", "technology", "fabric"] },
  { id: "fabopt", slug: "fabulously-optimized", title: "Fabulously Optimized", type: "modpack", summary: "面向性能与画质的轻量整合包（演示，24 个模组）。", author: "Vitrine Demo", downloads: 8_100_000, categories: ["optimization", "fabric"] },
  { id: "faith32", slug: "faithful-32x", title: "Faithful 32x", type: "resourcepack", summary: "保持原版风格的 32x 高清材质包。", author: "Faithful Team", downloads: 12_000_000, categories: ["vanilla-like"] },
  { id: "freshanim", slug: "fresh-animations", title: "Fresh Animations", type: "resourcepack", summary: "为原版生物添加流畅的自定义动画。", author: "Fresh Team", downloads: 9_000_000, categories: ["themed"] },
  { id: "compl", slug: "complementary-reimagined", title: "Complementary Shaders - Reimagined", type: "shader", summary: "兼顾性能与画质的热门光影包。", author: "EminGT", downloads: 30_000_000, categories: ["vanilla-like"] },
  { id: "bslshd", slug: "bsl-shaders", title: "BSL Shaders", type: "shader", summary: "经典全能光影包，效果细腻。", author: "capttatsu", downloads: 25_000_000, categories: ["cinematic"] },
];

interface ProjectVersion {
  json: Record<string, unknown>;
  data: Buffer;
  project: Project;
}
const versionsOf = new Map<string, ProjectVersion[]>();
const byHash = new Map<string, ProjectVersion>();
const statics = new Map<string, Buffer>();

function registerVersion(project: Project, id: string, number: string, filename: string, data: Buffer, extra: Record<string, unknown> = {}): ProjectVersion {
  const path = `/data/${project.id}/versions/${id}/${filename}`;
  statics.set(path, data);
  const entry: ProjectVersion = {
    data,
    project,
    json: {
      id,
      project_id: project.id,
      name: number,
      version_number: number,
      changelog: `- ${number}：修复若干问题，优化性能。\n- 演示数据，非真实更新日志。`,
      game_versions: ["1.21.1", "1.21.3", "1.21.4"],
      loaders: project.type === "mod" || project.type === "modpack" ? ["fabric"] : ["minecraft"],
      version_type: "release",
      date_published: new Date(Date.now() - (number.endsWith(".1") ? 3 : 40) * DAY).toISOString(),
      downloads: 1000,
      dependencies: project.requires ? [{ project_id: project.requires, dependency_type: "required" }] : [],
      files: [{ hashes: { sha1: sha1(data), sha512: sha512(data) }, url: `https://cdn.modrinth.com${path}`, filename, primary: true, size: data.length }],
      ...extra,
    },
  };
  versionsOf.set(project.id, [entry, ...(versionsOf.get(project.id) ?? [])]);
  byHash.set(sha1(data), entry);
  return entry;
}

const iconOf = (project: Project) => `/icons/${project.id}.png`;
const hueOf = (project: Project) => [...project.id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 9;
for (const project of CATALOG) statics.set(iconOf(project), solid(60 + hueOf(project) * 20, 130 + ((hueOf(project) * 37) % 90), 150 + ((hueOf(project) * 53) % 90)));

// Mods get an older and a newer version: the older one is what the demo instances have, so "check updates" finds something.
const olderMods = new Map<string, Buffer>();
for (const project of CATALOG.filter((p) => p.type === "mod")) {
  const base: JarSpec = { id: project.slug.replace(/-/g, "_"), version: "", name: project.title, authors: [project.author], size: 6_000 + hueOf(project) * 2_500, depends: project.requires ? { sodium: ">=0.5.0" } : {} };
  const older = await fabricJar({ ...base, version: "1.0.0", seed: hueOf(project) });
  const newer = await fabricJar({ ...base, version: "1.1.0", seed: hueOf(project) + 50 });
  registerVersion(project, `${project.id}-v1`, "1.0.0", `${project.slug}-1.0.0.jar`, older);
  registerVersion(project, `${project.id}-v2`, "1.1.0", `${project.slug}-1.1.0.jar`, newer);
  olderMods.set(project.slug, older);
}
for (const project of CATALOG.filter((p) => p.type === "resourcepack" || p.type === "shader")) {
  registerVersion(project, `${project.id}-v1`, "1.0.0", `${project.slug}-1.0.0.zip`, await zipBuffer({ "pack.mcmeta": JSON.stringify({ pack: { pack_format: 34, description: project.title } }), "padding.bin": bytes(30_000, hueOf(project)) }));
}

// The 160-file modpack: each file is its own small download so many lanes are busy at once.
async function makeSkyward(): Promise<Buffer> {
  const project = CATALOG.find((p) => p.id === "skyward")!;
  const files: Record<string, unknown>[] = [];
  const names = ["create", "flywheel", "ponder", "registrate", "sodium", "lithium", "iris", "ferritecore", "jade", "appleskin"];
  for (let i = 0; i < 160; i++) {
    const slug = i < names.length ? names[i] : `${["gear", "belt", "cog", "sky", "cloud", "island", "rail", "valve"][i % 8]}-addon-${i}`;
    const filename = `${slug}-${1 + (i % 4)}.${i % 10}.0.jar`;
    const data = await fabricJar({ id: slug.replace(/-/g, "_"), version: `${1 + (i % 4)}.${i % 10}.0`, name: slug.replace(/(^|-)(\w)/g, (_m, _s, c: string) => ` ${c.toUpperCase()}`).trim(), size: 60_000 + ((i * 7919) % 420_000), seed: 900 + i });
    const path = `/data/skyward/files/${i}/${filename}`;
    statics.set(path, data);
    files.push({ path: `mods/${filename}`, hashes: { sha1: sha1(data), sha512: sha512(data) }, env: { client: "required", server: "required" }, downloads: [`https://cdn.modrinth.com${path}`], fileSize: data.length });
  }
  return zipBuffer({
    "modrinth.index.json": JSON.stringify({ formatVersion: 1, game: "minecraft", versionId: "1.4.2", name: project.title, summary: project.summary, dependencies: { minecraft: "1.21.1", "fabric-loader": "0.16.9" }, files }),
    "overrides/config/vitrine-demo.toml": "title = \"天空岛\"\n",
    "overrides/options.txt": "lang:zh_cn\nfancyGraphics:false\n",
  });
}
const skyward = await makeSkyward();
const skywardProject = CATALOG.find((p) => p.id === "skyward")!;
registerVersion(skywardProject, "skyward-142", "1.4.2", "Skyward-Fabric-1.4.2.mrpack", skyward, { name: "1.4.2 · 夏日更新", loaders: ["fabric"], game_versions: ["1.21.1"] });
const lightProject = CATALOG.find((p) => p.id === "fabopt")!;
registerVersion(
  lightProject,
  "fabopt-100",
  "1.0.0",
  "Fabulously-Optimized-1.0.0.mrpack",
  await zipBuffer({
    "modrinth.index.json": JSON.stringify({
      formatVersion: 1,
      game: "minecraft",
      versionId: "1.0.0",
      name: lightProject.title,
      summary: lightProject.summary,
      dependencies: { minecraft: "1.21.1", "fabric-loader": "0.16.5" },
      files: await Promise.all(
        ["sodium", "lithium", "ferrite-core", "entityculling", "dynamic-fps", "modmenu"].map(async (slug, i) => {
          const data = await fabricJar({ id: slug.replace(/-/g, "_"), version: "1.0.0", name: slug, size: 30_000, seed: 300 + i });
          const path = `/data/fabopt/files/${i}/${slug}.jar`;
          statics.set(path, data);
          return { path: `mods/${slug}.jar`, hashes: { sha1: sha1(data), sha512: sha512(data) }, env: { client: "required", server: "required" }, downloads: [`https://cdn.modrinth.com${path}`], fileSize: data.length };
        }),
      ),
    }),
  }),
  { loaders: ["fabric"], game_versions: ["1.21.1"] },
);

const json = (res: import("node:http").ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

const contentBase = { url: "" };
const content = await startMock(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://mock");
  const path = url.pathname;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  const hit = (project: Project) => ({
    project_id: project.id, slug: project.slug, title: project.title, description: project.summary, author: project.author,
    icon_url: `${contentBase.url}${iconOf(project)}`, downloads: project.downloads, follows: Math.round(project.downloads / 80),
    categories: project.categories, versions: ["1.21.1", "1.21.3", "1.21.4"], project_type: project.type,
    date_modified: new Date(Date.now() - (1 + (project.downloads % 30)) * DAY).toISOString(), client_side: "required", server_side: project.type === "mod" ? "optional" : "unsupported",
  });
  if (path === "/modrinth/v2/search") {
    const facets = JSON.parse(url.searchParams.get("facets") ?? "[]") as string[][];
    const type = facets.map((group) => group[0]).find((facet) => facet.startsWith("project_type:"))?.slice("project_type:".length);
    const query = (url.searchParams.get("query") ?? "").toLowerCase();
    let list = CATALOG.filter((p) => (!type || p.type === type) && (!query || `${p.title} ${p.summary} ${p.slug}`.toLowerCase().includes(query)));
    if (url.searchParams.get("index") === "newest") list = [...list].reverse();
    else list = [...list].sort((a, b) => b.downloads - a.downloads);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    await sleep(120);
    return json(res, { hits: list.slice(offset, offset + limit).map(hit), offset, limit, total_hits: list.length });
  }
  const projectMatch = /^\/modrinth\/v2\/project\/([^/]+)(\/version)?$/.exec(path);
  if (projectMatch) {
    const project = CATALOG.find((p) => p.id === projectMatch[1] || p.slug === projectMatch[1]);
    if (!project) return json(res, { error: "not_found" }, 404);
    if (projectMatch[2]) return json(res, (versionsOf.get(project.id) ?? []).map((v) => v.json));
    return json(res, {
      id: project.id, slug: project.slug, title: project.title, description: project.summary, icon_url: `${contentBase.url}${iconOf(project)}`,
      body: `## ${project.title}\n\n${project.summary}\n\n- 这是 **演示数据**，由本地假服务器提供。\n- 作者：${project.author}\n\n> 在真实环境中，这里会显示 Modrinth 上的完整介绍。`,
      project_type: project.type, categories: project.categories, game_versions: ["1.21.1", "1.21.3", "1.21.4"], loaders: ["fabric"], downloads: project.downloads, followers: Math.round(project.downloads / 80),
      client_side: "required", server_side: "optional", source_url: "https://example.invalid/source", issues_url: "https://example.invalid/issues",
    });
  }
  const versionMatch = /^\/modrinth\/v2\/version\/([^/]+)$/.exec(path);
  if (versionMatch) {
    const found = [...versionsOf.values()].flat().find((v) => v.json.id === versionMatch[1]);
    return found ? json(res, found.json) : json(res, { error: "not_found" }, 404);
  }
  if (req.method === "POST" && (path === "/modrinth/v2/version_files" || path === "/modrinth/v2/version_files/update")) {
    const request = JSON.parse(body || "{}") as { hashes?: string[] };
    const out: Record<string, unknown> = {};
    for (const hash of request.hashes ?? []) {
      const known = byHash.get(hash);
      if (!known) continue;
      out[hash] = path.endsWith("/update") ? (versionsOf.get(known.project.id) ?? [known])[0].json : known.json;
    }
    return json(res, out);
  }
  if (path.startsWith("/curseforge/")) return json(res, { error: "demo has no CurseForge" }, 403);
  const data = statics.get(path);
  if (!data) {
    res.writeHead(404);
    return void res.end("not found");
  }
  // Mod files are slow on purpose; icons are not.
  return serveBytes(req, res, data, path.startsWith("/icons/") ? {} : { delayMs: 60 + (path.length % 5) * 40, bytesPerSecond: speed });
});
contentBase.url = content.url;

// ------------------------------------------------------------------------------------------------ fake game server

function varInt(value: number): Buffer {
  const out: number[] = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return Buffer.from(out);
}
const frame = (id: number, payload: Buffer) => {
  const body = Buffer.concat([varInt(id), payload]);
  return Buffer.concat([varInt(body.length), body]);
};
const mcString = (value: string) => Buffer.concat([varInt(Buffer.byteLength(value)), Buffer.from(value)]);

async function startStatusServer(status: unknown): Promise<{ port: number }> {
  const server = createServer((socket: Socket) => {
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let stage = 0;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        let length = 0;
        let size = 0;
        let shift = 0;
        let ok = false;
        for (let i = 0; i < Math.min(5, buffer.length); i++) {
          length |= (buffer[i] & 0x7f) << shift;
          shift += 7;
          if (!(buffer[i] & 0x80)) {
            size = i + 1;
            ok = true;
            break;
          }
        }
        if (!ok || buffer.length < size + length) return;
        const packet = buffer.subarray(size, size + length);
        buffer = Buffer.from(buffer.subarray(size + length));
        if (stage === 0) stage = 1;
        else if (stage === 1) {
          socket.write(frame(0, mcString(JSON.stringify(status))));
          stage = 2;
        } else socket.write(frame(1, packet.subarray(1)));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as { port: number }).port };
}
const status = await startStatusServer({
  version: { name: "Paper 1.21.1", protocol: 767 },
  players: { max: 100, online: 7, sample: [{ name: "Steve", id: "00000000-0000-0000-0000-000000000001" }] },
  description: { text: "", extra: [{ text: "琉匣测试服", color: "aqua", bold: true }, { text: "\n§7欢迎来到演示服务器" }] },
  favicon: `data:image/png;base64,${solid(90, 170, 200).toString("base64")}`,
});

// ------------------------------------------------------------------------------------------------ the core

const core = await Core.create({
  dataDir: join(dir, "data"),
  version: "0.1.0-demo",
  defaultRoot: join(dir, "minecraft"),
  host: {
    openExternal: (url) => void console.log(`[host] openExternal ${url}`),
    openPath: (path) => void console.log(`[host] openPath ${path}`),
    showItemInFolder: (path) => void console.log(`[host] showItemInFolder ${path}`),
  },
});
await core.settings.update({
  sources: { policy: "mirror-only", mirrorBase: mojang.mirrorBase, contentPolicy: "mirror-only", contentMirrorBase: content.url },
  network: { proxy: "none" },
  java: { autoInstall: false },
});

async function finished(taskId: string) {
  for (;;) {
    const task = core.tasks.get(taskId);
    if (task && task.state !== "queued" && task.state !== "running") {
      if (task.state !== "done") throw new Error(`${task.title}: ${task.state} ${task.error ?? ""}`);
      return task;
    }
    await sleep(80);
  }
}
async function install(name: string, mcVersion: string, loader?: { kind: "fabric"; version: string }) {
  await finished(core.createInstance({ name, mcVersion, loader: loader as never, isolation: "on" }).taskId);
  return versionDir(core.root, name);
}

const now = Date.now();
const worldAt = async (gameDir: string, folder: string, spec: { name: string; mode: number; hardcore?: boolean; cheats?: boolean; difficulty?: number; playedHoursAgo: number; seed: bigint; hue: number }) => {
  const world = join(gameDir, "saves", folder);
  await mkdir(join(world, "region"), { recursive: true });
  await mkdir(join(world, "datapacks"), { recursive: true });
  await writeFile(
    join(world, "level.dat"),
    writeNbt(
      {
        name: "",
        tag: nbt.compound({
          Data: nbt.compound({
            LevelName: nbt.string(spec.name),
            LastPlayed: nbt.long(BigInt(now - spec.playedHoursAgo * HOUR)),
            GameType: nbt.int(spec.mode),
            hardcore: nbt.byte(spec.hardcore ? 1 : 0),
            allowCommands: nbt.byte(spec.cheats ? 1 : 0),
            Difficulty: nbt.byte(spec.difficulty ?? 2),
            DataVersion: nbt.int(3955),
            Version: nbt.compound({ Name: nbt.string("1.21.1"), Id: nbt.int(3955) }),
            WorldGenSettings: nbt.compound({ seed: nbt.long(spec.seed) }),
          }),
        }),
      },
      "gzip",
    ),
  );
  await writeFile(join(world, "icon.png"), png(64, 64, (x, y) => landscape(spec.hue)(x * 10, y * 3 + 40)));
  await writeFile(join(world, "region", "r.0.0.mca"), bytes(180_000 + spec.hue * 30_000, spec.hue + 5));
};

// ---- 1. vanilla: stays running ----
console.log("installing demo instances…");
const vanilla = await install("生存 1.21.1", "1.21.1");
await worldAt(vanilla, "World-Day142", { name: "生存存档 · 第 142 天", mode: 0, difficulty: 2, playedHoursAgo: 3, seed: 8_473_920_184_732n, hue: 1 });
await worldAt(vanilla, "Redstone-Lab", { name: "红石实验室", mode: 1, cheats: true, difficulty: 0, playedHoursAgo: 26, seed: -3_441_007_112n, hue: 3 });
await worldAt(vanilla, "Hardcore-Run", { name: "极限模式 · 第一次尝试", mode: 0, hardcore: true, difficulty: 3, playedHoursAgo: 24 * 12, seed: 99_120_034n, hue: 5 });
await core.instances.saveConfig("生存 1.21.1", { favorite: true, note: "日常生存存档，原版画质。", gameArgs: "sleep", lastPlayed: now - 3 * HOUR, playTimeMs: 38 * HOUR, createdAt: now - 40 * DAY });

// ---- 2. Fabric: fourteen mods, dies of OutOfMemory ----
const fabric = await install("Fabric 轻量 1.21.1", "1.21.1", { kind: "fabric", version: "0.16.9" });
await mkdir(join(fabric, "mods"), { recursive: true });
const keep = ["sodium", "lithium", "iris", "fabric-api", "modmenu", "ferrite-core", "entityculling", "dynamic-fps", "appleskin", "xaeros-minimap"];
for (const slug of keep) await writeFile(join(fabric, "mods", `${slug}-1.0.0.jar`), olderMods.get(slug)!);
await writeFile(join(fabric, "mods", "lithium-fabric-0.12.0+mc1.21.1.jar"), await fabricJar({ id: "lithium", version: "0.12.0", name: "Lithium", authors: ["jellysquid3"], size: 9000, seed: 3 })); // duplicate id
await writeFile(join(fabric, "mods", "sodium-extra-0.6.0.jar.disabled"), await fabricJar({ id: "sodium_extra", version: "0.6.0", name: "Sodium Extra", depends: { sodium: ">=0.5.0" }, seed: 4 }));
await writeFile(join(fabric, "mods", "better-hud-1.2.jar"), await fabricJar({ id: "better_hud", version: "1.2.0", name: "Better HUD", depends: { "cloth-config": ">=15" }, seed: 5 })); // missing dependency
await writeFile(join(fabric, "mods", "readme.txt.jar"), Buffer.from("this is not a zip")); // unreadable jar
await worldAt(fabric, "Fabric-Test", { name: "Fabric 测试世界", mode: 1, cheats: true, playedHoursAgo: 30, seed: 5_000_000n, hue: 2 });
for (const [i, hue] of [0, 3, 6, 8].entries()) {
  await mkdir(join(fabric, "screenshots"), { recursive: true });
  await writeFile(join(fabric, "screenshots", `2026-10-2${i + 2}_2${i}.1${i}.0${i}.png`), png(640, 360, landscape(hue)));
}
await mkdir(join(fabric, "resourcepacks"), { recursive: true });
await mkdir(join(fabric, "shaderpacks"), { recursive: true });
await writeFile(join(fabric, "resourcepacks", "Faithful-32x.zip"), await zipBuffer({ "pack.mcmeta": JSON.stringify({ pack: { pack_format: 34, description: "§aFaithful §732x §8— 保持原版风格" } }), "pack.png": solid(70, 160, 90) }));
await writeFile(join(fabric, "resourcepacks", "Fresh-Animations.zip"), await zipBuffer({ "pack.mcmeta": JSON.stringify({ pack: { pack_format: 34, description: "Fresh Animations" } }), "pack.png": solid(180, 120, 60) }));
await writeFile(join(fabric, "shaderpacks", "ComplementaryReimagined_r5.2.zip"), await zipBuffer({ "shaders/composite.fsh": "// demo", "shaders/shaders.properties": "profile.A=x" }));
await writeFile(join(fabric, "shaderpacks", "BSL_v8.2.zip"), await zipBuffer({ "shaders/final.fsh": "// demo" }));
await mkdir(join(fabric, "logs"), { recursive: true });
const logLines: string[] = [];
const t = (n: number) => `[${String(21 + Math.floor(n / 3600)).padStart(2, "0")}:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}]`;
logLines.push(`${t(0)} [main/INFO]: Loading Minecraft 1.21.1 with Fabric Loader 0.16.9`);
for (let i = 0; i < 40; i++) logLines.push(`${t(1 + i)} [main/INFO]: [mixin] Mixing ${["SodiumWorldRenderer", "LithiumEntity", "IrisPipeline"][i % 3]}Mixin${i} into class_${700 + i}`);
logLines.push(`${t(44)} [main/WARN]: Mod 'modmenu' requests optional 'cloth-config' which is missing`);
logLines.push(`${t(46)} [Render thread/ERROR]: Failed to load shader pack BSL_v8.2: unsupported GLSL version`);
logLines.push("java.lang.IllegalStateException: shader compile failed", "\tat net.irisshaders.iris.pipeline.IrisRenderingPipeline.<init>(IrisRenderingPipeline.java:211)", "\tat net.irisshaders.iris.Iris.createPipeline(Iris.java:301)");
logLines.push(`${t(50)} [Render thread/INFO]: Reloading ResourceManager: vanilla, Faithful-32x`);
await writeFile(join(fabric, "logs", "latest.log"), `${logLines.join("\n")}\n`);
await mkdir(join(fabric, "crash-reports"), { recursive: true });
await writeFile(
  join(fabric, "crash-reports", "crash-2026-10-27_21.14.08-client.txt"),
  `---- Minecraft Crash Report ----\n// Don't be sad, have a hug! <3\n\nTime: 2026-10-27 21:14:08\nDescription: Rendering overlay\n\njava.lang.OutOfMemoryError: Java heap space\n\tat net.minecraft.class_1011.<init>(class_1011.java:55)\n\tat net.minecraft.class_1060.method_4616(class_1060.java:112)\n\nA detailed walkthrough of the error, its code path and all known details is as follows:\n---------------------------------------------------------------------------------------\n\n-- System Details --\nDetails:\n\tMinecraft Version: 1.21.1\n\tOperating System: Windows 11 (amd64)\n\tJava Version: 21.0.4, Microsoft\n\tMemory: 51234 bytes (0 MiB) / 2147483648 bytes (2048 MiB) up to 2147483648 bytes (2048 MiB)\n\tFabric Mods:\n\t\tsodium: Sodium 1.0.0\n`,
);
const serversFile = join(fabric, "servers.dat");
await addServer(serversFile, { name: "琉匣测试服", ip: `127.0.0.1:${status.port}` });
await addServer(serversFile, { name: "我的生存服", ip: "192.0.2.10:25565" });
await addServer(serversFile, { name: "Hypixel", ip: "mc.hypixel.net" });
await core.instances.saveConfig("Fabric 轻量 1.21.1", { group: "性能", gameArgs: "oom", memory: 2048, lastPlayed: now - 1 * DAY, playTimeMs: 12 * HOUR, createdAt: now - 21 * DAY });

// ---- 3. the pack: NeoForge-style, 64 mods, one missing file, exits with code 3 ----
const pack = await install("机械动力·天空岛", "1.21.1");
{
  const path = versionJsonPath(core.root, "机械动力·天空岛");
  const version = JSON.parse(await readFile(path, "utf8")) as { libraries: unknown[] };
  version.libraries.push({ name: "net.neoforged:neoforge:21.1.77", url: "https://maven.neoforged.net/releases/", sha1: sha1(neoJar), size: neoJar.length });
  await writeFile(path, JSON.stringify(version));
}
await mkdir(join(pack, "mods"), { recursive: true });
const base = ["create", "flywheel", "ponder", "registrate", "jei", "jade", "journeymap", "curios", "architectury", "cloth_config", "geckolib", "balm", "supplementaries", "moonlight", "farmersdelight", "ae2", "mekanism", "sophisticatedbackpacks", "sophisticatedcore", "tconstruct", "mantle", "patchouli", "iceberg", "ftbteams", "ftbchunks", "ftblibrary", "ftbquests", "waystones", "comforts", "cookingforblockheads", "embeddium", "oculus", "ferritecore", "modernfix", "entityculling", "immediatelyfast", "noisium", "alexscaves", "citadel", "aether"];
let seed = 100;
for (const id of base) {
  const name = id.replace(/(^|_)(\w)/g, (_m, _s, c: string) => ` ${c.toUpperCase()}`).trim();
  await writeFile(join(pack, "mods", `${id}-neoforge-${1 + (seed % 5)}.${seed % 9}.${seed % 4}.jar`), await neoJarOf({ id, version: `${1 + (seed % 5)}.${seed % 9}.${seed % 4}`, name, authors: ["Demo Team"], size: 20_000 + (seed % 7) * 11_000, seed, requires: id === "create" ? ["flywheel", "registrate"] : [] }));
  seed++;
}
for (let i = 0; i < 22; i++) await writeFile(join(pack, "mods", `skyward-extra-${String(i).padStart(2, "0")}.jar`), await neoJarOf({ id: `skyward_extra_${i}`, version: "1.0.0", name: `Skyward Extra ${i}`, size: 12_000, seed: 400 + i }));
await writeFile(join(pack, "mods", "create_ae2_bridge-0.3.jar"), await neoJarOf({ id: "create_ae2_bridge", version: "0.3.0", name: "Create AE2 Bridge", requires: ["ae2_wireless_extras"], seed: 77 })); // missing dependency
await writeFile(join(pack, "mods", "jei-neoforge-19.0.jar.disabled"), await neoJarOf({ id: "jei_old", version: "19.0.0", name: "JEI (old)", seed: 78 }));
await worldAt(pack, "Skyward-Main", { name: "天空岛主世界", mode: 0, playedHoursAgo: 5, seed: 123_456_789n, hue: 4 });
const missing = await fabricJar({ id: "create_fancy", version: "1.0.0", name: "Create Fancy", size: 25_000, seed: 8 });
statics.set("/data/skyward-extra/files/fancy/create-fancy-1.0.jar", missing);
await writeFile(
  join(pack, "vitrine-pack.json"),
  JSON.stringify({
    version: 1,
    origin: { source: "modrinth", name: "机械动力·天空岛", version: "1.4.2", projectId: "skyward", versionId: "skyward-142" },
    mcVersion: "1.21.1",
    files: [
      { path: "mods/create-neoforge-1.0.0.jar", urls: [] },
      { path: "mods/create-fancy-1.0.jar", urls: ["https://cdn.modrinth.com/data/skyward-extra/files/fancy/create-fancy-1.0.jar"], size: missing.length, hashes: { sha1: sha1(missing), sha512: sha512(missing) }, label: "Create Fancy" },
    ],
    failed: [{ path: "mods/create-fancy-1.0.jar", label: "Create Fancy", error: "下载失败：连接被重置（演示数据，点“修复”即可补全）" }],
    unresolved: [],
    complete: false,
    updatedAt: now - 2 * HOUR,
  }),
);
await core.instances.saveConfig("机械动力·天空岛", {
  favorite: true, group: "整合包", memory: 6144, gameArgs: "crash-me", note: "我的主力整合包：齿轮、传动与天空岛。", lastPlayed: now - 5 * HOUR, playTimeMs: 120 * HOUR, createdAt: now - 90 * DAY,
  modpack: { source: "modrinth", name: "机械动力·天空岛", version: "1.4.2", projectId: "skyward", versionId: "skyward-142" },
});

// ---- 4. 1.8.9: needs Java 8 ----
await install("1.8.9 PVP", "1.8.9");
await core.instances.saveConfig("1.8.9 PVP", { group: "旧版本", note: "练习 PVP 的旧版本。", lastPlayed: now - 30 * DAY, playTimeMs: 6 * HOUR, createdAt: now - 200 * DAY });

// ---- accounts ----
await core.accounts.addOffline("Wind", { useOwnerUuid: true });

// ---- online pack for the "import" flow (type this path into the file field) ----
await mkdir(join(dir, "packs"), { recursive: true });
await writeFile(join(dir, "packs", "Skyward-Fabric-1.4.2.mrpack"), skyward);

// ------------------------------------------------------------------------------------------------ serve

const server = await startWsServer({ core, port: Number(process.env.VITRINE_PORT ?? 7878), token: process.env.VITRINE_TOKEN });
const webOrigin = process.env.VITRINE_WEB ?? "http://127.0.0.1:5173";
const link = `${webOrigin}/?backend=${encodeURIComponent(server.url)}`;
await writeFile(join(dir, "link.txt"), link);
console.log(`Vitrine demo ready — data in ${dir}`);
console.log(`Open the interface with:\n  ${link}`);
console.log(`Importable modpack file: ${join(dir, "packs", "Skyward-Fabric-1.4.2.mrpack")}`);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  core.games.killAll();
  await server.close();
  await core.dispose();
  await content.close();
  await mojang.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
