/**
 * Snapshot / diff / rollback for the builder's working tree.
 *
 * Design constraint: the builder edits the user's real working tree, so CodeArena must be
 * able to hand the gatekeeper an exact diff and put the tree back if the loop goes wrong --
 * without touching the user's branches, HEAD, commit history, or index.
 *
 * The trick is an alternate index file (GIT_INDEX_FILE). We stage everything into a
 * throwaway index, write a tree object from it, and wrap that in a dangling commit anchored
 * by a ref under refs/codearena/ so git never garbage-collects it mid-task.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";

const exec = promisify(execFile);

export class Git {
  constructor(private readonly dir: string) {}

  private async run(args: string[], env: Record<string, string> = {}): Promise<string> {
    const { stdout } = await exec("git", args, {
      cwd: this.dir,
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }

  async isRepo(): Promise<boolean> {
    try {
      const out = await this.run(["rev-parse", "--is-inside-work-tree"]);
      return out.trim() === "true";
    } catch {
      return false;
    }
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
    const out = await this.run(["status", "--porcelain"]);
    return out.trim().length > 0;
  }

  /** Branch name, or "<name> (no commits yet)" on a freshly-initialised repo. */
  async currentBranch(): Promise<string> {
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
  async snapshot(label: string): Promise<string> {
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

      // Anchor it so gc can't reap it while the task is running.
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
   * Put the working tree back to a snapshot.
   *
   * `read-tree -u --reset` restores tracked content but leaves files created after the
   * snapshot in place, so we remove those explicitly using the diff as the source of truth.
   */
  async restore(snapshot: string): Promise<void> {
    const head = await this.snapshot("pre-restore");
    const added = (await this.run(["diff", "--name-only", "--diff-filter=A", snapshot, head]))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    await this.run(["read-tree", "-u", "--reset", snapshot]);
    for (const file of added) {
      await fs.rm(path.join(this.dir, file), { force: true });
    }
  }

  /** Drop the refs we created. Call when a task ends; the objects then gc normally. */
  async cleanupRefs(): Promise<void> {
    const out = await this.run(["for-each-ref", "--format=%(refname)", "refs/codearena/"]);
    for (const ref of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
      await this.run(["update-ref", "-d", ref]);
    }
  }
}
