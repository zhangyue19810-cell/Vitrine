import { rpc, tryRpc } from "../api";
import { guard, openLink, pickPath, withBusy } from "../actions";
import { $, $$, html, raw, setHtml, type Raw } from "../dom";
import { formatBytes } from "../format";
import { confirmDialog, openSheet, promptDialog, toast, type ModalHandle } from "../modal";
import { store } from "../store";
import { memoryOptions } from "../ui-bits";
import type { JavaInstall, Settings } from "../types";
import { PRODUCT } from "../../brand";

/**
 * Settings. Every control saves as soon as it changes (text after a short pause) and the core validates the value; what
 * it answers with is what the control shows afterwards, so a clamped number or a refused path is visible immediately.
 */

type Opt = [value: string | number, label: string];
type Field =
  | { kind: "toggle" }
  | { kind: "select"; options: Opt[] | (() => Opt[]) }
  | { kind: "seg"; options: Opt[] }
  | { kind: "number"; min: number; max: number; step?: number; unit?: string; placeholder?: string }
  | { kind: "text"; placeholder?: string; mono?: boolean; secret?: boolean; browse?: "folder" }
  | { kind: "area"; placeholder?: string; mono?: boolean; rows?: number }
  | { kind: "range"; min: number; max: number; step: number; format?: (value: number) => string }
  | { kind: "lines" };

interface Row {
  name: string;
  desc?: string | Raw;
  path?: string;
  field?: Field;
  /** Show the row only while another setting has this value, e.g. "network.proxy=custom". */
  showIf?: string;
  block?: boolean;
  custom?: (host: HTMLElement) => void;
}

interface Section {
  id: string;
  label: string;
  rows: Row[];
}

const POLICY: Opt[] = [
  ["official-first", "官方源优先，失败自动切镜像"],
  ["mirror-first", "镜像源优先，失败回退官方源"],
  ["official-only", "只用官方源"],
  ["mirror-only", "只用镜像源"],
];

