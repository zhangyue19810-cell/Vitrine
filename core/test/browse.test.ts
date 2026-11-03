import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyModUpdate, bestVersion, checkModUpdates, getProject, installContent, listContentVersions, searchContent, type ContentDeps } from "../src/content/browse";
import { CurseForgeClient } from "../src/content/curseforge";
import { ModrinthClient } from "../src/content/modrinth";
import { DEFAULT_ENGINE, DownloadEngine } from "../src/net/download";
import { HttpClient } from "../src/net/http";
import { DEFAULT_SOURCES, SourceRouter } from "../src/net/sources";
import { bytes, sha1 } from "./helpers/mock-server";
import { json, startContent, type Content } from "./helpers/content-server";
import { zipBuffer } from "./helpers/fake-mojang";

const http = new HttpClient({ userAgent: "vitrine-test" });
after(() => http.destroy());
const sha512 = (data: Buffer | string) => createHash("sha512").update(data).digest("hex");

let tmp: string;
let content: Content | undefined;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vitrine-browse-"));
});
afterEach(async () => {
  await content?.server.close();
  content = undefined;
  await rm(tmp, { recursive: true, force: true });
});

function deps(c: Content, key?: string): ContentDeps {
  const settings = { ...DEFAULT_SOURCES, policy: "mirror-only" as const, mirrorBase: c.server.url, contentPolicy: "mirror-only" as const, contentMirrorBase: c.server.url };
  const router = new SourceRouter(() => settings);
  return {
    modrinth: new ModrinthClient({ http, router }),
    curseforge: new CurseForgeClient({ http, router }, () => key),
    router,
    engine: new DownloadEngine(http, () => ({ ...DEFAULT_ENGINE, retries: 2, backoffBaseMs: 5, concurrency: 8 })),
  };
}

/** A Modrinth version record whose file is served by the mock CDN. */
function mrVersion(c: Content, spec: { project: string; id: string; number?: string; type?: "release" | "beta" | "alpha"; file: string; data?: Buffer; deps?: Record<string, unknown>[]; published?: string }) {
  const data = spec.data ?? bytes(1200 + spec.id.length * 50, spec.id.charCodeAt(0) * 31);
  const urlPath = `/data/${spec.project}/versions/${spec.id}/${spec.file}`;
  c.statics.set(urlPath, data);
  return {
    data,
    json: {
      id: spec.id,
      project_id: spec.project,
      name: spec.number ?? "1.0.0",
      version_number: spec.number ?? "1.0.0",
      game_versions: ["1.20.1"],
      loaders: ["fabric"],
      version_type: spec.type ?? "release",
      date_published: spec.published ?? "2024-03-01T00:00:00Z",
      downloads: 10,
      dependencies: spec.deps ?? [],
      files: [{ hashes: { sha1: sha1(data), sha512: sha512(data) }, url: `https://cdn.modrinth.com${urlPath}`, filename: spec.file, primary: true, size: data.length }],
    },
  };
}

function mrProject(id: string, title: string, extra: Record<string, unknown> = {}) {
  return { id, slug: id.toLowerCase(), title, description: `${title} description`, project_type: "mod", categories: ["library"], game_versions: ["1.20.1"], loaders: ["fabric"], downloads: 5, followers: 1, ...extra };
}

