/**
 * Terminal front-end. Conversation first; the pipeline runs only when you say so.
 *
 *   npm run arena -- --project ../my-repo
 *
 * Type to talk. `/build` commits to building what you just discussed. This is the throwaway
 * UI -- it renders the same ArenaEvent stream the Electron app consumes.
 */
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runChat, runBuild } from "../core/orchestrator.js";
import { resolveCodex } from "../core/codex-path.js";
import { resolveClaude } from "../core/claude-path.js";
import type { ArenaConfig, ArenaEvent, Finding } from "../core/types.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const blue = (s: string) => `\x1b[34m${s}\x1b[0m`;
const teal = (s: string) => `\x1b[36m${s}\x1b[0m`;

const SEVERITY_COLOR: Record<Finding["severity"], (s: string) => string> = {
  blocker: red,
  major: yellow,
  minor: dim,
};

function parseArgs(argv: string[]) {
  let projectDir = process.cwd();
  let maxRounds = 3;
  let skipPlanReview = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--project" || arg === "-C") projectDir = argv[++i] ?? projectDir;
    else if (arg === "--rounds") maxRounds = Number(argv[++i] ?? maxRounds);
    else if (arg === "--no-plan-review") skipPlanReview = true;
  }
  return { projectDir, maxRounds, skipPlanReview };
}

function render(event: ArenaEvent): void {
  switch (event.type) {
    case "phase": {
      if (event.phase === "chatting") return; // the prompt itself is the cue
      const label: Record<string, string> = {
        planning: "PLANNING        builder is designing the change (read-only)",
        plan_review: "PLAN REVIEW     gatekeeper is checking the approach",
        implementing: "IMPLEMENTING    builder is editing files",
        diff_review: "DIFF REVIEW     gatekeeper is checking the code",
        approved: "APPROVED",
      };
      const text = label[event.phase];
      if (text) {
        console.log(`\n${blue("──")} ${bold(text)} ${dim(`(round ${event.round})`)}`);
      }
      break;
    }
    case "builder.text":
      process.stdout.write(event.text);
      break;
    case "builder.tool":
      console.log(dim(`   · ${event.name}`));
      break;
    case "builder.permission":
      if (event.decision === "deny") console.log(yellow(`\n   ⊘ ${event.name}: ${event.reason}`));
      break;
    case "gatekeeper.item":
      if (event.kind === "command") console.log(dim(`   · gatekeeper ran: ${event.text.slice(0, 90)}`));
      if (event.kind === "error") console.log(red(`   ! ${event.text}`));
      break;
    case "snapshot":
      console.log(dim(`   snapshot ${event.ref.slice(0, 8)} (${event.label})`));
      break;
    case "review": {
      const { verdict, summary, findings } = event.review;
      console.log(
        `\n   ${verdict === "approve" ? green("APPROVE") : yellow("REQUEST CHANGES")}  ${summary}`,
      );
      for (const f of findings) {
        const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "";
        console.log(`   ${SEVERITY_COLOR[f.severity](`[${f.severity}]`)} ${bold(loc)} ${f.issue}`);
        console.log(dim(`      evidence: ${f.evidence}`));
        console.log(dim(`      fix:      ${f.suggestion}`));
      }
      break;
    }
    case "cost": {
      const c = event.cost;
      console.log(
        dim(
          `\n   cost — builder $${c.builderUsd.toFixed(4)} · ` +
            `gatekeeper ${c.gatekeeperInputTokens} in (${c.gatekeeperCachedInputTokens} cached) / ` +
            `${c.gatekeeperOutputTokens} out`,
        ),
      );
      break;
    }
    case "log":
      console.log(
        event.level === "error" ? red(`\n   ${event.message}`) : yellow(`\n   ${event.message}`),
      );
      break;
    case "done": {
      const { phase, rounds, diff } = event.result;
      const banner =
        phase === "approved"
          ? green("✓ APPROVED by the gatekeeper")
          : phase === "escalated"
            ? yellow("↑ ESCALATED — needs you")
            : red("✗ FAILED");
      console.log(`\n${bold(banner)}`);
      console.log(
        dim(`   ${rounds.length} review round(s), ${diff.split("\n").length} diff lines`),
      );
      break;
    }
    default:
      break;
  }
}

async function main() {
  const { projectDir, maxRounds, skipPlanReview } = parseArgs(process.argv.slice(2));

  const codex = await resolveCodex();
  if (!codex?.signedByOpenAI || !codex.loggedIn) {
    console.error(red("Gatekeeper unavailable. Run `npm run doctor` for details."));
    process.exit(1);
  }

  const claude = await resolveClaude();
  if (!claude.usable) console.log(yellow(`\n  ! builder: ${claude.detail}`));

  const config: ArenaConfig = {
    projectDir,
    maxRounds,
    skipPlanReview,
    codexPath: codex.path,
    ...(claude.path ? { claudePath: claude.path } : {}),
  };

  console.log(bold(`\nCodeArena`));
  console.log(dim(`  project:    ${projectDir}`));
  console.log(dim(`  builder:    Claude ${claude.version ?? ""} — read-only until you decide`));
  console.log(dim(`  gatekeeper: ${codex.version}, read-only`));
  console.log(dim(`  max rounds: ${maxRounds}`));
  console.log(
    dim(`\n  Talk it through. ${bold("/build")}${dim(" when you have decided.")} /reset, /exit`),
  );

  let session: string | null = null;

  /**
   * One line of input. Returns null at end of input.
   *
   * Piped stdin and an interactive terminal need different handling. readline closes as soon
   * as piped input is exhausted -- which happens while the first turn is still running, since
   * a turn takes minutes -- and any buffered lines after it are lost, silently. So when stdin
   * is not a TTY, drain it up front and replay it. That also makes the CLI scriptable, which
   * is how the end-to-end runs are driven.
   */
  let nextLine: () => Promise<string | null>;
  let closeInput = () => {};

  if (stdin.isTTY) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    closeInput = () => rl.close();
    nextLine = async () => {
      try {
        return await rl.question(teal("\n› "));
      } catch {
        return null;
      }
    };
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    const queued = Buffer.concat(chunks).toString().split("\n");
    let i = 0;
    nextLine = async () => {
      if (i >= queued.length) return null;
      const line = queued[i++]!;
      process.stdout.write(teal(`\n› `) + line + "\n");
      return line;
    };
  }

  for (;;) {
    const raw = await nextLine();
    if (raw === null) break;
    const line = raw.trim();
    if (!line) continue;

    if (line === "/exit" || line === "/quit") break;

    if (line === "/reset") {
      session = null;
      console.log(dim("   conversation cleared"));
      continue;
    }

    if (line === "/build" || line.startsWith("/build ")) {
      const instruction = line.slice("/build".length).trim();
      if (!session && !instruction) {
        console.log(
          yellow("   Nothing discussed yet. Say what you want first, or `/build <what>`."),
        );
        continue;
      }
      const outcome = await runBuild(config, render, session, instruction || undefined);
      session = outcome.sessionId;
      continue;
    }

    session = await runChat(line, config, render, session);
    console.log();
  }

  closeInput();
}

main().catch((e) => {
  console.error(red(String(e?.stack ?? e)));
  process.exit(1);
});