function sections(): Section[] {
  return [
    {
      id: "general",
      label: "通用",
      rows: [
        { name: "游戏目录", path: "gameRoot", field: { kind: "text", placeholder: "留空 = 启动器数据目录下的 minecraft", mono: true, browse: "folder" }, desc: "存放 versions / libraries / assets 的文件夹。更改后不会移动已有文件，新安装的内容会放进新目录。" },
        { name: "已发现的游戏目录", custom: buildRoots, block: true, desc: "在常见位置找到的 .minecraft 文件夹（官方启动器、PCL、HMCL 等创建的都可以直接使用）。" },
        { name: "启动游戏后", path: "launch.afterLaunch", field: { kind: "select", options: [["keep", "保持启动器窗口"], ["minimize", "最小化启动器"], ["hide", "隐藏启动器"], ["close", "关闭启动器"]] }, desc: "游戏退出后窗口会自动回来（关闭除外）。" },
        { name: "版本类型标识", path: "launch.versionType", field: { kind: "text", placeholder: "Vitrine" }, desc: "写入游戏启动参数 version_type，会显示在游戏版本号旁边。" },
      ],
    },
    {
      id: "download",
      label: "下载",
      rows: [
        { name: "游戏文件下载源", path: "sources.policy", field: { kind: "select", options: POLICY }, desc: "官方源 = Mojang、Fabric、Forge 等原始地址；镜像源 = BMCLAPI。“自动切换”会在官方源失败或太慢时改用另一个。" },
        { name: "模组 / 整合包下载源", path: "sources.contentPolicy", field: { kind: "select", options: POLICY }, desc: "官方 = Modrinth / CurseForge 官方接口；镜像 = MCIM 镜像（默认优先，国内访问通常更快；失败会回退官方）。" },
        { name: "游戏镜像地址", path: "sources.mirrorBase", field: { kind: "text", mono: true }, desc: "默认 https://bmclapi2.bangbang93.com" },
        { name: "内容镜像地址", path: "sources.contentMirrorBase", field: { kind: "text", mono: true }, desc: "默认 https://mod.mcimirror.top" },
        { name: "并行下载线程", path: "download.concurrency", field: { kind: "number", min: 1, max: 128, unit: "个" }, desc: "同时下载的文件数（默认 64）。整合包和资源文件有成千上万个小文件，线程越多越快；网络不稳或被限流时可以调低。" },
        { name: "单文件分段数", path: "download.segments", field: { kind: "number", min: 1, max: 16, unit: "段" }, desc: "大文件会用多个连接分段并行下载（默认 8 段），并支持断点续传。" },
        { name: "限速", path: "download.speedLimitKBps", field: { kind: "number", min: 0, max: 10_000_000, unit: "KB/s", placeholder: "0 = 不限速" }, desc: "0 表示不限速。限速对所有下载任务合计生效。" },
        { name: "失败重试次数", path: "download.retries", field: { kind: "number", min: 0, max: 10, unit: "次" } },
        { name: "网络代理", path: "network.proxy", field: { kind: "select", options: [["system", "使用系统代理"], ["none", "不使用代理"], ["custom", "自定义代理"]] } },
        { name: "代理地址", path: "network.proxyUrl", showIf: "network.proxy=custom", field: { kind: "text", placeholder: "http://127.0.0.1:7890", mono: true }, desc: "支持 http / https / socks5。" },
      ],
    },
    {
      id: "java",
      label: "Java",
      rows: [
        { name: "缺少 Java 时自动安装", path: "java.autoInstall", field: { kind: "toggle" }, desc: "启动时若没有合适版本的 Java，自动下载 Mojang 提供的运行时。" },
        { name: "已检测到的 Java", custom: buildJava, block: true },
        { name: "额外的 Java 路径", path: "java.extraPaths", field: { kind: "lines" }, block: true, desc: "每行一个 java 可执行文件或 Java 安装目录；检测不到的 Java 可以加在这里。" },
      ],
    },
    {
      id: "launch",
      label: "启动",
      rows: [
        { name: "游戏内存", path: "launch.memory", field: { kind: "select", options: () => memoryOptions(store.settings.launch.memory) }, desc: "“自动”会按电脑内存和整合包大小估算。实例设置里可以单独覆盖。" },
        { name: "JVM 预设", path: "launch.jvmPreset", field: { kind: "select", options: () => store.jvmPresets.map((p) => [p.id, p.label] as Opt) }, desc: presetDesc() },
        { name: "额外 JVM 参数", path: "launch.jvmArgs", field: { kind: "area", mono: true, placeholder: "-XX:+UseZGC …" }, block: true },
        { name: "额外游戏参数", path: "launch.gameArgs", field: { kind: "area", mono: true, placeholder: "--fullscreen …" }, block: true },
        { name: "窗口宽度", path: "launch.width", field: { kind: "number", min: 0, max: 16384, unit: "px", placeholder: "0 = 默认" } },
        { name: "窗口高度", path: "launch.height", field: { kind: "number", min: 0, max: 16384, unit: "px", placeholder: "0 = 默认" } },
        { name: "全屏启动", path: "launch.fullscreen", field: { kind: "toggle" } },
      ],
    },
    {
      id: "accounts",
      label: "账号与密钥",
      rows: [
        {
          name: "微软登录的 Azure 应用 ID",
          path: "accounts.msClientId",
          field: { kind: "text", mono: true, placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" },
          desc: html`Vitrine 已内置一个已通过 Mojang 审核、用于设备码登录的公共 Azure 客户端，通常不需要修改。若你想使用自己的 Azure 应用，可在这里覆盖它的“应用程序（客户端）ID”；自己的应用同样需要开启“允许公共客户端流”并通过 Mojang 审核。清空后会恢复内置值。`,
        },
        { name: "CurseForge API 密钥", path: "accounts.curseforgeKey", field: { kind: "text", secret: true, mono: true }, desc: "用于浏览和安装 CurseForge 的整合包与模组。可在 CurseForge for Studios 控制台免费申请；不填则只能使用 Modrinth（或内容镜像）。" },
        { name: "离线账号默认 UUID", path: "accounts.ownerUuid", field: { kind: "text", mono: true }, desc: "添加离线账号时默认使用的 UUID，保持不变可以让存档、背包和权限始终对应同一个玩家。" },
      ],
    },
    {
      id: "appearance",
      label: "外观与性能",
      rows: [
        { name: "界面配色", path: "ui.theme", field: { kind: "seg", options: [["auto", "跟随系统"], ["light", "亮色"], ["dark", "暗色"]] } },
        { name: "动效", path: "ui.motion", field: { kind: "select", options: [["auto", "跟随系统的“减少动态效果”"], ["full", "完整动效"], ["reduced", "精简动效"]] }, desc: "精简动效会关闭滚动数字、选择涟漪等装饰，帧率上限降到 30。" },
        { name: "3D 帧率上限", path: "ui.fps", field: { kind: "select", options: [["auto", "自动（跟随显示器，最高 60）"], [30, "30 帧"], [60, "60 帧"], [120, "120 帧"]] }, desc: "停止操作 10 秒后会自动降到 30 帧，90 秒后降到 15 帧。" },
        { name: "3D 画质", path: "ui.quality", field: { kind: "select", options: [["auto", "自动（卡顿时自动降级）"], ["high", "高"], ["medium", "中"], ["low", "低（省电）"]] }, desc: "没有独立显卡或使用软件渲染时，会自动使用最低画质。" },
        { name: "启动游戏时暂停动画", path: "ui.pauseWhenGameRuns", field: { kind: "toggle" }, desc: "游戏启动和运行期间完全停止 3D 动画，让出 GPU。你回到启动器窗口时动画自动恢复（游戏仍在运行时降到 30 帧）。" },
        { name: "游戏运行时释放显存", path: "ui.releaseGpuWhenGameRuns", field: { kind: "toggle" }, desc: "游戏在运行、启动器隐藏超过 15 秒后，销毁 3D 场景把显存还给游戏；回来时约 1 秒重新载入。" },
        { name: "窗口失去焦点时", path: "ui.whenUnfocused", field: { kind: "select", options: [["pause", "暂停动画"], ["throttle", "降到 10 帧"], ["full", "保持不变"]] } },
        { name: "界面音效", path: "ui.sounds", field: { kind: "toggle" }, desc: "选择、打开和完成时的短提示音，全部实时合成，没有音频文件。" },
        { name: "音效音量", path: "ui.soundVolume", field: { kind: "range", min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` } },
        { name: "开屏动画", path: "ui.splash", field: { kind: "select", options: [["full", "完整"], ["short", "简短"], ["off", "关闭"]] }, desc: "开屏动画不会拖慢启动，核心准备好后即可点击跳过。" },
        { name: "界面缩放", path: "ui.scale", field: { kind: "range", min: 0.75, max: 1.5, step: 0.05, format: (v) => `${Math.round(v * 100)}%` }, desc: "在窗口自适应缩放的基础上再放大或缩小整个界面。" },
      ],
    },
    { id: "about", label: "关于", rows: [{ name: "", custom: buildAbout, block: true }] },
  ];
}

function presetDesc(): string {
  const preset = store.jvmPresets.find((entry) => entry.id === store.settings?.launch.jvmPreset);
  return preset ? `${preset.description}（需要 Java ${preset.minJava}+）` : "";
}

// ---------------------------------------------------------------------------------------------- path helpers

function getPath(settings: Settings, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], settings);
}

function nest(path: string, value: unknown): Record<string, unknown> {
  const keys = path.split(".");
  const root: Record<string, unknown> = {};
  let node = root;
  keys.forEach((key, index) => {
    if (index === keys.length - 1) node[key] = value;
    else node = node[key] = {} as Record<string, unknown>;
  });
  return root;
}

function merge(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) merge((target[key] ??= {}) as Record<string, unknown>, value as Record<string, unknown>);
    else target[key] = value;
  }
}

// ---------------------------------------------------------------------------------------------- rendering

function control(row: Row): Raw {
  const field = row.field!;
  const bind = `data-bind="${row.path}"`;
  switch (field.kind) {
    case "toggle":
      return html`<button class="toggle" role="switch" ${raw(bind)} data-kind="toggle" aria-checked="false"></button>`;
    case "select": {
      const options = typeof field.options === "function" ? field.options() : field.options;
      return html`<select class="select" ${raw(bind)} data-kind="select">${options.map(([value, label]) => html`<option value="${value}">${label}</option>`)}</select>`;
    }
    case "seg":
      return html`<div class="seg" ${raw(bind)} data-kind="seg">${field.options.map(([value, label]) => html`<button type="button" data-value="${value}" aria-pressed="false">${label}</button>`)}</div>`;
    case "number":
      return html`<input class="input tnum" type="number" ${raw(bind)} data-kind="number" min="${field.min}" max="${field.max}" step="${field.step ?? 1}" placeholder="${field.placeholder ?? ""}" style="max-width:150px" />${field.unit ? html`<span class="muted" style="font-size:12px;min-width:34px">${field.unit}</span>` : ""}`;
    case "text":
      return html`<input class="input${field.mono ? " mono" : ""}" type="${field.secret ? "password" : "text"}" ${raw(bind)} data-kind="text" placeholder="${field.placeholder ?? ""}" autocomplete="off" spellcheck="false" />${field.secret ? html`<button class="btn sm soft" data-reveal>显示</button>` : ""}${field.browse ? html`<button class="btn sm soft" data-browse="${row.path}">浏览…</button>` : ""}`;
    case "area":
      return html`<textarea class="textarea${field.mono ? " mono" : ""}" ${raw(bind)} data-kind="text" rows="${field.rows ?? 3}" placeholder="${field.placeholder ?? ""}" spellcheck="false"></textarea>`;
    case "lines":
      return html`<textarea class="textarea mono" ${raw(bind)} data-kind="lines" rows="3" placeholder="C:\\Program Files\\Java\\jdk-21\\bin\\javaw.exe" spellcheck="false"></textarea>`;
    case "range":
      return html`<input class="range" type="range" ${raw(bind)} data-kind="range" min="${field.min}" max="${field.max}" step="${field.step}" style="max-width:200px" /><span class="tnum muted" data-range-label style="min-width:44px;text-align:right;font-size:12px"></span>`;
  }
}

function rowHtml(row: Row, index: number): Raw {
  if (row.custom) return html`<div class="setting block" data-custom="${index}">${row.name ? html`<div><div class="name">${row.name}</div>${row.desc ? html`<div class="desc">${row.desc}</div>` : ""}</div>` : ""}<div class="control" data-custom-host></div></div>`;
  return html`<div class="setting${row.block ? " block" : ""}" data-row="${row.path}" ${raw(row.showIf ? `data-show-if="${row.showIf}"` : "")}>
    <div><div class="name">${row.name}<span class="save-state" data-save></span></div>${row.desc ? html`<div class="desc" data-desc>${row.desc}</div>` : ""}</div>
    <div class="control">${control(row)}</div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------- the sheet

let open: ModalHandle | undefined;

export function openSettings(sectionId = "general") {
  if (open) {
    selectSection(open.body, sectionId);
    return;
  }
  const all = sections();
  const sheet = openSheet({ eyebrow: "SETTINGS", title: "设置", onClose: () => (open = undefined) });
  open = sheet;
  sheet.body.innerHTML = html`<div class="settings">
    <nav class="settings-nav" role="tablist">${all.map((s) => html`<button role="tab" data-section="${s.id}" aria-selected="false">${s.label}</button>`)}</nav>
    <div class="settings-body" data-f="body">${all.map(
      (s) => html`<section data-panel="${s.id}" hidden>${s.rows.map((row, i) => rowHtml(row, i))}</section>`,
    )}</div>
  </div>`.value;
  all.forEach((section) => {
    const panel = $(`[data-panel="${section.id}"]`, sheet.body);
    section.rows.forEach((row, i) => {
      if (row.custom) row.custom($("[data-custom-host]", $$(".setting", panel)[i]));
    });
  });
  const queue = new Map<string, unknown>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touched = new Set<string>();

  const flush = async () => {
    clearTimeout(timer);
    timer = undefined;
    if (!queue.size) return;
    const patch: Record<string, unknown> = {};
    const paths = [...queue.keys()];
    for (const [path, value] of queue) merge(patch, nest(path, value));
    queue.clear();
    try {
      await rpc("settings.update", { patch });
      for (const path of paths) flash(sheet.body, path, "已保存");
    } catch (error) {
      for (const path of paths) flash(sheet.body, path, (error as Error).message, true);
      syncControls(sheet.body, true);
    }
  };
  const save = (path: string, value: unknown, immediate: boolean) => {
    queue.set(path, value);
    touched.add(path);
    clearTimeout(timer);
    if (immediate) void flush();
    else timer = setTimeout(() => void flush(), 500);
  };

  const readValue = (element: HTMLElement): unknown => {
    const kind = element.dataset.kind;
    if (kind === "toggle") return element.getAttribute("aria-checked") !== "true";
    if (kind === "lines") return (element as HTMLTextAreaElement).value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (kind === "number") {
      const raw = (element as HTMLInputElement).value;
      return raw === "" ? 0 : Number(raw);
    }
    if (kind === "range") return Number((element as HTMLInputElement).value);
    if (kind === "select") {
      const value = (element as HTMLSelectElement).value;
      const options = fieldOptions(element.dataset.bind!);
      return options.find(([v]) => String(v) === value)?.[0] ?? value;
    }
    return (element as HTMLInputElement).value;
  };

  sheet.body.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const nav = target.closest<HTMLElement>("[data-section]");
    if (nav) return selectSection(sheet.body, nav.dataset.section!);
    const toggle = target.closest<HTMLElement>(".toggle[data-bind]");
    if (toggle) {
      const next = toggle.getAttribute("aria-checked") !== "true";
      toggle.setAttribute("aria-checked", String(next));
      return save(toggle.dataset.bind!, next, true);
    }
    const seg = target.closest<HTMLElement>(".seg[data-bind] button");
    if (seg) {
      const host = seg.closest<HTMLElement>(".seg")!;
      const options = fieldOptions(host.dataset.bind!);
      const value = options.find(([v]) => String(v) === seg.dataset.value)?.[0] ?? seg.dataset.value;
      host.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === seg)));
      return save(host.dataset.bind!, value, true);
    }
    const reveal = target.closest<HTMLElement>("[data-reveal]");
    if (reveal) {
      const input = reveal.parentElement!.querySelector<HTMLInputElement>("input")!;
      input.type = input.type === "password" ? "text" : "password";
      reveal.textContent = input.type === "password" ? "显示" : "隐藏";
      return;
    }
    const browse = target.closest<HTMLElement>("[data-browse]");
    if (browse) {
      void (async () => {
        const folder = await guard(() => pickPath("folder", { title: "选择游戏目录" }));
        if (!folder) return;
        const input = sheet.body.querySelector<HTMLInputElement>(`[data-bind="${browse.dataset.browse}"]`)!;
        input.value = folder;
        save(browse.dataset.browse!, folder, true);
      })();
    }
  });
  sheet.body.addEventListener("input", (event) => {
    const element = (event.target as HTMLElement).closest<HTMLElement>("[data-bind]");
    if (!element) return;
    const kind = element.dataset.kind;
    if (kind === "toggle" || kind === "seg" || kind === "select") return;
    if (kind === "range") updateRangeLabel(element as HTMLInputElement);
    save(element.dataset.bind!, readValue(element), kind === "range" ? false : false);
  });
  sheet.body.addEventListener("change", (event) => {
    const element = (event.target as HTMLElement).closest<HTMLElement>("[data-bind]");
    if (!element) return;
    const kind = element.dataset.kind;
    if (kind === "select") save(element.dataset.bind!, readValue(element), true);
    else if (kind !== "toggle" && kind !== "seg") void flush();
  });

  const off = store.on("settings", () => syncControls(sheet.body, false));
  void sheet.closed.then(off);
  selectSection(sheet.body, sectionId);
  syncControls(sheet.body, true);
}

function fieldOptions(path: string): Opt[] {
  for (const section of sections()) {
    for (const row of section.rows) {
      if (row.path !== path || !row.field) continue;
      if (row.field.kind === "select") return typeof row.field.options === "function" ? row.field.options() : row.field.options;
      if (row.field.kind === "seg") return row.field.options;
    }
  }
  return [];
}

function selectSection(root: HTMLElement, id: string) {
  $$("[data-section]", root).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.section === id)));
  $$("[data-panel]", root).forEach((p) => (p.hidden = p.dataset.panel !== id));
  const body = root.querySelector<HTMLElement>("[data-f='body']");
  if (body) body.scrollTop = 0;
}

