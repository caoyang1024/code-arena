// electron/main.ts
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import path4 from "node:path";
import { fileURLToPath } from "node:url";

// src/core/git.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
var exec = promisify(execFile);
var Git = class {
  constructor(dir) {
    this.dir = dir;
  }
  dir;
  async run(args, env = {}) {
    const { stdout } = await exec("git", args, {
      cwd: this.dir,
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024
    });
    return stdout;
  }
  async isRepo() {
    try {
      const out = await this.run(["rev-parse", "--is-inside-work-tree"]);
      return out.trim() === "true";
    } catch {
      return false;
    }
  }
  async hasCommits() {
    try {
      await this.run(["rev-parse", "--verify", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }
  /** Anything uncommitted (tracked or not) sitting in the tree before we start. */
  async isDirty() {
    const out = await this.run(["status", "--porcelain"]);
    return out.trim().length > 0;
  }
  /** Branch name, or "<name> (no commits yet)" on a freshly-initialised repo. */
  async currentBranch() {
    if (await this.hasCommits()) {
      return (await this.run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    }
    const head = (await this.run(["symbolic-ref", "--short", "HEAD"])).trim();
    return `${head} (no commits yet)`;
  }
  /**
   * Capture the full working tree (including untracked files, minus .gitignore'd ones)
   * as a dangling commit. Returns its sha.
   */
  async snapshot(label) {
    const indexFile = path.join(this.dir, ".git", `codearena-index-${process.pid}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      if (await this.hasCommits()) {
        await this.run(["read-tree", "HEAD"], env);
      } else {
        await this.run(["read-tree", "--empty"], env);
      }
      await this.run(["add", "-A", "."], env);
      const tree = (await this.run(["write-tree"], env)).trim();
      const parentArgs = [];
      if (await this.hasCommits()) {
        parentArgs.push("-p", (await this.run(["rev-parse", "HEAD"])).trim());
      }
      const commit = (await this.run(["commit-tree", tree, ...parentArgs, "-m", `codearena snapshot: ${label}`], {
        ...env,
        GIT_AUTHOR_NAME: "CodeArena",
        GIT_AUTHOR_EMAIL: "codearena@localhost",
        GIT_COMMITTER_NAME: "CodeArena",
        GIT_COMMITTER_EMAIL: "codearena@localhost"
      })).trim();
      await this.run(["update-ref", `refs/codearena/${commit}`, commit]);
      return commit;
    } finally {
      await fs.rm(indexFile, { force: true });
    }
  }
  /** Unified diff between two snapshots. */
  async diff(from, to) {
    return this.run(["diff", "--no-color", "--find-renames", from, to]);
  }
  /** Files touched between two snapshots, as repo-relative paths. */
  async changedFiles(from, to) {
    const out = await this.run(["diff", "--name-only", from, to]);
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  /**
   * Put the working tree back to a snapshot.
   *
   * `read-tree -u --reset` restores tracked content but leaves files created after the
   * snapshot in place, so we remove those explicitly using the diff as the source of truth.
   */
  async restore(snapshot) {
    const head = await this.snapshot("pre-restore");
    const added = (await this.run(["diff", "--name-only", "--diff-filter=A", snapshot, head])).split("\n").map((l) => l.trim()).filter(Boolean);
    await this.run(["read-tree", "-u", "--reset", snapshot]);
    for (const file of added) {
      await fs.rm(path.join(this.dir, file), { force: true });
    }
  }
  /** Drop the refs we created. Call when a task ends; the objects then gc normally. */
  async cleanupRefs() {
    const out = await this.run(["for-each-ref", "--format=%(refname)", "refs/codearena/"]);
    for (const ref of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
      await this.run(["update-ref", "-d", ref]);
    }
  }
};

// src/core/gatekeeper.ts
import { Codex } from "@openai/codex-sdk";

// src/core/schema.ts
var REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: {
      type: "string",
      enum: ["approve", "request_changes"],
      description: "approve only if you would merge this as-is. Any blocker or major finding means request_changes."
    },
    summary: {
      type: "string",
      description: "Two sentences at most: what was reviewed and why the verdict is what it is."
    },
    findings: {
      type: "array",
      description: "Concrete defects. Empty when approving. Do not pad with style nits or speculation.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "line", "issue", "evidence", "suggestion"],
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          file: { type: ["string", "null"], description: "Repo-relative path, or null." },
          line: { type: ["integer", "null"], description: "1-indexed line, or null." },
          issue: { type: "string", description: "One sentence stating the defect." },
          evidence: {
            type: "string",
            description: "Concrete inputs or state that trigger it, or the code you read that proves it. Not a restatement of the issue."
          },
          suggestion: { type: "string", description: "What the implementer should change." }
        }
      }
    }
  }
};
function parseReview(raw) {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) text = fence[1].trim();
  const data = JSON.parse(text);
  if (typeof data !== "object" || data === null) {
    throw new Error("Gatekeeper returned a non-object verdict");
  }
  const obj = data;
  if (obj.verdict !== "approve" && obj.verdict !== "request_changes") {
    throw new Error(`Gatekeeper returned an unknown verdict: ${JSON.stringify(obj.verdict)}`);
  }
  return {
    verdict: obj.verdict,
    summary: typeof obj.summary === "string" ? obj.summary : "",
    findings: Array.isArray(obj.findings) ? obj.findings : []
  };
}

// src/core/gatekeeper.ts
var CHARTER = `You are the gatekeeper on a two-model engineering team. Another model wrote
the work below. Your job is to decide whether it should be accepted.

You have read-only access to the repository -- use it. Read the files around a change before
judging it; a finding you did not verify against the actual code is worse than no finding.

Rules:
- Report defects, not preferences. Style nits and hypotheticals are noise.
- Every finding needs concrete evidence: the inputs that break it, or the code you read that
  proves it. "This could be a problem" is not evidence.
- Approve when you would merge it as-is. A single blocker or major finding means
  request_changes.
- Do not restate the diff back at me.`;
var Gatekeeper = class {
  constructor(config) {
    this.config = config;
    this.codex = new Codex({ codexPathOverride: config.codexPath });
  }
  config;
  codex;
  planThread = null;
  diffThread = null;
  inputTokens = 0;
  cachedInputTokens = 0;
  outputTokens = 0;
  newThread() {
    return this.codex.startThread({
      workingDirectory: this.config.projectDir,
      sandboxMode: "read-only",
      skipGitRepoCheck: false,
      ...this.config.gatekeeperModel ? { model: this.config.gatekeeperModel } : {}
    });
  }
  async runReview(thread, prompt, emit) {
    const { events } = await thread.runStreamed(prompt, { outputSchema: REVIEW_SCHEMA });
    let final = "";
    for await (const event of events) {
      if (event.type === "item.completed") {
        const item = event.item;
        switch (item.type) {
          case "agent_message":
            final = item.text;
            break;
          case "command_execution":
            emit({ type: "gatekeeper.item", kind: "command", text: item.command });
            break;
          case "reasoning":
            emit({ type: "gatekeeper.item", kind: "reasoning", text: item.text });
            break;
          case "error":
            emit({ type: "gatekeeper.item", kind: "error", text: item.message });
            break;
          default:
            break;
        }
      } else if (event.type === "turn.completed") {
        this.inputTokens += event.usage.input_tokens;
        this.cachedInputTokens += event.usage.cached_input_tokens;
        this.outputTokens += event.usage.output_tokens;
      } else if (event.type === "turn.failed") {
        throw new Error(`Gatekeeper turn failed: ${event.error.message}`);
      } else if (event.type === "error") {
        throw new Error(`Gatekeeper stream error: ${event.message}`);
      }
    }
    if (!final.trim()) throw new Error("Gatekeeper returned an empty response");
    return parseReview(final);
  }
  /** Review the builder's plan before a single file is touched. */
  async reviewPlan(task, plan2, emit) {
    this.planThread ??= this.newThread();
    const prompt = [
      CHARTER,
      "",
      "You are reviewing a PLAN, not code. Judge whether this approach will actually solve the",
      "task correctly: wrong approach, missed requirement, ignored existing abstraction,",
      "unhandled failure mode, or a plan that contradicts how this repository already works.",
      "",
      "--- TASK AS GIVEN TO THE IMPLEMENTER ---",
      task,
      "",
      "--- PROPOSED PLAN ---",
      plan2
    ].join("\n");
    return this.runReview(this.planThread, prompt, emit);
  }
  /** Review the actual diff after implementation. */
  async reviewDiff(task, plan2, diff, changedFiles, emit) {
    this.diffThread ??= this.newThread();
    const prompt = [
      CHARTER,
      "",
      "You are reviewing a DIFF. The working tree already contains these changes, so you can",
      "open any file to see the full post-change context. Look for: correctness bugs, missed",
      "requirements from the task, error paths that were skipped, and anything the plan",
      "promised but the diff does not deliver.",
      "",
      `--- FILES CHANGED (${changedFiles.length}) ---`,
      changedFiles.join("\n") || "(none)",
      "",
      "--- TASK AS GIVEN TO THE IMPLEMENTER ---",
      task,
      "",
      "--- APPROVED PLAN ---",
      plan2,
      "",
      "--- DIFF ---",
      diff || "(empty diff -- the implementer changed nothing; that is itself a finding)"
    ].join("\n");
    return this.runReview(this.diffThread, prompt, emit);
  }
};

// src/core/builder.ts
import { query } from "@anthropic-ai/claude-agent-sdk";

// src/core/policy.ts
import path2 from "node:path";
import os from "node:os";

// src/core/shell.ts
var OPERATORS = ["&&", "||", ";;", ";", "|", "&", "\n"];
function basename(p) {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}
function splitTopLevel(input) {
  const parts = [];
  let current = "";
  let quote = null;
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        current += c + (input[++i] ?? "");
      } else {
        if (c === quote) quote = null;
        current += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === "\\") {
      current += c + (input[++i] ?? "");
      continue;
    }
    if (c === "$" && input[i + 1] === "(") {
      depth++;
      current += "$(";
      i++;
      continue;
    }
    if (c === "(" && depth > 0) {
      depth++;
      current += c;
      continue;
    }
    if (c === ")" && depth > 0) {
      depth--;
      current += c;
      continue;
    }
    if (depth === 0) {
      const isDescriptorDup = c === "&" && !input.startsWith("&&", i) && current.trimEnd().endsWith(">");
      const op = isDescriptorDup ? void 0 : OPERATORS.find((o) => input.startsWith(o, i));
      if (op) {
        parts.push(current);
        current = "";
        i += op.length - 1;
        continue;
      }
    }
    current += c;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}
function extractSubstitutions(input) {
  const found = [];
  for (let i = 0; i < input.length - 1; i++) {
    if (input[i] === "$" && input[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < input.length && depth > 0; j++) {
        if (input[j] === "(") depth++;
        else if (input[j] === ")") depth--;
      }
      if (depth === 0) found.push(input.slice(i + 2, j - 1));
    }
  }
  for (const b of input.match(/`[^`]*`/g) ?? []) found.push(b.slice(1, -1));
  return found;
}
function tokenise(input) {
  const tokens = [];
  let current = "";
  let quote = null;
  let started = false;
  const push = () => {
    if (started) tokens.push(current);
    current = "";
    started = false;
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === "\\" && quote === '"') current += input[++i] ?? "";
      else if (c === quote) quote = null;
      else current += c;
      started = true;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\") {
      current += input[++i] ?? "";
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    current += c;
    started = true;
  }
  push();
  return tokens;
}
var ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
var PASSTHROUGH = /* @__PURE__ */ new Set([
  "env",
  "nohup",
  "time",
  "command",
  "builtin",
  "exec",
  "nice",
  "ionice",
  "stdbuf",
  "setsid",
  "timeout",
  "xargs",
  "sudo",
  "doas"
]);
function stripWrapperFlags(argv) {
  let out = argv;
  while (out.length > 0 && out[0].startsWith("-")) out = out.slice(1);
  return out;
}
function parseCommands(input) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (argv, raw) => {
    if (argv.length === 0) return;
    const key = argv.join("\0");
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ argv, raw });
  };
  const walk = (text, depth) => {
    if (depth > 8) return;
    for (const sub of extractSubstitutions(text)) walk(sub, depth + 1);
    for (const raw of splitTopLevel(text)) {
      let argv = tokenise(raw).filter((t) => !/^[0-9]*[<>]/.test(t));
      while (argv.length > 0 && ENV_ASSIGNMENT.test(argv[0])) argv = argv.slice(1);
      if (argv.length === 0) continue;
      add(argv, raw);
      let unwrapped = argv;
      let guard = 0;
      while (unwrapped.length > 1 && PASSTHROUGH.has(basename(unwrapped[0])) && guard++ < 8) {
        unwrapped = stripWrapperFlags(unwrapped.slice(1));
        while (unwrapped.length > 0 && ENV_ASSIGNMENT.test(unwrapped[0])) {
          unwrapped = unwrapped.slice(1);
        }
        add(unwrapped, raw);
      }
    }
  };
  walk(input, 0);
  return out;
}

// src/core/policy.ts
var ALLOW = { allow: true };
var deny = (reason) => ({ allow: false, reason });
var GIT_READ_SUBCOMMANDS = /* @__PURE__ */ new Set([
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "annotate",
  "describe",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "rev-parse",
  "rev-list",
  "cat-file",
  "show-ref",
  "for-each-ref",
  "shortlog",
  "grep",
  "whatchanged",
  "count-objects",
  "verify-pack",
  "check-ignore",
  "check-attr",
  "merge-base",
  "name-rev",
  "symbolic-ref",
  "var",
  "help",
  "version",
  "diff-tree",
  "diff-index",
  "difftool"
]);
var GIT_HISTORY_WRITES = /* @__PURE__ */ new Set([
  "commit",
  "reset",
  "rebase",
  "merge",
  "cherry-pick",
  "revert",
  "checkout",
  "switch",
  "restore",
  "stash",
  "clean",
  "am",
  "apply",
  "update-ref",
  "filter-branch",
  "filter-repo",
  "gc",
  "prune",
  "reflog",
  "branch",
  "tag",
  "worktree",
  "push",
  "pull",
  "fetch",
  "clone",
  "submodule",
  "rm",
  "mv",
  "add",
  "notes",
  "replace",
  "bisect"
]);
function gitRelocates(argv) {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-C" || a === "--git-dir" || a === "--work-tree" || a === "--exec-path") {
      return a;
    }
    if (a.startsWith("--git-dir=") || a.startsWith("--work-tree=")) return a.split("=")[0];
    if (!a.startsWith("-")) break;
  }
  return null;
}
function gitSubcommand(argv) {
  const VALUE_FLAGS = /* @__PURE__ */ new Set(["-C", "-c", "--git-dir", "--work-tree", "--exec-path", "--namespace"]);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
}
var DENIED_COMMANDS = /* @__PURE__ */ new Map([
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
  ["crontab", "installs scheduled jobs that outlive this task"]
]);
var PUBLISH = [
  { match: (a) => basename(a[0]) === "npm" && a[1] === "publish", what: "npm publish" },
  { match: (a) => basename(a[0]) === "yarn" && a[1] === "publish", what: "yarn publish" },
  { match: (a) => basename(a[0]) === "pnpm" && a[1] === "publish", what: "pnpm publish" },
  { match: (a) => basename(a[0]) === "gh" && (a[1] === "pr" || a[1] === "release"), what: "a GitHub PR or release" },
  { match: (a) => basename(a[0]) === "docker" && a[1] === "push", what: "a container push" },
  { match: (a) => basename(a[0]) === "cargo" && a[1] === "publish", what: "cargo publish" },
  { match: (a) => basename(a[0]) === "twine" && a[1] === "upload", what: "a PyPI upload" }
];
var MUTATING_COMMANDS = /* @__PURE__ */ new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "touch",
  "mkdir",
  "ln",
  "install",
  "truncate",
  "shred",
  "chmod",
  "chown",
  "chgrp",
  "dd",
  "tee",
  "patch",
  "unzip",
  "tar"
]);
function editsInPlace(argv) {
  const cmd = basename(argv[0] ?? "");
  if (cmd !== "sed" && cmd !== "perl" && cmd !== "ruby") return false;
  return argv.slice(1).some((a) => a === "-i" || a.startsWith("-i") && !a.startsWith("--"));
}
function hasRedirect(raw) {
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
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
    if (c === ">") {
      const next = raw[i + 1] === ">" ? raw[i + 2] : raw[i + 1];
      if (next !== "&") return true;
    }
  }
  return false;
}
var SENSITIVE_DIRS = [".ssh", ".aws", ".gnupg", ".config/gcloud", ".kube"];
var SENSITIVE_FILES = [".codex/auth.json", ".claude/.credentials.json", ".netrc", ".npmrc", ".pypirc"];
function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path2.join(os.homedir(), p.slice(2));
  return p;
}
function isInside(root, target) {
  const rel = path2.relative(root, target);
  return rel === "" || !rel.startsWith("..") && !path2.isAbsolute(rel);
}
function touchesCredentials(abs) {
  const home = os.homedir();
  for (const dir of SENSITIVE_DIRS) {
    if (isInside(path2.join(home, dir), abs)) return `~/${dir}`;
  }
  for (const file of SENSITIVE_FILES) {
    if (abs === path2.join(home, file)) return `~/${file}`;
  }
  return null;
}
var Policy = class {
  constructor(options) {
    this.options = options;
    this.projectDir = path2.resolve(options.projectDir);
  }
  options;
  projectDir;
  /** Resolve a tool-supplied path against the project root. */
  resolve(p) {
    return path2.resolve(this.projectDir, expandHome(p));
  }
  check(toolName, input) {
    const obj = input ?? {};
    switch (toolName) {
      case "Write":
      case "Edit":
      case "MultiEdit":
      case "NotebookEdit": {
        if (this.options.readOnly) {
          return deny(
            `${toolName} modifies files. Nothing is written until you decide to build \u2014 we are still talking it through.`
          );
        }
        const raw = obj.file_path ?? obj.notebook_path;
        if (typeof raw !== "string") return ALLOW;
        const abs = this.resolve(raw);
        const cred = touchesCredentials(abs);
        if (cred) return deny(`${cred} holds credentials and is never writable.`);
        if (!isInside(this.projectDir, abs)) {
          return deny(
            `${abs} is outside the project directory (${this.projectDir}). Keep changes inside the project.`
          );
        }
        if (isInside(path2.join(this.projectDir, ".git"), abs)) {
          return deny(
            `Writing inside .git corrupts the snapshots CodeArena uses to show your diff and to roll back. Change working-tree files instead.`
          );
        }
        return ALLOW;
      }
      case "Read": {
        const raw = obj.file_path;
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
  checkBash(command) {
    if (typeof command !== "string" || command.trim() === "") return ALLOW;
    for (const segment of parseCommands(command)) {
      const decision = this.checkSegment(segment);
      if (!decision.allow) return decision;
    }
    return ALLOW;
  }
  checkSegment(segment) {
    const argv = segment.argv;
    const cmd = basename(argv[0] ?? "");
    if (this.options.readOnly) {
      if (MUTATING_COMMANDS.has(cmd)) {
        return deny(
          `\`${cmd}\` modifies the filesystem. Nothing is written until you decide to build \u2014 we are still talking it through.`
        );
      }
      if (editsInPlace(argv)) {
        return deny(`\`${cmd} -i\` edits files in place; nothing is written yet.`);
      }
      if (hasRedirect(segment.raw)) {
        return deny(`That command redirects output into a file; nothing is written yet.`);
      }
    }
    const denied = DENIED_COMMANDS.get(cmd);
    if (denied) return deny(`\`${cmd}\` ${denied}; it is not available to the builder.`);
    if (!this.options.allowPublish) {
      for (const rule of PUBLISH) {
        if (rule.match(argv)) {
          return deny(
            `Publishing (${rule.what}) is outward-facing and irreversible. CodeArena leaves that to the human after review.`
          );
        }
      }
    }
    if (cmd === "git" && !this.options.allowGitWrites) {
      const relocation = gitRelocates(argv);
      if (relocation) {
        return deny(
          `\`git ${relocation}\` redirects git outside the project, which breaks the snapshot baseline. Run git from the project root.`
        );
      }
      const sub = gitSubcommand(argv);
      if (sub === null) return ALLOW;
      if (GIT_READ_SUBCOMMANDS.has(sub)) return ALLOW;
      if (GIT_HISTORY_WRITES.has(sub) || !GIT_READ_SUBCOMMANDS.has(sub)) {
        return deny(
          `\`git ${sub}\` changes git state. CodeArena owns the repository's git state: it snapshots your work to produce the review diff and to roll back if the review fails, and a commit, reset or checkout mid-task invalidates that baseline. Edit files; leave git to CodeArena. (git status/diff/log/show are available.)`
        );
      }
    }
    return ALLOW;
  }
};

// src/core/builder.ts
var MUTATING_TOOLS = /* @__PURE__ */ new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
var SILENCE_TIMEOUT_MS = 15e4;
var ACCOUNT_FAILURES = [
  /credit balance is too low/i,
  /insufficient credits?/i,
  /quota (has been )?exceeded/i,
  /rate limit(ed)? exceeded/i,
  /usage limit reached/i,
  /invalid api key/i,
  /authentication[_ ]error/i,
  /please run .?claude.? to (log ?in|authenticate)/i
];
function accountFailure(result, turns) {
  const text = result.trim();
  if (turns > 1 || text.length > 300) return null;
  return ACCOUNT_FAILURES.some((p) => p.test(text)) ? `Builder could not run \u2014 the account reported: "${text}"` : null;
}
var CHAT_SYSTEM = `You are the implementer on a two-model team, currently in conversation
with the engineer. Nothing you say here is being built yet.

You cannot modify anything, by design. Read the code, answer the question, and say what you
would actually do. If the request is ambiguous or you think the premise is wrong, say so now
-- this conversation is exactly where that belongs, and it is cheaper than being told by the
reviewer later.

Do not produce an implementation plan unless asked. The engineer decides when to build.`;
var PLAN_PREAMBLE = `The engineer has decided to build what you just discussed. Write the
implementation plan now.

A second model reviews this plan before you touch a single file, and it can read the
repository. Be specific about which files you will create or modify and what each change
does. State your assumptions and anything still ambiguous -- the reviewer checks those first.
Do not write the code yet.`;
var BUILD_PREAMBLE = `Your plan was approved. Implement it now. Match the conventions of the
surrounding code. When you are done, say briefly what you changed and anything you
deliberately left out.`;
var REVISE_PREAMBLE = `The reviewer rejected your work. Address every blocker and major
finding below. If you believe a finding is wrong, change nothing for that one but say so
explicitly and explain why -- do not silently ignore it.`;
function renderFindings(findings) {
  if (findings.length === 0) return "(no itemised findings)";
  return findings.map((f, i) => {
    const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "(no file)";
    return [
      `${i + 1}. [${f.severity}] ${loc}`,
      `   Issue: ${f.issue}`,
      `   Evidence: ${f.evidence}`,
      `   Suggested fix: ${f.suggestion}`
    ].join("\n");
  }).join("\n\n");
}
async function drive(prompt, config, emit, opts) {
  const readOnly = opts.mode !== "build";
  const policy = new Policy({
    projectDir: config.projectDir,
    readOnly,
    ...config.allowGitWrites !== void 0 ? { allowGitWrites: config.allowGitWrites } : {},
    ...config.allowPublish !== void 0 ? { allowPublish: config.allowPublish } : {}
  });
  let text = "";
  let sessionId = opts.resume;
  let costUsd = 0;
  let denials = 0;
  const abort = new AbortController();
  const response = query({
    prompt,
    options: {
      abortController: abort,
      cwd: config.projectDir,
      // Drive the Claude Code the user actually signed in to, rather than the SDK's bundled
      // copy -- the same reasoning as codex-path.ts. Keeps versions and credentials in one
      // place instead of two.
      ...config.claudePath ? { pathToClaudeCodeExecutable: config.claudePath } : {},
      ...config.builderModel ? { model: config.builderModel } : {},
      permissionMode: opts.mode === "plan" ? "plan" : "default",
      ...opts.resume ? { resume: opts.resume } : {},
      ...config.maxBudgetUsd !== void 0 ? { maxBudgetUsd: config.maxBudgetUsd } : {},
      systemPrompt: opts.mode === "chat" ? { type: "preset", preset: "claude_code", append: CHAT_SYSTEM } : { type: "preset", preset: "claude_code" },
      // Layer 1: kernel-enforced isolation. OFF BY DEFAULT -- it hangs.
      //
      // Measured on claude-agent-sdk 0.1.77 / macOS 25.6: with `sandbox: { enabled: true }`,
      // query() emits system:init at ~0.6s and then never yields another message. The same
      // call without it returns in 3.7s. Worse, the hang swallows account-level errors, so a
      // failed run is indistinguishable from a slow one.
      ...config.sandbox === true ? { sandbox: { enabled: true } } : {},
      // Layer 2: CodeArena adjudicates every call the permission flow would have prompted a
      // human for. Denials carry a reason so the model adapts instead of retrying.
      canUseTool: async (request) => {
        const name = request.tool_name ?? "unknown";
        const input = request.input ?? {};
        if (readOnly && MUTATING_TOOLS.has(name)) {
          denials += 1;
          const reason = opts.mode === "chat" ? `${name} modifies files. We are still talking \u2014 nothing is written until you decide to build.` : `${name} modifies files; the planning phase is read-only.`;
          emit({ type: "builder.permission", name, decision: "deny", reason });
          return { behavior: "deny", message: reason };
        }
        const decision = policy.check(name, input);
        if (!decision.allow) {
          denials += 1;
          emit({ type: "builder.permission", name, decision: "deny", reason: decision.reason });
          return { behavior: "deny", message: decision.reason };
        }
        emit({ type: "builder.permission", name, decision: "allow" });
        return { behavior: "allow", updatedInput: input };
      }
    }
  });
  let lastMessageAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastMessageAt > SILENCE_TIMEOUT_MS) {
      clearInterval(watchdog);
      emit({
        type: "log",
        level: "error",
        message: `Builder produced nothing for ${SILENCE_TIMEOUT_MS / 1e3}s; aborting. If the OS sandbox is enabled, that is the first thing to suspect.`
      });
      abort.abort();
    }
  }, 5e3);
  try {
    for await (const message of response) {
      lastMessageAt = Date.now();
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            text += block.text;
            emit({ type: "builder.text", text: block.text });
          } else if (block.type === "tool_use") {
            emit({ type: "builder.tool", name: block.name, input: block.input });
          }
        }
      } else if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      } else if (message.type === "result") {
        costUsd = message.total_cost_usd;
        sessionId = message.session_id;
        if (message.subtype === "success") {
          const failure = accountFailure(message.result, message.num_turns);
          if (failure) throw new Error(failure);
          text = message.result;
        } else {
          throw new Error(
            `Builder ended with ${message.subtype}: ${message.errors?.join("; ") ?? "no detail"}`
          );
        }
      }
    }
  } finally {
    clearInterval(watchdog);
  }
  return { text, sessionId, costUsd, denials };
}
function chat(message, config, emit, sessionId) {
  return drive(message, config, emit, { mode: "chat", resume: sessionId });
}
function plan(config, emit, sessionId, instruction) {
  const prompt = instruction ? `${PLAN_PREAMBLE}

--- WHAT TO BUILD ---
${instruction}` : PLAN_PREAMBLE;
  return drive(prompt, config, emit, { mode: "plan", resume: sessionId });
}
function replan(findings, summary, config, emit, sessionId) {
  const prompt = [
    REVISE_PREAMBLE,
    "",
    "--- REVIEWER SUMMARY ---",
    summary,
    "",
    "--- FINDINGS ---",
    renderFindings(findings),
    "",
    "Produce the corrected plan. Still do not write code."
  ].join("\n");
  return drive(prompt, config, emit, { mode: "plan", resume: sessionId });
}
function implement(config, emit, sessionId) {
  return drive(BUILD_PREAMBLE, config, emit, { mode: "build", resume: sessionId });
}
function revise(findings, summary, config, emit, sessionId) {
  const prompt = [
    REVISE_PREAMBLE,
    "",
    "--- REVIEWER SUMMARY ---",
    summary,
    "",
    "--- FINDINGS ---",
    renderFindings(findings)
  ].join("\n");
  return drive(prompt, config, emit, { mode: "build", resume: sessionId });
}

