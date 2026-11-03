import { $, onAll } from "../dom";
import type { TabContext, TabHandle } from "./detail-types";
import { gameFor, loadCrash, mountLogViewer, type LogViewerHandle } from "./logs";

/** Game console and crash analysis inside the instance page. A game that just crashed opens on the analysis. */
export function mount(ctx: TabContext): TabHandle {
  const { body, signal } = ctx;
  const instance = ctx.instance();
  const game = gameFor(instance.id);
  const crashed = Boolean(game && game.state === "exited" && !game.stoppedByUser && game.exitCode !== 0 && game.exitCode !== null && game.exitCode !== undefined);
  body.innerHTML = `<div style="display:flex;flex-direction:column;gap:14px;height:100%;min-height:320px">
    <div class="seg" style="align-self:flex-start"><button data-t="log" aria-pressed="${!crashed}">控制台日志</button><button data-t="crash" aria-pressed="${crashed}">崩溃分析</button></div>
    <div data-f="log" style="flex:1;min-height:0" ${crashed ? "hidden" : ""}></div>
    <div data-f="crash" style="flex:1;min-height:0;overflow:auto" ${crashed ? "" : "hidden"}></div>
  </div>`;
  const logHost = $<HTMLElement>("[data-f='log']", body);
  const crashHost = $<HTMLElement>("[data-f='crash']", body);
  const viewer: LogViewerHandle = mountLogViewer(logHost, instance.id);
  let crashLoaded = false;
  const showCrash = () => {
    crashLoaded = true;
    void loadCrash(crashHost, ctx.instance(), { game: gameFor(instance.id), signal, onFixed: () => (crashLoaded = false), goMods: () => ctx.go("mods") });
  };
  if (crashed) showCrash();
  onAll(body, "click", "[data-t]", (element) => {
    const tab = element.dataset.t;
    for (const button of body.querySelectorAll<HTMLElement>("[data-t]")) button.setAttribute("aria-pressed", String(button === element));
    logHost.hidden = tab !== "log";
    crashHost.hidden = tab !== "crash";
    if (tab === "crash" && !crashLoaded) showCrash();
  });
  return {
    dispose() {
      viewer.dispose();
    },
  };
}
