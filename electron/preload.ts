/**
 * The only bridge between the renderer and Node. contextIsolation is on and nodeIntegration
 * is off, so the renderer gets exactly these calls and nothing else -- it cannot reach
 * the filesystem, spawn a process, or touch either agent SDK directly.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { ArenaEvent } from "../src/core/types.js";

export interface TurnOptions {
  projectDir: string;
  maxRounds: number;
  skipPlanReview: boolean;
}

export type Started = { started: boolean; reason?: string };

const api = {
  doctor: (projectDir: string) => ipcRenderer.invoke("arena:doctor", projectDir),
  pickProject: (): Promise<string | null> => ipcRenderer.invoke("arena:pickProject"),

  /** An ordinary conversational turn. Read-only; the gatekeeper is not involved. */
  chat: (opts: TurnOptions & { message: string }): Promise<Started> =>
    ipcRenderer.invoke("arena:chat", opts),

  /** The engineer has decided. Runs plan -> review -> implement -> review. */
  build: (opts: TurnOptions & { instruction?: string; demo?: boolean }): Promise<Started> =>
    ipcRenderer.invoke("arena:build", opts),

  /** Forget the conversation and start fresh. */
  reset: (): Promise<void> => ipcRenderer.invoke("arena:reset"),

  revealDiff: (projectDir: string) => ipcRenderer.invoke("arena:revealDiff", projectDir),

  /** Fires when a turn finishes, whatever its outcome. */
  onIdle: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("arena:idle", listener);
    return () => ipcRenderer.removeListener("arena:idle", listener);
  },

  /** Subscribe to the orchestrator's event stream. Returns an unsubscribe function. */
  onEvent: (callback: (event: ArenaEvent) => void) => {
    const listener = (_e: unknown, event: ArenaEvent) => callback(event);
    ipcRenderer.on("arena:event", listener);
    return () => ipcRenderer.removeListener("arena:event", listener);
  },
};

contextBridge.exposeInMainWorld("arena", api);

export type ArenaApi = typeof api;
