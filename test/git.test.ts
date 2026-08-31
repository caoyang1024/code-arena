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
