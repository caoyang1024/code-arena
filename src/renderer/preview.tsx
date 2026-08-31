/**
 * Browser preview of the renderer.
 *
 * The renderer only ever touches Node through `window.arena`, so stubbing that one object
 * lets the whole UI run in an ordinary browser tab against the recorded fixture. Useful for
 * iterating on layout without launching Electron, and for reviewing the UI on a machine with
 * no agent credentials at all.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { replayFixture } from "../core/fixture.js";
import type { ArenaEvent } from "../core/types.js";
import "./styles.css";

const listeners = new Set<(e: ArenaEvent) => void>();
const idle = new Set<() => void>();

// Preview-only: lets a specific state be driven directly instead of waiting out the replay.
declare global {
  interface Window {
    __arenaEmit?: (e: ArenaEvent) => void;
  }
}
const emit = (e: ArenaEvent) => listeners.forEach((l) => l(e));
window.__arenaEmit = emit;

window.arena = {
  doctor: async () => ({
    builder: { ok: true, detail: "subscription login" },
    gatekeeper: { ok: true, detail: "Logged in using ChatGPT", version: "codex-cli 0.151.0" },
    project: { ok: true, detail: "main", branch: "main", dirty: false },
  }),
  pickProject: async () => "/Users/preview/work/calc",
  recentProjects: async () => ["/Users/preview/work/calc", "/Users/preview/work/api-gateway"],
  lastProject: async () => "/Users/preview/work/calc",
  rememberProject: async () => {},
  forgetProject: async () => {},
  newProject: async () => ({ dir: "/Users/preview/work/new-thing" }),
  chat: async ({ message }: { message: string }) => {
    emit({ type: "user.message", text: message });
    emit({ type: "phase", phase: "chatting", round: 1 });
    emit({ type: "builder.text", text: "(preview stub — the real builder answers here.)" });
    setTimeout(() => idle.forEach((l) => l()), 300);
    return { started: true };
  },
  build: async () => {
    void replayFixture(emit).finally(() => idle.forEach((l) => l()));
    return { started: true };
  },
  secondOpinion: async () => {
    emit({ type: "phase", phase: "second_opinion", round: 1 });
    emit({
      type: "gatekeeper.text",
      text: "(preview stub — the real reviewer's critique appears here.)",
    });
    setTimeout(() => idle.forEach((l) => l()), 300);
    return { started: true };
  },
  stop: async () => ({ stopped: true }),
  reset: async () => {},
  loginStart: async () => ({ ok: true, url: "https://claude.com/cai/oauth/authorize?preview=1" }),
  loginCode: async () => ({ ok: false, detail: "Preview stub — no real sign-in here." }),
  loginCancel: async () => {},
  onLoginDone: () => () => {},
  openExternal: async () => {},
  undoable: async () => ({ baseline: "3c356f70", changed: 2 }),
  revert: async () => ({ ok: true, undo: "ab12cd34ef56" }),
  revealDiff: async () => {},
  onIdle: (cb) => {
    idle.add(cb);
    return () => idle.delete(cb);
  },
  onEvent: (cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Auto-run so the populated state is what you see on load.
setTimeout(() => void replayFixture(emit).finally(() => idle.forEach((l) => l())), 400);
