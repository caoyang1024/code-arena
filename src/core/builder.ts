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

  const response = query({
    prompt,
    options: {
      cwd: config.projectDir,
      ...(config.builderModel ? { model: config.builderModel } : {}),
      permissionMode: opts.plan ? "plan" : "default",
      ...(opts.resume ? { resume: opts.resume } : {}),
      ...(config.maxBudgetUsd !== undefined ? { maxBudgetUsd: config.maxBudgetUsd } : {}),
      systemPrompt: { type: "preset", preset: "claude_code" },
      // Layer 1: kernel-enforced isolation.
      //
      // Deliberately NOT setting `autoAllowBashIfSandboxed`. It sounds like a convenience,
      // but auto-approved calls bypass `canUseTool` entirely -- which would silently disable
      // Layer 2 below, including the git-history rule that rollback depends on. The sandbox
      // and the policy have to both run, so every bash call must fall through to the prompt
      // path that invokes our callback.
      ...(config.sandbox === false ? {} : { sandbox: { enabled: true } }),
      // Layer 2: CodeArena adjudicates every call the permission flow would have prompted
      // a human for. Denials carry a reason so the model adapts instead of retrying.
      canUseTool: async (request) => {
        const name = (request as { tool_name?: string }).tool_name ?? "unknown";
        const input = (request as { input?: unknown }).input ?? {};

        if (opts.plan) {
          // Belt and braces: plan mode already enforces read-only, but never let a write
          // through on our side either.
          denials += 1;
          emit({
            type: "builder.permission",
            name,
            decision: "deny",
            reason: "planning phase is read-only",
          });
          return { behavior: "deny", message: "Planning phase is read-only." };
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

  for await (const message of response) {
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
        text = message.result;
      } else {
        throw new Error(
          `Builder ended with ${message.subtype}: ${message.errors?.join("; ") ?? "no detail"}`,
        );
      }
    }
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
