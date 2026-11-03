/**
 * Development backend: runs the core headless and exposes it over a local WebSocket so the interface can be developed
 * (and tested) in an ordinary browser with `npm run dev`. The desktop app does not use this — it talks to the core over
 * Electron IPC and never opens a port.
 *
 *   npm run dev:backend              data in ~/.vitrine-dev, port 7878, random token (printed as a ready-to-open link)
 *   VITRINE_DATA=… VITRINE_ROOT=… VITRINE_PORT=… VITRINE_TOKEN=… npm run dev:backend
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Core } from "../core/src/core";
import { startWsServer } from "../core/src/ws-server";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const dataDir = process.env.VITRINE_DATA ?? join(homedir(), ".vitrine-dev");
const port = Number(process.env.VITRINE_PORT ?? 7878);
const webOrigin = process.env.VITRINE_WEB ?? "http://127.0.0.1:5173";

const core = await Core.create({
  dataDir,
  version: pkg.version,
  defaultRoot: process.env.VITRINE_ROOT,
  // No desktop shell here: the interface falls back to typing paths, which is also how the browser tests drive it.
  host: {
    openExternal: (url) => void console.log(`[host] openExternal ${url}`),
    openPath: (path) => void console.log(`[host] openPath ${path}`),
    showItemInFolder: (path) => void console.log(`[host] showItemInFolder ${path}`),
  },
});

const server = await startWsServer({ core, port, token: process.env.VITRINE_TOKEN });

const link = `${webOrigin}/?backend=${encodeURIComponent(server.url)}`;
console.log(`Vitrine core ${core.version} — data: ${dataDir}`);
console.log(`WebSocket: ws://127.0.0.1:${server.port}/  (token required)`);
console.log(`Open the interface with:\n  ${link}`);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  await core.dispose();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
