import { rpc, tryRpc } from "../api";
import { pickPath } from "../actions";
import { $, debounce, html, onAll, type Raw } from "../dom";
import { errorMessage } from "../format";
import { store } from "../store";
import { ACCOUNT_TYPE_LABEL, memoryOptions } from "../ui-bits";
import type { InstanceConfig, JavaInstall } from "../types";
import type { TabContext, TabHandle } from "./detail-types";

/**
 * Per-instance settings. Like the global settings page, every control saves by itself; the core validates and the
 * control shows what it answered. Nothing on this page re-renders while the player is typing.
 */

type Opt = [value: string | number, label: string];

interface Row {
  key: keyof InstanceConfig | "env" | "memory" | "java";
  name: string;
  desc?: string | Raw;
  kind: "text" | "area" | "select" | "number" | "toggle" | "memory" | "java" | "env" | "group";
  placeholder?: string;
  mono?: boolean;
  options?: Opt[];
  rows?: number;
  min?: number;
  max?: number;
  block?: boolean;
}

interface Section {
  title: string;
  rows: Row[];
}

function sections(javaMajor: number | undefined): Section[] {
  return [
    {
      title: "外观与整理",
      rows: [
        { key: "displayName", name: "显示名称", kind: "text", placeholder: "留空则使用文件夹名称", desc: "只改显示的名字，不改文件夹。" },
        { key: "note", name: "备注", kind: "area", rows: 2, block: true, placeholder: "给自己留一句话，会显示在首页的实例介绍里" },
        { key: "group", name: "分组", kind: "group", placeholder: "留空 = 自动（整合包 / 模组 / 原版）", desc: "分组决定实例出现在 3D 书架的哪一列，也可以自己起名字。" },
        { key: "favorite", name: "收藏", kind: "toggle" },
      ],
    },
    {
      title: "运行环境",
      rows: [
        { key: "java", name: "Java", kind: "java", desc: `留空自动选择（这个版本需要 Java ${javaMajor ?? "?"}）；也可以指定某个已安装的 Java。` },
        { key: "memory", name: "最大内存", kind: "memory", desc: "“自动”会按电脑内存和模组数量估算。" },
        {
          key: "jvmPreset",
          name: "JVM 参数预设",
          kind: "select",
          options: [["", "跟随默认"], ...store.jvmPresets.map((preset): Opt => [preset.id, preset.label + (preset.minJava > (javaMajor ?? 99) ? `（需要 Java ${preset.minJava}+）` : "")])],
          desc: "大型整合包建议用“大型整合包”预设。你自己写了 GC 参数时，预设会自动让位。",
        },
        { key: "jvmArgs", name: "额外 JVM 参数", kind: "area", rows: 2, block: true, mono: true, placeholder: "-Dfile.encoding=UTF-8 -XX:+UseG1GC …", desc: "用空格分隔。内存请用上面的“最大内存”设置，不要写 -Xmx。" },
        { key: "isolation", name: "存档与模组存放位置", kind: "select", options: [["auto", "自动（带加载器或快照的实例独立存放）"], ["on", "总是独立（放在实例自己的文件夹里）"], ["off", "共用游戏目录"]], desc: "已有文件不会被移动：改变这一项后，游戏会换一个文件夹运行。" },
      ],
    },
    {
      title: "游戏",
      rows: [
        { key: "gameArgs", name: "额外游戏参数", kind: "area", rows: 2, block: true, mono: true, placeholder: "--demo、--quickPlayPath …" },
        { key: "width", name: "窗口宽度", kind: "number", min: 0, max: 16384, placeholder: "默认" },
        { key: "height", name: "窗口高度", kind: "number", min: 0, max: 16384, placeholder: "默认" },
        { key: "fullscreen", name: "全屏启动", kind: "toggle" },
        { key: "autoJoin", name: "启动后自动加入服务器", kind: "text", mono: true, placeholder: "play.example.com:25565", desc: "留空则正常进入主菜单。" },
        { key: "accountId", name: "使用的账号", kind: "select", options: [["", "跟随全局选择"], ...store.accounts.map((account): Opt => [account.id, `${account.name}（${ACCOUNT_TYPE_LABEL[account.type] ?? account.type}）`])], desc: "给这个实例固定使用某个账号，比如离线测试号。" },
      ],
    },
    {
      title: "高级",
      rows: [
        { key: "preLaunch", name: "启动前执行的命令", kind: "text", mono: true, placeholder: "例如 powershell -File C:\\scripts\\backup.ps1", desc: "在游戏启动前运行；命令失败会中止启动。" },
        { key: "wrapper", name: "包装命令", kind: "text", mono: true, placeholder: "例如 gamemoderun", desc: "放在 java 命令前面，常用于 gamemoderun、optirun 之类的包装器。" },
        { key: "env", name: "环境变量", kind: "env", rows: 3, block: true, mono: true, placeholder: "每行一个：名称=值\n__GL_THREADED_OPTIMIZATIONS=0", desc: "只对这个实例的游戏进程生效。" },
      ],
    },
  ];
}

