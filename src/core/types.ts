/**
 * CodeArena core types.
 *
 * Two agents, two roles:
 *   - Builder    (Claude, via @anthropic-ai/claude-agent-sdk) plans and writes code.
 *   - Gatekeeper (Codex,  via @openai/codex-sdk)              reviews and votes.
 *
 * The orchestrator owns the loop between them; neither agent knows the other exists
 * beyond the text it is handed.
 */

export type Phase =
  | "chatting"
  | "planning"
  | "plan_review"
  | "implementing"
  | "diff_review"
  | "approved"
  | "escalated"
  | "failed";

export type Verdict = "approve" | "request_changes";

export type Severity = "blocker" | "major" | "minor";

export interface Finding {
  severity: Severity;
  /** Repo-relative path, or null for findings that aren't anchored to a file. */
  file: string | null;
  /** 1-indexed line in the post-change file, when known. */
  line: number | null;
  /** One sentence: what is wrong. */
  issue: string;
  /** Concrete inputs/state that make it go wrong. Keeps the reviewer honest. */
  evidence: string;
  /** What the builder should do about it. */
  suggestion: string;
}

export interface Review {
  verdict: Verdict;
  summary: string;
  findings: Finding[];
}

/** What one round of the loop cost, per provider. */
export interface Cost {
  /** USD, as reported by the Claude Agent SDK. Zero-ish under a subscription plan. */
  builderUsd: number;
  gatekeeperInputTokens: number;
  gatekeeperCachedInputTokens: number;
  gatekeeperOutputTokens: number;
}

export interface RoundRecord {
  round: number;
  phase: Extract<Phase, "plan_review" | "diff_review">;
  review: Review;
  /** Git ref of the snapshot taken before this round's changes, for rollback. */
  snapshot?: string;
}

export interface TaskResult {
  phase: Phase;
  plan: string | null;
  rounds: RoundRecord[];
  /** Unified diff of everything the builder changed, relative to the start snapshot. */
  diff: string;
  cost: Cost;
  /** Set when phase is "failed". */
  error?: string;
}

/** Everything the orchestrator emits, for the CLI and later the Electron UI to render. */
export type ArenaEvent =
  | { type: "phase"; phase: Phase; round: number }
  | { type: "user.message"; text: string }
  | { type: "session"; sessionId: string | null }
  | { type: "builder.text"; text: string }
  | { type: "builder.tool"; name: string; input: unknown }
  | { type: "builder.permission"; name: string; decision: "allow" | "deny"; reason?: string }
  | { type: "gatekeeper.item"; kind: string; text: string }
  | { type: "review"; phase: Phase; review: Review }
  | { type: "snapshot"; ref: string; label: string }
  | { type: "cost"; cost: Cost }
  | { type: "done"; result: TaskResult }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

export interface ArenaConfig {
  /** Absolute path to the project the agents work on. Must be a git repo. */
  projectDir: string;
  /** Max builder<->gatekeeper round trips per review phase before escalating to the human. */
  maxRounds: number;
  /** Hard USD ceiling handed to the Claude Agent SDK. Ignored under subscription auth. */
  maxBudgetUsd?: number;
  builderModel?: string;
  gatekeeperModel?: string;
  /** Absolute path to a code-signed codex binary. Never the npm-vendored one. */
  codexPath: string;
  /** Absolute path to the user's Claude Code binary. Omit to use the SDK's bundled copy. */
  claudePath?: string;
  /** Skip the plan review and go straight to implementing after planning. */
  skipPlanReview?: boolean;

  /**
   * Enable the Claude Agent SDK's OS-level sandbox for the builder. This is the real
   * security boundary; policy.ts is the semantic guardrail layered on top. Default true.
   */
  sandbox?: boolean;
  /** Let the builder run git history commands. Breaks rollback -- see policy.ts. */
  allowGitWrites?: boolean;
  /** Let the builder publish/release. Default false. */
  allowPublish?: boolean;
}
