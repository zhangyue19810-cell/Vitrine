import type { Bridge } from "./bridge";

/**
 * Dropping a modpack (.mrpack / .zip) anywhere on the window imports it. The desktop shell can turn a dropped file into
 * a path; a plain browser (development) cannot, and says so.
 */

export interface DropOptions {
  veil: HTMLElement;
  bridge: Bridge;
  /** Dropping is allowed right now (not during the splash or over a dialog). */
  enabled(): boolean;
  onPaths(paths: string[]): void;
  onNoPath(names: string[]): void;
}

const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes("Files");

export function installDropZone(options: DropOptions): () => void {
  let depth = 0;
  const show = (on: boolean) => {
    options.veil.dataset.show = String(on);
  };
  const enter = (event: DragEvent) => {
    if (!hasFiles(event) || !options.enabled()) return;
    event.preventDefault();
    depth++;
    show(true);
  };
  const over = (event: DragEvent) => {
    if (!hasFiles(event) || !options.enabled()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };
  const leave = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) show(false);
  };
  const drop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    show(false);
    if (!options.enabled()) return;
    const files = [...(event.dataTransfer?.files ?? [])].filter((file) => /\.(mrpack|zip)$/i.test(file.name));
    if (!files.length) return options.onNoPath([]);
    const paths = files.map((file) => options.bridge.pathForFile(file)).filter((path): path is string => Boolean(path));
    if (paths.length) options.onPaths(paths);
    else options.onNoPath(files.map((file) => file.name));
  };
  window.addEventListener("dragenter", enter);
  window.addEventListener("dragover", over);
  window.addEventListener("dragleave", leave);
  window.addEventListener("drop", drop);
  return () => {
    window.removeEventListener("dragenter", enter);
    window.removeEventListener("dragover", over);
    window.removeEventListener("dragleave", leave);
    window.removeEventListener("drop", drop);
  };
}