// src/core/orchestrator.ts
async function runChat(message, config, emit, sessionId) {
  emit({ type: "user.message", text: message });
  emit({ type: "phase", phase: "chatting", round: 1 });
  try {
    const turn = await chat(message, config, emit, sessionId);
    emit({ type: "session", sessionId: turn.sessionId });
    return turn.sessionId;
  } catch (error) {
    emit({
      type: "log",
      level: "error",
      message: error instanceof Error ? error.message : String(error)
    });
    return sessionId;
  }
}
async function runBuild(config, emit, sessionId, instruction) {
  const git = new Git(config.projectDir);
  const gate = new Gatekeeper(config);
  const rounds = [];
  let plan2 = null;
  let builderUsd = 0;
  let session2 = sessionId;
  const cost = () => ({
    builderUsd,
    gatekeeperInputTokens: gate.inputTokens,
    gatekeeperCachedInputTokens: gate.cachedInputTokens,
    gatekeeperOutputTokens: gate.outputTokens
  });
  const finish = (phase, diff, error) => {
    const result = {
      phase,
      plan: plan2,
      rounds,
      diff,
      cost: cost(),
      sessionId: session2,
      ...error ? { error } : {}
    };
    emit({ type: "cost", cost: result.cost });
    emit({ type: "session", sessionId: session2 });
    emit({ type: "done", result });
    return result;
  };
  try {
    if (!await git.isRepo()) {
      return finish("failed", "", `${config.projectDir} is not a git repository`);
    }
    const baseline = await git.snapshot("build-start");
    emit({ type: "snapshot", ref: baseline, label: "build-start" });
    let round = 1;
    for (; ; ) {
      emit({ type: "phase", phase: "planning", round });
      const turn = round === 1 ? await plan(config, emit, session2, instruction) : await replan(
        rounds.at(-1).review.findings,
        rounds.at(-1).review.summary,
        config,
        emit,
        session2
      );
      builderUsd += turn.costUsd;
      session2 = turn.sessionId;
      const currentPlan = turn.text;
      plan2 = currentPlan;
      if (config.skipPlanReview) break;
      emit({ type: "phase", phase: "plan_review", round });
      const review = await gate.reviewPlan(instruction ?? "(see the plan)", currentPlan, emit);
      rounds.push({ round, phase: "plan_review", review, snapshot: baseline });
      emit({ type: "review", phase: "plan_review", review });
      if (review.verdict === "approve") break;
      if (round >= config.maxRounds) {
        emit({
          type: "log",
          level: "warn",
          message: `Plan still rejected after ${round} rounds \u2014 escalating. Nothing was written.`
        });
        return finish("escalated", "");
      }
      round += 1;
    }
    round = 1;
    for (; ; ) {
      emit({ type: "phase", phase: "implementing", round });
      const turn = round === 1 ? await implement(config, emit, session2) : await revise(
        rounds.at(-1).review.findings,
        rounds.at(-1).review.summary,
        config,
        emit,
        session2
      );
      builderUsd += turn.costUsd;
      session2 = turn.sessionId;
      const snapshot = await git.snapshot(`round-${round}`);
      emit({ type: "snapshot", ref: snapshot, label: `round-${round}` });
      const diff = await git.diff(baseline, snapshot);
      const changed = await git.changedFiles(baseline, snapshot);
      emit({ type: "phase", phase: "diff_review", round });
      const review = await gate.reviewDiff(
        instruction ?? "(see the plan)",
        plan2,
        diff,
        changed,
        emit
      );
      rounds.push({ round, phase: "diff_review", review, snapshot });
      emit({ type: "review", phase: "diff_review", review });
      if (review.verdict === "approve") {
        emit({ type: "phase", phase: "approved", round });
        return finish("approved", diff);
      }
      if (round >= config.maxRounds) {
        emit({
          type: "log",
          level: "warn",
          message: `Diff still rejected after ${round} rounds \u2014 escalating. The changes are left in the working tree; snapshot ${baseline.slice(0, 8)} is the pre-build state.`
        });
        return finish("escalated", diff);
      }
      round += 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "log", level: "error", message });
    return finish("failed", "", message);
  }
}

