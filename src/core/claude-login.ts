/**
 * Signing in to Claude from inside CodeArena.
 *
 * We drive the official `claude auth login` flow rather than reimplementing OAuth. Without a
 * TTY it behaves well: it opens the browser, prints the authorize URL, and then waits on
 * stdin for the authorization code the browser hands you.
 *
 * Credential handling rules this file exists to enforce:
 *
 *   - The authorization code goes straight to the child's stdin and nowhere else. It is never
 *     written to disk, never logged, never included in an event, and never returned to the
 *     renderer.
 *   - CodeArena stores no token of any kind. The official binary owns the credential store,
 *     exactly as it does when you run it yourself in a terminal.
 *   - `--claudeai` is passed explicitly. The alternative, `--console`, signs in to
 *     Anthropic Console with per-token API billing -- which is the thing the user is trying
 *     to avoid. Do not make this configurable without saying which one is which.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolveClaude, type ClaudeAuth } from "./claude-path.js";

/** How long to wait for the authorize URL before giving up on the flow. */
const URL_TIMEOUT_MS = 20_000;
/** How long to wait for the binary to finish after the code is submitted. */
const EXIT_TIMEOUT_MS = 60_000;

const URL_PATTERN = /https:\/\/\S*oauth\/authorize\S*/;

export interface LoginHandle {
  /** The URL to complete in a browser. Safe to display and to open. */
  url: string;
  /**
   * Hand the code from the browser to the waiting binary.
   *
   * The code is not retained, echoed, or logged anywhere in this process.
   */
  submitCode(code: string): Promise<{ ok: boolean; detail: string; auth?: ClaudeAuth }>;
  cancel(): void;
}

export class LoginError extends Error {}

/**
 * Begin a sign-in. Resolves once the authorize URL is known; the child stays alive waiting
 * for `submitCode`.
 */
export async function startLogin(email?: string): Promise<LoginHandle> {
  const claude = await resolveClaude();
  if (!claude.path) {
    throw new LoginError(
      "No Claude Code install found to sign in with. Install the Claude desktop app or the " +
        "claude CLI first.",
    );
  }

  const args = ["auth", "login", "--claudeai"];
  if (email) args.push("--email", email);

  const child: ChildProcessWithoutNullStreams = spawn(claude.path, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let transcript = "";
  let settled = false;

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new LoginError("Timed out waiting for the sign-in URL."));
    }, URL_TIMEOUT_MS);

    const scan = (chunk: Buffer) => {
      transcript += chunk.toString();
      const match = transcript.match(URL_PATTERN);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(match[0]);
      }
    };

    child.stdout.on("data", scan);
    child.stderr.on("data", scan);

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new LoginError(`Could not start sign-in: ${err.message}`));
    });

    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new LoginError(`Sign-in exited early (code ${code}) before printing a URL.`));
    });
  });

  return {
    url,

    async submitCode(code: string) {
      const trimmed = code.trim();
      if (!trimmed) return { ok: false, detail: "No code entered." };

      // Straight to the child. Deliberately not stored in a variable that outlives this call,
      // not appended to `transcript`, and not passed to any emit/log path.
      child.stdin.write(`${trimmed}\n`);
      child.stdin.end();

      const exited = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), EXIT_TIMEOUT_MS);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });

      if (!exited) {
        child.kill();
        return { ok: false, detail: "Sign-in did not complete in time." };
      }

      // Ask the binary who it thinks it is now, rather than trusting the exit code -- the
      // question that matters is whether a plan is attached, and only auth status answers it.
      const auth = await resolveClaude();
      if (auth.usable) return { ok: true, detail: auth.detail, auth };
      return {
        ok: false,
        detail: auth.loggedIn
          ? auth.detail
          : "Sign-in did not take. Check the code and try again.",
        auth,
      };
    },

    cancel() {
      child.kill();
    },
  };
}
