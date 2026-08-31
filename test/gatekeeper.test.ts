/**
 * Live check of the gatekeeper half: does Codex actually return a schema-conforming verdict,
 * and does it catch a defect that is only visible if it reads the file rather than the diff?
 */
import { Gatekeeper } from "../src/core/gatekeeper.js";
import { Git } from "../src/core/git.js";
import { resolveCodex } from "../src/core/codex-path.js";
import type { ArenaEvent } from "../src/core/types.js";

const projectDir = process.argv[2]!;
const codex = await resolveCodex();
if (!codex) throw new Error("no signed codex found");

const git = new Git(projectDir);
const head = (await import("node:child_process")).execFileSync(
  "git", ["rev-parse", "HEAD"], { cwd: projectDir }).toString().trim();
const now = await git.snapshot("test");
const diff = await git.diff(head, now);
const files = await git.changedFiles(head, now);

const emit = (e: ArenaEvent) => {
  if (e.type === "gatekeeper.item" && e.kind === "command") console.log(`  · ran: ${e.text.slice(0, 90)}`);
};

const gate = new Gatekeeper({ projectDir, maxRounds: 2, codexPath: codex.path });
const review = await gate.reviewDiff(
  "Make divide and average reject bad input: divide should throw on a zero divisor, and average should handle an empty array. Follow the conventions in README.md.",
  "Add a zero-divisor guard to divide(); make average() handle an empty array.",
  diff, files, emit,
);

console.log("\n--- VERDICT ---");
console.log(JSON.stringify(review, null, 2));
console.log("\n--- ASSERTIONS ---");
const a = (c: boolean, m: string) => console.log(`${c ? "✓" : "✗ FAIL"} ${m}`);
a(review.verdict === "request_changes", "caught that the work is incomplete (average is unguarded)");
a(review.findings.length > 0, "returned at least one itemised finding");
a(review.findings.every(f => ["blocker","major","minor"].includes(f.severity)), "every severity is in-enum");
a(review.findings.every(f => typeof f.evidence === "string" && f.evidence.length > 0), "every finding carries evidence");
a(review.findings.some(f => (f.file ?? "").includes("calc.js")), "a finding is anchored to calc.js");
await git.cleanupRefs();