describe("searching", () => {
  it("builds the Modrinth query from the filters and maps the hits", async () => {
    content = await startContent();
    const queries: URLSearchParams[] = [];
    content.routes.set("GET /modrinth/v2/search", (_req, res, url) => {
      queries.push(url.searchParams);
      json(res, { hits: [{ project_id: "AANobbMI", slug: "sodium", title: "Sodium", description: "Renderer", author: "jellysquid3", icon_url: "https://cdn.modrinth.com/i.png", downloads: 99, follows: 5, categories: ["optimization", "fabric"], versions: ["1.20.1"], project_type: "mod", date_modified: "2024-02-02T00:00:00Z", client_side: "required", server_side: "unsupported" }], offset: 40, limit: 20, total_hits: 321 });
    });
    const d = deps(content);
    const result = await searchContent(d, { source: "modrinth", kind: "mod", query: "sodium", gameVersion: "1.20.1", loader: "fabric", sort: "downloads", category: "optimization", page: 2, pageSize: 20 });
    assert.equal(result.total, 321);
    assert.equal(result.page, 2);
    assert.deepEqual(result.projects[0], { source: "modrinth", id: "AANobbMI", slug: "sodium", kind: "mod", title: "Sodium", summary: "Renderer", author: "jellysquid3", iconUrl: "https://cdn.modrinth.com/i.png", downloads: 99, categories: ["optimization", "fabric"], updatedAt: "2024-02-02T00:00:00Z", pageUrl: "https://modrinth.com/mod/sodium", clientSide: "required", serverSide: "unsupported" });
    const q = queries[0];
    assert.equal(q.get("query"), "sodium");
    assert.equal(q.get("index"), "downloads");
    assert.equal(q.get("offset"), "40");
    assert.equal(q.get("limit"), "20");
    assert.deepEqual(JSON.parse(q.get("facets")!), [["project_type:mod"], ["versions:1.20.1"], ["categories:fabric"], ["categories:optimization"]]);

    await searchContent(d, { source: "modrinth", kind: "shader", gameVersion: "1.20.1", loader: "fabric" });
    assert.deepEqual(JSON.parse(queries[1].get("facets")!), [["project_type:shader"], ["versions:1.20.1"]], "shaders are not loader-specific");
    assert.equal(queries[1].get("index"), "downloads", "browsing without a query sorts by downloads");
  });

  it("queries CurseForge through the mirror without leaking a key", async () => {
    content = await startContent();
    const queries: URLSearchParams[] = [];
    content.routes.set("GET /curseforge/v1/mods/search", (_req, res, url) => {
      queries.push(url.searchParams);
      json(res, { data: [{ id: 238222, name: "Jei", slug: "jei", summary: "Items", downloadCount: 7, logo: { url: "https://media.forgecdn.net/big.png", thumbnailUrl: "https://media.forgecdn.net/small.png" }, authors: [{ name: "mezz" }], categories: [{ id: 1, name: "Utility" }], classId: 6, links: { websiteUrl: "https://www.curseforge.com/minecraft/mc-mods/jei" }, dateModified: "2024-01-01T00:00:00Z" }], pagination: { index: 20, pageSize: 20, totalCount: 55 } });
    });
    const d = deps(content, "my-key");
    const result = await searchContent(d, { source: "curseforge", kind: "mod", query: "jei", gameVersion: "1.20.1", loader: "fabric", sort: "downloads", page: 1 });
    assert.equal(result.total, 55);
    assert.deepEqual(result.projects[0], { source: "curseforge", id: "238222", slug: "jei", kind: "mod", title: "Jei", summary: "Items", author: "mezz", iconUrl: "https://media.forgecdn.net/small.png", downloads: 7, categories: ["Utility"], updatedAt: "2024-01-01T00:00:00Z", pageUrl: "https://www.curseforge.com/minecraft/mc-mods/jei" });
    const q = queries[0];
    assert.deepEqual(Object.fromEntries([...q.entries()]), { gameId: "432", classId: "6", searchFilter: "jei", sortField: "6", sortOrder: "desc", index: "20", pageSize: "20", gameVersion: "1.20.1", modLoaderType: "4" });
    assert.equal(content.seen.at(-1)?.headers["x-api-key"], undefined);

    await searchContent(d, { source: "curseforge", kind: "resourcepack", gameVersion: "1.20.1", loader: "fabric" });
    assert.equal(queries[1].get("classId"), "12");
    assert.equal(queries[1].get("modLoaderType"), null, "resource packs are not loader-specific");
  });

  it("reads project details", async () => {
    content = await startContent();
    content.routes.set("GET /modrinth/v2/project/sodium", (_req, res) => json(res, mrProject("AANobbMI", "Sodium", { slug: "sodium", body: "# Long description" })));
    content.routes.set("GET /curseforge/v1/mods/238222", (_req, res) => json(res, { data: { id: 238222, name: "Jei", slug: "jei", summary: "s", downloadCount: 1, classId: 6 } }));
    const d = deps(content);
    const modrinth = await getProject(d, "modrinth", "sodium");
    assert.equal(modrinth.body, "# Long description");
    assert.equal(modrinth.pageUrl, "https://modrinth.com/mod/sodium");
    assert.equal((await getProject(d, "curseforge", "238222")).title, "Jei");
  });
});

