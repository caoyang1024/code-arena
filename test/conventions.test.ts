/** Scope resolution for the project's own rules. Offline. */
import { collect, render } from "../src/core/conventions.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-conv-"));
const write = (p: string, body: string) => {
  fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
  fs.writeFileSync(path.join(dir, p), body);
};

let passed = 0, failed = 0;
const a = (cond: boolean, msg: string) => {
  cond ? passed++ : failed++;
  console.log(`  ${cond ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${msg}`);
};

write("AGENTS.md", "Root rule: every behaviour change updates the README contract section.");
write("src/api/AGENTS.md", "API rule: every endpoint change needs a contract test.");
write("src/ui/CLAUDE.md", "UI rule: no inline styles.");

console.log("\nconventions: scope follows the directory tree");
{
  const found = await collect(dir, ["src/api/users.ts"]);
  a(found.length === 2, "root + the nearest governing file, and nothing else");
  a(found[0]!.path === "AGENTS.md", "root comes first (least specific first)");
  a(found[1]!.path === "src/api/AGENTS.md", "the subtree's own file follows it");
  a(!found.some((f) => f.path.includes("ui")), "an unrelated subtree's file is not included");
}
{
  const found = await collect(dir, ["src/ui/Button.tsx"]);
  a(found.some((f) => f.path === "src/ui/CLAUDE.md"), "CLAUDE.md counts when no AGENTS.md sits beside it");
}
{
  const found = await collect(dir, []);
  a(found.length === 1 && found[0]!.path === "AGENTS.md", "with no files changed, only the root applies");
}
{
  const found = await collect(dir, ["src/api/a.ts", "src/ui/b.tsx"]);
  a(found.length === 3, "a change spanning subtrees collects both of their files");
  const text = render(found);
  a(text.includes("governs the whole repository"), "the root's scope is labelled");
  a(text.includes("governs src/api/"), "a subtree's scope is labelled");
}
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "arena-conv-none-"));
  a(render(await collect(empty, ["a.ts"])) === "", "a project that states no rules renders nothing");
  fs.rmSync(empty, { recursive: true, force: true });
}

console.log("\nconventions: the working method section");
{
  const { section } = await import("../src/core/conventions.js");
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "arena-sect-"));
  const w = (p: string, body: string) => {
    fs.mkdirSync(path.join(d2, path.dirname(p)), { recursive: true });
    fs.writeFileSync(path.join(d2, p), body);
  };
  w("AGENTS.md", [
    "# proj", "",
    "## Conventions", "- always test", "",
    "## Working method", "Talk first. Build only when told.", "More method.", "",
    "## Other", "not this",
  ].join("\n"));
  w("src/AGENTS.md", ["## Working method", "The src subtree overrides it."].join("\n"));

  const rootOnly = section(await collect(d2, []), "Working method");
  a(rootOnly === "Talk first. Build only when told.\nMore method.", "extracts the section and stops at the next heading");
  a(!rootOnly.includes("always test"), "does not bleed in from a sibling section");

  const nested = section(await collect(d2, ["src/a.ts"]), "Working method");
  a(nested === "The src subtree overrides it.", "a nested file's version wins");

  a(section(await collect(d2, []), "Nonexistent") === "", "a missing section is empty, not an error");
  fs.rmSync(d2, { recursive: true, force: true });
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
