/**
 * Locating a codex binary we are willing to execute.
 *
 * Why this file exists: @openai/codex-sdk ships an unsigned native binary under
 * node_modules/@openai/codex-sdk/vendor/. On macOS, XProtect flags it and moves it to the
 * Bin -- observed first-hand on this machine. Rather than teach users to defeat their own
 * malware protection, CodeArena refuses the vendored binary outright and only runs a codex
 * that is code-signed by OpenAI. That also means the Electron build has nothing unsigned to
 * notarise later.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";

const exec = promisify(execFile);

const OPENAI_TEAM_ID = "2DC432GLL2";

const CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
  `${process.env.HOME}/Applications/ChatGPT.app/Contents/Resources/codex`,
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
];

export interface CodexProbe {
  path: string;
  version: string;
  signedByOpenAI: boolean;
  authority: string | null;
  loggedIn: boolean;
  loginDetail: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Read the Developer ID authority off a Mach-O binary, if any. */
async function signature(path: string): Promise<{ authority: string | null; team: string | null }> {
  if (process.platform !== "darwin") return { authority: null, team: null };
  try {
    // codesign writes its report to stderr.
    const { stderr } = await exec("codesign", ["-dv", "--verbose=2", path]).catch(
      (e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }),
    );
    const authority = stderr.match(/^Authority=(.+)$/m)?.[1] ?? null;
    const team = stderr.match(/^TeamIdentifier=(.+)$/m)?.[1] ?? null;
    return { authority, team };
  } catch {
    return { authority: null, team: null };
  }
}

export async function probe(path: string): Promise<CodexProbe | null> {
  if (!(await exists(path))) return null;

  const { authority, team } = await signature(path);
  const signedByOpenAI =
    process.platform !== "darwin" ||
    (team === OPENAI_TEAM_ID && (authority?.includes("Developer ID Application") ?? false));

  let version = "unknown";
  try {
    version = (await exec(path, ["--version"])).stdout.trim();
  } catch {
    return null;
  }

  // `codex login status` reports on stderr, not stdout -- read both.
  let loggedIn = false;
  let loginDetail = "not logged in";
  try {
    const { stdout, stderr } = await exec(path, ["login", "status"]);
    loginDetail = `${stdout}${stderr}`.trim() || loginDetail;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    loginDetail = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || loginDetail;
  }
  loggedIn = /logged in/i.test(loginDetail);

  return { path, version, signedByOpenAI, authority, loggedIn, loginDetail };
}

/**
 * Resolve the codex binary to use. CODEARENA_CODEX_PATH wins; otherwise the first signed,
 * working candidate. Returns null when nothing acceptable is installed.
 */
export async function resolveCodex(): Promise<CodexProbe | null> {
  const override = process.env.CODEARENA_CODEX_PATH;
  if (override) return probe(override);

  for (const candidate of CANDIDATES) {
    const found = await probe(candidate);
    if (found?.signedByOpenAI) return found;
  }
  return null;
}
