/**
 * The builder: Claude, driven through the Claude Agent SDK.
 *
 * One session, three modes. The session is the important part: chat, planning and
 * implementation are consecutive turns on the *same* thread, so when you finally say "build
 * it", the plan is grounded in everything the two of you just worked out -- the constraint
 * you mentioned in passing, the approach you rejected, the file you pointed at. Restarting a
 * fresh session at build time would throw all of that away and make the model guess again.
 *
 *   chat  -- read-only. Explore, argue, change your mind. Nothing is written, ever.
 *   plan  -- read-only, plan mode. Entered only when the user decides to build.
 *   build -- writes, policed by policy.ts.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Policy } from "./policy.js";
import type { ArenaConfig, ArenaEvent, Finding, TurnControl } from "./types.js";

export type BuilderMode = "chat" | "plan" | "build";

export interface BuilderTurn {
  text: string;
  /** True when the user stopped this turn rather than it finishing. */
  cancelled?: boolean;
  sessionId: string | null;
  costUsd: number;
  denials: number;
}

type Emit = (event: ArenaEvent) => void;

/** Tools that write. Denied outright while chatting or planning. */
const MUTATING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * Leaving plan mode is itself the dangerous act.
 *
 * ExitPlanMode used to fall through to the policy's `default: ALLOW`. Allowing it ends plan
 * mode, and everything the SDK auto-approves afterwards never reaches canUseTool at all --
 * so the write denials below simply stopped firing. Observed on a real run: during a phase
 * the UI labelled "PLANNING (read-only)" the builder made two Writes and an Edit, with zero
 * denials recorded, and the "plan" handed to the gatekeeper was a report of work already
 * done. The reviewer's own language gave it away; it wrote about the change in the past
 * tense.
 *
 * This is the same shape as the autoAllowBashIfSandboxed trap: an auto-approved call is one
 * this process never sees. The only reliable defence is to refuse the thing that flips the
 * mode, not the things that become possible afterwards.
 */
const PHASE_ESCAPES = new Set(["ExitPlanMode", "exit_plan_mode"]);

/**
 * Abort a turn that has produced nothing at all for this long.
 *
 * Deliberately generous. Messages arrive between tool calls, not during them, so this timer
 * cannot distinguish "the SDK has hung" from "npm test is still running" -- and running the
 * tests is exactly what the build phase should be doing. At 150s it killed any turn with a
 * slow command in it.
 *
 * This is a backstop against a wedged subprocess, not a policy on how long work may take.
 * Deciding that a turn is taking too long is the user's call, and there is a Stop button for
 * it now; before there was one, this timer was standing in for it, which is why it was set so
 * aggressively.
 */
const SILENCE_TIMEOUT_MS = 15 * 60_000;

/**
 * Account-level failures (quota, billing, auth) arrive as an ordinary successful result whose
 * entire text is the error. They are recognisable by being short, tool-free, single-turn, and
 * matching one of these phrases -- a real answer is none of those things.
 */
const ACCOUNT_FAILURES = [
  /credit balance is too low/i,
  /insufficient credits?/i,
  /quota (has been )?exceeded/i,
  /rate limit(ed)? exceeded/i,
  /usage limit reached/i,
  /invalid api key/i,
  /authentication[_ ]error/i,
  /please run .?claude.? to (log ?in|authenticate)/i,
];

function accountFailure(result: string, turns: number): string | null {
  const text = result.trim();
  if (turns > 1 || text.length > 300) return null;
  return ACCOUNT_FAILURES.some((p) => p.test(text))
    ? `Builder could not run — the account reported: "${text}"`
    : null;
}

// -----------------------------------------------------------------------------------------
// prompts

const CHAT_SYSTEM = `You are the implementer on a two-model team, currently in conversation
with the engineer. Nothing you say here is being built yet.

You cannot modify anything, by design. Read the code, answer the question, and say what you
would actually do. If the request is ambiguous or you think the premise is wrong, say so now
-- this conversation is exactly where that belongs, and it is cheaper than being told by the
reviewer later.

Do not produce an implementation plan unless asked. The engineer decides when to build.`;

const PLAN_PREAMBLE = `The engineer has decided to build what you just discussed. Write the
implementation plan now.

You cannot modify anything in this phase, by design. Write the plan out as your answer and
stop -- do not try to leave planning or begin the work. Implementation starts only after the
reviewer approves, and you will be asked for it explicitly.

A second model reviews this plan before you touch a single file, and it can read the
repository. Be specific about which files you will create or modify and what each change
does. State your assumptions and anything still ambiguous -- the reviewer checks those first.
Do not write the code yet.`;

const BUILD_PREAMBLE = `Your plan was approved. Implement it now. Match the conventions of the
surrounding code. When you are done, say briefly what you changed and anything you
deliberately left out.`;

const REVISE_PREAMBLE = `The reviewer rejected your work. Address every blocker and major
finding below. If you believe a finding is wrong, change nothing for that one but say so
explicitly and explain why -- do not silently ignore it.`;

