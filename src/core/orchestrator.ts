/**
 * The state machine that is CodeArena's actual product.
 *
 * The engineer talks to the builder for as long as they like -- read-only, no gatekeeper, no
 * cost beyond the conversation. Nothing is planned and nothing is written until they decide.
 * Then, and only then:
 *
 *   (decision) -> planning -> plan_review --(request_changes, < maxRounds)--> planning
 *                                         \--(approve)--> implementing -> diff_review
 *   diff_review --(request_changes, < maxRounds)--> implementing (revise)
 *               \--(approve)--> approved, back to chatting
 *
 * Exceeding maxRounds in either phase escalates to the human rather than looping forever.
 * That ceiling is why this is safe to leave running: two models that disagree will otherwise
 * ping-pong indefinitely and bill you for it.
 *
 * Everything runs on one Claude session, threaded through by `sessionId`. That is what makes
 * "build what we just discussed" mean anything.
 */
import { Git } from "./git.js";
import { Gatekeeper, Cancelled } from "./gatekeeper.js";
import * as builder from "./builder.js";
import type { BuilderTurn } from "./builder.js";
import type { ArenaConfig, ArenaEvent, RoundRecord, TaskResult, TurnControl } from "./types.js";

/**
 * What to put in the task slot when the user pressed Build with an empty composer -- the
 * main-line path, and the one that used to yield the literal string "(see the plan)".
 */
function describeIntent(conversation?: string): string {
  return conversation?.trim()
    ? "Not restated separately — see the conversation above. The ENGINEER lines are the requirement."
    : "No conversation and no instruction were given; the plan is the only statement of intent, " +
      "so treat an unjustified assumption in it as a finding.";
}

export interface BuildOutcome extends TaskResult {
  /** Threaded back to the caller so the conversation continues where the build left off. */
  sessionId: string | null;
}

/**
 * One conversational turn. Read-only, no gatekeeper -- this is the part that should feel like
 * an ordinary chat.
 */