function updateRangeLabel(input: HTMLInputElement) {
  const label = input.parentElement?.querySelector<HTMLElement>("[data-range-label]");
  if (!label) return;
  const path = input.dataset.bind!;
  let format = (v: number) => String(v);
  for (const section of sections()) for (const row of section.rows) if (row.path === path && row.field?.kind === "range" && row.field.format) format = row.field.format;
  label.textContent = format(Number(input.value));
}

/** Show what the core holds in every control that is not being edited right now. */
function syncControls(root: HTMLElement, force: boolean) {
  const settings = store.settings;
  if (!settings) return;
  for (const element of $$("[data-bind]", root)) {
    const path = element.dataset.bind!;
    const value = getPath(settings, path);
    const kind = element.dataset.kind;
    const editing = document.activeElement === element;
    if (kind === "toggle") element.setAttribute("aria-checked", String(Boolean(value)));
    else if (kind === "seg") element.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === String(value))));
    else if (kind === "select") {
      const select = element as HTMLSelectElement;
      // Options that depend on live data (memory, presets) are rebuilt first.
      const wanted = fieldOptions(path);
      if (wanted.length && (select.options.length !== wanted.length || [...select.options].some((o, i) => o.value !== String(wanted[i][0])))) {
        select.innerHTML = wanted.map(([v, l]) => `<option value="${String(v).replace(/"/g, "&quot;")}">${String(l).replace(/</g, "&lt;")}</option>`).join("");
      }
      select.value = String(value);
    } else if (!editing || force) {
      const input = element as HTMLInputElement;
      if (kind === "lines") input.value = ((value as string[]) ?? []).join("\n");
      else if (kind === "number") input.value = String(value ?? "");
      else if (kind === "range") {
        input.value = String(value);
        updateRangeLabel(input);
      } else input.value = String(value ?? "");
    }
  }
  for (const row of $$("[data-show-if]", root)) {
    const [path, expected] = row.dataset.showIf!.split("=");
    row.hidden = String(getPath(settings, path)) !== expected;
  }
  const preset = root.querySelector<HTMLElement>("[data-row='launch.jvmPreset'] [data-desc]");
  if (preset) preset.textContent = presetDesc();
}