describe("versions", () => {
  it("lists Modrinth versions for the instance and prefers a release over a newer beta", async () => {
    content = await startContent();
    let seen: URLSearchParams | undefined;
    const beta = mrVersion(content, { project: "P", id: "VB", number: "2.0.0-beta", type: "beta", file: "p-2.0.0-beta.jar" });
    const release = mrVersion(content, { project: "P", id: "VR", number: "1.9.0", file: "p-1.9.0.jar", deps: [{ project_id: "LIB", dependency_type: "required" }, { project_id: "EMB", dependency_type: "embedded" }, { version_id: null, project_id: null, file_name: "x.jar", dependency_type: "optional" }] });
    content.routes.set("GET /modrinth/v2/project/P/version", (_req, res, url) => {
      seen = url.searchParams;
      json(res, [beta.json, release.json]);
    });
    const versions = await listContentVersions(deps(content), "modrinth", "P", { gameVersion: "1.20.1", loader: "fabric" });
    assert.deepEqual(JSON.parse(seen!.get("loaders")!), ["fabric"]);
    assert.deepEqual(JSON.parse(seen!.get("game_versions")!), ["1.20.1"]);
    assert.equal(bestVersion(versions)?.id, "VR");
    assert.deepEqual(versions[1].dependencies.map((dep) => `${dep.projectId ?? "-"}:${dep.kind}`), ["LIB:required", "EMB:embedded", "-:optional"]);
    assert.equal(versions[0].files[0].hashes.sha1, sha1(beta.data));
    assert.equal(bestVersion([versions[0]])?.id, "VB");
    assert.equal(bestVersion([]), undefined);
  });

  it("maps CurseForge files, newest first, flagging restricted downloads", async () => {
    content = await startContent();
    const file = (id: number, name: string, date: string, release: number, url: string | null) => ({ id, modId: 100, displayName: name, fileName: `${name}.jar`, releaseType: release, fileDate: date, fileLength: 500, downloadCount: 3, downloadUrl: url, hashes: [{ value: "a".repeat(40), algo: 1 }], gameVersions: ["1.20.1", "Fabric", "Client"], dependencies: [{ modId: 7, relationType: 3 }, { modId: 8, relationType: 2 }, { modId: 9, relationType: 5 }, { modId: 10, relationType: 4 }], isAvailable: true });
    let seen: URLSearchParams | undefined;
    content.routes.set("GET /curseforge/v1/mods/100/files", (_req, res, url) => {
      seen = url.searchParams;
      json(res, { data: [file(1, "old", "2023-01-01T00:00:00Z", 1, "https://edge.forgecdn.net/files/1/0/old.jar"), file(3, "new-beta", "2024-06-01T00:00:00Z", 2, null), file(2, "new-release", "2024-05-01T00:00:00Z", 1, "https://edge.forgecdn.net/files/2/0/new-release.jar"), { ...file(4, "gone", "2024-07-01T00:00:00Z", 1, null), isAvailable: false }] });
    });
    const versions = await listContentVersions(deps(content), "curseforge", "100", { gameVersion: "1.20.1", loader: "fabric" });
    assert.equal(seen?.get("modLoaderType"), "4");
    assert.deepEqual(versions.map((version) => version.id), ["3", "2", "1"], "newest first, unavailable files dropped");
    assert.equal(versions[0].channel, "beta");
    assert.equal(versions[0].files[0].restricted, true);
    assert.equal(versions[1].files[0].restricted, false);
    assert.deepEqual(versions[1].loaders, ["fabric"]);
    assert.deepEqual(versions[1].gameVersions, ["1.20.1"]);
    assert.deepEqual(versions[1].dependencies.map((dep) => `${dep.projectId}:${dep.kind}`), ["7:required", "8:optional", "9:incompatible"]);
    assert.equal(bestVersion(versions)?.id, "2");
  });
});

