import { openLink } from "../actions";
import { html, onAll } from "../dom";
import { openDialog, toast } from "../modal";
import { store } from "../store";
import { PRODUCT, markSvg } from "../../brand";

/** About box: version, where the data lives, and the credits the licences ask for. */
export function openAbout() {
  const system = store.ready ? store.system : undefined;
  const body = document.createElement("div");
  body.className = "stack";
  body.innerHTML = html`
    <div style="display:flex;gap:18px;align-items:center"><div style="width:64px;height:64px;flex:none">${markSvg({ label: PRODUCT.name })}</div><div><div style="font-size:22px;font-weight:750;letter-spacing:.5px">${PRODUCT.name} <span style="font-weight:400">${PRODUCT.nameCn}</span></div><div class="muted" style="margin-top:4px;font-size:13px">${PRODUCT.tagline}</div></div></div>
    <dl class="kv">
      <dt>版本</dt><dd>${system ? system.version : "—"}${store.coreVersion ? ` · 核心 ${store.coreVersion}` : ""}</dd>
      ${system ? html`<dt>系统</dt><dd>${system.os.name} ${system.os.arch}${system.os.version ? ` · ${system.os.version}` : ""} · ${system.cpuCount} 核 · ${(system.totalMemoryMB / 1024).toFixed(1)} GB 内存</dd><dt>数据目录</dt><dd class="mono" style="font-size:11.5px;overflow-wrap:anywhere">${system.dataDir}</dd><dt>游戏目录</dt><dd class="mono" style="font-size:11.5px;overflow-wrap:anywhere">${system.root}</dd>` : ""}
    </dl>
    <div class="muted" style="font-size:12px;line-height:1.85">
      ${PRODUCT.name} 是一个独立编写的启动器，核心（下载、安装、启动、账号、整合包、崩溃分析）为原创实现，<b>没有使用 PCL2 的源代码</b>；官方源与镜像源（BMCLAPI、MCIM）的地址与 PCL2 使用的相同，只是调用公开接口。<br />
      界面基于 <a class="link" data-link="https://github.com/LBEILC/RhineLabUI">RhineLabUI</a>（MIT © 2026 LBEILC）修改；字体 MiSans（小米，按其许可使用）；3D 渲染 three.js（MIT）。<br />
      “Minecraft”是 Mojang Studios / Microsoft 的商标，本软件与其无隶属关系。
    </div>
    <div class="toolbar"><button class="btn sm soft" data-copy>复制系统信息</button></div>`.value;
  onAll(body, "click", "[data-link]", (element, event) => {
    event.preventDefault();
    void openLink(element.dataset.link!);
  });
  onAll(body, "click", "[data-copy]", async () => {
    const text = [`${PRODUCT.name} ${system?.version ?? ""}`, system ? `${system.os.name} ${system.os.arch} ${system.os.version ?? ""}, ${system.cpuCount} cores, ${(system.totalMemoryMB / 1024).toFixed(1)} GB` : "", store.settings ? `sources: ${store.settings.sources.policy}/${store.settings.sources.contentPolicy}, threads ${store.settings.download.concurrency}×${store.settings.download.segments}` : ""].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制", "ok");
    } catch {
      toast("浏览器不允许写入剪贴板", "error");
    }
  });
  openDialog({ eyebrow: "ABOUT", title: `关于 ${PRODUCT.name}`, body, size: "wide", buttons: [{ id: "ok", label: "好", kind: "primary" }] });
}