// src/core/codex-path.ts
import { execFile as execFile2 } from "node:child_process";
import { promisify as promisify2 } from "node:util";
import fs2 from "node:fs/promises";
var exec2 = promisify2(execFile2);
var OPENAI_TEAM_ID = "2DC432GLL2";
var CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
  `${process.env.HOME}/Applications/ChatGPT.app/Contents/Resources/codex`,
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex"
];
async function exists(p) {
  try {
    await fs2.access(p, fs2.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
async function signature(path5) {
  if (process.platform !== "darwin") return { authority: null, team: null };
  try {
    const { stderr } = await exec2("codesign", ["-dv", "--verbose=2", path5]).catch(
      (e) => ({ stderr: e.stderr ?? "" })
    );
    const authority = stderr.match(/^Authority=(.+)$/m)?.[1] ?? null;
    const team = stderr.match(/^TeamIdentifier=(.+)$/m)?.[1] ?? null;
    return { authority, team };
  } catch {
    return { authority: null, team: null };
  }
}
async function probe(path5) {
  if (!await exists(path5)) return null;
  const { authority, team } = await signature(path5);
  const signedByOpenAI = process.platform !== "darwin" || team === OPENAI_TEAM_ID && (authority?.includes("Developer ID Application") ?? false);
  let version = "unknown";
  try {
    version = (await exec2(path5, ["--version"])).stdout.trim();
  } catch {
    return null;
  }
  let loggedIn = false;
  let loginDetail = "not logged in";
  try {
    const { stdout, stderr } = await exec2(path5, ["login", "status"]);
    loginDetail = `${stdout}${stderr}`.trim() || loginDetail;
  } catch (e) {
    const err = e;
    loginDetail = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || loginDetail;
  }
  loggedIn = /logged in/i.test(loginDetail);
  return { path: path5, version, signedByOpenAI, authority, loggedIn, loginDetail };
}
async function resolveCodex() {
  const override = process.env.CODEARENA_CODEX_PATH;
  if (override) return probe(override);
  for (const candidate of CANDIDATES) {
    const found = await probe(candidate);
    if (found?.signedByOpenAI) return found;
  }
  return null;
}

// src/core/claude-path.ts
import { execFile as execFile3 } from "node:child_process";
import { promisify as promisify3 } from "node:util";
import fs3 from "node:fs/promises";
import path3 from "node:path";
import os2 from "node:os";
var exec3 = promisify3(execFile3);
async function exists2(p) {
  try {
    await fs3.access(p, fs3.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
async function candidates() {
  const out = [];
  if (process.env.CODEARENA_CLAUDE_PATH) out.push(process.env.CODEARENA_CLAUDE_PATH);
  const appSupport = path3.join(
    os2.homedir(),
    "Library/Application Support/Claude/claude-code"
  );
  try {
    const versions = await fs3.readdir(appSupport);
    versions.filter((v) => /^\d/.test(v)).sort((a, b) => b.localeCompare(a, void 0, { numeric: true })).forEach((v) => out.push(path3.join(appSupport, v, "claude.app/Contents/MacOS/claude")));
  } catch {
  }
  out.push(
    path3.join(os2.homedir(), ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude"
  );
  return out;
}
async function authStatus(binary) {
  try {
    const { stdout } = await exec3(binary, ["auth", "status"], { timeout: 15e3 });
    const parsed = JSON.parse(stdout);
    return {
      loggedIn: parsed.loggedIn === true,
      email: typeof parsed.email === "string" ? parsed.email : null,
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
      subscriptionType: typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null
    };
  } catch {
    return null;
  }
}
async function resolveClaude() {
  const unusable = (detail) => ({
    path: null,
    version: null,
    loggedIn: false,
    email: null,
    authMethod: null,
    subscriptionType: null,
    usable: false,
    detail
  });
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      path: null,
      version: null,
      loggedIn: true,
      email: null,
      authMethod: "api_key",
      subscriptionType: null,
      usable: true,
      detail: "ANTHROPIC_API_KEY is set \u2014 requests are billed per token"
    };
  }
  for (const candidate of await candidates()) {
    if (!await exists2(candidate)) continue;
    const status = await authStatus(candidate);
    if (!status) continue;
    let version = null;
    try {
      version = (await exec3(candidate, ["--version"], { timeout: 1e4 })).stdout.trim();
    } catch {
    }
    if (!status.loggedIn) {
      return {
        ...unusable(`not signed in \u2014 run: "${candidate}" auth login`),
        path: candidate,
        version
      };
    }
    if (!status.subscriptionType) {
      return {
        path: candidate,
        version,
        loggedIn: true,
        email: status.email ?? null,
        authMethod: status.authMethod ?? null,
        subscriptionType: null,
        usable: false,
        detail: `signed in as ${status.email ?? "unknown"} but no plan is attached (subscriptionType: null), so requests bill against API credits. Attach a Claude plan to this account, sign in with one that has it ("${candidate}" auth login), or set ANTHROPIC_API_KEY to pay per token.`
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
      detail: `${status.subscriptionType} plan, signed in as ${status.email ?? "unknown"}`
    };
  }
  return unusable(
    "no Claude Code install found \u2014 install the Claude desktop app or the claude CLI, or set ANTHROPIC_API_KEY"
  );
}

// src/core/fixture.ts
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var USER_1 = `average() is returning NaN somewhere in the report pipeline. is that our bug or the caller's?`;
var REPLY_1 = `Ours. \`average([])\` computes \`0 / 0\`, which is \`NaN\` \u2014 it never throws, so the
bad input propagates silently until something downstream formats it.

\`divide\` has the same shape: \`divide(1, 0)\` returns \`Infinity\` rather than rejecting.
README.md says bad input should throw \`TypeError\`, so neither function currently follows the
convention the repo states.

Worth deciding: do you want them to throw, or to return a sentinel the caller checks? Throwing
matches the README, but it will surface as an exception in the report pipeline rather than a
\`NaN\` \u2014 that is a behaviour change for whatever calls it today.`;
var USER_2 = `throw. the NaN is exactly the problem \u2014 I want it loud.`;
var REPLY_2 = `Agreed, and it is the smaller change. Both guards go at the top of their
function, before any arithmetic, and both throw \`TypeError\` naming the offending argument.

One thing to watch: \`average\` currently divides inline rather than calling \`divide\`, so
guarding \`divide\` alone would not cover it.`;
var PLAN = `I'll add input guards to both functions, following the TypeError convention the README states.

**calc.js**
1. \`divide(a, b)\` \u2014 throw \`TypeError\` when \`b === 0\`, before the division.
2. \`average(numbers)\` \u2014 throw \`TypeError\` on an empty array, since \`0/0\` would otherwise
   return \`NaN\` and silently propagate.

No new files, no dependencies. \`average\` already routes through \`divide\`, so the zero-divisor
guard covers it once the empty-array case is handled explicitly.`;
var PLAN_REVIEW = {
  verdict: "approve",
  summary: "The approach matches the repository's stated TypeError convention and covers both failure modes named in the task.",
  findings: []
};
var DIFF_REVIEW_1 = {
  verdict: "request_changes",
  summary: "The divide guard is correct, but average still does not reject an empty array according to the repository's TypeError convention.",
  findings: [
    {
      severity: "major",
      file: "calc.js",
      line: 11,
      issue: "average([]) returns NaN instead of rejecting the empty array with a TypeError.",
      evidence: "With numbers.length equal to 0, line 11 evaluates 0 / 0, which produces NaN; README.md says bad input must throw TypeError.",
      suggestion: "Add an explicit empty-array check in average() that throws TypeError before calculating the result."
    }
  ]
};
var DIFF_REVIEW_2 = {
  verdict: "approve",
  summary: "Both guards are now present and consistent with the README convention. Messages name the function and the offending argument.",
  findings: []
};
var BUILDER_ROUND_1 = `Added the zero-divisor guard to \`divide\`. \`average\` now delegates its
division, so the guard applies transitively.`;
var BUILDER_ROUND_2 = `You're right \u2014 the transitive argument doesn't hold: \`average\` computed
\`total / numbers.length\` directly rather than calling \`divide\`. Added an explicit empty-array
check that throws \`TypeError\` before the division.`;
function stream(text) {
  const words = text.match(/\S+\s*/g) ?? [];
  const steps = [];
  for (let i = 0; i < words.length; i += 3) {
    steps.push({
      event: { type: "builder.text", text: words.slice(i, i + 3).join("") },
      after: 45
    });
  }
  return steps;
}
async function replayFixture(emit) {
  const steps = [
    // --- conversation: read-only, no gatekeeper, no decision made yet ------------------
    { event: { type: "user.message", text: USER_1 }, after: 500 },
    { event: { type: "phase", phase: "chatting", round: 1 }, after: 400 },
    { event: { type: "builder.tool", name: "Read", input: { file_path: "calc.js" } }, after: 350 },
    ...stream(REPLY_1),
    { event: { type: "user.message", text: USER_2 }, after: 1100 },
    { event: { type: "phase", phase: "chatting", round: 1 }, after: 400 },
    ...stream(REPLY_2),
    // --- the engineer presses "Build this". Only now does anything happen. ------------
    { event: { type: "snapshot", ref: "5365c7fc9a1b4e2d", label: "build-start" }, after: 900 },
    { event: { type: "phase", phase: "planning", round: 1 }, after: 500 },
    { event: { type: "builder.tool", name: "Read", input: { file_path: "README.md" } }, after: 350 },
    ...stream(PLAN),
    { event: { type: "phase", phase: "plan_review", round: 1 }, after: 600 },
    { event: { type: "gatekeeper.item", kind: "command", text: "sed -n '1,240p' README.md" }, after: 500 },
    { event: { type: "gatekeeper.item", kind: "command", text: "nl -ba calc.js" }, after: 700 },
    { event: { type: "review", phase: "plan_review", review: PLAN_REVIEW }, after: 900 },
    { event: { type: "phase", phase: "implementing", round: 1 }, after: 500 },
    { event: { type: "builder.tool", name: "Edit", input: { file_path: "calc.js" } }, after: 400 },
    {
      event: {
        type: "builder.permission",
        name: "Bash",
        decision: "deny",
        reason: "`git add` changes git state. CodeArena owns the repository's git state: it snapshots your work to produce the review diff and to roll back if the review fails, and a commit, reset or checkout mid-task invalidates that baseline. Edit files; leave git to CodeArena. (git status/diff/log/show are available.)"
      },
      after: 700
    },
    ...stream(BUILDER_ROUND_1),
    { event: { type: "snapshot", ref: "a71c3f80d5e6b912", label: "round-1" }, after: 300 },
    { event: { type: "phase", phase: "diff_review", round: 1 }, after: 600 },
    { event: { type: "gatekeeper.item", kind: "command", text: "nl -ba calc.js" }, after: 600 },
    { event: { type: "gatekeeper.item", kind: "command", text: "git diff --check" }, after: 600 },
    { event: { type: "review", phase: "diff_review", review: DIFF_REVIEW_1 }, after: 1400 },
    { event: { type: "phase", phase: "implementing", round: 2 }, after: 500 },
    { event: { type: "builder.tool", name: "Edit", input: { file_path: "calc.js" } }, after: 500 },
    ...stream(BUILDER_ROUND_2),
    { event: { type: "snapshot", ref: "c92d5a17f3b8e045", label: "round-2" }, after: 300 },
    { event: { type: "phase", phase: "diff_review", round: 2 }, after: 600 },
    { event: { type: "gatekeeper.item", kind: "command", text: "sed -n '1,40p' calc.js" }, after: 700 },
    { event: { type: "review", phase: "diff_review", review: DIFF_REVIEW_2 }, after: 900 },
    { event: { type: "phase", phase: "approved", round: 2 }, after: 200 },
    {
      event: {
        type: "cost",
        cost: {
          builderUsd: 0.2143,
          gatekeeperInputTokens: 24518,
          gatekeeperCachedInputTokens: 18944,
          gatekeeperOutputTokens: 1876
        }
      },
      after: 200
    },
    {
      event: {
        type: "done",
        result: {
          phase: "approved",
          plan: PLAN,
          rounds: [
            { round: 1, phase: "plan_review", review: PLAN_REVIEW },
            { round: 1, phase: "diff_review", review: DIFF_REVIEW_1 },
            { round: 2, phase: "diff_review", review: DIFF_REVIEW_2 }
          ],
          diff: DEMO_DIFF,
          cost: {
            builderUsd: 0.2143,
            gatekeeperInputTokens: 24518,
            gatekeeperCachedInputTokens: 18944,
            gatekeeperOutputTokens: 1876
          }
        }
      },
      after: 0
    }
  ];
  for (const step of steps) {
    emit(step.event);
    if (step.after) await sleep(step.after);
  }
}
var DEMO_DIFF = `diff --git a/calc.js b/calc.js
--- a/calc.js
+++ b/calc.js
@@ -1,10 +1,16 @@
 export function divide(a, b) {
+  if (b === 0) {
+    throw new TypeError("divide: divisor must not be zero");
+  }
   return a / b;
 }

 export function average(numbers) {
+  if (numbers.length === 0) {
+    throw new TypeError("average: numbers must not be empty");
+  }
   let total = 0;
   for (const n of numbers) total += n;
-  return total / numbers.length;
+  return divide(total, numbers.length);
 }
`;

// electron/main.ts
import { execFile as execFile4 } from "node:child_process";
import { promisify as promisify4 } from "node:util";
var exec4 = promisify4(execFile4);
var dirname = path4.dirname(fileURLToPath(import.meta.url));
var win = null;
var running = false;
var session = null;
var projectOfSession = "";
function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0b0d10",
    webPreferences: {
      preload: path4.join(dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path4.join(dirname, "../dist-renderer/index.html"));
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
ipcMain.handle("arena:doctor", async (_e, projectDir) => {
  const report = {
    builder: { ok: false, detail: "" },
    gatekeeper: { ok: false, detail: "" },
    project: { ok: false, detail: "" }
  };
  const claude = await resolveClaude();
  report.builder = { ok: claude.usable, detail: claude.detail };
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
      version: codex.version
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
ipcMain.handle("arena:pickProject", async () => {
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openDirectory"],
    message: "Choose the repository the agents will work in"
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
});
function ensureProject(projectDir) {
  if (projectOfSession !== projectDir) {
    session = null;
    projectOfSession = projectDir;
  }
}
async function configFor(opts, codexPath) {
  const claude = await resolveClaude();
  return {
    projectDir: opts.projectDir,
    maxRounds: opts.maxRounds,
    skipPlanReview: opts.skipPlanReview,
    codexPath,
    ...claude.path ? { claudePath: claude.path } : {}
  };
}
ipcMain.handle(
  "arena:chat",
  async (event, opts) => {
    if (running) return { started: false, reason: "Still working on the previous turn." };
    ensureProject(opts.projectDir);
    const send = (e) => event.sender.send("arena:event", e);
    const codex = await resolveCodex();
    running = true;
    void runChat(opts.message, await configFor(opts, codex?.path ?? ""), send, session).then((next) => {
      session = next;
    }).finally(() => {
      running = false;
      event.sender.send("arena:idle", true);
    });
    return { started: true };
  }
);
ipcMain.handle(
  "arena:build",
  async (event, opts) => {
    if (running) return { started: false, reason: "Still working on the previous turn." };
    const send = (e) => event.sender.send("arena:event", e);
    if (opts.demo) {
      running = true;
      void replayFixture(send).catch((e) => send({ type: "log", level: "error", message: String(e) })).finally(() => {
        running = false;
        event.sender.send("arena:idle", true);
      });
      return { started: true };
    }
    ensureProject(opts.projectDir);
    const codex = await resolveCodex();
    if (!codex?.loggedIn) {
      return { started: false, reason: "Gatekeeper unavailable \u2014 check Setup." };
    }
    running = true;
    void runBuild(await configFor(opts, codex.path), send, session, opts.instruction).then((outcome) => {
      session = outcome.sessionId;
    }).catch(
      (e) => send({ type: "log", level: "error", message: String(e?.message ?? e) })
    ).finally(() => {
      running = false;
      event.sender.send("arena:idle", true);
    });
    return { started: true };
  }
);
ipcMain.handle("arena:reset", async () => {
  session = null;
});
ipcMain.handle("arena:revealDiff", async (_e, projectDir) => {
  shell.openPath(projectDir);
});
