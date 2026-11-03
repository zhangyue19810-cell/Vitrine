import { createHash } from "node:crypto";
import yazl from "yazl";
import { bytes, sha1, startMock, type MockServer } from "./mock-server";
import { serveBytes } from "./mock-server";

export function zipBuffer(files: Record<string, Buffer | string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, data] of Object.entries(files)) zip.addBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data), name);
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

export interface FakeVersionSpec {
  id: string;
  type?: string;
  javaMajor?: number;
  assetCount?: number;
  /** Replace the default client jar (e.g. with a jar holding a real main class). */
  clientJar?: Buffer;
  mainClass?: string;
  legacy?: boolean;
}

export interface FakeWorld {
  server: MockServer;
  /** Use as SourceSettings.mirrorBase together with policy "mirror-only". */
  mirrorBase: string;
  versions: Map<string, { json: Record<string, unknown>; jar: Buffer; jsonBuffer: Buffer; sha1: string; libraries: { path: string; data: Buffer }[]; assets: { hash: string; data: Buffer }[] }>;
  /** Number of requests per route prefix, for assertions. */
  hits: Record<string, number>;
  /** Register another route (mirror path → content). */
  add(path: string, data: Buffer | string): void;
  close(): Promise<void>;
}

const OFFICIAL = {
  libs: "https://libraries.minecraft.net",
  data: "https://piston-data.mojang.com",
  meta: "https://piston-meta.mojang.com",
  assets: "https://resources.download.minecraft.net",
};

