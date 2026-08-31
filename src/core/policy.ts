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
import { parseCommands, basename, redirectTargets, type Segment } from "./shell.js";

export type Decision = { allow: true } | { allow: false; reason: string };

const ALLOW: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason });

export interface PolicyOptions {
  projectDir: string;
  /**
   * Read-only mode: nothing may be modified at all.
   *
   * Used while the user is still talking to the builder, before any decision has been made.
   * Denying Write/Edit is not sufficient -- bash writes too, via redirects, `sed -i`, `rm`,
   * `tee` and friends -- so those are denied here as well.
   */
  readOnly?: boolean;
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

/**
 * Commands a read-only conversation may run.
 *
 * An allowlist, not a denylist, and that asymmetry is deliberate. "Nothing is written until
 * you decide" is the promise the conversation-first design rests on, and a denylist only ever
 * promises "we blocked the spellings we thought of". `python3 -c "open('x','w').write(...)"`
 * and `node -e "fs.writeFileSync(...)"` walk straight through a denylist of shell verbs; the
 * chat phase has no need to execute code, so the honest shape here is to deny by default.
 *
 * `git` is absent because it is adjudicated separately, by subcommand.
 */
const READONLY_COMMANDS = new Set([
  "ls", "cat", "bat", "head", "tail", "wc", "file", "stat", "du", "df", "pwd", "echo",
  "printf", "date", "which", "type", "env", "basename", "dirname", "realpath", "readlink",
  "find", "fd", "grep", "egrep", "fgrep", "rg", "ag", "ack", "sed", "awk", "sort", "uniq",
  "cut", "tr", "diff", "comm", "join", "paste", "column", "nl", "od", "xxd", "strings",
  "jq", "yq", "tree", "true", "false", "test", "expr", "seq", "sha256sum", "shasum", "md5",
  "uname", "hostname", "whoami", "id", "tty", "sleep",
]);

/** Commands that modify the filesystem. Denied in read-only mode. */
const MUTATING_COMMANDS = new Set([
  "rm", "rmdir", "mv", "cp", "touch", "mkdir", "ln", "install", "truncate", "shred",
  "chmod", "chown", "chgrp", "dd", "tee", "patch", "unzip", "tar",
]);

/** `sed -i` and `perl -i` edit in place; without -i they are read-only filters. */
function editsInPlace(argv: string[]): boolean {
  const cmd = basename(argv[0] ?? "");
  if (cmd !== "sed" && cmd !== "perl" && cmd !== "ruby") return false;
  return argv.slice(1).some((a) => a === "-i" || (a.startsWith("-i") && !a.startsWith("--")));
}

/** An unquoted `>` or `>>` writes a file. The tokeniser drops these, so check the raw text. */
function hasRedirect(raw: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    // `2>&1` merges descriptors and writes nothing; `>file` and `>>file` do.
    if (c === ">") {
      const next = raw[i + 1] === ">" ? raw[i + 2] : raw[i + 1];
      if (next !== "&") return true;
    }
  }
  return false;
}

/**
 * argv entries that look like filesystem paths.
 *
 * Over-reports: a bare word that happens to name a file is indistinguishable from an argument.
 * That is the right direction to err -- an extra containment check on a non-path costs
 * nothing, since a non-path resolves inside the project and passes.
 */
function pathLikeTokens(argv: string[]): string[] {
  return argv.slice(1).filter(
    (t) =>
      !t.startsWith("-") &&
      (t.startsWith("/") || t.startsWith("~") || t.startsWith("./") || t.startsWith("../") ||
        t.includes("/")),
  );
}

/** Commands whose non-flag arguments name things they will write to or destroy. */
const WRITE_TARGET_COMMANDS = new Set([
  ...MUTATING_COMMANDS,
  "sed", "perl", "ruby", // only reachable here with -i; see editsInPlace
]);