function envToText(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {}).map(([name, value]) => `${name}=${value}`).join("\n");
}

function parseEnv(text: string): { value: Record<string, string> | null; error?: string } {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) return { value: null, error: `第 ${index + 1} 行格式不对，应为 名称=值（名称只能含字母、数字和下划线）` };
    out[match[1]] = match[2];
  }
  return { value: Object.keys(out).length ? out : null };
}

export function mount(ctx: TabContext): TabHandle {
  const { body, signal } = ctx;
  const instance = ctx.instance();
  const config = instance.config;
  let javas: JavaInstall[] = [];

  const valueOf = (row: Row): string | number | boolean | undefined => {
    switch (row.key) {
      case "env":
        return envToText(config.env);
      case "memory":
        return config.memory ?? "auto";
      case "java":
        return config.javaPath ?? "";
      case "jvmPreset":
        return config.jvmPreset ?? "";
      case "favorite":
      case "fullscreen":
        return Boolean(config[row.key]);
      default:
        return config[row.key as keyof InstanceConfig] as string | number | undefined;
    }
  };

  const control = (row: Row): Raw => {
    const value = valueOf(row);
    switch (row.kind) {
      case "toggle":
        return html`<button class="toggle" role="switch" data-k="${row.key}" aria-checked="${Boolean(value)}"></button>`;
      case "select":
        return html`<select class="select" data-k="${row.key}">${(row.options ?? []).map(([v, label]) => html`<option value="${v}" ${String(v) === String(value ?? "") ? "selected" : ""}>${label}</option>`)}</select>`;
      case "memory":
        return html`<select class="select" data-k="memory">${memoryOptions(value as "auto" | number).map(([v, label]) => html`<option value="${v}" ${String(v) === String(value) ? "selected" : ""}>${label}</option>`)}</select>`;
      case "number":
        return html`<input class="input tnum" type="number" inputmode="numeric" min="${row.min ?? 0}" max="${row.max ?? 99999}" data-k="${row.key}" value="${value ?? ""}" placeholder="${row.placeholder ?? ""}" />`;
      case "area":
      case "env":
        return html`<textarea class="textarea${row.mono ? " mono" : ""}" rows="${row.rows ?? 2}" data-k="${row.key}" spellcheck="false" placeholder="${row.placeholder ?? ""}">${value ?? ""}</textarea>`;
      case "java":
        return html`<div style="display:flex;gap:8px;width:100%"><select class="select" data-k="java" data-java style="flex:1;min-width:0"><option value="">自动选择</option></select><button class="btn sm soft" data-act="cfg-java-browse" type="button">浏览…</button></div>`;
      case "group":
        return html`<input class="input" data-k="${row.key}" value="${value ?? ""}" maxlength="16" placeholder="${row.placeholder ?? ""}" list="vitrine-groups" />`;
      default:
        return html`<input class="input${row.mono ? " mono" : ""}" data-k="${row.key}" value="${value ?? ""}" placeholder="${row.placeholder ?? ""}" spellcheck="false" />`;
    }
  };

  const groups = [...new Set(store.instances.map((entry) => entry.config.group).filter((g): g is string => Boolean(g)))];
  body.innerHTML = `<datalist id="vitrine-groups">${groups.map((g) => `<option value="${g.replace(/"/g, "&quot;")}"></option>`).join("")}</datalist>` +
    html`${sections(instance.javaMajor).map(
      (section) => html`<section><div class="section-title">${section.title}</div>${section.rows.map(
        (row) => html`<div class="setting${row.block ? " block" : ""}" data-row="${row.key}"><div><div class="name">${row.name}<span class="save-state" data-save></span></div>${row.desc ? html`<div class="desc" data-desc>${row.desc}</div>` : ""}</div><div class="control">${control(row)}</div></div>`,
      )}</section>`,
    )}`.value;

  // ------------------------------------------------------------------------------------------ saving
  const rowOf = (element: HTMLElement) => element.closest<HTMLElement>(".setting")!;
  const flash = (row: HTMLElement, text: string, kind: "ok" | "error" = "ok") => {
    const state = row.querySelector<HTMLElement>("[data-save]");
    if (!state) return;
    state.textContent = text;
    state.dataset.kind = kind;
    state.dataset.show = "true";
    clearTimeout(Number(state.dataset.timer));
    if (kind === "ok") state.dataset.timer = String(window.setTimeout(() => (state.dataset.show = "false"), 1600));
  };

  async function save(element: HTMLElement, patch: Record<string, unknown>) {
    const row = rowOf(element);
    try {
      await rpc("instances.setConfig", { id: ctx.instance().id, patch });
      flash(row, "已保存");
    } catch (error) {
      flash(row, errorMessage(error), "error");
    }
  }

  const read = (element: HTMLElement): { patch: Record<string, unknown> } | { error: string } => {
    const key = element.dataset.k!;
    if (element instanceof HTMLButtonElement) return { patch: { [key]: element.getAttribute("aria-checked") === "true" } };
    const raw = (element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
    switch (key) {
      case "env": {
        const parsed = parseEnv(raw);
        return parsed.error ? { error: parsed.error } : { patch: { env: parsed.value } };
      }
      case "memory":
        return { patch: { memory: raw === "auto" ? "auto" : Number(raw) } };
      case "java":
        return { patch: { javaPath: raw } };
      case "width":
      case "height":
        return { patch: { [key]: raw === "" ? 0 : Number(raw) } };
      case "jvmPreset":
        return { patch: { jvmPreset: raw === "" ? null : raw } };
      default:
        return { patch: { [key]: raw } };
    }
  };

  const commit = (element: HTMLElement) => {
    const result = read(element);
    if ("error" in result) return flash(rowOf(element), result.error, "error");
    void save(element, result.patch);
  };
  const commitSoon = debounce(commit, 700);
  let lastEdited: HTMLElement | undefined;

  onAll(body, "change", "select[data-k], input[data-k]", (element) => commit(element));
  onAll(body, "input", "textarea[data-k], input[data-k]:not([type=number])", (element) => {
    flash(rowOf(element), "编辑中…");
    commitSoon.cancel();
    // One debounce per page: typing in another field right away saves the first one at once.
    if (lastEdited?.isConnected && lastEdited !== element) commit(lastEdited);
    lastEdited = element;
    commitSoon(element);
  });
  onAll(body, "focusout", "textarea[data-k], input[data-k]", (element) => {
    if (element === lastEdited) {
      commitSoon.cancel();
      commit(element);
      lastEdited = undefined;
    }
  });
  onAll(body, "click", "button.toggle[data-k]", (element) => {
    element.setAttribute("aria-checked", String(element.getAttribute("aria-checked") !== "true"));
    commit(element);
  });
  onAll(body, "click", "[data-act='cfg-java-browse']", async () => {
    const file = await pickPath("file", { title: "选择 java 可执行文件", filters: store.system.os.name === "windows" ? [{ name: "java", extensions: ["exe"] }] : undefined, hint: "选择 java.exe（Windows）或 java（Linux / macOS）的完整路径。" });
    if (!file) return;
    const check = await tryRpc("java.test", { path: file });
    const select = $("select[data-java]", body) as HTMLSelectElement;
    if (!check) return flash(rowOf(select), "这个文件不能作为 Java 运行", "error");
    if (![...select.options].some((option) => option.value === check.path)) select.add(new Option(`Java ${check.major} · ${check.path}`, check.path));
    select.value = check.path;
    commit(select);
  });

  // ------------------------------------------------------------------------------------------ Java list (filled in when detection finishes)
  void rpc("java.list", undefined, signal).then(
    (list) => {
      javas = list;
      const select = body.querySelector<HTMLSelectElement>("select[data-java]");
      if (!select) return;
      const current = ctx.instance().config.javaPath ?? "";
      const options = javas.map((java) => new Option(`Java ${java.major} · ${java.vendor ?? "未知发行版"} · ${java.arch}${java.isJdk ? " · JDK" : ""}`, java.path));
      for (const option of options) select.add(option);
      if (current && !javas.some((java) => java.path === current)) select.add(new Option(`自定义 · ${current}`, current));
      select.value = current;
    },
    () => undefined,
  );

  return {
    dispose() {
      // Do not lose an edit that was still waiting for its debounce.
      commitSoon.cancel();
      if (lastEdited?.isConnected) commit(lastEdited);
    },
  };
}
