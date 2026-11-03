import { rpc, tryRpc } from "./api";
import { RpcError } from "./bridge";
import { html } from "./dom";
import { errorMessage } from "./format";
import { confirmDialog, openDialog, promptDialog, toast } from "./modal";
import { displayName } from "./records";
import { store } from "./store";
import type { InstanceSummary, TaskSnapshot } from "./types";

/**
 * Operations the interface starts from several places (the home screen, the detail page, search…). Each one talks to the
 * core, asks the player when something is destructive, and reports failures as a toast instead of throwing.
 */

/** Run an async job, showing a toast when it fails. Resolves to undefined on failure. */
export async function guard<T>(job: () => Promise<T>, prefix = ""): Promise<T | undefined> {
  try {
    return await job();
  } catch (error) {
    if ((error as { code?: string })?.code === "cancelled") return undefined;
    toast(`${prefix}${errorMessage(error)}`, "error");
    return undefined;
  }
}

/** Mark a button busy while a job runs. */
export async function withBusy<T>(button: HTMLElement | null | undefined, job: () => Promise<T>): Promise<T> {
  button?.setAttribute("data-busy", "true");
  try {
    return await job();
  } finally {
    button?.removeAttribute("data-busy");
  }
}

type PickKind = "file" | "folder" | "save";

/**
 * Ask for a path. The desktop app opens its native dialog; the development backend has no window to show one, so the
 * player types or pastes the path instead.
 */
export async function pickPath(kind: PickKind, options: { title: string; filters?: { name: string; extensions: string[] }[]; defaultPath?: string; hint?: string } = { title: "选择" }): Promise<string | undefined> {
  try {
    if (kind === "file") return (await rpc("host.pickFile", { title: options.title, filters: options.filters }))?.[0];
    if (kind === "folder") return await rpc("host.pickFolder", { title: options.title });
    return await rpc("host.saveFile", { title: options.title, defaultPath: options.defaultPath, filters: options.filters });
  } catch (error) {
    if (!(error instanceof RpcError) || error.code !== "no-host") throw error;
  }
  return promptDialog({
    title: options.title,
    label: kind === "folder" ? "文件夹路径" : kind === "save" ? "保存到（完整路径）" : "文件路径",
    message: options.hint ?? "当前不是桌面版，没有系统文件选择窗口，请直接粘贴路径。",
    value: options.defaultPath,
    validate: (value) => (value ? undefined : "请输入路径"),
  });
}

// ---------------------------------------------------------------------------------------------- instances

export async function launchInstance(id: string, options: { server?: string; world?: string } = {}) {
  const instance = store.instance(id);
  if (!instance) return;
  if (store.gameOf(id)) {
    toast("这个实例的游戏已经在运行了", "info");
    return;
  }
  const { openLaunch } = await import("./views/launch");
  const started = await guard(() => rpc("instances.launch", { id, ...options }));
  if (started) openLaunch(started.taskId, id);
}

export async function stopGame(instanceId: string) {
  const game = store.gameOf(instanceId);
  if (!game) return;
  const ok = await confirmDialog({ title: "结束游戏？", message: "游戏进程会被立即终止，尚未保存的进度将丢失。", confirm: "结束游戏", danger: true });
  if (ok) await guard(() => rpc("games.kill", { id: game.id }));
}

export async function repairInstance(id: string, verify: "size" | "hash" = "size") {
  const started = await guard(() => rpc("instances.repair", { id, verify }));
  if (started) {
    toast("正在校验并修复文件，进度见“下载”", "info");
    const { openDownloads } = await import("./views/downloads");
    openDownloads(started.taskId);
  }
}

export async function toggleFavorite(id: string) {
  const instance = store.instance(id);
  if (!instance) return;
  await guard(() => rpc("instances.setConfig", { id, patch: { favorite: !instance.config.favorite } }));
}

export async function renameInstance(instance: InstanceSummary) {
  const value = await promptDialog({ title: "显示名称", label: "名称", value: displayName(instance), placeholder: instance.name, confirm: "保存", validate: (v) => (v.length > 60 ? "名称太长了" : undefined) });
  if (value === undefined) return;
  await guard(() => rpc("instances.setConfig", { id: instance.id, patch: { displayName: value === instance.name ? "" : value } }));
}

