import type { IncomingMessage, ServerResponse } from "node:http";
import type { VersionJson } from "../../src/mc/types";
import { serveBytes, sha1, startMock, type MockServer } from "./mock-server";
import { startFakeMojang, zipBuffer, type FakeWorld } from "./fake-mojang";

/** A fake Mojang + Fabric world and a fake content network (Modrinth / CurseForge APIs and CDNs). */
export interface Content {
  server: MockServer;
  statics: Map<string, Buffer>;
  routes: Map<string, (req: IncomingMessage, res: ServerResponse, url: URL, body: string) => void | Promise<void>>;
  /** Headers seen on API calls (to prove secrets do not reach a mirror). */
  seen: { path: string; headers: IncomingMessage["headers"] }[];
  fileDelayMs: number;
  /** Paths for which the server pretends to have a damaged copy. */
  corrupt: Set<string>;
}

export async function startContent(): Promise<Content> {
  const statics = new Map<string, Buffer>();
  const routes: Content["routes"] = new Map();
  const seen: Content["seen"] = [];
  const corrupt = new Set<string>();
  const state: Content = { server: undefined as unknown as MockServer, statics, routes, seen, fileDelayMs: 30, corrupt };
  state.server = await startMock(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    seen.push({ path: `${req.method} ${url.pathname}`, headers: req.headers });
    const route = routes.get(`${req.method} ${url.pathname}`);
    if (route) return route(req, res, url, body);
    const data = statics.get(url.pathname);
    if (!data) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const served = corrupt.has(url.pathname) ? Buffer.from(data).fill(0x41) : data;
    await serveBytes(req, res, served, { delayMs: state.fileDelayMs });
  });
  return state;
}

export const json = (res: ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

export async function fabricWorld(): Promise<FakeWorld> {
  const w = await startFakeMojang([{ id: "1.20.1", assetCount: 4 }]);
  const loaderJar = await zipBuffer({ "fabric.mod.json": "{}" });
  const intermediary = await zipBuffer({ "mappings/mappings.tiny": "x" });
  w.add("/maven/net/fabricmc/fabric-loader/0.15.11/fabric-loader-0.15.11.jar", loaderJar);
  w.add("/maven/net/fabricmc/intermediary/1.20.1/intermediary-1.20.1.jar", intermediary);
  const profile: VersionJson = {
    id: "fabric-loader-0.15.11-1.20.1",
    inheritsFrom: "1.20.1",
    type: "release",
    mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
    arguments: { game: [], jvm: [] },
    libraries: [
      { name: "net.fabricmc:fabric-loader:0.15.11", url: "https://maven.fabricmc.net/", sha1: sha1(loaderJar), size: loaderJar.length },
      { name: "net.fabricmc:intermediary:1.20.1", url: "https://maven.fabricmc.net/", sha1: sha1(intermediary), size: intermediary.length },
    ],
  };
  w.add("/fabric-meta/v2/versions/loader/1.20.1/0.15.11/profile/json", JSON.stringify(profile));
  return w;
}

