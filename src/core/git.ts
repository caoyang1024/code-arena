/**
 * Snapshot / diff / rollback for the builder's working tree.
 *
 * Design constraint: the builder edits the user's real working tree, so CodeArena must be able
 * to hand the gatekeeper an exact diff and put the tree back if the loop goes wrong -- without
 * touching the user's branches, HEAD, commit history, or index.
 *
 * The mechanism is an alternate index file (GIT_INDEX_FILE). We stage everything into a
 * throwaway index, write a tree object from it, and wrap that in a dangling commit anchored by
 * a ref under refs/codearena/ so git cannot garbage-collect it mid-task.
 *
 * Two things this file learned the hard way:
 *
 *   - **Everything runs at the repository top level, not at the directory the user chose.**
 *     `rev-parse --is-inside-work-tree` is true in any subdirectory, and the Electron folder
 *     picker makes choosing one a single click. Staging with `add -A .` from a subdirectory
 *     stages only that subtree, so a change elsewhere in the repo vanishes from the diff --
 *     and the gatekeeper reviews an incomplete change while believing it saw everything. That
 *     is worse than the crash it was hiding behind.
 *
 *   - **The index file lives in the temp directory, not `<dir>/.git/`.** That path does not
 *     exist in a subdirectory, and in a worktree or submodule `.git` is a *file*, so joining
 *     onto it yields ENOTDIR. GIT_INDEX_FILE has no requirement to live inside the repository.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

const exec = promisify(execFile);

/** Distinguishes concurrent index files within a process, not just between processes. */
let indexCounter = 0;

export class Git {
  /** Repository top level. Resolved on first use; every git call below runs here. */
  private topLevel: string | null = null;

  constructor(private readonly dir: string) {}

  private async run(args: string[], env: Record<string, string> = {}): Promise<string> {
    const { stdout } = await exec("git", args, {
      cwd: (await this.root()) ?? this.dir,
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }

  /** Raw call that does not resolve the top level -- used by the resolution itself. */
  private async runHere(args: string[]): Promise<string> {
    const { stdout } = await exec("git", args, { cwd: this.dir, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  }

  /** The repository top level, or null when `dir` is not in a repository. */
  async root(): Promise<string | null> {
    if (this.topLevel !== null) return this.topLevel;
    try {
      this.topLevel = (await this.runHere(["rev-parse", "--show-toplevel"])).trim();
      return this.topLevel;
    } catch {
      return null;
    }
  }

  async isRepo(): Promise<boolean> {
    return (await this.root()) !== null;
  }

  async hasCommits(): Promise<boolean> {
    try {
      await this.run(["rev-parse", "--verify", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  /** Anything uncommitted (tracked or not) sitting in the tree before we start. */
  async isDirty(): Promise<boolean> {
    return (await this.run(["status", "--porcelain"])).trim().length > 0;
  }

  /** Branch name, or "<name> (no commits yet)" on a freshly-initialised repo. */
  async currentBranch(): Promise<string> {
    if (await this.hasCommits()) {
      return (await this.run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    }
    const head = (await this.run(["symbolic-ref", "--short", "HEAD"])).trim();
    return `${head} (no commits yet)`;
  }

  /** A scratch index path that cannot collide, inside or across processes. */
  private scratchIndex(): string {
    return path.join(os.tmpdir(), `codearena-index-${process.pid}-${indexCounter++}`);
  }

  /**
   * Capture the full working tree (including untracked files, minus .gitignore'd ones) as a
   * dangling commit. Returns its sha.
   */
  async snapshot(label: string): Promise<string> {
    const indexFile = this.scratchIndex();
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      if (await this.hasCommits()) {
        await this.run(["read-tree", "HEAD"], env);
      } else {
        await this.run(["read-tree", "--empty"], env);
      }
      // `:/` is the repository root regardless of cwd -- belt and braces alongside running
      // at the top level.
      await this.run(["add", "-A", ":/"], env);
      const tree = (await this.run(["write-tree"], env)).trim();

      const parentArgs: string[] = [];
      if (await this.hasCommits()) {
        parentArgs.push("-p", (await this.run(["rev-parse", "HEAD"])).trim());
      }
      const commit = (
        await this.run(["commit-tree", tree, ...parentArgs, "-m", `codearena snapshot: ${label}`], {
          ...env,
          GIT_AUTHOR_NAME: "CodeArena",
          GIT_AUTHOR_EMAIL: "codearena@localhost",
          GIT_COMMITTER_NAME: "CodeArena",
          GIT_COMMITTER_EMAIL: "codearena@localhost",
        })
      ).trim();

      await this.run(["update-ref", `refs/codearena/${commit}`, commit]);
      return commit;
    } finally {
      await fs.rm(indexFile, { force: true });
    }
  }

  /** Unified diff between two snapshots. */
  async diff(from: string, to: string): Promise<string> {
    return this.run(["diff", "--no-color", "--find-renames", from, to]);
  }

  /** Files touched between two snapshots, as repo-relative paths. */
  async changedFiles(from: string, to: string): Promise<string[]> {
    const out = await this.run(["diff", "--name-only", from, to]);
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  /**
   * Put the working tree back to a snapshot, leaving the user's index as they left it.
   *
   * `read-tree -u --reset` against the real index would restore the tree and silently stage
   * everything it touched: a file the user had left unstaged came back as staged. The README
   * promises the index is untouched, and rollback was the one path that broke it. Running it
   * against a scratch index updates the working tree and leaves the real one alone.
   *
   * Files created after the snapshot are removed explicitly -- `--reset` restores tracked
   * content but does not delete what the snapshot never knew about.
   *
   * Returns the snapshot taken immediately before the restore, so discarding an agent's work
   * is itself undoable. Throwing away several rounds of edits on one click, with no way back,
   * would be a worse failure than the one it is undoing.
   */
  async restore(snapshot: string): Promise<string> {
    const current = await this.snapshot("pre-restore");
    const added = (await this.run(["diff", "--name-only", "--diff-filter=A", snapshot, current]))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const indexFile = this.scratchIndex();
    try {
      await this.run(["read-tree", "-u", "--reset", snapshot], { GIT_INDEX_FILE: indexFile });
    } finally {
      await fs.rm(indexFile, { force: true });
    }

    const root = (await this.root()) ?? this.dir;
    for (const file of added) {
      await fs.rm(path.join(root, file), { force: true });
    }

    return current;
  }

  /** Refs we have created in this repository. */
  async listRefs(): Promise<string[]> {
    const out = await this.run(["for-each-ref", "--format=%(refname)", "refs/codearena/"]);
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  /**
   * Drop our refs, keeping the ones named.
   *
   * Each ref pins an entire working tree, and every snapshot created one -- so an unbounded
   * pile of unreclaimable objects accumulated in the user's repository, one baseline plus one
   * per round per build, forever. For a tool whose pitch is that it never touches your git,
   * leaving that behind is not a small thing.
   *
   * The most recent baseline is kept so a rollback remains possible; everything older goes.
   */
  async pruneRefs(keep: string[] = []): Promise<void> {
    const keepRefs = new Set(keep.map((sha) => `refs/codearena/${sha}`));
    for (const ref of await this.listRefs()) {
      if (keepRefs.has(ref)) continue;
      await this.run(["update-ref", "-d", ref]);
    }
  }

  /** Drop every ref we created. */
  async cleanupRefs(): Promise<void> {
    await this.pruneRefs([]);
  }
}