function flash(root: HTMLElement, path: string, message: string, error = false) {
  const element = root.querySelector<HTMLElement>(`[data-row="${CSS.escape(path)}"] [data-save]`);
  if (!element) return;
  element.textContent = message;
  element.dataset.kind = error ? "error" : "ok";
  element.dataset.show = "true";
  clearTimeout(Number(element.dataset.timer));
  element.dataset.timer = String(window.setTimeout(() => (element.dataset.show = "false"), error ? 5000 : 1400));
}

// ---------------------------------------------------------------------------------------------- custom rows

function buildRoots(host: HTMLElement) {
  host.innerHTML = `<div class="muted" style="font-size:12.5px">正在查找…</div>`;
  void (async () => {
    const roots = await tryRpc("app.suggestRoots");
    if (!roots?.length) return setHtml(host, html`<div class="muted" style="font-size:12.5px">没有在常见位置发现已有的游戏目录。</div>`);
    setHtml(
      host,
      html`<div class="list" style="width:100%">${roots.map(
        (root) => html`<div class="item no-lead"><div style="min-width:0"><div class="title mono">${root.path}</div><div class="sub">${root.versions} 个版本</div></div><div class="tail"><button class="btn sm soft" data-use-root="${root.path}">使用</button></div></div>`,
      )}</div>`,
    );
    host.addEventListener("click", async (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-use-root]");
      if (!button) return;
      await guard(() => rpc("settings.update", { patch: { gameRoot: button.dataset.useRoot } }));
      toast("已切换游戏目录", "ok");
    });
  })();
}

