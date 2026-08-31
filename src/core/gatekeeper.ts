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
import type { ArenaConfig, ArenaEvent, Review, TurnControl } from "./types.js";

type Emit = (event: ArenaEvent) => void;

/** The project's own account of how work proceeds, appended to the charter when it states one. */
function methodSuffix(method?: string): string {
  return method?.trim() ? `\n\n--- HOW WORK PROCEEDS HERE ---\n${method.trim()}` : "";
}

const CHARTER = `You are the gatekeeper on a two-model engineering team. Another model wrote
the work below. Your job is to decide whether it should be accepted.

Read the conversation first, when one is given. The lines marked ENGINEER are the requirement
-- they are the only text here the implementer did not write, and they are what the work has
to satisfy. The lines marked IMPLEMENTER are claims: useful context, not requirements, and
not evidence. Where the plan or the diff diverges from what the engineer asked for, say so;
that is the one thing only you can see.

You have read-only access to the repository -- use it. Read the files around a change before
judging it; a finding you did not verify against the actual code is worse than no finding.

Rules:
- Report defects, not preferences. Style nits and hypotheticals are noise.
- Every finding needs concrete evidence: the inputs that break it, or the code you read that
  proves it. "This could be a problem" is not evidence.
- Approve when you would merge it as-is. A single blocker or major finding means
  request_changes.
- Do not restate the diff back at me.`;

/** Thrown when the user stops a turn. Distinguished from a failure everywhere it is caught. */
export class Cancelled extends Error {
  constructor() {
    super("Stopped by the user.");
  }
}

/**
 * The conversation, when there is one. Placed before everything the implementer wrote, so the
 * requirement is read before the claims about it.
 */
/**
 * The project's own rules, quoted rather than left to be found.
 *
 * These are the repository's standard for what a finished change looks like, so compliance is
 * reported explicitly: an unmet rule is a finding, and a rule that does not apply is silence,
 * not a paragraph explaining why.
 */
function conventionsSection(conventions?: string): string[] {
  if (!conventions?.trim()) return [];
  return [
    "--- THE PROJECT'S OWN RULES ---",
    "These are this repository's stated conventions. A more deeply nested file governs the",
    "subtree it sits in and takes precedence where it conflicts with one above it. Check the",
    "work against them and report any that are not met as findings. Say nothing about the ones",
    "that are met or do not apply.",
    "",
    conventions.trim(),
    "",
  ];
}

function conversationSection(conversation?: string): string[] {
  if (!conversation?.trim()) return [];
  return ["--- CONVERSATION WITH THE ENGINEER ---", conversation.trim(), ""];
}

export class Gatekeeper {
  private readonly codex: Codex;
  private planThread: Thread | null = null;
  private diffThread: Thread | null = null;
  public inputTokens = 0;
  public cachedInputTokens = 0;
  public outputTokens = 0;

  constructor(
    private readonly config: ArenaConfig,
    private readonly control?: TurnControl,
  ) {
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
      // Breaking the loop returns the generator, which tears down the codex subprocess. The
      // review is abandoned rather than paused; there is no resume point in a codex turn.
      if (this.control?.signal.aborted) throw new Cancelled();

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

  /**
   * A second opinion on the builder's reasoning, before anything is planned or built.
   *
   * The pipeline only ever checked plans and diffs, but the judgements that decide whether
   * the work is worth doing happen earlier -- is this our bug, should this throw or return a
   * sentinel, is the premise even right. Those went unchecked, and a flawless review of a
   * plan built on a wrong diagnosis is a careful answer to the wrong question.
   *
   * No verdict schema here: nothing is being gated, so a verdict would be theatre. This
   * returns prose, and its value is that it was formed without the builder's framing.
   */
  async secondOpinion(conversation: string, emit: Emit): Promise<string> {
    const thread = this.newThread();
    const prompt = [
      `You are the second model on a two-model engineering team. Below is a conversation
between an engineer and the other model. You are not reviewing code and nothing is being
approved -- you are being asked whether the reasoning holds.`,
      "",
      "The lines marked ENGINEER are the requirement. The lines marked IMPLEMENTER are the",
      "other model's claims -- treat them as claims, not as established fact, and check them",
      "against the repository, which you can read.",
      "",
      "Say, briefly and in this order:",
      "  1. Where you agree, and what you verified to be sure.",
      "  2. Where you disagree or think a claim is unsupported, with the evidence.",
      "  3. What neither of them has considered that matters here.",
      "",
      "Rules: read the code before asserting anything about it, and quote what you read.",
      "Do not restate the conversation. Do not hedge to be agreeable -- agreeing with a",
      "wrong diagnosis is the failure mode this whole arrangement exists to prevent. If you",
      "think the engineer's premise is wrong, say that too.",
      "",
      "--- CONVERSATION ---",
      conversation,
    ].join("\n");

    const { events } = await thread.runStreamed(prompt);
    let final = "";
    for await (const event of events) {
      if (this.control?.signal.aborted) throw new Cancelled();
      if (event.type === "item.completed") {
        const item = event.item;
        if (item.type === "agent_message") final = item.text;
        else if (item.type === "command_execution") {
          emit({ type: "gatekeeper.item", kind: "command", text: item.command });
        } else if (item.type === "error") {
          emit({ type: "gatekeeper.item", kind: "error", text: item.message });
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
    if (!final.trim()) throw new Error("Gatekeeper returned an empty second opinion");
    return final;
  }

  /** Review the builder's plan before a single file is touched. */
  async reviewPlan(
    task: string,
    plan: string,
    emit: Emit,
    conversation?: string,
    conventions?: string,
  ): Promise<Review> {
    // One thread across all plan rounds, so round 2 knows what it asked for in round 1.
    this.planThread ??= this.newThread();
    const prompt = [
      CHARTER + methodSuffix(this.config.workingMethod),
      "",
      "You are reviewing a PLAN, not code. Judge whether this approach will actually solve the",
      "task correctly: wrong approach, missed requirement, ignored existing abstraction,",
      "unhandled failure mode, or a plan that contradicts how this repository already works.",
      "",
      ...conventionsSection(conventions),
      ...conversationSection(conversation),
      "--- WHAT THE ENGINEER ASKED FOR ---",
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
    conversation?: string,
    conventions?: string,
  ): Promise<Review> {
    this.diffThread ??= this.newThread();
    const prompt = [
      CHARTER + methodSuffix(this.config.workingMethod),
      "",
      "You are reviewing a DIFF. The working tree already contains these changes, so you can",
      "open any file to see the full post-change context. Look for: correctness bugs, missed",
      "requirements from the task, error paths that were skipped, and anything the plan",
      "promised but the diff does not deliver.",
      "",
      "Also report what the change makes STALE. A change has consequences outside its own",
      "diff -- documentation that now describes the old behaviour, callers that were not",
      "updated, a test that should exist for the new contract and does not. Those are part of",
      "the change even though they are absent from it, and nothing else in this pipeline is",
      "looking for them.",
      "",
      ...conventionsSection(conventions),
      `--- FILES CHANGED (${changedFiles.length}) ---`,
      changedFiles.join("\n") || "(none)",
      "",
      ...conversationSection(conversation),
      "--- WHAT THE ENGINEER ASKED FOR ---",
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
