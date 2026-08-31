/**
 * The semantic guardrail layer.
 *
 * CodeArena defends the builder's blast radius in two layers, and they are not redundant:
 *
 *   1. The OS sandbox (`sandbox: { enabled: true }` in builder.ts) is the real boundary.
 *      Kernel-enforced, not defeatable by clever quoting. It stops the builder reaching
 *      outside the project or the network.
 *
 *   2. This policy handles what a filesystem sandbox structurally *cannot* express --
 *      constraints about meaning rather than location. The load-bearing example:
 *      `git commit` and `git reset --hard` write only to files inside the project
 *      directory, so no sandbox will ever stop them. But CodeArena's entire rollback
 *      guarantee rests on git history staying exactly where we left it (see git.ts): we
 *      snapshot into dangling commits and diff against a baseline. A builder that commits,
 *      resets or checks out mid-task silently invalidates that baseline, and "roll back the
 *      agent's work" starts destroying the user's instead.
 *
 * So: git *reads* are free, git *history writes* are denied, and the reason string tells the
 * model why -- so it adapts instead of retrying.
 *
 * Layer 2 is a guardrail, not a boundary. It runs string analysis over a shell command, and
 * string analysis of shell is not a security control. It is here to stop a well-intentioned
 * model from breaking an invariant it has no way to know about. Layer 1 stops the rest.
 */
import path from "node:path";
import os from "node:os";
import { parseCommands, basename, type Segment } from "./shell.js";

export type Decision = { allow: true } | { allow: false; reason: string };

const ALLOW: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason });

export interface PolicyOptions {
  projectDir: string;
  /** Let the builder manage git history itself. Breaks rollback; off by default. */
  allowGitWrites?: boolean;
  /** Let the builder run publish/release commands. Off by default. */
  allowPublish?: boolean;
}

// ---------------------------------------------------------------------------------------
// git

/** Read-only porcelain and plumbing. Everything not listed here is treated as a write. */
const GIT_READ_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "blame", "annotate", "describe", "ls-files", "ls-tree",
  "ls-remote", "rev-parse", "rev-list", "cat-file", "show-ref", "for-each-ref", "shortlog",
  "grep", "whatchanged", "count-objects", "verify-pack", "check-ignore", "check-attr",
  "merge-base", "name-rev", "symbolic-ref", "var", "help", "version", "diff-tree",
  "diff-index", "difftool",
]);

/**
 * Subcommands that move HEAD, rewrite history, or mutate refs -- the ones that break the
 * snapshot baseline. Listed explicitly so the denial message can be specific.
 */
const GIT_HISTORY_WRITES = new Set([
  "commit", "reset", "rebase", "merge", "cherry-pick", "revert", "checkout", "switch",
  "restore", "stash", "clean", "am", "apply", "update-ref", "filter-branch", "filter-repo",
  "gc", "prune", "reflog", "branch", "tag", "worktree", "push", "pull", "fetch", "clone",
  "submodule", "rm", "mv", "add", "notes", "replace", "bisect",
]);

/** Global git flags that relocate where git operates, escaping the project entirely. */
function gitRelocates(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-C" || a === "--git-dir" || a === "--work-tree" || a === "--exec-path") {
      return a;
    }
    if (a.startsWith("--git-dir=") || a.startsWith("--work-tree=")) return a.split("=")[0]!;
    if (!a.startsWith("-")) break;
  }
  return null;
}