function buildJava(host: HTMLElement) {
  host.style.display = "block";
  const render = async (force: boolean) => {
    setHtml(host, html`<div class="row-flex muted" style="font-size:12.5px"><span class="spinner"></span>正在检测 Java…</div>`);
    const list = await guard(() => rpc("java.list", { force }));
    if (!list) return setHtml(host, html`<div class="muted">检测失败</div>`);
    setHtml(
      host,
      html`<div class="toolbar" style="margin-bottom:10px">
          <button class="btn sm soft" data-java="refresh">重新检测</button>
          <button class="btn sm soft" data-java="test">测试一个路径…</button>
          <span class="grow"></span>
          ${[8, 17, 21].map((major) => html`<button class="btn sm soft" data-java="install" data-major="${major}">下载 Java ${major}</button>`)}
        </div>
        ${list.length ? html`<div class="list">${list.map((java) => javaRow(java))}</div>` : html`<div class="empty" style="min-height:90px">没有检测到 Java。启动游戏时会自动下载合适的版本，或点击上方按钮手动下载。</div>`}`,
    );
  };
  void render(false);
  host.addEventListener("click", async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-java]");
    if (!button) return;
    const action = button.dataset.java;
    if (action === "refresh") await render(true);
    else if (action === "install") {
      const started = await guard(() => rpc("java.install", { major: Number(button.dataset.major) }));
      if (started) {
        toast(`开始下载 Java ${button.dataset.major}`, "ok");
        (await import("./downloads")).openDownloads(started.taskId);
      }
    } else if (action === "test") {
      const path = await promptDialog({ title: "测试 Java", label: "java / javaw 可执行文件的完整路径", placeholder: "C:\\Program Files\\Java\\jdk-21\\bin\\javaw.exe" });
      if (!path) return;
      const result = await withBusy(button, () => guard(() => rpc("java.test", { path })));
      if (result) toast(`可用：Java ${result.major}（${result.version}）`, "ok");
      else if (result === null) toast("这个路径不是可用的 Java", "error");
    }
  });
}