export function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) return "(no itemised findings)";
  return findings
    .map((f, i) => {
      const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "(no file)";
      return [
        `${i + 1}. [${f.severity}] ${loc}`,
        `   Issue: ${f.issue}`,
        `   Evidence: ${f.evidence}`,
        `   Suggested fix: ${f.suggestion}`,
      ].join("\n");
    })
    .join("\n\n");
}

// -----------------------------------------------------------------------------------------

async function drive(
  prompt: string,
  config: ArenaConfig,
  emit: Emit,
  opts: { mode: BuilderMode; resume: string | null; control?: TurnControl },
): Promise<BuilderTurn> {
  const readOnly = opts.mode !== "build";
  const policy = new Policy({
    projectDir: config.projectDir,
    readOnly,
    ...(config.allowGitWrites !== undefined ? { allowGitWrites: config.allowGitWrites } : {}),
    ...(config.allowPublish !== undefined ? { allowPublish: config.allowPublish } : {}),
  });

  let text = "";
  let sessionId: string | null = opts.resume;
  let costUsd = 0;
  let denials = 0;

  const abort = new AbortController();
  // Fold the caller's cancellation into this turn's controller.
  const external = opts.control?.signal;
  if (external) {
    if (external.aborted) abort.abort();
    else external.addEventListener("abort", () => abort.abort(), { once: true });
  }

  const response = query({
    prompt,
    options: {
      abortController: abort,
      cwd: config.projectDir,
      // Drive the Claude Code the user actually signed in to, rather than the SDK's bundled
      // copy -- the same reasoning as codex-path.ts. Keeps versions and credentials in one
      // place instead of two.
      ...(config.claudePath ? { pathToClaudeCodeExecutable: config.claudePath } : {}),
      ...(config.builderModel ? { model: config.builderModel } : {}),
      // Always "default" -- never the SDK's plan mode.
      //
      // Plan mode looks like the right tool for a read-only planning phase, and its read-only
      // enforcement is real, but it ships with its own exit: ExitPlanMode. That call is
      // auto-approved by the mode, and permissionMode auto-approvals never reach canUseTool,
      // so the callback below cannot refuse it. Once it lands, the mode is gone and every
      // subsequent write is auto-approved too -- invisibly, with no denial recorded.
      //
      // Twice observed on real runs: a phase the UI labelled "PLANNING (read-only)" made
      // Writes and Edits, and the "plan" handed to the reviewer was a report of work already
      // finished. Denying ExitPlanMode in canUseTool did not help, for the same reason it
      // could not have.
      //
      // In default mode there is no mode to escape and writes fall through to canUseTool,
      // which is the path policy.ts covers with 109 assertions. Planning and chatting now
      // differ only in the prompt, which is the only thing that should have differed.
      permissionMode: "default",
      ...(opts.resume ? { resume: opts.resume } : {}),
      // Nothing should be reaching for it now, but leaving it available invites the model to
      // announce a mode change that is not happening.
      ...(readOnly ? { disallowedTools: ["ExitPlanMode"] } : {}),
      ...(config.maxBudgetUsd !== undefined ? { maxBudgetUsd: config.maxBudgetUsd } : {}),
      systemPrompt:
        opts.mode === "chat"
          ? { type: "preset", preset: "claude_code", append: CHAT_SYSTEM }
          : { type: "preset", preset: "claude_code" },

      // Layer 1: kernel-enforced isolation. ON by default.
      //
      // It was off for a while on the strength of a bad measurement: with the SDK's own
      // bundled cli.js (0.1.77) a sandboxed query emits system:init and then never yields
      // again -- not even an AbortController ends it. That was recorded as "the sandbox
      // hangs". It is the bundled binary that hangs. Against the Claude Code the user is
      // actually signed in to (2.1.247, which is what claudePath resolves to) the same call
      // returns in 4.9s.
      //
      // And it enforces: `node -e "fs.writeFileSync('/tmp/x')"` writes the file with the
      // sandbox off and fails with EPERM from the kernel with it on. That is exactly the
      // escape policy.ts cannot close, because build mode legitimately needs interpreters
      // and no amount of string analysis reaches inside one.
      //
      // Pass `sandbox: false` if a toolchain needs something it denies.
      ...(config.sandbox === false ? {} : { sandbox: { enabled: true } }),

      // Layer 2: CodeArena adjudicates every call the permission flow would have prompted a
      // human for. Denials carry a reason so the model adapts instead of retrying.
      canUseTool: async (request) => {
        const name = (request as { tool_name?: string }).tool_name ?? "unknown";
        const input = (request as { input?: unknown }).input ?? {};

        // Deny the tools that mutate -- and ONLY those. An earlier version denied everything
        // that reached this callback while planning, on "belt and braces" reasoning. That
        // deadlocked the phase: the builder could not open a single file, retried, and spun
        // for ten minutes producing nothing. A gate that denies reads to a planner denies it
        // the ability to plan.
        if (readOnly && PHASE_ESCAPES.has(name)) {
          denials += 1;
          const reason =
            opts.mode === "plan"
              ? "Stay in plan mode. Write the plan out as your answer and stop; CodeArena " +
                "moves to implementation only after the reviewer approves it."
              : "We are still talking. Nothing is written until the engineer decides to build.";
          emit({ type: "builder.permission", name, decision: "deny", reason });
          return { behavior: "deny", message: reason };
        }

        if (readOnly && MUTATING_TOOLS.has(name)) {
          denials += 1;
          const reason =
            opts.mode === "chat"
              ? `${name} modifies files. We are still talking — nothing is written until you decide to build.`
              : `${name} modifies files; the planning phase is read-only.`;
          emit({ type: "builder.permission", name, decision: "deny", reason });
          return { behavior: "deny", message: reason };
        }

        const decision = policy.check(name, input);
        if (!decision.allow) {
          denials += 1;
          emit({ type: "builder.permission", name, decision: "deny", reason: decision.reason });
          return { behavior: "deny", message: decision.reason };
        }

        emit({ type: "builder.permission", name, decision: "allow" });
        return { behavior: "allow", updatedInput: input as Record<string, unknown> };
      },
    },
  });

  // A hung SDK is indistinguishable from a slow model without one of these: an earlier run
  // sat silent for ten minutes before anyone noticed it was never going to finish.
  let lastMessageAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastMessageAt > SILENCE_TIMEOUT_MS) {
      clearInterval(watchdog);
      emit({
        type: "log",
        level: "error",
        message:
          `Builder produced nothing for ${SILENCE_TIMEOUT_MS / 1000}s; aborting. ` +
          `If the OS sandbox is enabled, that is the first thing to suspect.`,
      });
      abort.abort();
    }
  }, 5_000);

  try {
    for await (const message of response) {
      lastMessageAt = Date.now();
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            text += block.text;
            emit({ type: "builder.text", text: block.text });
          } else if (block.type === "tool_use") {
            emit({ type: "builder.tool", name: block.name, input: block.input });
          }
        }
      } else if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      } else if (message.type === "result") {
        costUsd = message.total_cost_usd;
        sessionId = message.session_id;
        if (message.subtype === "success") {
          // A quota or billing failure comes back as subtype "success" with the error as the
          // whole assistant text -- so the orchestrator would happily hand
          // "Credit balance is too low" to the gatekeeper as if it were a plan.
          const failure = accountFailure(message.result, message.num_turns);
          if (failure) throw new Error(failure);
          text = message.result;
        } else {
          throw new Error(
            `Builder ended with ${message.subtype}: ${message.errors?.join("; ") ?? "no detail"}`,
          );
        }
      }
    }
  } catch (error) {
    // An abort is a user decision, not a failure. Surface it as one.
    if (external?.aborted) return { text, sessionId, costUsd, denials, cancelled: true };
    throw error;
  } finally {
    clearInterval(watchdog);
  }

  return { text, sessionId, costUsd, denials, cancelled: external?.aborted ?? false };
}

