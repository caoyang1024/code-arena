/**
 * The state machine that is CodeArena's actual product.
 *
 *   planning -> plan_review --(request_changes, < maxRounds)--> planning
 *                          \--(approve)--> implementing -> diff_review
 *   diff_review --(request_changes, < maxRounds)--> implementing (revise)
 *               \--(approve)--> approved
 *
 * Exceeding maxRounds in either phase escalates to the human rather than looping forever.
 * That ceiling is the whole reason this is safe to run unattended: a disagreeing pair of
 * models can otherwise ping-pong indefinitely and bill you for it.
 */
import { Git } from "./git.js";
import { Gatekeeper } from "./gatekeeper.js";
import * as builder from "./builder.js";
import type { BuilderTurn } from "./builder.js";
import type { ArenaConfig, ArenaEvent, RoundRecord, TaskResult } from "./types.js";

export async function runTask(
  task: string,
  config: ArenaConfig,
  emit: (event: ArenaEvent) => void,
): Promise<TaskResult> {
  const git = new Git(config.projectDir);
  const gate = new Gatekeeper(config);
  const rounds: RoundRecord[] = [];

  let plan: string | null = null;
  let builderUsd = 0;
  let sessionId: string | null = null;

  const cost = () => ({
    builderUsd,
    gatekeeperInputTokens: gate.inputTokens,
    gatekeeperCachedInputTokens: gate.cachedInputTokens,
    gatekeeperOutputTokens: gate.outputTokens,
  });

  const finish = async (
    phase: TaskResult["phase"],
    diff: string,
    error?: string,
  ): Promise<TaskResult> => {
    const result: TaskResult = { phase, plan, rounds, diff, cost: cost(), ...(error ? { error } : {}) };
    emit({ type: "cost", cost: result.cost });
    emit({ type: "done", result });
    return result;
  };

  try {
    if (!(await git.isRepo())) {
      return finish("failed", "", `${config.projectDir} is not a git repository`);
    }

    const baseline = await git.snapshot("task-start");
    emit({ type: "snapshot", ref: baseline, label: "task-start" });

    // ---- Phase 1: plan, reviewed before anything is written -------------------------
    if (!config.skipPlanReview) {
      let round = 1;
      for (;;) {
        emit({ type: "phase", phase: "planning", round });
        const turn: BuilderTurn =
          plan === null
            ? await builder.plan(task, config, emit)
            : await builder.replan(
                task,
                plan,
                rounds.at(-1)!.review.findings,
                rounds.at(-1)!.review.summary,
                config,
                emit,
                sessionId,
              );
        builderUsd += turn.costUsd;
        sessionId = turn.sessionId;
        const currentPlan = turn.text;
        plan = currentPlan;

        emit({ type: "phase", phase: "plan_review", round });
        const review = await gate.reviewPlan(task, currentPlan, emit);
        rounds.push({ round, phase: "plan_review", review, snapshot: baseline });
        emit({ type: "review", phase: "plan_review", review });

        if (review.verdict === "approve") break;
        if (round >= config.maxRounds) {
          emit({
            type: "log",
            level: "warn",
            message: `Plan still rejected after ${round} rounds -- escalating.`,
          });
          return finish("escalated", "");
        }
        round += 1;
      }
    } else {
      plan = "(plan review skipped by configuration)";
    }

    // ---- Phase 2: implement, reviewed as a diff -------------------------------------
    // The builder starts a fresh session here: plan mode and write mode are different jobs,
    // and a clean session keeps the plan-round back-and-forth out of the implementation
    // context. Revision rounds then resume *this* session.
    sessionId = null;
    let round = 1;
    let lastSnapshot = baseline;

    for (;;) {
      emit({ type: "phase", phase: "implementing", round });
      const turn: BuilderTurn =
        round === 1
          ? await builder.implement(task, plan!, config, emit, null)
          : await builder.revise(
              rounds.at(-1)!.review.findings,
              rounds.at(-1)!.review.summary,
              config,
              emit,
              sessionId,
            );
      builderUsd += turn.costUsd;
      sessionId = turn.sessionId;

      lastSnapshot = await git.snapshot(`round-${round}`);
      emit({ type: "snapshot", ref: lastSnapshot, label: `round-${round}` });

      const diff = await git.diff(baseline, lastSnapshot);
      const changed = await git.changedFiles(baseline, lastSnapshot);

      emit({ type: "phase", phase: "diff_review", round });
      const review = await gate.reviewDiff(task, plan!, diff, changed, emit);
      rounds.push({ round, phase: "diff_review", review, snapshot: lastSnapshot });
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
            `Diff still rejected after ${round} rounds -- escalating. ` +
            `The changes are left in the working tree; snapshot ${baseline.slice(0, 8)} is the ` +
            `pre-task state if you want to roll back.`,
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
