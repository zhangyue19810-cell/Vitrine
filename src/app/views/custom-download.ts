import { guard, pickPath } from "../actions";
import { rpc } from "../api";
import { $, html } from "../dom";
import { openDialog, toast } from "../modal";
import { store } from "../store";

/** A focused download sheet: URL, destination, optional name and a source policy. */
export function openCustomDownload() {
  const segments = store.settings?.download.segments ?? 8;
  const body = document.createElement("div");
  body.className = "custom-download";
  body.innerHTML = html`
    <div class="field">
      <label>文件地址</label>
      <input class="input mono" data-url autofocus autocomplete="off" spellcheck="false" placeholder="https://github.com/owner/repo/releases/download/…" />
      <div class="hint-text">支持 GitHub Release、普通直链和任意 http(s) 文件；GitHub 地址会自动生成阿里云、华清云与多个 GH 云加速候选。</div>
    </div>
    <div class="field">
      <label>保存到</label>
      <div class="row-flex">
        <input class="input mono grow" data-folder autocomplete="off" spellcheck="false" placeholder="点击右侧选择文件夹" />
        <button class="btn soft" type="button" data-browse>选择文件夹…</button>
      </div>
    </div>
    <div class="row-flex custom-download-row">
      <div class="field grow">
        <label>文件名（可选）</label>
        <input class="input" data-name autocomplete="off" spellcheck="false" placeholder="留空则使用原文件名" />
      </div>
      <div class="field custom-download-threads">
        <label>分段连接</label>
        <input class="input tnum" data-segments type="number" min="1" max="16" value="${Math.max(1, Math.min(16, segments))}" />
      </div>
    </div>
    <div class="field">
      <label>下载来源</label>
      <select class="select" data-mode>
        <option value="auto">自动测速（推荐，逐个测试后选最快）</option>
        <option value="github">GitHub 云加速优先</option>
        <option value="aliyun">阿里云镜像优先</option>
        <option value="huaqing">华清云镜像优先</option>
        <option value="direct">只用原始地址</option>
      </select>
      <div class="hint-text">“自动测速”会并行请求每个候选源的首段数据，按实际速度排序；失败源会自动跳过，真正下载仍会保留回退列表。</div>
    </div>
    <div class="custom-download-status" data-status aria-live="polite"></div>`.value;

  const field = <T extends HTMLElement>(name: string) => $<T>(`[data-${name}]`, body);
  const status = field<HTMLElement>("status");
  let busy = false;

  body.querySelector<HTMLButtonElement>("[data-browse]")?.addEventListener("click", async () => {
    const folder = await pickPath("folder", { title: "选择下载保存文件夹" });
    if (folder) field<HTMLInputElement>("folder").value = folder;
  });

  const urlInput = field<HTMLInputElement>("url");
  const folderInput = field<HTMLInputElement>("folder");
  const clearInvalid = (input: HTMLInputElement) => {
    input.removeAttribute("aria-invalid");
    delete input.dataset.valid;
  };

  urlInput.addEventListener("input", () => {
    status.textContent = "";
    status.dataset.kind = "";
    clearInvalid(urlInput);
    const value = urlInput.value.trim();
    if (!value) return;
    try {
      const parsed = new URL(value);
      if ((parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password) urlInput.dataset.valid = "true";
    } catch {
      /* still being typed */
    }
  });

  folderInput.addEventListener("input", () => {
    clearInvalid(folderInput);
    if (folderInput.value.trim()) folderInput.dataset.valid = "true";
  });

  const dialog = openDialog({
    eyebrow: "CUSTOM DOWNLOAD",
    title: "自定义下载",
    size: "wide",
    body,
    buttons: [
      { id: "cancel", label: "取消" },
      { id: "start", label: "测速并下载", kind: "accent" },
    ],
    onButton: async (id) => {
      if (id !== "start" || busy) return;
      const url = field<HTMLInputElement>("url").value.trim();
      const folder = field<HTMLInputElement>("folder").value.trim();
      const filename = field<HTMLInputElement>("name").value.trim();
      const mode = field<HTMLSelectElement>("mode").value as "auto" | "direct" | "github" | "aliyun" | "huaqing";
      const segmentsValue = Number(field<HTMLInputElement>("segments").value);
      const clear = (input: HTMLInputElement) => {
        input.removeAttribute("aria-invalid");
        delete input.dataset.valid;
      };
      const fail = (message: string, input?: HTMLInputElement) => {
        status.textContent = message;
        status.dataset.kind = "error";
        if (input) {
          input.removeAttribute("data-valid");
          input.setAttribute("aria-invalid", "true");
          input.focus({ preventScroll: true });
        }
        return false;
      };
      clear(urlInput);
      clear(folderInput);
      if (!url) return fail("请填写文件地址", urlInput);
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return fail("文件地址必须以 http:// 或 https:// 开头", urlInput);
        if (parsed.username || parsed.password) return fail("文件地址不能包含用户名或密码", urlInput);
        urlInput.dataset.valid = "true";
      } catch {
        return fail("文件地址不是有效的网址", urlInput);
      }
      if (!folder) return fail("请选择保存文件夹", folderInput);
      folderInput.dataset.valid = "true";
      busy = true;
      status.textContent = "正在提交下载任务…";
      status.dataset.kind = "busy";
      const started = await guard(() => rpc("customDownload.start", {
        url,
        folder,
        filename: filename || undefined,
        mode,
        segments: Number.isFinite(segmentsValue) ? Math.max(1, Math.min(16, Math.round(segmentsValue))) : undefined,
      }), "无法开始下载：");
      busy = false;
      if (!started) {
        status.textContent = "任务没有开始，请检查地址、保存目录或网络设置。";
        status.dataset.kind = "error";
        return false;
      }
      toast("已加入下载队列，完成后顶部灵动岛会提示 3 秒。", "ok");
      return true;
    },
  });
  queueMicrotask(() => field<HTMLInputElement>("url").focus());
  void dialog.result;
}
