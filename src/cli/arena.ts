/**
 * Terminal front-end for the orchestrator. This is the throwaway UI: it exists to prove the
 * loop works end to end. The Electron app renders the same ArenaEvent stream.
 *
 *   npm run arena -- "add retry with backoff to the http client"
 *   npm run arena -- --project ../some-repo --rounds 2 "fix the flaky test"
 */
import { runTask } from "../core/orchestrator.js";
import { resolveCodex } from "../core/codex-path.js";
import type { ArenaConfig, ArenaEvent, Finding } from "../core/types.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const blue = (s: string) => `\x1b[34m${s}\x1b[0m`;

const SEVERITY_COLOR: Record<Finding["severity"], (s: string) => string> = {
  blocker: red,
  major: yellow,
  minor: dim,
};

function parseArgs(argv: string[]) {
  let projectDir = process.cwd();
  let maxRounds = 3;
  let skipPlanReview = false;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--project" || arg === "-C") projectDir = argv[++i] ?? projectDir;
    else if (arg === "--rounds") maxRounds = Number(argv[++i] ?? maxRounds);
    else if (arg === "--no-plan-review") skipPlanReview = true;
    else rest.push(arg);
  }
  return { projectDir, maxRounds, skipPlanReview, task: rest.join(" ").trim() };
}

function render(event: ArenaEvent): void {
  switch (event.type) {
    case "phase": {
      const label: Record<string, string> = {
        planning: "PLANNING        builder is designing the change (read-only)",
        plan_review: "PLAN REVIEW     gatekeeper is checking the approach",
        implementing: "IMPLEMENTING    builder is editing files",
        diff_review: "DIFF REVIEW     gatekeeper is checking the code",
        approved: "APPROVED",
      };
      console.log(`\n${blue("──")} ${bold(label[event.phase] ?? event.phase)} ${dim(`(round ${event.round})`)}`);
      break;
    }
    case "builder.text":
      process.stdout.write(dim(event.text));
      break;
    case "builder.tool":
      console.log(dim(`   · ${event.name}`));
      break;
    case "builder.permission":
      if (event.decision === "deny") console.log(red(`   ⨯ denied ${event.name}: ${event.reason}`));
      break;
    case "gatekeeper.item":
      if (event.kind === "command") console.log(dim(`   · gatekeeper ran: ${event.text.slice(0, 100)}`));
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
        event.level === "error" ? red(`   ${event.message}`) : yellow(`   ${event.message}`),
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
      console.log(dim(`   ${rounds.length} review round(s), ${diff.split("\n").length} diff lines`));
      break;
    }
  }
}

async function main() {
  const { projectDir, maxRounds, skipPlanReview, task } = parseArgs(process.argv.slice(2));

  if (!task) {
    console.error('usage: npm run arena -- [--project DIR] [--rounds N] [--no-plan-review] "<task>"');
    process.exit(2);
  }

  const codex = await resolveCodex();
  if (!codex?.signedByOpenAI || !codex.loggedIn) {
    console.error(red("Gatekeeper unavailable. Run `npm run doctor` for details."));
    process.exit(1);
  }

  const config: ArenaConfig = {
    projectDir,
    maxRounds,
    skipPlanReview,
    codexPath: codex.path,
  };

  console.log(bold(`\nCodeArena`));
  console.log(dim(`  task:       ${task}`));
  console.log(dim(`  project:    ${projectDir}`));
  console.log(dim(`  builder:    Claude (Agent SDK)`));
  console.log(dim(`  gatekeeper: ${codex.version}, read-only`));
  console.log(dim(`  max rounds: ${maxRounds}`));

  const result = await runTask(task, config, render);
  process.exit(result.phase === "approved" ? 0 : 1);
}

main().catch((e) => {
  console.error(red(String(e?.stack ?? e)));
  process.exit(1);
});
