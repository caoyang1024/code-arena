/**
 * The project's own rules, delivered to the reviewer rather than left to be discovered.
 *
 * `AGENTS.md` is the one convention file both models read: Claude Code hardcodes CLAUDE.md
 * and AGENTS.md discovery, while codex knows only AGENTS.md -- the string CLAUDE.md does not
 * appear in its binary at all. So rules written in CLAUDE.md are visible to the builder and
 * invisible to the gatekeeper, which is the one asymmetry this product must not have: the
 * reviewer would be judging against a standard it cannot see.
 *
 * Even with the right filename, relying on the reviewer to go and look is relying on luck. In
 * an early run it did quote README.md as the contract, but because it chose to, not because
 * anything guaranteed it. So CodeArena reads the files itself and puts them in the prompt.
 *
 * Scope follows the rule codex documents for itself, so the two agree about which file
 * governs which code:
 *
 *   - A file's scope is the entire directory tree rooted at the folder containing it.
 *   - More deeply nested files take precedence where they conflict.
 *
 * No new format is invented. Whatever the project writes is what the reviewer is asked to
 * check the change against.
 */
import path from "node:path";
import fs from "node:fs/promises";

/** Filenames treated as conventions, in the order they are looked for in a directory. */
const NAMES = ["AGENTS.md", "CLAUDE.md"];

/** Never read more than this from any one file; conventions are not a whole handbook. */
const MAX_FILE_CHARS = 8_000;
/** Total budget across every file collected. */
const MAX_TOTAL_CHARS = 20_000;

export interface Convention {
  /** Repo-relative path of the file, e.g. "src/api/AGENTS.md". */
  path: string;
  /** Repo-relative directory it governs. "" for the root. */
  scope: string;
  text: string;
}

async function readIfPresent(dir: string): Promise<{ name: string; text: string } | null> {
  for (const name of NAMES) {
    try {
      const text = await fs.readFile(path.join(dir, name), "utf8");
      if (text.trim()) return { name, text: text.trim().slice(0, MAX_FILE_CHARS) };
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * Collect the conventions governing a set of changed files.
 *
 * Walks from the repository root down to each file's directory, so a rule at the root applies
 * everywhere and a rule beside the code applies to that subtree. Ordered root-first, which is
 * also least-specific-first: a reviewer reading in order sees the general rule before the
 * local one that narrows it.
 */
export async function collect(root: string, changedFiles: string[]): Promise<Convention[]> {
  const dirs = new Set<string>([""]);

  for (const file of changedFiles) {
    const parts = path.dirname(file).split("/").filter((p) => p && p !== ".");
    for (let i = 0; i < parts.length; i++) {
      dirs.add(parts.slice(0, i + 1).join("/"));
    }
  }

  const found: Convention[] = [];
  let budget = MAX_TOTAL_CHARS;

  for (const scope of [...dirs].sort((a, b) => a.split("/").length - b.split("/").length)) {
    if (budget <= 0) break;
    const hit = await readIfPresent(path.join(root, scope));
    if (!hit) continue;
    const text = hit.text.slice(0, budget);
    budget -= text.length;
    found.push({ path: scope ? `${scope}/${hit.name}` : hit.name, scope, text });
  }

  return found;
}

/**
 * Pull one `## Heading` section out of the collected conventions.
 *
 * The working method -- what happens at each stage and what each model is told there -- is
 * mostly the prompts, so making it editable does not need a stage interpreter, only a place
 * for a project to say what it wants said. A section of a file the models already read is
 * that place; a new config format would be a new thing to learn for no more expressiveness.
 *
 * Later files win, matching the scope rule: a subtree can restate the method for its own code.
 */
export function section(conventions: Convention[], heading: string): string {
  const wanted = heading.trim().toLowerCase();
  let found = "";

  for (const c of conventions) {
    const lines = c.text.split("\n");
    let capturing = false;
    const body: string[] = [];

    for (const line of lines) {
      const match = /^(#{1,6})\s+(.*)$/.exec(line);
      if (match) {
        const isWanted = match[2]!.trim().toLowerCase() === wanted;
        if (capturing && !isWanted) break; // the next heading of any depth ends the section
        capturing = isWanted;
        continue;
      }
      if (capturing) body.push(line);
    }

    const text = body.join("\n").trim();
    if (text) found = text;
  }

  return found;
}

/** Render for a prompt, or "" when the project states no conventions. */
export function render(conventions: Convention[]): string {
  if (conventions.length === 0) return "";
  return conventions
    .map((c) =>
      [
        `### ${c.path}${c.scope ? ` — governs ${c.scope}/` : " — governs the whole repository"}`,
        c.text,
      ].join("\n"),
    )
    .join("\n\n");
}
