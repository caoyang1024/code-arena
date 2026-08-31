import { Git } from "../src/core/git.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-git-"));
const sh = (c: string) => execFileSync("bash", ["-c", c], { cwd: dir }).toString();

sh("git init -q && git config user.email t@t && git config user.name T");
fs.writeFileSync(path.join(dir, "a.txt"), "original\n");
sh("git add -A && git commit -qm init");
fs.writeFileSync(path.join(dir, "dirty.txt"), "pre-existing uncommitted\n");

const git = new Git(dir);
const assert = (cond: boolean, msg: string) => console.log(`${cond ? "✓" : "✗ FAIL"} ${msg}`);

const baseline = await git.snapshot("task-start");
assert(/^[0-9a-f]{40}$/.test(baseline), "snapshot returns a commit sha");

// simulate the builder: modify, create, delete
fs.writeFileSync(path.join(dir, "a.txt"), "modified by builder\n");
fs.writeFileSync(path.join(dir, "new.txt"), "created by builder\n");
fs.mkdirSync(path.join(dir, "sub"));
fs.writeFileSync(path.join(dir, "sub/deep.txt"), "nested\n");

const after = await git.snapshot("round-1");
const diff = await git.diff(baseline, after);
const files = await git.changedFiles(baseline, after);

assert(diff.includes("modified by builder"), "diff captures modified tracked file");
assert(diff.includes("created by builder"), "diff captures newly created untracked file");
assert(files.includes("sub/deep.txt"), "changedFiles sees nested new file");
assert(!diff.includes("pre-existing uncommitted"), "pre-existing dirty file is NOT attributed to the builder");

// user's own git state must be untouched
assert(sh("git rev-parse --abbrev-ref HEAD").trim() === "main" || sh("git rev-parse --abbrev-ref HEAD").trim() === "master", "HEAD/branch unchanged");
assert(sh("git log --oneline").trim().split("\n").length === 1, "no commits added to user history");
assert(sh("git status --porcelain").includes("new.txt"), "user index untouched (new.txt still untracked)");

// rollback
await git.restore(baseline);
assert(fs.readFileSync(path.join(dir, "a.txt"), "utf8") === "original\n", "restore reverts modified file");
assert(!fs.existsSync(path.join(dir, "new.txt")), "restore removes builder-created file");
assert(!fs.existsSync(path.join(dir, "sub/deep.txt")), "restore removes nested builder-created file");
assert(fs.readFileSync(path.join(dir, "dirty.txt"), "utf8") === "pre-existing uncommitted\n", "restore preserves the user's pre-existing uncommitted work");

await git.cleanupRefs();
assert(sh("git for-each-ref refs/codearena/").trim() === "", "cleanupRefs removes all arena refs");

fs.rmSync(dir, { recursive: true, force: true });

// ---------------------------------------------------------------------------------------
// Regressions found by pointing CodeArena at its own source.

console.log("\nsubdirectories and worktrees");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "arena-sub-"));
  const run = (c: string, cwd = repo) => execFileSync("bash", ["-c", c], { cwd }).toString();
  run("git init -q && git config user.email t@t && git config user.name T");
  fs.mkdirSync(path.join(repo, "pkg/app"), { recursive: true });
  fs.writeFileSync(path.join(repo, "root.txt"), "root\n");
  fs.writeFileSync(path.join(repo, "pkg/app/a.txt"), "app\n");
  run("git add -A && git commit -qm init");

  // The Electron folder picker makes choosing a subdirectory one click.
  const sub = new Git(path.join(repo, "pkg/app"));
  assert(await sub.isRepo(), "a subdirectory is recognised as a repo");

  const base = await sub.snapshot("from-subdir");
  assert(/^[0-9a-f]{40}$/.test(base), "snapshot works from a subdirectory (used to ENOENT)");

  fs.writeFileSync(path.join(repo, "root.txt"), "root changed\n");
  fs.writeFileSync(path.join(repo, "pkg/app/a.txt"), "app changed\n");
  const after = await sub.snapshot("after");
  const files = await sub.changedFiles(base, after);

  assert(files.includes("pkg/app/a.txt"), "sees changes in the chosen subdirectory");
  assert(files.includes("root.txt"), "sees changes ELSEWHERE in the repo, not just the subtree");

  await sub.cleanupRefs();
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log("\nrestore leaves the user's index alone");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "arena-idx-"));
  const run = (c: string) => execFileSync("bash", ["-c", c], { cwd: repo }).toString();
  run("git init -q && git config user.email t@t && git config user.name T");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  run("git add -A && git commit -qm init");

  const g = new Git(repo);
  fs.writeFileSync(path.join(repo, "user_unstaged.txt"), "the user's own work\n");
  const base = await g.snapshot("base");

  fs.writeFileSync(path.join(repo, "a.txt"), "changed by builder\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "created by builder\n");

  await g.restore(base);

  const status = run("git status --porcelain");
  assert(status.includes("?? user_unstaged.txt"), "the user's untracked file is still UNTRACKED after restore");
  assert(!/^A /m.test(status), "restore staged nothing (it used to stage everything it touched)");
  assert(fs.readFileSync(path.join(repo, "a.txt"), "utf8") === "one\n", "restore reverted the builder's edit");
  assert(!fs.existsSync(path.join(repo, "new.txt")), "restore removed the builder's new file");

  await g.cleanupRefs();
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log("\nrefs do not accumulate");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "arena-refs-"));
  const run = (c: string) => execFileSync("bash", ["-c", c], { cwd: repo }).toString();
  run("git init -q && git config user.email t@t && git config user.name T");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  run("git add -A && git commit -qm init");

  const g = new Git(repo);
  const first = await g.snapshot("build-1-baseline");
  fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
  await g.snapshot("build-1-round-1");
  fs.writeFileSync(path.join(repo, "a.txt"), "three\n");
  const latest = await g.snapshot("build-2-baseline");

  assert((await g.listRefs()).length === 3, "three snapshots left three refs");
  await g.pruneRefs([latest]);
  const kept = await g.listRefs();
  assert(kept.length === 1, "pruning leaves exactly one ref");
  assert(kept[0]!.endsWith(latest), "the ref kept is the one asked for");
  assert(first !== latest, "sanity: the pruned refs were different commits");

  await g.cleanupRefs();
  assert((await g.listRefs()).length === 0, "cleanupRefs removes the rest");
  fs.rmSync(repo, { recursive: true, force: true });
}