/** Uploading a local file is exfiltration regardless of where it is going. */
const UPLOAD_FLAGS = new Set(["-T", "--upload-file", "-d", "--data", "--data-binary", "-F", "--form"]);

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
      case "MultiEdit":
      case "NotebookEdit": {
        if (this.options.readOnly) {
          return deny(
            `${toolName} modifies files. Nothing is written until you decide to build — ` +
              `we are still talking it through.`,
          );
        }
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

  /**
   * Credential reads and out-of-project writes, for one command.
   *
   * Credentials are denied to every command, read or write, in both modes -- a chat turn has
   * no business opening ~/.ssh any more than a build does. Containment is applied to writes
   * only: reading a file outside the project is how a builder learns about its toolchain,
   * and denying it would be the plan-mode read ban all over again.
   */
  private checkPaths(cmd: string, argv: string[], redirects: string[]): Decision | null {
    const args = pathLikeTokens(argv);

    for (const token of [...args, ...redirects]) {
      const cred = touchesCredentials(this.resolve(token));
      if (cred) {
        return deny(`${cred} holds credentials and is not available to \`${cmd}\`.`);
      }
    }

    // A redirect writes, whatever the command in front of it is.
    for (const target of redirects) {
      const abs = this.resolve(target);
      if (!isInside(this.projectDir, abs)) {
        return deny(
          `That command writes to ${abs}, outside the project directory ` +
            `(${this.projectDir}). Keep changes inside the project.`,
        );
      }
    }

    if (WRITE_TARGET_COMMANDS.has(cmd)) {
      for (const token of args) {
        const abs = this.resolve(token);
        if (!isInside(this.projectDir, abs)) {
          return deny(
            `\`${cmd}\` would modify ${abs}, outside the project directory ` +
              `(${this.projectDir}).`,
          );
        }
      }
    }

    return null;
  }

  private checkSegment(segment: Segment): Decision {
    const argv = segment.argv;
    const cmd = basename(argv[0] ?? "");

    // Path containment runs in BOTH modes and before anything else.
    //
    // It used to run in neither. `checkSegment` inspected command names, publish verbs and git
    // subcommands, and never once called touchesCredentials or isInside -- so `Write` to
    // ~/.zshrc was denied while `echo pwned >> ~/.zshrc` was allowed, and `rm -rf ~/Documents`
    // and `cat ~/.ssh/id_rsa` sailed through during the build phase, which is precisely the
    // phase where bash is busiest. shell.ts spent 228 lines enumerating every command hidden
    // in a pipeline and then did nothing with the arguments it had extracted.
    const targets = redirectTargets(segment.raw);
    const denial = this.checkPaths(cmd, argv, targets);
    if (denial) return denial;

    if (this.options.readOnly) {
      // Allowlist. Unknown commands are denied here, including every script interpreter --
      // see READONLY_COMMANDS for why this one is not a denylist.
      if (cmd !== "git" && !READONLY_COMMANDS.has(cmd)) {
        return deny(
          `\`${cmd}\` is not one of the read-only commands available while we are still ` +
            `talking. Nothing is written until you decide to build. If you need it to answer ` +
            `the question, say so and I will decide.`,
        );
      }
      if (editsInPlace(argv)) {
        return deny(`\`${cmd} -i\` edits files in place; nothing is written yet.`);
      }
      if (targets.length > 0) {
        return deny(`That command redirects output into a file; nothing is written yet.`);
      }
    }

    // `curl … | bash` -- the parser splits the pipe, so a shell with no script argument is
    // reading its program from the pipe.
    if (["sh", "bash", "zsh", "dash", "ksh"].includes(cmd)) {
      const hasScript = argv.slice(1).some((a) => !a.startsWith("-"));
      if (!hasScript) {
        return deny(
          `Piping a downloaded script straight into \`${cmd}\` runs code nobody has read. ` +
            `Download it to the project and run it as a file if you need it.`,
        );
      }
    }

    if (!this.options.allowPublish && (cmd === "curl" || cmd === "wget")) {
      const uploading = argv.some((a) => UPLOAD_FLAGS.has(a) || a.startsWith("--data"));
      if (uploading) {
        return deny(
          `\`${cmd}\` is being used to upload data. Sending anything out of this machine is ` +
            `a human decision.`,
        );
      }
    }

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
      return deny(
        `\`git ${sub}\` changes git state. CodeArena owns the repository's git state: it ` +
          `snapshots your work to produce the review diff and to roll back if the review ` +
          `fails, and a commit, reset or checkout mid-task invalidates that baseline. ` +
          `Edit files; leave git to CodeArena. (git status/diff/log/show are available.)`,
      );
    }

    return ALLOW;
  }
}
