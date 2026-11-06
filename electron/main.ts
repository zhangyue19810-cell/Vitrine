/**
 * Desktop shell: one window, the core in this process, and a tiny IPC surface between them.
 *
 *  - The interface is served from the app's own `app://vitrine/` scheme (GLTF loading needs fetch(), which `file://` forbids).
 *  - The page gets no Node: `preload.ts` exposes `window.vitrine` (call / abort / events / window controls).
 *  - No port is ever opened; the WebSocket transport in core/src/ws-server.ts is for development only.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, protocol, safeStorage, session, shell, Tray, type IpcMainEvent, type IpcMainInvokeEvent, type OpenDialogOptions, type SaveDialogOptions } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { plainCipher, type Cipher } from "../core/src/account/secrets";
import { Core, type HostBridge } from "../core/src/core";
import type { CoreEvent } from "../core/src/events";
import type { AfterLaunch } from "../core/src/settings";
import { buildRpc, describeError, type RpcTable } from "../core/src/rpc";

const SMOKE = process.env.VITRINE_SMOKE === "1";
const DEVTOOLS = process.env.VITRINE_DEVTOOLS === "1" || process.argv.includes("--devtools");
const APP_URL = "app://vitrine/index.html";

// ------------------------------------------------------------------------------------------------ before ready

app.setName("Vitrine");
const exeDir = dirname(process.execPath);

/** Files that prove a folder is a Vitrine data directory rather than an empty/default Electron profile. */
function hasVitrineData(dir: string): boolean {
  return ["accounts.json", "settings.json", "secrets.json"].some((name) => existsSync(join(dir, name)));
}

/**
 * Resolve the data folder before the core starts.
 *
 * The update package is a plain ZIP, so a player who previously used portable mode can replace
 * the app folder and accidentally lose the empty portable.txt marker. If the default AppData
 * folder has no launcher data but `data/` beside the exe does, keep using the portable data
 * instead of silently starting with an empty account list. The same fallback catches old brand
 * names from early builds.
 */
function selectDataDir(): void {
  if (process.env.VITRINE_DATA) {
    app.setPath("userData", resolve(process.env.VITRINE_DATA));
    return;
  }
  if (!app.isPackaged) return;
  const defaultDir = app.getPath("userData");
  const portableDir = join(exeDir, "data");
  if (existsSync(join(exeDir, "portable.txt"))) {
    app.setPath("userData", portableDir);
    return;
  }
  if (!hasVitrineData(defaultDir) && hasVitrineData(portableDir)) {
    console.warn(`[vitrine] using portable data recovered from ${portableDir} (portable.txt is missing)`);
    app.setPath("userData", portableDir);
    return;
  }
  if (hasVitrineData(defaultDir)) return;
  const appData = app.getPath("appData");
  for (const legacyName of ["vitrine-launcher", "Vitrine Launcher", "Vitrine 琉匣"]) {
    const legacyDir = join(appData, legacyName);
    if (!hasVitrineData(legacyDir)) continue;
    console.warn(`[vitrine] using legacy data directory ${legacyDir}`);
    app.setPath("userData", legacyDir);
    return;
  }
}
selectDataDir();

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.commandLine.appendSwitch("ignore-gpu-blocklist");
if (process.platform === "win32") app.setAppUserModelId("app.vitrine.launcher");

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ------------------------------------------------------------------------------------------------ state

let core: Core | undefined;
let table: RpcTable | undefined;
let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let hiddenByGame = false;
let disposed = false;
const controllers = new Map<number, AbortController>();

const iconPath = () => [join(process.resourcesPath ?? "", "icon.png"), join(app.getAppPath(), "build", "icon.png")].find((path) => existsSync(path));
const webRoot = () => join(app.getAppPath(), "dist");

const replacer = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);
const wire = <T>(value: T): T => (value === undefined ? (null as T) : (JSON.parse(JSON.stringify(value, replacer)) as T));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// ------------------------------------------------------------------------------------------------ app:// scheme

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".glb": "model/gltf-binary",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
};

/** The page needs: its own scripts and styles, blob/data images and https icons (Modrinth / CurseForge), and nothing else. */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data: https://aidemo.youdao.com https://api.mymemory.translated.net",
  "media-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'",
].join("; ");

