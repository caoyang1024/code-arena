/**
 * A recorded task, replayed as a live ArenaEvent stream.
 *
 * The gatekeeper's verdict below is real -- captured verbatim from the first live Codex
 * review (test/gatekeeper.test.ts against a sandbox repo), including its evidence line.
 * The builder's side is reconstructed, since the Claude half could not be exercised.
 *
 * This earns its place twice: the UI can be built and reviewed without spending model
 * quota, and a first-run user can watch the loop before connecting any account.
 */
import type { ArenaEvent, Review } from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const USER_1 = `average() is returning NaN somewhere in the report pipeline. is that our bug or the caller's?`;

const REPLY_1 = `Ours. \`average([])\` computes \`0 / 0\`, which is \`NaN\` — it never throws, so the
bad input propagates silently until something downstream formats it.

\`divide\` has the same shape: \`divide(1, 0)\` returns \`Infinity\` rather than rejecting.
README.md says bad input should throw \`TypeError\`, so neither function currently follows the
convention the repo states.

Worth deciding: do you want them to throw, or to return a sentinel the caller checks? Throwing
matches the README, but it will surface as an exception in the report pipeline rather than a
\`NaN\` — that is a behaviour change for whatever calls it today.`;

const USER_2 = `throw. the NaN is exactly the problem — I want it loud.`;

const REPLY_2 = `Agreed, and it is the smaller change. Both guards go at the top of their
function, before any arithmetic, and both throw \`TypeError\` naming the offending argument.

One thing to watch: \`average\` currently divides inline rather than calling \`divide\`, so
guarding \`divide\` alone would not cover it.`;

const PLAN = `I'll add input guards to both functions, following the TypeError convention the README states.

**calc.js**
1. \`divide(a, b)\` — throw \`TypeError\` when \`b === 0\`, before the division.
2. \`average(numbers)\` — throw \`TypeError\` on an empty array, since \`0/0\` would otherwise
   return \`NaN\` and silently propagate.

No new files, no dependencies. \`average\` already routes through \`divide\`, so the zero-divisor
guard covers it once the empty-array case is handled explicitly.`;

const PLAN_REVIEW: Review = {
  verdict: "approve",
  summary:
    "The approach matches the repository's stated TypeError convention and covers both failure modes named in the task.",
  findings: [],
};

/** Verbatim from the live Codex run — see README, "Status". */
const DIFF_REVIEW_1: Review = {
  verdict: "request_changes",
  summary:
    "The divide guard is correct, but average still does not reject an empty array according to the repository's TypeError convention.",
  findings: [
    {
      severity: "major",
      file: "calc.js",
      line: 11,
      issue: "average([]) returns NaN instead of rejecting the empty array with a TypeError.",
      evidence:
        "With numbers.length equal to 0, line 11 evaluates 0 / 0, which produces NaN; README.md says bad input must throw TypeError.",
      suggestion:
        "Add an explicit empty-array check in average() that throws TypeError before calculating the result.",
    },
  ],
};

const DIFF_REVIEW_2: Review = {
  verdict: "approve",
  summary:
    "Both guards are now present and consistent with the README convention. Messages name the function and the offending argument.",
  findings: [],
};

const BUILDER_ROUND_1 = `Added the zero-divisor guard to \`divide\`. \`average\` now delegates its
division, so the guard applies transitively.`;

const BUILDER_ROUND_2 = `You're right — the transitive argument doesn't hold: \`average\` computed
\`total / numbers.length\` directly rather than calling \`divide\`. Added an explicit empty-array
check that throws \`TypeError\` before the division.`;

interface Step {
  event: ArenaEvent;
  /** Pause after emitting, in ms. */
  after: number;
}

/**
 * Emit text in chunks so the transcript streams the way a live run does.
 *
 * Chunks must concatenate back to the original byte-for-byte: split on word boundaries and
 * carry the trailing whitespace with each word. Splitting on punctuation and re-joining with
 * a space turns `calc.js` into `calc. js`.
 */
function stream(text: string): Step[] {
  const words = text.match(/\S+\s*/g) ?? [];
  const steps: Step[] = [];
  for (let i = 0; i < words.length; i += 3) {
    steps.push({
      event: { type: "builder.text", text: words.slice(i, i + 3).join("") } as ArenaEvent,
      after: 45,
    });
  }
  return steps;
}

