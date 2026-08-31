/**
 * Preflight. Run this before anything else -- it answers "can this machine actually run a
 * dual-model task", which is the question that costs the most time to debug later.
 */
import { resolveCodex, probe } from "../core/codex-path.js";
import { resolveClaude } from "../core/claude-path.js";
import { Git } from "../core/git.js";

const ok = (s: string) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s: string) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (s: string) => `\x1b[33m!\x1b[0m ${s}`;

async function main() {
  const projectDir = process.argv[2] ?? process.cwd();
  console.log(`\nCodeArena doctor -- project: ${projectDir}\n`);

  let fatal = false;

  // --- builder side -----------------------------------------------------------------
  const claude = await resolveClaude();
  const line = `Claude (builder): ${claude.detail}`;
  console.log(claude.usable ? ok(line) : bad(line));
  if (claude.path) console.log(`    path: ${claude.path}${claude.version ? ` (${claude.version})` : ""}`);
  if (!claude.usable) fatal = true;

  // --- gatekeeper side --------------------------------------------------------------
  const codex = await resolveCodex();
  if (!codex) {
    console.log(bad("Codex (gatekeeper): no code-signed codex binary found"));
    console.log(
      "    Install the ChatGPT desktop app (it ships a signed codex CLI), or point\n" +
        "    CODEARENA_CODEX_PATH at a codex binary signed by OpenAI.",
    );
    fatal = true;
  } else {
    console.log(ok(`Codex (gatekeeper): ${codex.version}`));
    console.log(`    path: ${codex.path}`);
    console.log(`    signature: ${codex.authority ?? "unsigned"}`);
    console.log(
      codex.loggedIn
        ? `    ${ok(`auth: ${codex.loginDetail}`)}`
        : `    ${bad(`auth: ${codex.loginDetail} -- run \`${codex.path} login\``)}`,
    );
    if (!codex.loggedIn) fatal = true;
  }

  // --- the vendored binary we refuse to use -----------------------------------------
  const vendored = await probe(
    new URL(
      "../../node_modules/@openai/codex-sdk/vendor/aarch64-apple-darwin/codex/codex",
      import.meta.url,
    ).pathname,
  );
  if (vendored) {
    console.log(
      warn(
        "the npm-vendored codex binary is present and unsigned; CodeArena will not use it",
      ),
    );
  }

  // --- project ----------------------------------------------------------------------
  const git = new Git(projectDir);
  if (!(await git.isRepo())) {
    console.log(bad(`project: ${projectDir} is not a git repository (run \`git init\`)`));
    fatal = true;
  } else {
    console.log(ok(`project: git repo on branch ${await git.currentBranch()}`));
    if (await git.isDirty()) {
      console.log(
        warn(
          "working tree is dirty -- CodeArena snapshots it as the baseline, so your\n" +
            "    uncommitted work will be treated as pre-existing, not as agent output",
        ),
      );
    }
  }

  console.log(
    fatal
      ? `\n\x1b[31mNot ready.\x1b[0m Fix the ✗ items above.\n`
      : `\n\x1b[32mReady.\x1b[0m Run: npm run arena -- "<your task>"\n`,
  );
  process.exit(fatal ? 1 : 0);
}

main();