function registerAppProtocol() {
  protocol.handle("app", async (request) => {
    let pathname: string;
    try {
      const url = new URL(request.url);
      if (url.hostname !== "vitrine") return new Response("not found", { status: 404 });
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    if (pathname === "/" || pathname === "") pathname = "/index.html";
    const root = webRoot();
    const file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + sep)) return new Response("forbidden", { status: 403 });
    try {
      // Electron's fs is asar-aware: the same read serves dist/ when run from a checkout and app.asar/dist when packaged.
      const data = await readFile(file);
      const headers = new Headers();
      headers.set("content-type", MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
      headers.set("content-length", String(data.byteLength));
      headers.set("x-content-type-options", "nosniff");
      if (pathname === "/index.html") headers.set("content-security-policy", CSP);
      return new Response(data, { status: 200, headers });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

function hardenSession() {
  const allowed = new Set(["clipboard-sanitized-write", "fullscreen"]);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
}

// ------------------------------------------------------------------------------------------------ secrets and proxy

/** Refresh tokens and passwords are wrapped by the OS (DPAPI on Windows); without that they are only obscured. */
function makeCipher(): Cipher {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn("[vitrine] OS secret storage is unavailable; tokens are only obscured, not encrypted");
    return plainCipher;
  }
  return {
    encrypt: (plain) => `ss1:${safeStorage.encryptString(plain).toString("base64")}`,
    // Values written while the OS store was unavailable stay readable.
    decrypt: (encoded) => (encoded.startsWith("ss1:") ? safeStorage.decryptString(Buffer.from(encoded.slice(4), "base64")) : plainCipher.decrypt(encoded)),
  };
}

/** The core asks for a proxy synchronously; Electron resolves asynchronously, so answers are cached per host. */
class ProxyCache {
  private readonly cache = new Map<string, string | undefined>();
  private readonly pending = new Set<string>();

  constructor() {
    setInterval(() => this.cache.clear(), 60_000).unref();
  }

  private static parse(raw: string): string | undefined {
    const first = raw.split(";")[0]?.trim() ?? "";
    const match = /^(PROXY|HTTPS|HTTP)\s+(\S+)$/i.exec(first);
    if (!match) return undefined; // DIRECT, or SOCKS (not supported by the downloader)
    return `${match[1].toUpperCase() === "HTTPS" ? "https" : "http"}://${match[2]}`;
  }

  async warm(url: string) {
    const host = new URL(url).hostname;
    if (this.pending.has(host)) return;
    this.pending.add(host);
    try {
      const answer = ProxyCache.parse(await session.defaultSession.resolveProxy(url));
      this.cache.set(host, answer);
      if (!this.cache.has("*")) this.cache.set("*", answer);
    } catch {
      /* no proxy information */
    } finally {
      this.pending.delete(host);
    }
  }

  lookup(url: string): string | undefined {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return undefined;
    }
    if (!this.cache.has(host)) {
      void this.warm(url);
      return this.cache.get("*");
    }
    return this.cache.get(host);
  }
}

// ------------------------------------------------------------------------------------------------ window

interface Bounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

const boundsFile = () => join(app.getPath("userData"), "window.json");

function loadBounds(): Bounds {
  try {
    const saved = JSON.parse(readFileSync(boundsFile(), "utf8")) as Bounds;
    if (Number.isFinite(saved.width) && Number.isFinite(saved.height)) return saved;
  } catch {
    /* first run */
  }
  return { width: 1280, height: 780 };
}

let boundsTimer: ReturnType<typeof setTimeout> | undefined;

/** Remember size, position and maximised state (debounced: a drag-resize fires hundreds of events). */
function saveBounds(immediately = false) {
  clearTimeout(boundsTimer);
  const write = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    try {
      const maximized = win.isMaximized();
      const rect = maximized ? loadBounds() : win.getBounds();
      writeFileSync(boundsFile(), JSON.stringify({ ...rect, maximized }));
    } catch {
      /* not worth failing for */
    }
  };
  if (immediately) write();
  else boundsTimer = setTimeout(write, 400);
}

const windowState = () => ({ focused: Boolean(win && !win.isDestroyed() && win.isFocused()), visible: Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) });

function pushWindowState() {
  if (win && !win.isDestroyed()) win.webContents.send("vitrine:window-state", windowState());
}

