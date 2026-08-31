/**
 * The gatekeeper: Codex, driven through the Codex SDK.
 *
 * Hard rule enforced here: sandboxMode is always "read-only". The reviewer gets the diff
 * *and* the ability to grep and read the surrounding repository to check its claims, but it
 * can never write. A reviewer that can edit is no longer a reviewer.
 *
 * Verdicts come back through `outputSchema`, so the loop branches on data rather than on
 * prose we would otherwise have to guess at.
 */
import { Codex, type Thread } from "@openai/codex-sdk";
import { REVIEW_SCHEMA, parseReview } from "./schema.js";
import type { ArenaConfig, ArenaEvent, Review } from "./types.js";

type Emit = (event: ArenaEvent) => void;

const CHARTER = `You are the gatekeeper on a two-model engineering team. Another model wrote
the work below. Your job is to decide whether it should be accepted.

You have read-only access to the repository -- use it. Read the files around a change before
judging it; a finding you did not verify against the actual code is worse than no finding.

Rules:
- Report defects, not preferences. Style nits and hypotheticals are noise.
- Every finding needs concrete evidence: the inputs that break it, or the code you read that
  proves it. "This could be a problem" is not evidence.
- Approve when you would merge it as-is. A single blocker or major finding means
  request_changes.
- Do not restate the diff back at me.`;

export class Gatekeeper {
  private readonly codex: Codex;
  private planThread: Thread | null = null;
  private diffThread: Thread | null = null;
  public inputTokens = 0;
  public cachedInputTokens = 0;
  public outputTokens = 0;

  constructor(private readonly config: ArenaConfig) {
    // Never the npm-vendored binary -- see doctor.ts for why.
    this.codex = new Codex({ codexPathOverride: config.codexPath });
  }

  private newThread(): Thread {
    return this.codex.startThread({
      workingDirectory: this.config.projectDir,
      sandboxMode: "read-only",
      skipGitRepoCheck: false,
      ...(this.config.gatekeeperModel ? { model: this.config.gatekeeperModel } : {}),
    });
  }

  private async runReview(thread: Thread, prompt: string, emit: Emit): Promise<Review> {
    const { events } = await thread.runStreamed(prompt, { outputSchema: REVIEW_SCHEMA });

    let final = "";
    for await (const event of events) {
      if (event.type === "item.completed") {
        const item = event.item;
        switch (item.type) {
          case "agent_message":
            final = item.text;
            break;
          case "command_execution":
            emit({ type: "gatekeeper.item", kind: "command", text: item.command });
            break;
          case "reasoning":
            emit({ type: "gatekeeper.item", kind: "reasoning", text: item.text });
            break;
          case "error":
            emit({ type: "gatekeeper.item", kind: "error", text: item.message });
            break;
          default:
            break;
        }
      } else if (event.type === "turn.completed") {
        this.inputTokens += event.usage.input_tokens;
        this.cachedInputTokens += event.usage.cached_input_tokens;
        this.outputTokens += event.usage.output_tokens;
      } else if (event.type === "turn.failed") {
        throw new Error(`Gatekeeper turn failed: ${event.error.message}`);
      } else if (event.type === "error") {
        throw new Error(`Gatekeeper stream error: ${event.message}`);
      }
    }

    if (!final.trim()) throw new Error("Gatekeeper returned an empty response");
    return parseReview(final);
  }

  /** Review the builder's plan before a single file is touched. */
  async reviewPlan(task: string, plan: string, emit: Emit): Promise<Review> {
    // One thread across all plan rounds, so round 2 knows what it asked for in round 1.
    this.planThread ??= this.newThread();
    const prompt = [
      CHARTER,
      "",
      "You are reviewing a PLAN, not code. Judge whether this approach will actually solve the",
      "task correctly: wrong approach, missed requirement, ignored existing abstraction,",
      "unhandled failure mode, or a plan that contradicts how this repository already works.",
      "",
      "--- TASK AS GIVEN TO THE IMPLEMENTER ---",
      task,
      "",
      "--- PROPOSED PLAN ---",
      plan,
    ].join("\n");
    return this.runReview(this.planThread, prompt, emit);
  }

  /** Review the actual diff after implementation. */
  async reviewDiff(
    task: string,
    plan: string,
    diff: string,
    changedFiles: string[],
    emit: Emit,
  ): Promise<Review> {
    this.diffThread ??= this.newThread();
    const prompt = [
      CHARTER,
      "",
      "You are reviewing a DIFF. The working tree already contains these changes, so you can",
      "open any file to see the full post-change context. Look for: correctness bugs, missed",
      "requirements from the task, error paths that were skipped, and anything the plan",
      "promised but the diff does not deliver.",
      "",
      `--- FILES CHANGED (${changedFiles.length}) ---`,
      changedFiles.join("\n") || "(none)",
      "",
      "--- TASK AS GIVEN TO THE IMPLEMENTER ---",
      task,
      "",
      "--- APPROVED PLAN ---",
      plan,
      "",
      "--- DIFF ---",
      diff || "(empty diff -- the implementer changed nothing; that is itself a finding)",
    ].join("\n");
    return this.runReview(this.diffThread, prompt, emit);
  }
}
