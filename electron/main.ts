/**
 * Electron main process.
 *
 * The orchestrator lives here, not in the renderer: it spawns the two agent CLIs, reads and
 * writes the user's filesystem, and shells out to git. The renderer is a pure view over the
 * ArenaEvent stream -- the same stream the CLI renders -- so the UI never has to understand
 * how a task runs, only how to draw what happened.
 */
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runChat, runBuild } from "../src/core/orchestrator.js";
import { resolveCodex } from "../src/core/codex-path.js";
import { Git } from "../src/core/git.js";
import { replayFixture } from "../src/core/fixture.js";
import type { ArenaConfig, ArenaEvent } from "../src/core/types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const dirname = path.dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;
/** Set while a turn is in flight so a second one is refused rather than racing the first. */
let running = false;

/**
 * The conversation. One Claude session spans chatting, planning and building, so "build what
 * we just discussed" resolves to something real. Cleared only by an explicit reset.
 */
let session: string | null = null;
let projectOfSession = "";

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0b0d10",
    webPreferences: {
      preload: path.join(dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(dirname, "../dist-renderer/index.html"));

  // Development affordance: CODEARENA_DEMO=1 replays the recorded transcript on launch, so
  // the populated UI can be inspected without spending model quota.
  if (process.env.CODEARENA_DEMO) {
    win.webContents.once("did-finish-load", () => {
      const target = win?.webContents;
      if (!target) return;
      running = true;
      void replayFixture((e) => target.send("arena:event", e)).finally(() => {
        running = false;
        target.send("arena:idle", true);
      });
    });
  }

  // External links open in the real browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// -----------------------------------------------------------------------------------------
// IPC

export interface DoctorReport {
  builder: { ok: boolean; detail: string };
  gatekeeper: { ok: boolean; detail: string; path?: string; version?: string };
  project: { ok: boolean; detail: string; branch?: string; dirty?: boolean };
}

ipcMain.handle("arena:doctor", async (_e, projectDir: string): Promise<DoctorReport> => {
  const report: DoctorReport = {
    builder: { ok: false, detail: "" },
    gatekeeper: { ok: false, detail: "" },
    project: { ok: false, detail: "" },
  };

  if (process.env.ANTHROPIC_API_KEY) {
    report.builder = { ok: true, detail: "API key (metered)" };
  } else if (process.platform === "darwin") {
    try {
      await exec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
      report.builder = { ok: true, detail: "subscription login" };
    } catch {
      report.builder = { ok: false, detail: "not logged in — run `claude` once" };
    }
  } else {
    report.builder = { ok: false, detail: "no credentials found" };
  }

  const codex = await resolveCodex();
  if (!codex) {
    report.gatekeeper = { ok: false, detail: "no code-signed codex found" };
  } else if (!codex.loggedIn) {
    report.gatekeeper = { ok: false, detail: "not logged in", path: codex.path };
  } else {
    report.gatekeeper = {
      ok: true,
      detail: codex.loginDetail,
      path: codex.path,
      version: codex.version,
    };
  }

  if (projectDir) {
    const git = new Git(projectDir);
    if (await git.isRepo()) {
      const branch = await git.currentBranch();
      const dirty = await git.isDirty();
      report.project = { ok: true, detail: branch, branch, dirty };
    } else {
      report.project = { ok: false, detail: "not a git repository" };
    }
  } else {
    report.project = { ok: false, detail: "no project selected" };
  }

  return report;
});

ipcMain.handle("arena:pickProject", async (): Promise<string | null> => {
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openDirectory"],
    message: "Choose the repository the agents will work in",
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

interface TurnOptions {
  projectDir: string;
  maxRounds: number;
  skipPlanReview: boolean;
}

/** Switching projects invalidates the conversation -- it was about other code. */
function ensureProject(projectDir: string) {
  if (projectOfSession !== projectDir) {
    session = null;
    projectOfSession = projectDir;
  }
}

function configFor(opts: TurnOptions, codexPath: string): ArenaConfig {
  return {
    projectDir: opts.projectDir,
    maxRounds: opts.maxRounds,
    skipPlanReview: opts.skipPlanReview,
    codexPath,
  };
}

ipcMain.handle(
  "arena:chat",
  async (
    event,
    opts: TurnOptions & { message: string },
  ): Promise<{ started: boolean; reason?: string }> => {
    if (running) return { started: false, reason: "Still working on the previous turn." };
    ensureProject(opts.projectDir);

    const send = (e: ArenaEvent) => event.sender.send("arena:event", e);
    const codex = await resolveCodex();

    running = true;
    void runChat(opts.message, configFor(opts, codex?.path ?? ""), send, session)
      .then((next) => {
        session = next;
      })
      .finally(() => {
        running = false;
        event.sender.send("arena:idle", true);
      });

    return { started: true };
  },
);

ipcMain.handle(
  "arena:build",
  async (
    event,
    opts: TurnOptions & { instruction?: string; demo?: boolean },
  ): Promise<{ started: boolean; reason?: string }> => {
    if (running) return { started: false, reason: "Still working on the previous turn." };

    const send = (e: ArenaEvent) => event.sender.send("arena:event", e);

    // Demo mode replays a recorded transcript. It exists so the UI can be reviewed without
    // spending model quota, and so a first-run user can see the loop before connecting an
    // account.
    if (opts.demo) {
      running = true;
      void replayFixture(send)
        .catch((e: unknown) => send({ type: "log", level: "error", message: String(e) }))
        .finally(() => {
          running = false;
          event.sender.send("arena:idle", true);
        });
      return { started: true };
    }

    ensureProject(opts.projectDir);

    const codex = await resolveCodex();
    if (!codex?.loggedIn) {
      return { started: false, reason: "Gatekeeper unavailable — check Setup." };
    }

    running = true;
    void runBuild(configFor(opts, codex.path), send, session, opts.instruction)
      .then((outcome) => {
        session = outcome.sessionId;
      })
      .catch((e: unknown) =>
        send({ type: "log", level: "error", message: String((e as Error)?.message ?? e) }),
      )
      .finally(() => {
        running = false;
        event.sender.send("arena:idle", true);
      });

    return { started: true };
  },
);

ipcMain.handle("arena:reset", async () => {
  session = null;
});

ipcMain.handle("arena:revealDiff", async (_e, projectDir: string) => {
  shell.openPath(projectDir);
});