function createWindow() {
  const bounds = loadBounds();
  const icon = iconPath();
  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 960,
    minHeight: 600,
    show: false,
    frame: false,
    title: "Vitrine 琉匣",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#11181b" : "#eae5e1",
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged || DEVTOOLS,
    },
  });
  const contents = win.webContents;
  // Pinch zoom would rescale the fixed stage; the promise rejects when called before the first frame exists, so do it after load.
  contents.on("did-finish-load", () => void contents.setVisualZoomLevelLimits(1, 1).catch(() => {}));
  if (bounds.maximized) win.maximize();

  win.once("ready-to-show", () => {
    if (!SMOKE) win?.show();
    pushWindowState();
  });
  for (const name of ["focus", "blur", "minimize", "restore", "show", "hide"] as const) win.on(name as "focus", pushWindowState);
  win.on("resize", () => saveBounds());
  win.on("move", () => saveBounds());
  win.on("close", () => saveBounds(true));
  win.on("closed", () => {
    win = undefined;
  });

  // Nothing may navigate the window away from the interface, and links go to the real browser.
  contents.on("will-navigate", (event, url) => {
    if (!url.startsWith("app://vitrine/")) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("render-process-gone", (_event, details) => {
    console.error("[vitrine] renderer gone:", details.reason);
    if (details.reason !== "clean-exit" && !SMOKE && win && !win.isDestroyed()) win.loadURL(APP_URL).catch(() => {});
  });
  if (DEVTOOLS) contents.openDevTools({ mode: "detach" });

  win.loadURL(APP_URL).catch((error: Error) => {
    // A custom-scheme navigation can report a swapped frame as a failure although the page loaded.
    console.warn("[vitrine] loadURL:", error.message);
  });
  return win;
}

function ensureTray() {
  if (tray) return true;
  const icon = iconPath();
  if (!icon) return false;
  try {
    tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }));
    tray.setToolTip("Vitrine 琉匣");
    tray.setContextMenu(Menu.buildFromTemplate([{ label: "显示启动器", click: () => showWindow() }, { type: "separator" }, { label: "退出", click: () => app.quit() }]));
    tray.on("click", () => showWindow());
    return true;
  } catch {
    return false;
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** What the launcher window does once a game is up (the setting “启动游戏后”), and the way back when it exits. */
function applyAfterLaunch(mode: AfterLaunch) {
  if (!win || win.isDestroyed() || mode === "keep") return;
  if (mode === "close") return void app.quit();
  if (mode === "hide" && ensureTray()) {
    hiddenByGame = true;
    return void win.hide();
  }
  hiddenByGame = true;
  win.minimize();
}

function restoreAfterGame() {
  if (hiddenByGame) showWindow();
  hiddenByGame = false;
  tray?.destroy();
  tray = undefined;
}

// ------------------------------------------------------------------------------------------------ host bridge and IPC

function hostBridge(proxies: ProxyCache): HostBridge {
  const parent = () => (win && !win.isDestroyed() ? win : undefined);
  const filters = (list?: { name: string; extensions: string[] }[]) => list?.map((filter) => ({ name: filter.name, extensions: filter.extensions }));
  return {
    async openPath(path) {
      const error = await shell.openPath(path);
      if (error) throw new Error(error);
    },
    showItemInFolder: (path) => shell.showItemInFolder(path),
    async openExternal(url) {
      if (!/^https?:\/\//i.test(url)) throw new Error("只能打开 http / https 链接");
      await shell.openExternal(url);
    },
    async pickFile(options) {
      const settings: OpenDialogOptions = { title: options.title, filters: filters(options.filters), properties: options.multi ? ["openFile", "multiSelections"] : ["openFile"] };
      const owner = parent();
      const result = owner ? await dialog.showOpenDialog(owner, settings) : await dialog.showOpenDialog(settings);
      return result.canceled ? undefined : result.filePaths;
    },
    async pickFolder(options) {
      const settings: OpenDialogOptions = { title: options.title, properties: ["openDirectory", "createDirectory"] };
      const owner = parent();
      const result = owner ? await dialog.showOpenDialog(owner, settings) : await dialog.showOpenDialog(settings);
      return result.canceled ? undefined : result.filePaths[0];
    },
    async saveFile(options) {
      const settings: SaveDialogOptions = { title: options.title, defaultPath: options.defaultPath, filters: filters(options.filters) };
      const owner = parent();
      const result = owner ? await dialog.showSaveDialog(owner, settings) : await dialog.showSaveDialog(settings);
      return result.canceled ? undefined : result.filePath;
    },
    systemProxy: (url) => proxies.lookup(url),
  };
}

/** Only our own page, in the main frame, may talk to the core. */
function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame?.url.startsWith("app://vitrine/"));
}

