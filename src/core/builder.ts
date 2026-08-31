/**
 * The builder: Claude, driven through the Claude Agent SDK.
 *
 * Two calls matter here:
 *   plan()      -- permissionMode 'plan' puts the SDK in read-only enforcement, so Claude
 *                  can explore the repo and propose an approach without touching a file.
 *   implement() -- default permissions, with every prompted tool call routed through our
 *                  canUseTool gate so CodeArena stays the permission authority and gets an
 *                  audit trail of the writes.
 *
 * Sessions are resumed across rounds (`resume: sessionId`) so revision rounds cost a
 * fraction of a cold start -- Claude still remembers what it built and why.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Policy } from "./policy.js";
import type { ArenaConfig, ArenaEvent, Finding } from "./types.js";

/** Tools that write. Denied outright while planning; policed by policy.ts while building. */
const MUTATING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Abort a turn that has gone this long without producing a single message. */
const SILENCE_TIMEOUT_MS = 150_000;

/**
 * Account-level failures (quota, billing, auth) arrive as an ordinary successful result whose
 * entire text is the error. They are recognisable by being short, tool-free, single-turn, and
 * matching one of these phrases -- a real plan is none of those things.
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
  const hit = ACCOUNT_FAILURES.find((p) => p.test(text));
  return hit ? `Builder could not run — the account reported: "${text}"` : null;
}

export interface BuilderTurn {
  text: string;
  sessionId: string | null;
  costUsd: number;
  denials: number;
}

type Emit = (event: ArenaEvent) => void;

const PLAN_PREAMBLE = `You are the implementer on a two-model team. Another model reviews
everything you produce before it is accepted, and it can see the repository.

Produce an implementation plan. Be specific about which files you will create or modify and
what each change does. State the assumptions you are making and any part of the request that
is ambiguous -- the reviewer will check those first. Do not write the code yet.`;

const IMPLEMENT_PREAMBLE = `You are the implementer on a two-model team. Implement the approved
plan now. Match the conventions of the surrounding code. When you are done, state briefly what
you changed and anything you deliberately left out.`;

const REVISE_PREAMBLE = `The reviewer rejected your work. Address every blocker and major
finding below. If you believe a finding is wrong, fix nothing for that one but say so
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

async function drive(
  prompt: string,
  config: ArenaConfig,
  emit: Emit,
  opts: { plan: boolean; resume?: string | null },
): Promise<BuilderTurn> {
  const policy = new Policy({
    projectDir: config.projectDir,
    ...(config.allowGitWrites !== undefined ? { allowGitWrites: config.allowGitWrites } : {}),
    ...(config.allowPublish !== undefined ? { allowPublish: config.allowPublish } : {}),
  });

  let text = "";
  let sessionId: string | null = opts.resume ?? null;
  let costUsd = 0;
  let denials = 0;

  const abort = new AbortController();
  const response = query({
    prompt,
    options: {
      abortController: abort,
      cwd: config.projectDir,
      ...(config.builderModel ? { model: config.builderModel } : {}),
      permissionMode: opts.plan ? "plan" : "default",
      ...(opts.resume ? { resume: opts.resume } : {}),
      ...(config.maxBudgetUsd !== undefined ? { maxBudgetUsd: config.maxBudgetUsd } : {}),
      systemPrompt: { type: "preset", preset: "claude_code" },
      // Layer 1: kernel-enforced isolation. OFF BY DEFAULT -- it hangs.
      //
      // Measured on claude-agent-sdk 0.1.77 / macOS 25.6: with `sandbox: { enabled: true }`,
      // query() emits system:init at ~0.6s and then never yields another message. The same
      // call without it returns in 3.7s. Worse, the hang swallows account-level errors: a
      // "Credit balance is too low" result that surfaces in 3.7s unsandboxed simply never
      // arrives, so the run looks like a slow model instead of a failed one.
      //
      // Opt in with `sandbox: true` once that is understood; layer 2 (policy.ts) runs either
      // way. Note this means location containment currently rests on the policy's path
      // checks, which are lexical -- see the symlink note in policy.ts.
      ...(config.sandbox === true ? { sandbox: { enabled: true } } : {}),
      // Layer 2: CodeArena adjudicates every call the permission flow would have prompted
      // a human for. Denials carry a reason so the model adapts instead of retrying.
      canUseTool: async (request) => {
        const name = (request as { tool_name?: string }).tool_name ?? "unknown";
        const input = (request as { input?: unknown }).input ?? {};

        // During planning, deny the tools that mutate -- and ONLY those.
        //
        // This used to deny everything that reached the callback, on "belt and braces"
        // reasoning. That was wrong and it deadlocked the phase: plan mode still routes
        // some reads through the permission prompt, so blanket denial meant the builder
        // could not open a single file, retried forever, and spent ten minutes producing
        // nothing. A gate that denies reads to a planner denies it the ability to plan.
        if (opts.plan && MUTATING_TOOLS.has(name)) {
          denials += 1;
          const reason = `${name} modifies files; the planning phase is read-only.`;
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

  // A hung SDK is indistinguishable from a slow model without one of these: the run above
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
        // "Credit balance is too low" to the gatekeeper as if it were a plan. Catch it here.
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

  } finally {
    clearInterval(watchdog);
  }

  return { text, sessionId, costUsd, denials };
}

export function plan(task: string, config: ArenaConfig, emit: Emit): Promise<BuilderTurn> {
  return drive(`${PLAN_PREAMBLE}\n\n--- TASK ---\n${task}`, config, emit, { plan: true });
}

export function replan(
  task: string,
  previousPlan: string,
  findings: Finding[],
  summary: string,
  config: ArenaConfig,
  emit: Emit,
  sessionId: string | null,
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
    "",
    "--- ORIGINAL TASK ---",
    task,
    ...(sessionId ? [] : ["", "--- YOUR PREVIOUS PLAN ---", previousPlan]),
  ].join("\n");
  return drive(prompt, config, emit, { plan: true, resume: sessionId });
}

export function implement(
  task: string,
  approvedPlan: string,
  config: ArenaConfig,
  emit: Emit,
  sessionId: string | null,
): Promise<BuilderTurn> {
  const prompt = [
    IMPLEMENT_PREAMBLE,
    "",
    "--- TASK ---",
    task,
    "",
    "--- APPROVED PLAN ---",
    approvedPlan,
  ].join("\n");
  return drive(prompt, config, emit, { plan: false, resume: sessionId });
}

export function revise(
  findings: Finding[],
  summary: string,
  config: ArenaConfig,
  emit: Emit,
  sessionId: string | null,
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
  return drive(prompt, config, emit, { plan: false, resume: sessionId });
}