export async function duplicateInstance(instance: InstanceSummary) {
  const value = await promptDialog({
    title: "复制实例",
    label: "新实例的文件夹名称",
    value: `${instance.name} - 副本`,
    confirm: "复制",
    message: "会复制整个实例文件夹（模组、存档、设置），大型整合包需要一点时间。",
    validate: (v) => (!v ? "请输入名称" : /[\\/:*?"<>|]/.test(v) ? "名称不能包含 \\ / : * ? \" < > |" : store.instances.some((entry) => entry.name === v) ? "已经有同名的实例" : undefined),
  });
  if (!value) return;
  const started = await guard(() => rpc("instances.duplicate", { id: instance.id, name: value }));
  if (started) {
    toast("正在复制实例…", "info");
    const { openDownloads } = await import("./views/downloads");
    openDownloads(started.taskId);
  }
}

export async function deleteInstance(instance: InstanceSummary): Promise<boolean> {
  if (store.gameOf(instance.id)) {
    toast("请先结束这个实例的游戏", "error");
    return false;
  }
  const typed = instance.modCount > 0 || instance.isolated;
  const ok = await confirmDialog({
    eyebrow: "DELETE",
    title: `删除“${displayName(instance)}”？`,
    message: html`<p style="margin:0">将删除 <b>${instance.isolated ? "整个实例文件夹，包括存档、模组和截图" : "这个版本的文件（共享目录里的存档不受影响）"}</b>。此操作无法撤销。</p>${typed ? html`<p class="muted" style="margin:10px 0 0;font-size:12px">${instance.dir}</p>` : ""}`,
    confirm: "永久删除",
    danger: true,
  });
  if (!ok) return false;
  return (await guard(() => rpc("instances.remove", { id: instance.id }).then(() => true))) ?? false;
}

export async function openFolder(id: string, sub?: string) {
  // The core opens the folder through the desktop shell; the development backend has none and says so.
  await guard(() => rpc("instances.openFolder", { id, sub }));
}

/** Resolve with the final state of a task (also when it has already finished). Rejects with the task's error when it failed. */
export function awaitTask(taskId: string, signal?: AbortSignal): Promise<TaskSnapshot> {
  return new Promise((resolve, reject) => {
    const settle = (task: TaskSnapshot | null | undefined): boolean => {
      if (!task) return false;
      if (task.state === "done") resolve(task);
      else if (task.state === "failed") reject(Object.assign(new Error(task.error ?? "任务失败"), { code: task.errorCode }));
      else if (task.state === "cancelled") reject(Object.assign(new Error("已取消"), { code: "cancelled" }));
      else return false;
      return true;
    };
    if (settle(store.tasks.get(taskId))) return;
    const stop = () => {
      off();
      signal?.removeEventListener("abort", onAbort);
    };
    const off = store.on<TaskSnapshot>("task", (task) => {
      if (task.id === taskId && settle(task)) stop();
    });
    const onAbort = () => {
      stop();
      reject(Object.assign(new Error("已取消"), { code: "cancelled" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // The task may have finished between the first check and the subscription (or been dropped from the list).
    void rpc("tasks.get", { id: taskId }).then((task) => {
      if (task && settle(task)) stop();
    }, () => undefined);
  });
}

export async function openLink(url: string) {
  const ok = await tryRpc("host.openExternal", { url });
  if (ok === undefined) window.open(url, "_blank", "noopener");
}

// ---------------------------------------------------------------------------------------------- modpacks

/** Preview a pack file, let the player adjust the name and optional files, then install it. */
export async function importPack(path?: string) {
  const file =
    path ??
    (await pickPath("file", {
      title: "选择整合包文件",
      filters: [{ name: "整合包", extensions: ["mrpack", "zip"] }],
      hint: "支持 Modrinth (.mrpack)、CurseForge (.zip)、MultiMC / Prism (.zip) 和 MCBBS 整合包。当前不是桌面版，请粘贴文件的完整路径。",
    }));
  if (!file) return;
  const preview = await guard(() => rpc("packs.preview", { file }), "无法读取整合包：");
  if (!preview) return;
  const body = document.createElement("div");
  body.className = "stack";
  const optional = preview.optionalFiles ?? [];
  body.innerHTML = html`
    <div class="field"><label>实例名称</label><input class="input" data-name value="${preview.name}" /></div>
    <dl class="kv">
      <dt>格式</dt><dd>${({ mrpack: "Modrinth (.mrpack)", curseforge: "CurseForge", multimc: "MultiMC / Prism", mcbbs: "MCBBS" } as Record<string, string>)[preview.format] ?? preview.format}</dd>
      <dt>Minecraft</dt><dd>${preview.mcVersion}${preview.loader ? ` · ${preview.loader.kind} ${preview.loader.version}` : ""}</dd>
      <dt>文件</dt><dd>${preview.fileCount} 个需要下载，${preview.overrideCount} 个直接解压</dd>
      ${preview.author ? html`<dt>作者</dt><dd>${preview.author}</dd>` : ""}
      ${preview.version ? html`<dt>版本</dt><dd>${preview.version}</dd>` : ""}
    </dl>
    ${preview.summary ? html`<div class="muted" style="font-size:12.5px;line-height:1.7">${preview.summary}</div>` : ""}
    ${preview.warnings.map((w) => html`<div class="notice warn">${w}</div>`)}
    ${optional.length ? html`<div><div class="section-title">可选文件（取消勾选即跳过）</div>${optional.map((f, i) => html`<label class="check" style="display:flex;margin:4px 0"><input type="checkbox" data-optional="${i}" checked />${f.label ?? f.path}</label>`)}</div>` : ""}`.value;
  const dialog = openDialog({
    eyebrow: "IMPORT MODPACK",
    title: preview.name,
    size: "wide",
    body,
    buttons: [
      { id: "cancel", label: "取消" },
      { id: "ok", label: "开始安装", kind: "accent" },
    ],
  });
  if ((await dialog.result) !== "ok") return;
  const name = (body.querySelector<HTMLInputElement>("[data-name]")?.value ?? "").trim() || preview.name;
  const skipped = optional.filter((_, i) => !body.querySelector<HTMLInputElement>(`[data-optional="${i}"]`)?.checked).map((f) => f.path);
  const started = await guard(() => rpc("packs.install", { file, name, skipOptional: skipped.length ? skipped : undefined }));
  if (started) {
    toast("开始安装整合包，多线程下载进度见“下载”", "ok");
    const { openDownloads } = await import("./views/downloads");
    openDownloads(started.taskId);
  }
}