function javaRow(java: JavaInstall): Raw {
  const source = { env: "环境变量", path: "PATH", registry: "注册表", common: "常见位置", mojang: "Mojang 运行时", vitrine: "启动器安装", custom: "自定义" }[java.source] ?? java.source;
  return html`<div class="item no-lead"><div style="min-width:0"><div class="title">Java ${java.major} <span class="muted" style="font-weight:400">· ${java.version}${java.vendor ? ` · ${java.vendor}` : ""}</span></div><div class="sub mono">${java.path}</div></div><div class="tail"><span class="chip">${java.arch}</span><span class="chip">${java.isJdk ? "JDK" : "JRE"}</span><span class="chip">${source}</span></div></div>`;
}

function buildAbout(host: HTMLElement) {
  const system = store.system;
  host.style.display = "block";
  setHtml(
    host,
    html`<div class="row-flex" style="gap:18px;margin-bottom:22px"><div style="width:56px;height:56px;color:var(--ink)">${raw((document.querySelector(".brand-mark")?.innerHTML ?? ""))}</div><div><div style="font-size:24px;font-weight:800;letter-spacing:5px">${PRODUCT.name.toUpperCase()}</div><div class="muted" style="margin-top:4px;font-size:13px">${PRODUCT.nameCn} · ${PRODUCT.tagline}</div></div></div>
    <dl class="kv">
      <dt>版本</dt><dd>${system.version}</dd>
      <dt>系统</dt><dd>${system.os.name} ${system.os.arch}${system.os.version ? ` · ${system.os.version}` : ""}</dd>
      <dt>处理器 / 内存</dt><dd>${system.cpuCount} 线程 · ${formatBytes(system.totalMemoryMB * 1024 * 1024)}（空闲 ${formatBytes(system.freeMemoryMB * 1024 * 1024)}）</dd>
      <dt>数据目录</dt><dd class="mono">${system.dataDir}</dd>
      <dt>游戏目录</dt><dd class="mono">${system.root}</dd>
      <dt>CurseForge</dt><dd>${system.hasCurseForgeKey ? "已配置 API 密钥" : "未配置（只能使用 Modrinth 或内容镜像）"}</dd>
      <dt>微软登录</dt><dd>${system.hasMicrosoftClientId ? "已配置 Azure 应用 ID" : "未配置（只能使用离线 / 外置登录）"}</dd>
    </dl>
    <div class="toolbar" style="margin-top:20px"><button class="btn sm soft" data-about="cache">清除缓存</button></div>
    <div class="section-title">开源与致谢</div>
    <div class="muted" style="font-size:12.5px;line-height:1.9">
      界面基于 <a class="link" data-about-link="https://github.com/LBEILC/RhineLabUI">RhineLabUI</a>（MIT © 2026 LBEILC）改造；3D 渲染使用 three.js；界面字体为小米 MiSans。<br />
      本启动器的后端为原创实现，使用与 PCL 相同的官方源（Mojang、Fabric、Forge、NeoForge、Modrinth、CurseForge）和镜像源（BMCLAPI、MCIM），不包含 PCL 的任何源代码。<br />
      Minecraft 是 Mojang Studios 的商标，本项目与 Mojang、Microsoft 无关。
    </div>`,
  );
  host.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const link = target.closest<HTMLElement>("[data-about-link]");
    if (link) return void openLink(link.dataset.aboutLink!);
    if (target.closest("[data-about='cache']")) {
      if (await confirmDialog({ title: "清除缓存？", message: "会删除版本列表、加载器列表等下载缓存，下次使用时重新获取。不会影响游戏文件。", confirm: "清除" })) {
        await guard(() => rpc("app.clearCache"));
        toast("缓存已清除", "ok");
      }
    }
  });
}