describe("installing content", () => {
  it("installs a mod with its required dependencies, skipping what is already there", async () => {
    content = await startContent();
    const c = content;
    const game = join(tmp, "game");
    await mkdir(join(game, "mods"), { recursive: true });
    // B is already installed (under a different file name) and must not be installed twice
    const installedB = bytes(900, 77);
    await writeFile(join(game, "mods", "lib-b-0.1.jar"), installedB);
    const a = mrVersion(c, { project: "A", id: "VA", number: "3.0", file: "a-3.0.jar", deps: [{ project_id: "B", dependency_type: "required" }, { version_id: "VC", project_id: "C", dependency_type: "required" }, { project_id: "D", dependency_type: "optional" }, { project_id: "E", dependency_type: "embedded" }, { project_id: "G", dependency_type: "required" }] });
    const cVersion = mrVersion(c, { project: "C", id: "VC", number: "2.2", file: "c-2.2.jar", deps: [{ project_id: "F", dependency_type: "required" }] });
    const f = mrVersion(c, { project: "F", id: "VF", number: "1.1", file: "f-1.1.jar", deps: [{ project_id: "A", dependency_type: "required" }] }); // a cycle back to A
    c.routes.set("GET /modrinth/v2/project/A/version", (_req, res) => json(res, [a.json]));
    c.routes.set("GET /modrinth/v2/version/VC", (_req, res) => json(res, cVersion.json));
    c.routes.set("GET /modrinth/v2/project/F/version", (_req, res) => json(res, [f.json]));
    c.routes.set("GET /modrinth/v2/project/G/version", (_req, res) => json(res, []));
    c.routes.set("GET /modrinth/v2/project/B/version", (_req, res) => json(res, [mrVersion(c, { project: "B", id: "VB", file: "lib-b-1.0.jar" }).json]));
    for (const [id, title] of [["A", "Mod A"], ["B", "Lib B"], ["C", "Lib C"], ["F", "Lib F"], ["G", "Lib G"]]) c.routes.set(`GET /modrinth/v2/project/${id}`, (_req, res) => json(res, mrProject(id, title)));
    c.routes.set("POST /modrinth/v2/version_files", (_req, res, _url, body) => {
      const hashes: string[] = JSON.parse(body).hashes;
      const out: Record<string, unknown> = {};
      if (hashes.includes(sha1(installedB))) out[sha1(installedB)] = { ...mrVersion(c, { project: "B", id: "VB-OLD", file: "lib-b-0.1.jar", data: installedB }).json };
      json(res, out);
    });

    const plan: { title: string; dependency: boolean }[] = [];
    const result = await installContent(deps(c), { gameDir: game, kind: "mod", source: "modrinth", projectId: "A", filter: { gameVersion: "1.20.1", loader: "fabric" }, onPlan: (items) => plan.push(...items) });
    assert.deepEqual(result.installed.map((item) => `${item.title}:${item.dependency}:${item.path}`).sort(), ["Lib C:true:mods/c-2.2.jar", "Lib F:true:mods/f-1.1.jar", "Mod A:false:mods/a-3.0.jar"]);
    assert.deepEqual(result.skipped, [{ title: "Lib B", reason: "已安装" }]);
    assert.deepEqual(result.failed.map((entry) => entry.title), ["Lib G"]);
    assert.deepEqual(plan.map((item) => item.title).sort(), ["Lib C", "Lib F", "Mod A"]);
    assert.deepEqual(await readFile(join(game, "mods", "a-3.0.jar")), a.data);
    assert.deepEqual(await readFile(join(game, "mods", "c-2.2.jar")), cVersion.data);
    assert.deepEqual((await readdir(join(game, "mods"))).sort(), ["a-3.0.jar", "c-2.2.jar", "f-1.1.jar", "lib-b-0.1.jar"]);

    // without dependency handling only the mod itself arrives
    const solo = await installContent(deps(c), { gameDir: join(tmp, "solo"), kind: "mod", source: "modrinth", projectId: "A", filter: { gameVersion: "1.20.1", loader: "fabric" }, withDependencies: false });
    assert.deepEqual(solo.installed.map((item) => item.title), ["Mod A"]);
  });

  it("puts resource packs, shaders and data packs in their folders and refuses unsafe names", async () => {
    content = await startContent();
    const c = content;
    const game = join(tmp, "game");
    const pack = mrVersion(c, { project: "RP", id: "VRP", file: "faithful.zip" });
    const shader = mrVersion(c, { project: "SH", id: "VSH", file: "bliss.zip" });
    const data = mrVersion(c, { project: "DP", id: "VDP", file: "tweaks.zip" });
    const bad = mrVersion(c, { project: "BAD", id: "VBAD", file: "evil:name.jar" });
    for (const [id, version, title] of [["RP", pack, "Faithful"], ["SH", shader, "Bliss"], ["DP", data, "Tweaks"], ["BAD", bad, "Bad"]] as const) {
      c.routes.set(`GET /modrinth/v2/project/${id}/version`, (_req, res) => json(res, [version.json]));
      c.routes.set(`GET /modrinth/v2/project/${id}`, (_req, res) => json(res, mrProject(id, title)));
    }
    const d = deps(c);
    const filter = { gameVersion: "1.20.1" };
    assert.equal((await installContent(d, { gameDir: game, kind: "resourcepack", source: "modrinth", projectId: "RP", filter })).installed[0].path, "resourcepacks/faithful.zip");
    assert.equal((await installContent(d, { gameDir: game, kind: "shader", source: "modrinth", projectId: "SH", filter })).installed[0].path, "shaderpacks/bliss.zip");
    assert.equal((await installContent(d, { gameDir: game, kind: "datapack", source: "modrinth", projectId: "DP", filter, world: "My World" })).installed[0].path, "saves/My World/datapacks/tweaks.zip");
    await assert.rejects(installContent(d, { gameDir: game, kind: "datapack", source: "modrinth", projectId: "DP", filter }), /选择一个存档/);
    await assert.rejects(installContent(d, { gameDir: game, kind: "datapack", source: "modrinth", projectId: "DP", filter, world: "../escape" }), /选择一个存档/);
    const unsafe = await installContent(d, { gameDir: game, kind: "resourcepack", source: "modrinth", projectId: "BAD", filter });
    assert.equal(unsafe.installed.length, 0);
    assert.match(unsafe.failed[0].error, /文件名不安全/);
    assert.deepEqual(await readdir(join(game, "resourcepacks")), ["faithful.zip"]);
    await assert.rejects(stat(join(game, "saves", "escape")));
  });

  it("installs from CurseForge and points to the project page when the CDN refuses", async () => {
    content = await startContent();
    const c = content;
    const good = bytes(1500, 5);
    const hidden = bytes(1600, 6);
    const cfFile = (id: number, modId: number, name: string, data: Buffer, url: string | null, deps: { modId: number; relationType: number }[] = []) => ({ id, modId, displayName: name, fileName: name, releaseType: 1, fileDate: "2024-05-01T00:00:00Z", fileLength: data.length, downloadUrl: url, hashes: [{ value: sha1(data), algo: 1 }], gameVersions: ["1.20.1", "Fabric"], dependencies: deps, isAvailable: true });
    c.statics.set("/files/5000/1/main-mod.jar", good);
    c.routes.set("GET /curseforge/v1/mods/500/files", (_req, res) => json(res, { data: [cfFile(5000001, 500, "main-mod.jar", good, "https://edge.forgecdn.net/files/5000/1/main-mod.jar", [{ modId: 501, relationType: 3 }])] }));
    c.routes.set("GET /curseforge/v1/mods/501/files", (_req, res) => json(res, { data: [cfFile(5001001, 501, "hidden-lib.jar", hidden, null)] }));
    c.routes.set("GET /curseforge/v1/mods/500", (_req, res) => json(res, { data: { id: 500, name: "Main Mod", slug: "main-mod", summary: "", downloadCount: 1, classId: 6, links: { websiteUrl: "https://www.curseforge.com/minecraft/mc-mods/main-mod" } } }));
    c.routes.set("GET /curseforge/v1/mods/501", (_req, res) => json(res, { data: { id: 501, name: "Hidden Lib", slug: "hidden-lib", summary: "", downloadCount: 1, classId: 6, links: { websiteUrl: "https://www.curseforge.com/minecraft/mc-mods/hidden-lib" } } }));
    c.routes.set("POST /modrinth/v2/version_files", (_req, res) => json(res, {}));
    const result = await installContent(deps(c, "k"), { gameDir: join(tmp, "game"), kind: "mod", source: "curseforge", projectId: "500", filter: { gameVersion: "1.20.1", loader: "fabric" } });
    assert.deepEqual(result.installed.map((item) => item.title), ["Main Mod"]);
    assert.deepEqual(result.failed, [{ title: "Hidden Lib", error: result.failed[0].error, pageUrl: "https://www.curseforge.com/minecraft/mc-mods/hidden-lib" }]);
    assert.deepEqual(await readFile(join(tmp, "game", "mods", "main-mod.jar")), good);
  });

  it("can be cancelled", async () => {
    content = await startContent();
    content.fileDelayMs = 300;
    const c = content;
    const slow = mrVersion(c, { project: "SLOW", id: "VS", file: "slow.jar" });
    c.routes.set("GET /modrinth/v2/project/SLOW/version", (_req, res) => json(res, [slow.json]));
    c.routes.set("GET /modrinth/v2/project/SLOW", (_req, res) => json(res, mrProject("SLOW", "Slow")));
    c.routes.set("POST /modrinth/v2/version_files", (_req, res) => json(res, {}));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(installContent(deps(c), { gameDir: join(tmp, "game"), kind: "mod", source: "modrinth", projectId: "SLOW", filter: {}, signal: controller.signal }), (error: Error) => error.name === "AbortError");
  });
});