export async function runChat(
  message: string,
  config: ArenaConfig,
  emit: (event: ArenaEvent) => void,
  sessionId: string | null,
  control?: TurnControl,
): Promise<string | null> {
  emit({ type: "user.message", text: message });
  emit({ type: "phase", phase: "chatting", round: 1 });
  try {
    const turn = await builder.chat(message, config, emit, sessionId, control);
    if (turn.cancelled) emit({ type: "cancelled", phase: "chatting" });
    emit({ type: "session", sessionId: turn.sessionId });
    return turn.sessionId;
  } catch (error) {
    emit({
      type: "log",
      level: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    return sessionId;
  }
}

/**
 * The pipeline, entered when the engineer decides to build.
 *
 * `instruction` is optional: with an open conversation behind it, "build what we discussed"
 * is usually enough, and forcing the user to restate it invites them to restate it *wrong*.
 */
export async function runBuild(
  config: ArenaConfig,
  emit: (event: ArenaEvent) => void,
  sessionId: string | null,
  instruction?: string,
  control?: TurnControl,
  conversation?: string,
): Promise<BuildOutcome> {
  const git = new Git(config.projectDir);
  const gate = new Gatekeeper(config, control);
  const stopped = () => control?.signal.aborted ?? false;
  const rounds: RoundRecord[] = [];

  let plan: string | null = null;
  let builderUsd = 0;
  let session = sessionId;

  const cost = () => ({
    builderUsd,
    gatekeeperInputTokens: gate.inputTokens,
    gatekeeperCachedInputTokens: gate.cachedInputTokens,
    gatekeeperOutputTokens: gate.outputTokens,
  });

  let baselineRef: string | null = null;
  const safeDiff = async (g: Git) => {
    try {
      return baselineRef ? await g.diff(baselineRef, await g.snapshot("stopped")) : "";
    } catch {
      return "";
    }
  };

  const finish = (
    phase: TaskResult["phase"],
    diff: string,
    error?: string,
  ): BuildOutcome => {
    const result: BuildOutcome = {
      phase,
      plan,
      rounds,
      diff,
      baseline: baselineRef,
      cost: cost(),
      sessionId: session,
      ...(error ? { error } : {}),
    };
    if (phase === "cancelled") emit({ type: "cancelled", phase: "cancelled" });
    // Keep this build's baseline so a rollback stays possible; drop everything older. Every
    // snapshot pins a whole working tree, and nothing was ever pruned, so they piled up in
    // the user's repository one per round per build, forever.
    void git.pruneRefs(baselineRef ? [baselineRef] : []).catch(() => {});
    emit({ type: "cost", cost: result.cost });
    emit({ type: "session", sessionId: session });
    emit({ type: "done", result });
    return result;
  };

  try {
    if (!(await git.isRepo())) {
      return finish("failed", "", `${config.projectDir} is not a git repository`);
    }

    const baseline = await git.snapshot("build-start");
    baselineRef = baseline;
    emit({ type: "snapshot", ref: baseline, label: "build-start" });

    // ---- Phase 1: plan, reviewed before anything is written -------------------------
    let round = 1;
    for (;;) {
      emit({ type: "phase", phase: "planning", round });
      const turn: BuilderTurn =
        round === 1
          ? await builder.plan(config, emit, session, instruction, control)
          : await builder.replan(
              rounds.at(-1)!.review.findings,
              rounds.at(-1)!.review.summary,
              config,
              emit,
              session,
              control,
            );
      builderUsd += turn.costUsd;
      session = turn.sessionId;
      if (turn.cancelled || stopped()) return finish("cancelled", "");
      const currentPlan = turn.text;
      plan = currentPlan;

      if (config.skipPlanReview) break;

      emit({ type: "phase", phase: "plan_review", round });
      const review = await gate.reviewPlan(
        instruction ?? describeIntent(conversation),
        currentPlan,
        emit,
        conversation,
      );
      rounds.push({ round, phase: "plan_review", review, snapshot: baseline });
      emit({ type: "review", phase: "plan_review", review });

      if (review.verdict === "approve") break;
      if (round >= config.maxRounds) {
        emit({
          type: "log",
          level: "warn",
          message: `Plan still rejected after ${round} rounds — escalating. Nothing was written.`,
        });
        return finish("escalated", "");
      }
      round += 1;
    }

    // ---- Phase 2: implement, reviewed as a diff -------------------------------------
    round = 1;
    for (;;) {
      emit({ type: "phase", phase: "implementing", round });
      const turn: BuilderTurn =
        round === 1
          ? await builder.implement(config, emit, session, control)
          : await builder.revise(
              rounds.at(-1)!.review.findings,
              rounds.at(-1)!.review.summary,
              config,
              emit,
              session,
              control,
            );
      builderUsd += turn.costUsd;
      session = turn.sessionId;

      // Snapshot before bailing out: the builder may have written files before it was
      // stopped, and the user needs to see what landed.
      const snapshot = await git.snapshot(`round-${round}`);
      emit({ type: "snapshot", ref: snapshot, label: `round-${round}` });

      const diff = await git.diff(baseline, snapshot);
      const changed = await git.changedFiles(baseline, snapshot);

      if (turn.cancelled || stopped()) return finish("cancelled", diff);

      emit({ type: "phase", phase: "diff_review", round });
      const review = await gate.reviewDiff(
        instruction ?? describeIntent(conversation),
        plan!,
        diff,
        changed,
        emit,
        conversation,
      );
      rounds.push({ round, phase: "diff_review", review, snapshot });
      emit({ type: "review", phase: "diff_review", review });

      if (review.verdict === "approve") {
        emit({ type: "phase", phase: "approved", round });
        return finish("approved", diff);
      }
      if (round >= config.maxRounds) {
        emit({
          type: "log",
          level: "warn",
          message:
            `Diff still rejected after ${round} rounds — escalating. The changes are left in ` +
            `the working tree; snapshot ${baseline.slice(0, 8)} is the pre-build state.`,
        });
        return finish("escalated", diff);
      }
      round += 1;
    }
  } catch (error) {
    if (error instanceof Cancelled || stopped()) {
      const diff = plan ? await safeDiff(git) : "";
      return finish("cancelled", diff);
    }
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "log", level: "error", message });
    return finish("failed", "", message);
  }
}