// -----------------------------------------------------------------------------------------
// the four things the builder is asked to do

/** An ordinary conversational turn. Read-only; no gatekeeper involved. */
export function chat(
  message: string,
  config: ArenaConfig,
  emit: Emit,
  sessionId: string | null,
  control?: TurnControl,
): Promise<BuilderTurn> {
  return drive(message, config, emit, { mode: "chat", resume: sessionId, ...(control ? { control } : {}) });
}

/** Entered when the user decides to build. Resumes the conversation that led here. */
export function plan(
  config: ArenaConfig,
  emit: Emit,
  sessionId: string | null,
  instruction?: string,
  control?: TurnControl,
): Promise<BuilderTurn> {
  const prompt = instruction
    ? `${PLAN_PREAMBLE}\n\n--- WHAT TO BUILD ---\n${instruction}`
    : PLAN_PREAMBLE;
  return drive(prompt, config, emit, { mode: "plan", resume: sessionId, ...(control ? { control } : {}) });
}

export function replan(
  findings: Finding[],
  summary: string,
  config: ArenaConfig,
  emit: Emit,
  sessionId: string | null,
  control?: TurnControl,
): Promise<BuilderTurn> {
  const prompt = [
    REVISE_PREAMBLE,
    "",
    "--- REVIEWER SUMMARY ---",
    summary,
    "",
    "--- FINDINGS ---",
    renderFindings(findings),
    "",
    "Produce the corrected plan. Still do not write code.",
  ].join("\n");
  return drive(prompt, config, emit, { mode: "plan", resume: sessionId, ...(control ? { control } : {}) });
}

export function implement(
  config: ArenaConfig,
  emit: Emit,
  sessionId: string | null,
  control?: TurnControl,
): Promise<BuilderTurn> {
  return drive(BUILD_PREAMBLE, config, emit, { mode: "build", resume: sessionId, ...(control ? { control } : {}) });
}

export function revise(
  findings: Finding[],
  summary: string,
  config: ArenaConfig,
  emit: Emit,
  sessionId: string | null,
  control?: TurnControl,
): Promise<BuilderTurn> {
  const prompt = [
    REVISE_PREAMBLE,
    "",
    "--- REVIEWER SUMMARY ---",
    summary,
    "",
    "--- FINDINGS ---",
    renderFindings(findings),
  ].join("\n");
  return drive(prompt, config, emit, { mode: "build", resume: sessionId, ...(control ? { control } : {}) });
}
