import { rpc } from "../api";
import { guard, pickPath } from "../actions";
import { html } from "../dom";
import { formatBytes } from "../format";
import { openDialog, toast } from "../modal";
import { displayName } from "../records";
import type { InstanceSummary } from "../types";
import { openDownloads } from "./downloads";

/**
 * Export an instance as a Modrinth modpack (.mrpack). The player chooses which folders and files go in; mods that
 * Modrinth knows are written as download links (small file), everything else is packed into the archive.
 */
export async function exportPack(instance: InstanceSummary) {
  const candidates = await guard(() => rpc("packs.exportCandidates", { instanceId: instance.id }));
  if (!candidates) return;
  if (!candidates.length) {
    toast("这个实例里没有可以导出的内容", "info");
    return;
  }
  const body = document.createElement("div");
  body.className = "stack";
  body.innerHTML = html`
    <div class="grid-2">
      <div class="field"><label>整合包名称</label><input class="input" data-name value="${displayName(instance)}" maxlength="60" /></div>
      <div class="field"><label>版本号</label><input class="input" data-version value="1.0.0" maxlength="40" /></div>
    </div>
    <div class="field"><label>简介（可选）</label><input class="input" data-summary maxlength="200" placeholder="一句话介绍" /></div>
    <div>
      <div class="section-title">包含的内容</div>
      <div class="list" style="max-height:260px;overflow:auto">${candidates.map(
        (entry, index) => html`<label class="item" style="cursor:pointer"><input type="checkbox" data-include="${index}" ${entry.defaultInclude ? "checked" : ""} /><div style="min-width:0"><div class="title">${entry.path}${entry.kind === "dir" ? "/" : ""}</div>${entry.note ? html`<div class="sub wrap">${entry.note}</div>` : ""}</div><div class="tail muted">${formatBytes(entry.size)}</div></label>`,
      )}</div>
    </div>
    <label class="check" style="display:flex"><input type="checkbox" data-identify checked />把能在 Modrinth 找到的模组写成下载链接（文件更小）</label>
    <div class="notice warn" style="font-size:12px">不要把含有账号信息、个人路径或私人存档的文件分享给别人。默认已排除 saves、日志和账号文件。</div>`.value;
  const dialog = openDialog({ eyebrow: "EXPORT MODPACK", title: "导出整合包", size: "wide", body, buttons: [{ id: "cancel", label: "取消" }, { id: "ok", label: "选择保存位置", kind: "accent" }] });
  if ((await dialog.result) !== "ok") return;
  const name = (body.querySelector<HTMLInputElement>("[data-name]")?.value ?? "").trim() || displayName(instance);
  const version = (body.querySelector<HTMLInputElement>("[data-version]")?.value ?? "").trim() || "1.0.0";
  const summary = (body.querySelector<HTMLInputElement>("[data-summary]")?.value ?? "").trim() || undefined;
  const include = candidates.filter((_, index) => body.querySelector<HTMLInputElement>(`[data-include="${index}"]`)?.checked).map((entry) => entry.path);
  const identify = body.querySelector<HTMLInputElement>("[data-identify]")?.checked ?? true;
  if (!include.length) {
    toast("没有选择任何内容", "error");
    return;
  }
  const dest = await pickPath("save", { title: "保存整合包", defaultPath: `${name}-${version}.mrpack`, filters: [{ name: "Modrinth 整合包", extensions: ["mrpack"] }] });
  if (!dest) return;
  const started = await guard(() => rpc("packs.export", { instanceId: instance.id, dest, name, version, summary, include, identify }));
  if (started) {
    toast("正在导出整合包…", "info");
    openDownloads(started.taskId);
  }
}
