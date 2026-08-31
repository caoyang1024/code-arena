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
import { Gatekeeper } from "./gatekeeper.js";
import * as builder from "./builder.js";
import type { BuilderTurn } from "./builder.js";
import type { ArenaConfig, ArenaEvent, RoundRecord, TaskResult } from "./types.js";

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
): Promise<string | null> {
  emit({ type: "user.message", text: message });
  emit({ type: "phase", phase: "chatting", round: 1 });
  try {
    const turn = await builder.chat(message, config, emit, sessionId);
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
): Promise<BuildOutcome> {
  const git = new Git(config.projectDir);
  const gate = new Gatekeeper(config);
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
      cost: cost(),
      sessionId: session,
      ...(error ? { error } : {}),
    };
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
    emit({ type: "snapshot", ref: baseline, label: "build-start" });

    // ---- Phase 1: plan, reviewed before anything is written -------------------------
    let round = 1;
    for (;;) {
      emit({ type: "phase", phase: "planning", round });
      const turn: BuilderTurn =
        round === 1
          ? await builder.plan(config, emit, session, instruction)
          : await builder.replan(
              rounds.at(-1)!.review.findings,
              rounds.at(-1)!.review.summary,
              config,
              emit,
              session,
            );
      builderUsd += turn.costUsd;
      session = turn.sessionId;
      const currentPlan = turn.text;
      plan = currentPlan;

      if (config.skipPlanReview) break;

      emit({ type: "phase", phase: "plan_review", round });
      const review = await gate.reviewPlan(instruction ?? "(see the plan)", currentPlan, emit);
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
          ? await builder.implement(config, emit, session)
          : await builder.revise(
              rounds.at(-1)!.review.findings,
              rounds.at(-1)!.review.summary,
              config,
              emit,
              session,
            );
      builderUsd += turn.costUsd;
      session = turn.sessionId;

      const snapshot = await git.snapshot(`round-${round}`);
      emit({ type: "snapshot", ref: snapshot, label: `round-${round}` });

      const diff = await git.diff(baseline, snapshot);
      const changed = await git.changedFiles(baseline, snapshot);

      emit({ type: "phase", phase: "diff_review", round });
      const review = await gate.reviewDiff(
        instruction ?? "(see the plan)",
        plan!,
        diff,
        changed,
        emit,
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
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "log", level: "error", message });
    return finish("failed", "", message);
  }
}
