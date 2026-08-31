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
const emit = (e: ArenaEvent) => listeners.forEach((l) => l(e));

window.arena = {
  doctor: async () => ({
    builder: { ok: true, detail: "subscription login" },
    gatekeeper: { ok: true, detail: "Logged in using ChatGPT", version: "codex-cli 0.151.0" },
    project: { ok: true, detail: "main", branch: "main", dirty: false },
  }),
  pickProject: async () => "/Users/preview/work/calc",
  start: async () => {
    void replayFixture(emit);
    return { started: true };
  },
  revealDiff: async () => {},
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
setTimeout(() => void replayFixture(emit), 400);