/** A tiny stand-in for Mojang + BMCLAPI, serving mirror-style paths. */
export async function startFakeMojang(specs: FakeVersionSpec[]): Promise<FakeWorld> {
  const files = new Map<string, Buffer>();
  const hits: Record<string, number> = {};
  const versions: FakeWorld["versions"] = new Map();
  const manifestEntries: Record<string, unknown>[] = [];

  const nativeWin = await zipBuffer({
    "windows/x64/org/lwjgl/lwjgl.dll": bytes(2048, 77),
    "windows/x64/org/lwjgl/lwjgl.dll.sha1": "abc",
    "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n",
  });

  for (const spec of specs) {
    const jar = spec.clientJar ?? (await zipBuffer({ "net/minecraft/client/main/Main.class": bytes(300, spec.id.length + 3), "version.json": JSON.stringify({ id: spec.id, name: spec.id }) }));
    const jarSha = sha1(jar);
    files.set(`/v1/objects/${jarSha}/client.jar`, jar);

    const libs: { path: string; data: Buffer }[] = [];
    const libJson: Record<string, unknown>[] = [];
    const addLib = (name: string, data: Buffer, extra: Record<string, unknown> = {}) => {
      const [g, a, v, c] = name.split(":");
      const path = `${g.replace(/\./g, "/")}/${a}/${v}/${a}-${v}${c ? `-${c}` : ""}.jar`;
      files.set(`/maven/${path}`, data);
      libs.push({ path, data });
      libJson.push({ name, downloads: { artifact: { path, sha1: sha1(data), size: data.length, url: `${OFFICIAL.libs}/${path}` } }, ...extra });
    };
    const jarOf = (size: number, seed: number) => zipBuffer({ "data.bin": bytes(size, seed) });
    addLib("com.mojang:brigadier:1.1.8", await jarOf(5000, 1));
    addLib("com.google.guava:guava:31.1-jre", await jarOf(9000, 2));
    addLib("org.lwjgl:lwjgl:3.3.1", await jarOf(7000, 3));
    addLib("org.lwjgl:lwjgl:3.3.1:natives-windows", nativeWin, { rules: [{ action: "allow", os: { name: "windows" } }] });
    addLib("org.lwjgl:lwjgl:3.3.1:natives-linux", await zipBuffer({ "linux/x64/org/lwjgl/liblwjgl.so": bytes(3000, 4) }), { rules: [{ action: "allow", os: { name: "linux" } }] });

    // Old-style natives with a classifier map.
    const oldNative = await zipBuffer({ "lwjgl64.dll": bytes(1500, 9), "META-INF/x.sf": "sig" });
    const oldPath = "org/lwjgl/lwjgl/lwjgl-platform/2.9.4/lwjgl-platform-2.9.4-natives-windows.jar";
    files.set(`/maven/${oldPath}`, oldNative);
    libs.push({ path: oldPath, data: oldNative });
    libJson.push({
      name: "org.lwjgl.lwjgl:lwjgl-platform:2.9.4",
      natives: { windows: "natives-windows", linux: "natives-linux" },
      extract: { exclude: ["META-INF/"] },
      downloads: { classifiers: { "natives-windows": { path: oldPath, sha1: sha1(oldNative), size: oldNative.length, url: `${OFFICIAL.libs}/${oldPath}` } } },
    });

    const assetCount = spec.assetCount ?? 40;
    const assets: { hash: string; data: Buffer }[] = [];
    const objects: Record<string, { hash: string; size: number }> = {};
    for (let i = 0; i < assetCount; i++) {
      const data = bytes(200 + ((i * 131) % 4000), 1000 + i);
      const hash = sha1(data);
      files.set(`/assets/${hash.slice(0, 2)}/${hash}`, data);
      assets.push({ hash, data });
      objects[`minecraft/sounds/${spec.id}/s${i}.ogg`] = { hash, size: data.length };
    }
    const indexId = spec.legacy ? "legacy" : "12";
    const index = Buffer.from(JSON.stringify(spec.legacy ? { virtual: true, objects } : { objects }));
    const indexSha = sha1(index);
    files.set(`/v1/packages/${indexSha}/${indexId}.json`, index);

    const mappings = Buffer.from(`# mappings for ${spec.id}\ncom.example.Foo -> a:\n`);
    const mappingsSha = sha1(mappings);
    files.set(`/v1/objects/${mappingsSha}/client.txt`, mappings);

    const logCfg = Buffer.from('<Configuration status="WARN"/>');
    const logSha = sha1(logCfg);
    files.set(`/v1/objects/${logSha}/client-1.12.xml`, logCfg);

    const json: Record<string, unknown> = {
      id: spec.id,
      type: spec.type ?? "release",
      mainClass: spec.mainClass ?? "net.minecraft.client.main.Main",
      releaseTime: "2023-06-12T13:25:51+00:00",
      time: "2023-06-12T13:25:51+00:00",
      assets: indexId,
      assetIndex: { id: indexId, sha1: indexSha, size: index.length, totalSize: 1, url: `${OFFICIAL.meta}/v1/packages/${indexSha}/${indexId}.json` },
      downloads: {
        client: { sha1: jarSha, size: jar.length, url: `${OFFICIAL.data}/v1/objects/${jarSha}/client.jar` },
        client_mappings: { sha1: mappingsSha, size: mappings.length, url: `${OFFICIAL.data}/v1/objects/${mappingsSha}/client.txt` },
      },
      javaVersion: { component: "java-runtime-gamma", majorVersion: spec.javaMajor ?? 17 },
      libraries: libJson,
      logging: { client: { argument: "-Dlog4j.configurationFile=${path}", type: "log4j2-xml", file: { id: "client-1.12.xml", sha1: logSha, size: logCfg.length, url: `${OFFICIAL.data}/v1/objects/${logSha}/client-1.12.xml` } } },
      arguments: {
        game: [
          "--username", "${auth_player_name}", "--version", "${version_name}", "--gameDir", "${game_directory}",
          "--assetsDir", "${assets_root}", "--assetIndex", "${assets_index_name}", "--uuid", "${auth_uuid}",
          "--accessToken", "${auth_access_token}", "--userType", "${user_type}", "--versionType", "${version_type}",
          { rules: [{ action: "allow", features: { is_demo_user: true } }], value: "--demo" },
          { rules: [{ action: "allow", features: { has_custom_resolution: true } }], value: ["--width", "${resolution_width}", "--height", "${resolution_height}"] },
          { rules: [{ action: "allow", features: { is_quick_play_multiplayer: true } }], value: ["--quickPlayMultiplayer", "${quickPlayMultiplayer}"] },
        ],
        jvm: [
          { rules: [{ action: "allow", os: { name: "windows" } }], value: "-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump" },
          { rules: [{ action: "allow", os: { name: "osx" } }], value: ["-XstartOnFirstThread"] },
          "-Djava.library.path=${natives_directory}",
          "-Dminecraft.launcher.brand=${launcher_name}",
          "-Dminecraft.launcher.version=${launcher_version}",
          "-cp",
          "${classpath}",
        ],
      },
    };
    if (spec.legacy) {
      delete json.arguments;
      json.minecraftArguments = "--username ${auth_player_name} --session ${auth_session} --version ${version_name} --gameDir ${game_directory} --assetsDir ${game_assets}";
    }
    const jsonBuffer = Buffer.from(JSON.stringify(json));
    const jsonSha = createHash("sha1").update(jsonBuffer).digest("hex");
    files.set(`/v1/packages/${jsonSha}/${spec.id}.json`, jsonBuffer);
    manifestEntries.push({
      id: spec.id,
      type: json.type,
      // a mirror rewrites the url to itself; the catalog must undo that using the sha1
      url: `__MIRROR__/v1/packages/${jsonSha}/${spec.id}.json`,
      time: "2023-06-12T13:25:51+00:00",
      releaseTime: "2023-06-12T13:25:51+00:00",
      sha1: jsonSha,
      complianceLevel: 1,
    });
    versions.set(spec.id, { json, jar, jsonBuffer, sha1: jsonSha, libraries: libs, assets });
  }

  let base = "";
  const server = await startMock(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const bucket = path.split("/")[1] || "root";
    hits[bucket] = (hits[bucket] ?? 0) + 1;
    if (path === "/mc/game/version_manifest_v2.json") {
      const body = JSON.stringify({
        latest: { release: specs[0].id, snapshot: specs[0].id },
        versions: manifestEntries.map((entry) => ({ ...entry, url: String(entry.url).replace("__MIRROR__", base) })),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    const data = files.get(path);
    if (!data) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    await serveBytes(req, res, data);
  });
  base = server.url;
  return {
    server,
    mirrorBase: server.url,
    versions,
    hits,
    add: (path, data) => {
      files.set(path, Buffer.isBuffer(data) ? data : Buffer.from(data));
    },
    close: () => server.close(),
  };
}