/** The first non-flag token after `git`, accounting for flags that take a value. */
function gitSubcommand(argv: string[]): string | null {
  const VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--exec-path", "--namespace"]);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// outward-facing and privileged commands

/** argv[0] basenames that are never appropriate for an unattended builder. */
const DENIED_COMMANDS = new Map<string, string>([
  ["sudo", "runs with elevated privileges"],
  ["doas", "runs with elevated privileges"],
  ["su", "switches user"],
  ["security", "reads or writes the macOS Keychain, where CodeArena's own credentials live"],
  ["launchctl", "modifies system services"],
  ["systemctl", "modifies system services"],
  ["defaults", "modifies system and application settings"],
  ["csrutil", "modifies system integrity protection"],
  ["spctl", "modifies Gatekeeper policy"],
  ["diskutil", "modifies disks"],
  ["mkfs", "formats filesystems"],
  ["fdisk", "modifies partition tables"],
  ["shutdown", "halts the machine"],
  ["reboot", "restarts the machine"],
  ["halt", "halts the machine"],
  ["crontab", "installs scheduled jobs that outlive this task"],
]);

/** Publish/release verbs: outward-facing and effectively irreversible. */
const PUBLISH: Array<{ match: (argv: string[]) => boolean; what: string }> = [
  { match: (a) => basename(a[0]!) === "npm" && a[1] === "publish", what: "npm publish" },
  { match: (a) => basename(a[0]!) === "yarn" && a[1] === "publish", what: "yarn publish" },
  { match: (a) => basename(a[0]!) === "pnpm" && a[1] === "publish", what: "pnpm publish" },
  { match: (a) => basename(a[0]!) === "gh" && (a[1] === "pr" || a[1] === "release"), what: "a GitHub PR or release" },
  { match: (a) => basename(a[0]!) === "docker" && a[1] === "push", what: "a container push" },
  { match: (a) => basename(a[0]!) === "cargo" && a[1] === "publish", what: "cargo publish" },
  { match: (a) => basename(a[0]!) === "twine" && a[1] === "upload", what: "a PyPI upload" },
];

// ---------------------------------------------------------------------------------------
// paths

const SENSITIVE_DIRS = [".ssh", ".aws", ".gnupg", ".config/gcloud", ".kube"];
const SENSITIVE_FILES = [".codex/auth.json", ".claude/.credentials.json", ".netrc", ".npmrc", ".pypirc"];

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * True when `target` is inside `root` (or is `root`).
 *
 * Lexical only: it resolves `..` but does not follow symlinks, so a symlink inside the
 * project pointing out of it passes this check. That gap is deliberate -- resolving links
 * here would make the policy async and racy (the link can be swapped between check and
 * use), and the OS sandbox already denies the write at the syscall, where TOCTOU does not
 * apply. Layer 1 owns location; this layer owns meaning.
 */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function touchesCredentials(abs: string): string | null {
  const home = os.homedir();
  for (const dir of SENSITIVE_DIRS) {
    if (isInside(path.join(home, dir), abs)) return `~/${dir}`;
  }
  for (const file of SENSITIVE_FILES) {
    if (abs === path.join(home, file)) return `~/${file}`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------

export class Policy {
  private readonly projectDir: string;

  constructor(private readonly options: PolicyOptions) {
    this.projectDir = path.resolve(options.projectDir);
  }

  /** Resolve a tool-supplied path against the project root. */
  private resolve(p: string): string {
    return path.resolve(this.projectDir, expandHome(p));
  }

  check(toolName: string, input: unknown): Decision {
    const obj = (input ?? {}) as Record<string, unknown>;

    switch (toolName) {
      case "Write":
      case "Edit":
      case "NotebookEdit": {
        const raw = (obj.file_path ?? obj.notebook_path) as string | undefined;
        if (typeof raw !== "string") return ALLOW;
        const abs = this.resolve(raw);
        const cred = touchesCredentials(abs);
        if (cred) return deny(`${cred} holds credentials and is never writable.`);
        if (!isInside(this.projectDir, abs)) {
          return deny(
            `${abs} is outside the project directory (${this.projectDir}). ` +
              `Keep changes inside the project.`,
          );
        }
        if (isInside(path.join(this.projectDir, ".git"), abs)) {
          return deny(
            `Writing inside .git corrupts the snapshots CodeArena uses to show your diff ` +
              `and to roll back. Change working-tree files instead.`,
          );
        }
        return ALLOW;
      }

      case "Read": {
        const raw = obj.file_path as string | undefined;
        if (typeof raw !== "string") return ALLOW;
        const cred = touchesCredentials(this.resolve(raw));
        return cred ? deny(`${cred} holds credentials and is not readable.`) : ALLOW;
      }

      case "Bash":
        return this.checkBash(obj.command);

      default:
        return ALLOW;
    }
  }

  private checkBash(command: unknown): Decision {
    if (typeof command !== "string" || command.trim() === "") return ALLOW;

    for (const segment of parseCommands(command)) {
      const decision = this.checkSegment(segment);
      if (!decision.allow) return decision;
    }
    return ALLOW;
  }

  private checkSegment(segment: Segment): Decision {
    const argv = segment.argv;
    const cmd = basename(argv[0] ?? "");

    const denied = DENIED_COMMANDS.get(cmd);
    if (denied) return deny(`\`${cmd}\` ${denied}; it is not available to the builder.`);

    if (!this.options.allowPublish) {
      for (const rule of PUBLISH) {
        if (rule.match(argv)) {
          return deny(
            `Publishing (${rule.what}) is outward-facing and irreversible. ` +
              `CodeArena leaves that to the human after review.`,
          );
        }
      }
    }

    if (cmd === "git" && !this.options.allowGitWrites) {
      const relocation = gitRelocates(argv);
      if (relocation) {
        return deny(
          `\`git ${relocation}\` redirects git outside the project, which breaks the ` +
            `snapshot baseline. Run git from the project root.`,
        );
      }
      const sub = gitSubcommand(argv);
      if (sub === null) return ALLOW;
      if (GIT_READ_SUBCOMMANDS.has(sub)) return ALLOW;
      if (GIT_HISTORY_WRITES.has(sub) || !GIT_READ_SUBCOMMANDS.has(sub)) {
        return deny(
          `\`git ${sub}\` changes git state. CodeArena owns the repository's git state: it ` +
            `snapshots your work to produce the review diff and to roll back if the review ` +
            `fails, and a commit, reset or checkout mid-task invalidates that baseline. ` +
            `Edit files; leave git to CodeArena. (git status/diff/log/show are available.)`,
        );
      }
    }

    return ALLOW;
  }
}