function registerIpc() {
  ipcMain.handle("vitrine:call", async (event, id: unknown, method: unknown, params: unknown) => {
    const fail = (code: string, message: string) => ({ ok: false as const, error: { code, message } });
    if (!trusted(event)) return fail("forbidden", "不受信任的调用来源");
    if (typeof id !== "number" || typeof method !== "string") return fail("bad-params", "请求格式不正确");
    const handler = table && Object.hasOwn(table, method) ? table[method] : undefined;
    if (!handler) return fail("no-method", `未知的方法：${method}`);
    const controller = new AbortController();
    controllers.set(id, controller);
    try {
      const result = await handler(isRecord(params) ? params : {}, { signal: controller.signal });
      return { ok: true as const, result: wire(result === undefined ? null : result) };
    } catch (error) {
      return { ok: false as const, error: describeError(error) };
    } finally {
      controllers.delete(id);
    }
  });

  ipcMain.on("vitrine:abort", (event, id: unknown) => {
    if (trusted(event) && typeof id === "number") controllers.get(id)?.abort();
  });

  ipcMain.handle("vitrine:window-state", (event) => (trusted(event) ? windowState() : { focused: false, visible: false }));

  ipcMain.on("vitrine:window-control", (event, action: unknown) => {
    if (!trusted(event) || !win || win.isDestroyed()) return;
    if (action === "minimize") win.minimize();
    else if (action === "maximize") win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === "close") win.close();
  });
}

function forward(event: CoreEvent) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send("vitrine:event", event);
  } catch {
    win.webContents.send("vitrine:event", wire(event));
  }
}

// ------------------------------------------------------------------------------------------------ smoke mode

/** `VITRINE_SMOKE=1`: boot the real interface against a throw-away data dir, report what happened, exit. Used by the build checks. */
async function smoke() {
  const contents = win!.webContents;
  const messages: string[] = [];
  contents.on("console-message", (event) => {
    const { level, message } = event as unknown as { level: string | number; message: string };
    if (level === "error" || level === "warning" || level === 2 || level === 3) messages.push(`[${level}] ${message.slice(0, 240)}`);
  });
  const deadline = Date.now() + 60_000;
  let booted = false;
  while (Date.now() < deadline) {
    booted = await contents.executeJavaScript(`document.querySelector('#stage')?.dataset.booted === 'true'`).catch(() => false);
    if (booted) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 1500));
  const facts = await contents.executeJavaScript(`(async () => {
    const bridge = window.vitrine;
    const info = bridge ? await bridge.call(1, 'app.info', {}) : null;
    return {
      booted: document.querySelector('#stage')?.dataset.booted === 'true',
      shell: document.documentElement.dataset.shell,
      scene: document.querySelector('#stage')?.dataset.scene,
      perf: document.documentElement.dataset.perf,
      title: document.title,
      ipc: info && info.ok ? { version: info.result.version, os: info.result.os && info.result.os.name } : info,
      fontsLoaded: document.fonts.check('16px MiSans'),
      text: document.body.innerText.slice(0, 160).replace(/\\s+/g, ' '),
    };
  })()`).catch((error: Error) => ({ error: String(error) }));
  console.log(`SMOKE ${JSON.stringify({ booted, facts, messages: [...new Set(messages)].slice(0, 20) })}`);
  const ok = booted && (facts as { ipc?: unknown }).ipc;
  app.exit(ok ? 0 : 2);
}

// ------------------------------------------------------------------------------------------------ life cycle

app.on("second-instance", () => showWindow());
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (disposed) return;
  disposed = true;
  event.preventDefault();
  // A running game is a separate process and keeps going; only the launcher's own work (downloads…) is stopped.
  void Promise.race([core?.dispose(), new Promise((r) => setTimeout(r, 4000))]).finally(() => app.quit());
});

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  hardenSession();
  registerAppProtocol();
  const proxies = new ProxyCache();
  try {
    core = await Core.create({ dataDir: app.getPath("userData"), version: app.getVersion(), cipher: makeCipher(), host: hostBridge(proxies) });
  } catch (error) {
    dialog.showErrorBox("Vitrine 无法启动", `核心初始化失败：${(error as Error).message}\n\n数据目录：${app.getPath("userData")}`);
    app.exit(1);
    return;
  }
  table = buildRpc(core);
  registerIpc();
  core.on((event) => {
    if (event.type === "after-launch") applyAfterLaunch(event.mode);
    else if (event.type === "game-exit-ui") restoreAfterGame();
    forward(event);
  });
  createWindow();
  for (const host of ["https://piston-meta.mojang.com", "https://api.modrinth.com", "https://bmclapi2.bangbang93.com"]) void proxies.warm(host);
  if (SMOKE) void smoke();
});
