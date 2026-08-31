/**
 * The only bridge between the renderer and Node. contextIsolation is on and nodeIntegration
 * is off, so the renderer gets exactly these five calls and nothing else -- it cannot reach
 * the filesystem, spawn a process, or touch either agent SDK directly.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { ArenaEvent } from "../src/core/types.js";

export interface StartOptions {
  task: string;
  projectDir: string;
  maxRounds: number;
  skipPlanReview: boolean;
  demo?: boolean;
}

const api = {
  doctor: (projectDir: string) => ipcRenderer.invoke("arena:doctor", projectDir),
  pickProject: (): Promise<string | null> => ipcRenderer.invoke("arena:pickProject"),
  start: (opts: StartOptions): Promise<{ started: boolean; reason?: string }> =>
    ipcRenderer.invoke("arena:start", opts),
  revealDiff: (projectDir: string) => ipcRenderer.invoke("arena:revealDiff", projectDir),

  /** Subscribe to the orchestrator's event stream. Returns an unsubscribe function. */
  onEvent: (callback: (event: ArenaEvent) => void) => {
    const listener = (_e: unknown, event: ArenaEvent) => callback(event);
    ipcRenderer.on("arena:event", listener);
    return () => ipcRenderer.removeListener("arena:event", listener);
  },
};

contextBridge.exposeInMainWorld("arena", api);

export type ArenaApi = typeof api;
