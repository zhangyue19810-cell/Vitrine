import { rpc, tryRpc } from "../api";
import { guard, openFolder, openLink, repairInstance, withBusy } from "../actions";
import { $, html, onAll, setHtml } from "../dom";
import { formatDate, formatPlayTime, relativeTime } from "../format";
import { promptDialog, toast } from "../modal";
import { displayName } from "../records";
import { store } from "../store";
import { loaderText, memoryOptions } from "../ui-bits";
import type { InstanceSummary, LatestPack, PackState } from "../types";
import type { TabContext, TabHandle } from "./detail-types";
import { openDownloads } from "./downloads";

const ORIGIN_LABEL: Record<string, string> = { modrinth: "Modrinth", curseforge: "CurseForge", mrpack: "本地 .mrpack", "curseforge-zip": "CurseForge 整合包文件", multimc: "MultiMC / Prism", mcbbs: "MCBBS", vitrine: "Vitrine" };

type Advice = { maxMB: number; minMB: number; reason: string; totalMB: number; freeMB: number; modCount: number };

export function mount(ctx: TabContext): TabHandle {
  const { body, signal } = ctx;
  body.innerHTML = `<div class="stack" style="gap:26px">
    <div data-f="notice"></div>
    <div class="stats" data-f="stats"></div>
    <section><div class="section-title">内存</div><div data-f="memory"><div class="skeleton" style="height:96px"></div></div></section>
    <section data-f="pack-section" hidden><div class="section-title">整合包</div><div data-f="pack"></div></section>
    <section><div class="section-title">文件与维护</div><div data-f="tools"></div></section>
  </div>`;
  const f = (name: string) => $(`[data-f="${name}"]`, body);
  let advice: Advice | undefined;
  let state: PackState | null | undefined;
  let latest: LatestPack | null | undefined;
  let latestError = "";

  const paintTop = () => {
    const instance = ctx.instance();
    const game = store.gameOf(instance.id);
    setHtml(
      f("notice"),
      !instance.valid
        ? html`<div class="notice danger"><div><b>这个实例无法读取</b><div style="margin-top:4px">${instance.problem ?? "版本文件缺失或已损坏。"}</div></div></div>`
        : instance.incomplete
          ? html`<div class="notice warn"><div style="flex:1"><b>文件不完整</b><div style="margin-top:4px">整合包里还有必需的文件没有下载成功。修复会重新下载缺失的文件，已完成的不会重复下载。</div></div><button class="btn sm" data-act="ov-repair">修复文件</button></div>`
          : game
            ? html`<div class="notice"><div><b>游戏正在运行</b><div style="margin-top:4px">部分操作（删除、完整校验）需要先结束游戏。</div></div></div>`
            : html``,
    );
    const stat = (label: string, value: string, small?: string) => html`<div class="stat" title="${value}"><div class="label">${label}</div><div class="value">${value}${small ? html` <small>${small}</small>` : ""}</div></div>`;
    setHtml(
      f("stats"),
      html`${stat("MINECRAFT", instance.mcVersion ?? "—")}${stat("加载器", loaderText(instance))}${stat("JAVA", instance.javaMajor ? `${instance.javaMajor}` : "—", instance.config.javaPath ? "自定义" : "自动")}${stat("模组", String(instance.modCount))}${stat("游玩时长", formatPlayTime(instance.config.playTimeMs))}${stat("上次游玩", instance.config.lastPlayed ? relativeTime(instance.config.lastPlayed) : "从未")}`,
    );
  };

  const paintMemory = () => {
    const instance = ctx.instance();
    const memory = instance.config.memory;
    const current = memory === undefined || memory === "auto" ? "auto" : memory;
    if (!advice) return;
    const wanted = advice.maxMB;
    const effective = current === "auto" ? wanted : current;
    const tooBig = effective > advice.totalMB * 0.85;
    const tooSmall = advice.modCount > 0 && effective < wanted * 0.7;
    setHtml(
      f("memory"),
      html`<div class="card" style="display:grid;gap:14px">
        <dl class="kv">
          <dt>当前设置</dt><dd>${current === "auto" ? `自动 → ${(wanted / 1024).toFixed(wanted % 1024 ? 1 : 0)} GB` : `${(current / 1024).toFixed(current % 1024 ? 2 : 0).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")} GB（${current} MB）`}</dd>
          <dt>推荐</dt><dd>${(wanted / 1024).toFixed(wanted % 1024 ? 1 : 0)} GB · ${advice.reason}</dd>
          <dt>这台电脑</dt><dd>共 ${(advice.totalMB / 1024).toFixed(1)} GB，现在空闲 ${(advice.freeMB / 1024).toFixed(1)} GB</dd>
        </dl>
        ${tooBig ? html`<div class="notice warn">设置的内存超过电脑内存的 85%，游戏可能起不来或让系统变卡。</div>` : ""}
        ${tooSmall ? html`<div class="notice warn">这个实例有 ${advice.modCount} 个模组，内存可能偏小，容易卡顿或崩溃（OutOfMemory）。</div>` : ""}
        <div class="toolbar"><select class="select" data-memory style="min-width:230px">${memoryOptions(current).map(([value, label]) => html`<option value="${value}" ${String(value) === String(current) ? "selected" : ""}>${label}</option>`)}</select>${current !== "auto" ? html`<button class="btn sm soft" data-act="ov-auto-memory">改回自动</button>` : ""}</div>
      </div>`,
    );
  };

  const paintPack = () => {
    const instance = ctx.instance();
    const origin = instance.config.modpack;
    const section = f("pack-section");
    section.hidden = !origin;
    if (!origin) return;
    const files = state?.files.length ?? 0;
    const failed = state?.failed ?? [];
    const unresolved = state?.unresolved ?? [];
    const canCheck = (origin.source === "modrinth" || origin.source === "curseforge") && Boolean(origin.projectId);
    const isNewer = latest && origin.versionId && latest.versionId !== origin.versionId;
    setHtml(
      f("pack"),
      html`<div class="card" style="display:grid;gap:14px">
        <dl class="kv">
          <dt>来源</dt><dd>${ORIGIN_LABEL[origin.source] ?? origin.source}</dd>
          ${origin.name ? html`<dt>名称</dt><dd>${origin.name}</dd>` : ""}
          ${origin.version ? html`<dt>版本</dt><dd>${origin.version}</dd>` : ""}
          ${state ? html`<dt>文件</dt><dd>${files} 个由整合包管理${state.complete ? "，全部就绪" : "，仍有缺失"}${state.updatedAt ? ` · 更新于 ${formatDate(state.updatedAt)}` : ""}</dd>` : ""}
        </dl>
        ${failed.length ? html`<div class="notice warn"><div style="flex:1"><b>${failed.length} 个文件下载失败</b><div style="margin-top:4px;font-size:12px;line-height:1.7;max-height:96px;overflow:auto">${failed.slice(0, 12).map((entry) => html`<div>${entry.path}：${entry.error}</div>`)}${failed.length > 12 ? html`<div>…另有 ${failed.length - 12} 个</div>` : ""}</div></div><button class="btn sm" data-act="ov-repair">重试下载</button></div>` : ""}
        ${unresolved.length ? html`<div class="notice warn"><div style="flex:1"><b>${unresolved.length} 个文件需要手动下载</b><div style="margin-top:4px;font-size:12px;line-height:1.7">这些模组的作者不允许第三方启动器直接下载。点开页面下载后，放进这个实例的 mods 文件夹即可。</div><div style="margin-top:8px;display:grid;gap:4px;max-height:140px;overflow:auto">${unresolved.slice(0, 30).map((entry) => (entry.pageUrl ? html`<a class="link" href="#" data-link="${entry.pageUrl}">${entry.name ?? `项目 ${entry.projectId}`} ↗</a>` : html`<span>${entry.name ?? `项目 ${entry.projectId}`}：${entry.reason}</span>`))}</div></div></div>` : ""}
        ${isNewer ? html`<div class="notice"><div style="flex:1"><b>有新版本 ${latest!.version}</b>${latest!.publishedAt ? html` <span class="muted">${formatDate(latest!.publishedAt)}</span>` : ""}${latest!.changelog ? html`<div class="muted" style="margin-top:6px;font-size:12px;line-height:1.7;max-height:96px;overflow:auto;white-space:pre-wrap">${latest!.changelog.slice(0, 900)}</div>` : ""}<div class="muted" style="margin-top:6px;font-size:12px">新版本会安装成一个新的实例，当前实例的存档和设置不受影响。</div></div><button class="btn sm accent" data-act="ov-install-latest">安装新版本</button></div>` : latest ? html`<div class="muted" style="font-size:12.5px">已经是最新版本（${latest.version}）。</div>` : ""}
        ${latestError ? html`<div class="muted" style="font-size:12.5px">${latestError}</div>` : ""}
        <div class="toolbar">${canCheck ? html`<button class="btn sm" data-act="ov-check-pack">检查整合包更新</button>` : html`<span class="muted" style="font-size:12px">这个整合包不是从在线平台安装的，无法检查更新。</span>`}${origin.projectId && origin.source === "modrinth" ? html`<button class="btn sm soft" data-link="https://modrinth.com/modpack/${origin.projectId}">在 Modrinth 打开 ↗</button>` : ""}</div>
      </div>`,
    );
  };

  const paintTools = () => {
    const instance = ctx.instance();
    const folder = (sub: string, label: string) => html`<button class="btn sm soft" data-folder="${sub}">${label}</button>`;
    setHtml(
      f("tools"),
      html`<div class="card" style="display:grid;gap:16px">
        <div class="toolbar">${folder("", "游戏文件夹")}${folder("mods", "mods")}${folder("saves", "存档")}${folder("screenshots", "截图")}${folder("logs", "日志")}${folder("crash-reports", "崩溃报告")}${folder("config", "配置")}</div>
        <div class="toolbar"><button class="btn sm" data-act="ov-repair">校验并修复文件</button><button class="btn sm soft" data-act="ov-mods">管理模组 →</button><button class="btn sm soft" data-act="ov-logs">查看日志 →</button></div>
        <dl class="kv">
          <dt>实例目录</dt><dd class="mono" style="font-size:11.5px;overflow-wrap:anywhere">${instance.dir}</dd>
          ${instance.gameDir !== instance.dir ? html`<dt>游戏目录</dt><dd class="mono" style="font-size:11.5px;overflow-wrap:anywhere">${instance.gameDir}</dd>` : ""}
          <dt>存档与模组</dt><dd>${instance.isolated ? "放在实例自己的文件夹里（独立）" : "放在共享的游戏目录里（与其他实例共用）"}</dd>
          ${instance.config.createdAt ? html`<dt>创建于</dt><dd>${formatDate(instance.config.createdAt)}</dd>` : ""}
        </dl>
      </div>`,
    );
  };

  const paintAll = () => {
    paintTop();
    paintMemory();
    paintPack();
    paintTools();
  };
  paintAll();

  // ------------------------------------------------------------------------------------------ data
  void rpc("instances.memoryAdvice", { id: ctx.instance().id }, signal).then(
    (value) => {
      advice = value;
      paintMemory();
    },
    () => setHtml(f("memory"), html`<div class="muted" style="font-size:12.5px">暂时无法估算内存。</div>`),
  );
  if (ctx.instance().config.modpack) {
    void tryRpc("instances.packState", { id: ctx.instance().id }).then((value) => {
      if (signal.aborted) return;
      state = value ?? null;
      paintPack();
    });
  }

  // ------------------------------------------------------------------------------------------ events
  const setMemory = async (value: string) => {
    const memory = value === "auto" ? "auto" : Number(value);
    await guard(() => rpc("instances.setConfig", { id: ctx.instance().id, patch: { memory } }));
  };
  onAll(body, "change", "[data-memory]", (element) => void setMemory((element as HTMLSelectElement).value));
  onAll(body, "click", "[data-folder]", (element) => void openFolder(ctx.instance().id, element.dataset.folder));
  onAll(body, "click", "[data-link]", (element, event) => {
    event.preventDefault();
    void openLink(element.dataset.link!);
  });
  onAll(body, "click", "[data-act]", (element) => {
    const instance = ctx.instance();
    switch (element.dataset.act) {
      case "ov-repair":
        return void repairInstance(instance.id);
      case "ov-auto-memory":
        return void setMemory("auto");
      case "ov-mods":
        return ctx.go("mods");
      case "ov-logs":
        return ctx.go("logs");
      case "ov-check-pack":
        return void withBusy(element, () => checkPack(instance));
      case "ov-install-latest":
        return void installLatest(instance);
    }
  });

  async function checkPack(instance: InstanceSummary) {
    latestError = "";
    try {
      latest = await rpc("packs.latest", { instanceId: instance.id }, signal);
      if (!latest) latestError = "平台上没有找到这个整合包的可用版本。";
    } catch (error) {
      latest = undefined;
      latestError = `检查失败：${(error as Error).message}`;
    }
    if (!signal.aborted) paintPack();
  }

  async function installLatest(instance: InstanceSummary) {
    const origin = instance.config.modpack;
    if (!origin?.projectId || !latest || (origin.source !== "modrinth" && origin.source !== "curseforge")) return;
    const name = await promptDialog({
      title: "安装新版本",
      label: "新实例名称",
      value: `${origin.name ?? displayName(instance)} ${latest.version}`.replace(/[\\/:*?"<>|]/g, "_"),
      message: "会下载整合包的新版本并创建一个新实例。当前实例保持不变，需要时可以把存档复制过去。",
      confirm: "开始安装",
      validate: (value) => (!value ? "请输入名称" : store.instances.some((entry) => entry.name === value) ? "已经有同名的实例" : undefined),
    });
    if (!name) return;
    const started = await guard(() => rpc("packs.installOnline", { source: origin.source as "modrinth" | "curseforge", projectId: origin.projectId!, versionId: latest!.versionId, name, title: origin.name }));
    if (started) {
      toast("开始安装新版本", "ok");
      openDownloads(started.taskId);
    }
  }

  return {
    update() {
      paintTop();
      paintMemory();
    },
  };
}