describe("mod updates", () => {
  it("finds newer versions by file hash and applies them", async () => {
    content = await startContent();
    const c = content;
    const game = join(tmp, "game");
    await mkdir(join(game, "mods"), { recursive: true });
    const fabric = (id: string) => JSON.stringify({ id, name: id, version: "1" });
    const oldA = await zipBuffer({ "fabric.mod.json": fabric("a") });
    const currentB = await zipBuffer({ "fabric.mod.json": fabric("b") });
    const unknownC = await zipBuffer({ "fabric.mod.json": fabric("c") });
    await writeFile(join(game, "mods", "a-1.0.jar"), oldA);
    await writeFile(join(game, "mods", "b-1.0.jar"), currentB);
    await writeFile(join(game, "mods", "c-1.0.jar"), unknownC);
    await writeFile(join(game, "mods", "d-1.0.jar.disabled"), await zipBuffer({ "fabric.mod.json": fabric("d") }));

    const newA = await zipBuffer({ "fabric.mod.json": JSON.stringify({ id: "a", name: "a", version: "2" }) });
    const currentVersionA = mrVersion(c, { project: "PA", id: "VA1", number: "1.0", file: "a-1.0.jar", data: oldA });
    const latestVersionA = mrVersion(c, { project: "PA", id: "VA2", number: "2.0", file: "a-2.0.jar", data: newA });
    const versionB = mrVersion(c, { project: "PB", id: "VB1", number: "1.0", file: "b-1.0.jar", data: currentB });
    c.routes.set("POST /modrinth/v2/version_files", (_req, res, _url, body) => {
      const request = JSON.parse(body) as { hashes: string[]; algorithm: string };
      assert.equal(request.algorithm, "sha1");
      assert.equal(request.hashes.length, 3, "disabled mods are not checked");
      json(res, { [sha1(oldA)]: currentVersionA.json, [sha1(currentB)]: versionB.json });
    });
    c.routes.set("POST /modrinth/v2/version_files/update", (_req, res, _url, body) => {
      const request = JSON.parse(body) as { hashes: string[]; loaders: string[]; game_versions: string[] };
      assert.deepEqual(request.loaders, ["fabric"]);
      assert.deepEqual(request.game_versions, ["1.20.1"]);
      assert.deepEqual(request.hashes.sort(), [sha1(oldA), sha1(currentB)].sort(), "only recognised files are sent");
      json(res, { [sha1(oldA)]: latestVersionA.json, [sha1(currentB)]: versionB.json });
    });
    c.routes.set("GET /modrinth/v2/projects", (_req, res, url) => {
      assert.deepEqual(JSON.parse(url.searchParams.get("ids")!), ["PA"], "titles are only fetched for mods with updates");
      json(res, [mrProject("PA", "Mod A Pretty Name")]);
    });
    const d = deps(c);
    const check = await checkModUpdates(d, game, { loaders: ["fabric"], gameVersions: ["1.20.1"] });
    assert.equal(check.checked, 3);
    assert.equal(check.unknown, 1);
    assert.equal(check.updates.length, 1);
    const update = check.updates[0];
    assert.deepEqual({ file: update.file, path: update.path, title: update.title, currentVersion: update.currentVersion, latest: update.latest.versionNumber }, { file: "a-1.0.jar", path: "mods/a-1.0.jar", title: "Mod A Pretty Name", currentVersion: "1.0", latest: "2.0" });

    const applied = await applyModUpdate(d, game, update);
    assert.equal(applied.path, "mods/a-2.0.jar");
    assert.deepEqual(await readFile(join(game, "mods", "a-2.0.jar")), newA);
    assert.deepEqual((await readdir(join(game, "mods"))).sort(), ["a-2.0.jar", "b-1.0.jar", "c-1.0.jar", "d-1.0.jar.disabled"]);
  });
});
