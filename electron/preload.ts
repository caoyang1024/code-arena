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

  /**
   * Sign-in. `start` returns only the authorize URL; the code the browser gives you is
   * forwarded straight to the official binary and is never stored on this side.
   */
  loginStart: (email?: string): Promise<{ ok: boolean; url?: string; reason?: string }> =>
    ipcRenderer.invoke("arena:login:start", email),
  loginCode: (code: string): Promise<{ ok: boolean; detail: string }> =>
    ipcRenderer.invoke("arena:login:code", code),
  loginCancel: (): Promise<void> => ipcRenderer.invoke("arena:login:cancel"),

  /** Fires when the sign-in finishes by itself, i.e. no pasted code was needed. */
  onLoginDone: (callback: (result: { ok: boolean; detail: string }) => void) => {
    const listener = (_e: unknown, result: { ok: boolean; detail: string }) => callback(result);
    ipcRenderer.on("arena:login:done", listener);
    return () => ipcRenderer.removeListener("arena:login:done", listener);
  },
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("arena:openExternal", url),

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
