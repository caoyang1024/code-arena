/**
 * Locating the builder's Claude Code install, and asking it who it is logged in as.
 *
 * Two reasons this file exists, both learned the hard way:
 *
 * 1. The first version of `doctor` reported "subscription login found" whenever the
 *    `Claude Code-credentials` keychain entry existed. That entry exists for other reasons --
 *    on this machine it held only MCP OAuth tokens and no `claudeAiOauth` at all -- so doctor
 *    showed a green tick for an account that could not make a single request. A preflight
 *    that lies is worse than no preflight.
 *
 *    `claude auth status` is authoritative and cheap, so ask it instead of guessing at
 *    storage. It reports the account, the auth method, and -- the field that actually
 *    decides whether anything will run -- `subscriptionType`.
 *
 * 2. `subscriptionType: null` with `loggedIn: true` is the confusing case: authentication
 *    succeeds, so nothing looks broken, and the first sign of trouble is "Credit balance is
 *    too low" arriving from deep inside a build. Surfacing it in preflight turns a mid-run
 *    mystery into a line you read before you start.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const exec = promisify(execFile);

export interface ClaudeAuth {
  /** Path to the claude binary we would drive, or null to let the SDK use its bundled one. */
  path: string | null;
  version: string | null;
  loggedIn: boolean;
  email: string | null;
  authMethod: string | null;
  /** "pro" / "max" / etc., or null when no plan is attached to the account. */
  subscriptionType: string | null;
  /** True when we expect requests to actually go through. */
  usable: boolean;
  detail: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Candidate binaries, most-preferred first. The Claude desktop app ships a versioned
 * claude-code; prefer the newest, then anything on PATH.
 */
async function candidates(): Promise<string[]> {
  const out: string[] = [];
  if (process.env.CODEARENA_CLAUDE_PATH) out.push(process.env.CODEARENA_CLAUDE_PATH);

  const appSupport = path.join(
    os.homedir(),
    "Library/Application Support/Claude/claude-code",
  );
  try {
    const versions = await fs.readdir(appSupport);
    versions
      .filter((v) => /^\d/.test(v))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .forEach((v) => out.push(path.join(appSupport, v, "claude.app/Contents/MacOS/claude")));
  } catch {
    /* not installed */
  }

  out.push(
    path.join(os.homedir(), ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  );
  return out;
}

/** Ask a claude binary who it is logged in as. Returns null if it cannot answer. */
async function authStatus(binary: string): Promise<Partial<ClaudeAuth> | null> {
  try {
    const { stdout } = await exec(binary, ["auth", "status"], { timeout: 15_000 });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return {
      loggedIn: parsed.loggedIn === true,
      email: typeof parsed.email === "string" ? parsed.email : null,
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
      subscriptionType:
        typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null,
    };
  } catch {
    return null;
  }
}

export async function resolveClaude(): Promise<ClaudeAuth> {
  const unusable = (detail: string): ClaudeAuth => ({
    path: null,
    version: null,
    loggedIn: false,
    email: null,
    authMethod: null,
    subscriptionType: null,
    usable: false,
    detail,
  });

  // An explicit API key sidesteps the whole subscription question.
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      path: null,
      version: null,
      loggedIn: true,
      email: null,
      authMethod: "api_key",
      subscriptionType: null,
      usable: true,
      detail: "ANTHROPIC_API_KEY is set — requests are billed per token",
    };
  }

  for (const candidate of await candidates()) {
    if (!(await exists(candidate))) continue;

    const status = await authStatus(candidate);
    if (!status) continue;

    let version: string | null = null;
    try {
      version = (await exec(candidate, ["--version"], { timeout: 10_000 })).stdout.trim();
    } catch {
      /* non-fatal */
    }

    if (!status.loggedIn) {
      return {
        ...unusable(`not signed in — run: "${candidate}" auth login`),
        path: candidate,
        version,
      };
    }

    // The case that matters: authenticated, but with no plan behind it. Requests fall
    // through to API credit billing, which is usually empty, and the failure only shows up
    // mid-build as "Credit balance is too low".
    if (!status.subscriptionType) {
      return {
        path: candidate,
        version,
        loggedIn: true,
        email: status.email ?? null,
        authMethod: status.authMethod ?? null,
        subscriptionType: null,
        usable: false,
        detail:
          `signed in as ${status.email ?? "unknown"} but no plan is attached ` +
          `(subscriptionType: null), so requests bill against API credits. ` +
          `Attach a Claude plan to this account, sign in with one that has it ` +
          `("${candidate}" auth login), or set ANTHROPIC_API_KEY to pay per token.`,
      };
    }

    return {
      path: candidate,
      version,
      loggedIn: true,
      email: status.email ?? null,
      authMethod: status.authMethod ?? null,
      subscriptionType: status.subscriptionType,
      usable: true,
      detail: `${status.subscriptionType} plan, signed in as ${status.email ?? "unknown"}`,
    };
  }

  return unusable(
    "no Claude Code install found — install the Claude desktop app or the claude CLI, " +
      "or set ANTHROPIC_API_KEY",
  );
}
