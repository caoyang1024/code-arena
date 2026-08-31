"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// electron/preload.ts
var preload_exports = {};
module.exports = __toCommonJS(preload_exports);
var import_electron = require("electron");
var api = {
  doctor: (projectDir) => import_electron.ipcRenderer.invoke("arena:doctor", projectDir),
  pickProject: () => import_electron.ipcRenderer.invoke("arena:pickProject"),
  /** An ordinary conversational turn. Read-only; the gatekeeper is not involved. */
  chat: (opts) => import_electron.ipcRenderer.invoke("arena:chat", opts),
  /** The engineer has decided. Runs plan -> review -> implement -> review. */
  build: (opts) => import_electron.ipcRenderer.invoke("arena:build", opts),
  /** Forget the conversation and start fresh. */
  reset: () => import_electron.ipcRenderer.invoke("arena:reset"),
  /**
   * Sign-in. `start` returns only the authorize URL; the code the browser gives you is
   * forwarded straight to the official binary and is never stored on this side.
   */
  loginStart: (email) => import_electron.ipcRenderer.invoke("arena:login:start", email),
  loginCode: (code) => import_electron.ipcRenderer.invoke("arena:login:code", code),
  loginCancel: () => import_electron.ipcRenderer.invoke("arena:login:cancel"),
  /** Fires when the sign-in finishes by itself, i.e. no pasted code was needed. */
  onLoginDone: (callback) => {
    const listener = (_e, result) => callback(result);
    import_electron.ipcRenderer.on("arena:login:done", listener);
    return () => import_electron.ipcRenderer.removeListener("arena:login:done", listener);
  },
  openExternal: (url) => import_electron.ipcRenderer.invoke("arena:openExternal", url),
  revealDiff: (projectDir) => import_electron.ipcRenderer.invoke("arena:revealDiff", projectDir),
  /** Fires when a turn finishes, whatever its outcome. */
  onIdle: (callback) => {
    const listener = () => callback();
    import_electron.ipcRenderer.on("arena:idle", listener);
    return () => import_electron.ipcRenderer.removeListener("arena:idle", listener);
  },
  /** Subscribe to the orchestrator's event stream. Returns an unsubscribe function. */
  onEvent: (callback) => {
    const listener = (_e, event) => callback(event);
    import_electron.ipcRenderer.on("arena:event", listener);
    return () => import_electron.ipcRenderer.removeListener("arena:event", listener);
  }
};
import_electron.contextBridge.exposeInMainWorld("arena", api);
