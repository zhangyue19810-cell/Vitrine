/**
 * The only thing the page can reach: a small, fixed surface over IPC. No Node, no `ipcRenderer`, no file system.
 * The shape is `ElectronBridge` in src/app/bridge.ts.
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

type WindowState = { focused: boolean; visible: boolean };
type WindowAction = "minimize" | "maximize" | "close";

contextBridge.exposeInMainWorld("vitrine", {
  platform: process.platform,

  call: (id: number, method: string, params: Record<string, unknown>) => ipcRenderer.invoke("vitrine:call", id, method, params),

  abort: (id: number) => {
    ipcRenderer.send("vitrine:abort", id);
  },

  onEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on("vitrine:event", handler);
    return () => void ipcRenderer.removeListener("vitrine:event", handler);
  },

  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },

  windowControl: (action: WindowAction) => {
    if (action === "minimize" || action === "maximize" || action === "close") ipcRenderer.send("vitrine:window-control", action);
  },

  onWindowState: (listener: (state: WindowState) => void) => {
    const handler = (_event: IpcRendererEvent, state: WindowState) => listener(state);
    ipcRenderer.on("vitrine:window-state", handler);
    // The page subscribes after the window already has a state: ask for it so the first decision is not a guess.
    void ipcRenderer.invoke("vitrine:window-state").then((state: WindowState) => listener(state), () => {});
    return () => void ipcRenderer.removeListener("vitrine:window-state", handler);
  },
});