export async function replayFixture(emit: (event: ArenaEvent) => void): Promise<void> {
  const steps: Step[] = [
    // --- conversation: read-only, no gatekeeper, no decision made yet ------------------
    { event: { type: "user.message", text: USER_1 }, after: 500 },
    { event: { type: "phase", phase: "chatting", round: 1 }, after: 400 },
    { event: { type: "builder.tool", name: "Read", input: { file_path: "calc.js" } }, after: 350 },
    ...stream(REPLY_1),
    { event: { type: "user.message", text: USER_2 }, after: 1100 },
    { event: { type: "phase", phase: "chatting", round: 1 }, after: 400 },
    ...stream(REPLY_2),

    // --- the engineer presses "Build this". Only now does anything happen. ------------
    { event: { type: "snapshot", ref: "5365c7fc9a1b4e2d", label: "build-start" }, after: 900 },

    { event: { type: "phase", phase: "planning", round: 1 }, after: 500 },
    { event: { type: "builder.tool", name: "Read", input: { file_path: "README.md" } }, after: 350 },
    ...stream(PLAN),

    { event: { type: "phase", phase: "plan_review", round: 1 }, after: 600 },
    { event: { type: "gatekeeper.item", kind: "command", text: "sed -n '1,240p' README.md" }, after: 500 },
    { event: { type: "gatekeeper.item", kind: "command", text: "nl -ba calc.js" }, after: 700 },
    { event: { type: "review", phase: "plan_review", review: PLAN_REVIEW }, after: 900 },

    { event: { type: "phase", phase: "implementing", round: 1 }, after: 500 },
    { event: { type: "builder.tool", name: "Edit", input: { file_path: "calc.js" } }, after: 400 },
    {
      event: {
        type: "builder.permission",
        name: "Bash",
        decision: "deny",
        reason:
          "`git add` changes git state. CodeArena owns the repository's git state: it snapshots your work to produce the review diff and to roll back if the review fails, and a commit, reset or checkout mid-task invalidates that baseline. Edit files; leave git to CodeArena. (git status/diff/log/show are available.)",
      },
      after: 700,
    },
    ...stream(BUILDER_ROUND_1),
    { event: { type: "snapshot", ref: "a71c3f80d5e6b912", label: "round-1" }, after: 300 },

    { event: { type: "phase", phase: "diff_review", round: 1 }, after: 600 },
    { event: { type: "gatekeeper.item", kind: "command", text: "nl -ba calc.js" }, after: 600 },
    { event: { type: "gatekeeper.item", kind: "command", text: "git diff --check" }, after: 600 },
    { event: { type: "review", phase: "diff_review", review: DIFF_REVIEW_1 }, after: 1400 },

    { event: { type: "phase", phase: "implementing", round: 2 }, after: 500 },
    { event: { type: "builder.tool", name: "Edit", input: { file_path: "calc.js" } }, after: 500 },
    ...stream(BUILDER_ROUND_2),
    { event: { type: "snapshot", ref: "c92d5a17f3b8e045", label: "round-2" }, after: 300 },

    { event: { type: "phase", phase: "diff_review", round: 2 }, after: 600 },
    { event: { type: "gatekeeper.item", kind: "command", text: "sed -n '1,40p' calc.js" }, after: 700 },
    { event: { type: "review", phase: "diff_review", review: DIFF_REVIEW_2 }, after: 900 },

    { event: { type: "phase", phase: "approved", round: 2 }, after: 200 },
    {
      event: {
        type: "cost",
        cost: {
          builderUsd: 0.2143,
          gatekeeperInputTokens: 24518,
          gatekeeperCachedInputTokens: 18944,
          gatekeeperOutputTokens: 1876,
        },
      },
      after: 200,
    },
    {
      event: {
        type: "done",
        result: {
          phase: "approved",
          plan: PLAN,
          rounds: [
            { round: 1, phase: "plan_review", review: PLAN_REVIEW },
            { round: 1, phase: "diff_review", review: DIFF_REVIEW_1 },
            { round: 2, phase: "diff_review", review: DIFF_REVIEW_2 },
          ],
          diff: DEMO_DIFF,
          cost: {
            builderUsd: 0.2143,
            gatekeeperInputTokens: 24518,
            gatekeeperCachedInputTokens: 18944,
            gatekeeperOutputTokens: 1876,
          },
        },
      },
      after: 0,
    },
  ];

  for (const step of steps) {
    emit(step.event);
    if (step.after) await sleep(step.after);
  }
}

const DEMO_DIFF = `diff --git a/calc.js b/calc.js
--- a/calc.js
+++ b/calc.js
@@ -1,10 +1,16 @@
 export function divide(a, b) {
+  if (b === 0) {
+    throw new TypeError("divide: divisor must not be zero");
+  }
   return a / b;
 }

 export function average(numbers) {
+  if (numbers.length === 0) {
+    throw new TypeError("average: numbers must not be empty");
+  }
   let total = 0;
   for (const n of numbers) total += n;
-  return total / numbers.length;
+  return divide(total, numbers.length);
 }
`;
