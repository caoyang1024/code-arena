/**
 * The renderer is a pure fold over the ArenaEvent stream: events in, transcript blocks out.
 * It holds no knowledge of how a task runs -- the orchestrator in the main process owns all
 * of that -- which is why the CLI and this app can render the same run without sharing code.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArenaEvent, Finding, Phase, Review, TaskResult } from "../core/types.js";

// -----------------------------------------------------------------------------------------
// bridge

interface DoctorReport {
  builder: { ok: boolean; detail: string };
  gatekeeper: { ok: boolean; detail: string; path?: string; version?: string };
  project: { ok: boolean; detail: string; branch?: string; dirty?: boolean };
}

interface TurnOptions {
  projectDir: string;
  maxRounds: number;
  skipPlanReview: boolean;
}

interface ArenaApi {
  doctor(projectDir: string): Promise<DoctorReport>;
  pickProject(): Promise<string | null>;
  chat(opts: TurnOptions & { message: string }): Promise<{ started: boolean; reason?: string }>;
  build(
    opts: TurnOptions & { instruction?: string; demo?: boolean },
  ): Promise<{ started: boolean; reason?: string }>;
  reset(): Promise<void>;
  revealDiff(projectDir: string): Promise<void>;
  onEvent(cb: (event: ArenaEvent) => void): () => void;
  onIdle(cb: () => void): () => void;
}

declare global {
  interface Window {
    arena: ArenaApi;
  }
}

// -----------------------------------------------------------------------------------------
// transcript model

type Block =
  | { kind: "user"; id: number; text: string }
  | { kind: "builder"; id: number; phase: Phase; round: number; text: string; tools: string[] }
  | { kind: "gatekeeper"; id: number; phase: Phase; round: number; commands: string[]; review?: Review }
  | { kind: "denial"; id: number; name: string; reason: string }
  | { kind: "snapshot"; id: number; ref: string; label: string }
  | { kind: "outcome"; id: number; result: TaskResult }
  | { kind: "note"; id: number; level: "info" | "warn" | "error"; message: string };

let nextId = 0;

/**
 * Continuation events (streamed text, tool chips, verdicts) attach to the most recent block
 * of the matching kind -- NOT to the tail.
 *
 * They are not the same thing: interstitials like a policy denial or a snapshot marker get
 * pushed between a block and the events still flowing into it. Matching on the tail silently
 * dropped every token the builder emitted after its first denied tool call.
 */
function lastIndexOfKind(blocks: Block[], kind: Block["kind"]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]!.kind === kind) return i;
  }
  return -1;
}

function replaceAt(blocks: Block[], index: number, block: Block): Block[] {
  const next = blocks.slice();
  next[index] = block;
  return next;
}

function reduce(blocks: Block[], event: ArenaEvent): Block[] {

  switch (event.type) {
    case "user.message":
      return [...blocks, { kind: "user", id: nextId++, text: event.text }];

    case "phase": {
      if (event.phase === "approved" || event.phase === "escalated" || event.phase === "failed") {
        return blocks;
      }
      const isBuilder =
        event.phase === "chatting" ||
        event.phase === "planning" ||
        event.phase === "implementing";
      return [
        ...blocks,
        isBuilder
          ? { kind: "builder", id: nextId++, phase: event.phase, round: event.round, text: "", tools: [] }
          : { kind: "gatekeeper", id: nextId++, phase: event.phase, round: event.round, commands: [] },
      ];
    }

    case "builder.text": {
      const i = lastIndexOfKind(blocks, "builder");
      const target = blocks[i];
      if (target?.kind !== "builder") return blocks;
      return replaceAt(blocks, i, { ...target, text: target.text + event.text });
    }

    case "builder.tool": {
      const i = lastIndexOfKind(blocks, "builder");
      const block = blocks[i];
      if (block?.kind !== "builder") return blocks;
      const input = (event.input as { file_path?: string; command?: string } | null) ?? {};
      const label = input.file_path ?? input.command ?? "";
      const entry = label ? `${event.name} ${shortenPath(label)}` : event.name;
      if (block.tools.includes(entry)) return blocks;
      return replaceAt(blocks, i, { ...block, tools: [...block.tools, entry] });
    }

    case "builder.permission":
      if (event.decision !== "deny" || !event.reason) return blocks;
      return [...blocks, { kind: "denial", id: nextId++, name: event.name, reason: event.reason }];

    case "gatekeeper.item": {
      if (event.kind !== "command") return blocks;
      const i = lastIndexOfKind(blocks, "gatekeeper");
      const block = blocks[i];
      if (block?.kind !== "gatekeeper") return blocks;
      const cmd = event.text.split("\n")[0]!.trim();
      if (block.commands.includes(cmd)) return blocks;
      return replaceAt(blocks, i, { ...block, commands: [...block.commands, cmd] });
    }

    case "review": {
      const i = lastIndexOfKind(blocks, "gatekeeper");
      const block = blocks[i];
      if (block?.kind !== "gatekeeper") return blocks;
      return replaceAt(blocks, i, { ...block, review: event.review });
    }

    case "snapshot":
      return [...blocks, { kind: "snapshot", id: nextId++, ref: event.ref, label: event.label }];

    case "done":
      return [...blocks, { kind: "outcome", id: nextId++, result: event.result }];

    case "log":
      if (event.level === "info") return blocks;
      return [...blocks, { kind: "note", id: nextId++, level: event.level, message: event.message }];

    default:
      return blocks;
  }
}

function shortenPath(p: string): string {
  if (p.length <= 42) return p;
  const parts = p.split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : `…${p.slice(-40)}`;
}

// -----------------------------------------------------------------------------------------
// phase rail

const RAIL: Array<{ phase: Phase; label: string; side: "builder" | "gate" }> = [
  { phase: "chatting", label: "Talking", side: "builder" },
  { phase: "planning", label: "Plan", side: "builder" },
  { phase: "plan_review", label: "Plan review", side: "gate" },
  { phase: "implementing", label: "Implement", side: "builder" },
  { phase: "diff_review", label: "Diff review", side: "gate" },
];

function PhaseRail({ current, round }: { current: Phase | null; round: number }) {
  const index = RAIL.findIndex((s) => s.phase === current);
  const settled = current === "approved" || current === "escalated" || current === "failed";

  return (
    <div className="rail">
      {RAIL.map((step, i) => {
        const active = i === index && !settled;
        const done = settled || (index >= 0 && i < index);
        return (
          <div key={step.phase} style={{ display: "contents" }}>
            {i > 0 && <div className={`connector${done || active ? " done" : ""}`} />}
            <div className={`step ${step.side}${active ? " active" : ""}${done ? " done" : ""}`}>
              <div className="pip" />
              {step.label}
              {active && round > 1 && <span className="round-badge">×{round}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// -----------------------------------------------------------------------------------------
// blocks

const PHASE_LABEL: Partial<Record<Phase, string>> = {
  chatting: "thinking it through",
  planning: "planning",
  implementing: "implementing",
  plan_review: "reviewing the plan",
  diff_review: "reviewing the diff",
};

/** Minimal inline markdown: `code` and **bold**. The agents write in this register. */
function RichText({ text }: { text: string }) {
  const nodes = useMemo(() => {
    const out: React.ReactNode[] = [];
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let key = 0;
    while ((m = pattern.exec(text)) !== null) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const token = m[0];
      out.push(
        token.startsWith("`") ? (
          <code key={key++}>{token.slice(1, -1)}</code>
        ) : (
          <strong key={key++}>{token.slice(2, -2)}</strong>
        ),
      );
      last = m.index + token.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }, [text]);

  return <>{nodes}</>;
}

function FindingRow({ finding }: { finding: Finding }) {
  const loc = finding.file
    ? `${finding.file}${finding.line ? `:${finding.line}` : ""}`
    : "unanchored";
  return (
    <div className="finding">
      <div className="finding-head">
        <span className={`sev ${finding.severity}`}>{finding.severity}</span>
        <span className="loc">{loc}</span>
      </div>
      <div className="finding-issue">{finding.issue}</div>
      <div className="finding-meta">
        <b>Evidence</b> — {finding.evidence}
      </div>
      <div className="finding-meta">
        <b>Fix</b> — {finding.suggestion}
      </div>
    </div>
  );
}

function BlockView({ block, projectDir }: { block: Block; projectDir: string }) {
  switch (block.kind) {
    case "user":
      return (
        <div className="block right">
          <div className="card user">
            <div className="card-body">{block.text}</div>
          </div>
        </div>
      );

    case "builder":
      return (
        <div className="block">
          <div className="card builder">
            <div className="card-head">
              Builder · Claude
              <span className="sub">
                {PHASE_LABEL[block.phase]}
                {block.round > 1 ? ` · round ${block.round}` : ""}
              </span>
            </div>
            {block.text.trim() && (
              <div className="card-body">
                <RichText text={block.text.trim()} />
              </div>
            )}
            {block.tools.length > 0 && (
              <div className="tools">
                {block.tools.map((t) => (
                  <span className="tool" key={t}>
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      );

    case "gatekeeper": {
      const review = block.review;
      return (
        <div className="block right">
          <div className="card gatekeeper">
            <div className="card-head">
              Gatekeeper · Codex
              <span className="sub">
                read-only
                {block.round > 1 ? ` · round ${block.round}` : ""}
              </span>
            </div>
            {block.commands.length > 0 && (
              <div className="tools" style={{ paddingTop: 12 }}>
                {block.commands.map((c) => (
                  <span className="tool" key={c}>
                    {c.length > 56 ? `${c.slice(0, 56)}…` : c}
                  </span>
                ))}
              </div>
            )}
            {review && (
              <>
                <div className={`verdict ${review.verdict === "approve" ? "approve" : "changes"}`}>
                  <span className="verdict-tag">
                    {review.verdict === "approve" ? "APPROVE" : "CHANGES"}
                  </span>
                  <span className="verdict-summary">{review.summary}</span>
                </div>
                {review.findings.map((f, i) => (
                  <FindingRow finding={f} key={i} />
                ))}
              </>
            )}
          </div>
        </div>
      );
    }

    case "denial":
      return (
        <div className="denial">
          <div className="denial-head">⊘ Blocked by policy · {block.name}</div>
          <div className="denial-body">{block.reason}</div>
        </div>
      );

    case "snapshot":
      return (
        <div className="mark">
          snapshot {block.ref.slice(0, 8)} · {block.label}
        </div>
      );

    case "note":
      return (
        <div className="denial">
          <div className="denial-head">{block.level === "error" ? "✗ Error" : "! Notice"}</div>
          <div className="denial-body">{block.message}</div>
        </div>
      );

    case "outcome": {
      const { phase, rounds, diff, cost } = block.result;
      const title =
        phase === "approved"
          ? "Approved by the gatekeeper"
          : phase === "escalated"
            ? "Escalated — needs you"
            : "Failed";
      const changed = diff ? diff.split("\n").filter((l) => /^[+-][^+-]/.test(l)).length : 0;
      return (
        <div className={`outcome ${phase}`}>
          <div style={{ flex: 1 }}>
            <div className="outcome-title">{title}</div>
            <div className="outcome-meta">
              {rounds.length} review round{rounds.length === 1 ? "" : "s"} · {changed} changed lines
              {" · "}builder ${cost.builderUsd.toFixed(4)} · gatekeeper{" "}
              {(cost.gatekeeperInputTokens / 1000).toFixed(1)}k in /{" "}
              {(cost.gatekeeperOutputTokens / 1000).toFixed(1)}k out
            </div>
          </div>
          {diff && (
            <button onClick={() => window.arena.revealDiff(projectDir)}>Open project</button>
          )}
        </div>
      );
    }
  }
}

// -----------------------------------------------------------------------------------------
// app

/**
 * If the preload script fails to load, `window.arena` is undefined and every handler below
 * throws on mount -- which renders as a blank window with no explanation. Say what happened
 * instead.
 */
function BridgeMissing() {
  return (
    <div className="empty" style={{ flex: 1 }}>
      <h2>Cannot reach the main process</h2>
      <p>
        The preload bridge did not load, so the UI has no way to run a task. This usually
        means <code>dist-electron/preload.cjs</code> is missing — run <code>npm run build</code>{" "}
        and relaunch.
      </p>
    </div>
  );
}

export default function App() {
  if (typeof window.arena === "undefined") return <BridgeMissing />;
  return <Arena />;
}

function Arena() {
  const [projectDir, setProjectDir] = useState("");
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [showSetup, setShowSetup] = useState(false);

  const [blocks, setBlocks] = useState<Block[]>([]);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [round, setRound] = useState(1);
  const [running, setRunning] = useState(false);

  const [draft, setDraft] = useState("");
  const [maxRounds, setMaxRounds] = useState(3);
  const [skipPlanReview, setSkipPlanReview] = useState(false);
  /** True once the conversation has something in it worth building. */
  const [hasContext, setHasContext] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const offEvent = window.arena.onEvent((event) => {
      setBlocks((prev) => reduce(prev, event));
      if (event.type === "phase") {
        setPhase(event.phase);
        setRound(event.round);
      }
      if (event.type === "user.message") setHasContext(true);
      if (event.type === "done") setPhase(event.result.phase);
    });
    const offIdle = window.arena.onIdle(() => setRunning(false));
    return () => {
      offEvent();
      offIdle();
    };
  }, []);

  // Follow the tail while the user is at the bottom; stop fighting them if they scroll up.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [blocks]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  const refreshDoctor = useCallback(async (dir: string) => {
    setDoctor(await window.arena.doctor(dir));
  }, []);

  useEffect(() => {
    void refreshDoctor(projectDir);
  }, [projectDir, refreshDoctor]);

  const pick = useCallback(async () => {
    const dir = await window.arena.pickProject();
    if (dir) {
      setProjectDir(dir);
      // The conversation was about other code; the main process drops it too.
      setBlocks([]);
      setHasContext(false);
      setPhase(null);
    }
  }, []);

  const turnOptions = useMemo(
    () => ({ projectDir, maxRounds, skipPlanReview }),
    [projectDir, maxRounds, skipPlanReview],
  );

  const fail = useCallback((reason: string) => {
    setRunning(false);
    setBlocks((prev) => [...prev, { kind: "note", id: nextId++, level: "error", message: reason }]);
  }, []);

  /** Enter sends a message. Nothing is written; this is just conversation. */
  const send = useCallback(async () => {
    const message = draft.trim();
    if (running || !message || !projectDir) return;
    setDraft("");
    pinned.current = true;
    setRunning(true);
    const res = await window.arena.chat({ ...turnOptions, message });
    if (!res.started) fail(res.reason ?? "Could not start.");
  }, [draft, running, projectDir, turnOptions, fail]);

  /**
   * The decision. Everything up to here was read-only; this is where the gatekeeper enters
   * and files start changing. Deliberately a separate, explicit action -- never something
   * that happens because a message looked like an instruction.
   */
  const build = useCallback(
    async (demo = false) => {
      if (running) return;
      if (!demo && !projectDir) return;
      if (demo) {
        setBlocks([]);
        setPhase(null);
      }
      const instruction = draft.trim();
      if (instruction) setDraft("");
      pinned.current = true;
      setRunning(true);
      const res = await window.arena.build({
        ...turnOptions,
        ...(instruction ? { instruction } : {}),
        demo,
      });
      if (!res.started) fail(res.reason ?? "Could not start.");
    },
    [running, projectDir, draft, turnOptions, fail],
  );

  const restart = useCallback(async () => {
    if (running) return;
    await window.arena.reset();
    setBlocks([]);
    setHasContext(false);
    setPhase(null);
  }, [running]);

  const ready = Boolean(doctor?.builder.ok && doctor?.gatekeeper.ok && doctor?.project.ok);
  const building =
    running && phase !== null && phase !== "chatting";
  const statusText = running
    ? phase && PHASE_LABEL[phase]
      ? `${PHASE_LABEL[phase]}…`
      : "working…"
    : ready
      ? "ready"
      : "setup needed";

  return (
    <>
      <div className="titlebar">
        <div className="wordmark">
          Code<span>A</span>ren<em>a</em>
        </div>
        <div className="project" onClick={pick} title={projectDir || "Choose a project"}>
          {projectDir ? shortenPath(projectDir.replace(/^\/Users\/[^/]+/, "~")) : "Choose project…"}
          {doctor?.project.branch && <span className="branch">{doctor.project.branch}</span>}
        </div>
        <div className="spacer" />
        <div className="status">
          <span
            className={`dot${running ? " live" : ready ? "" : " warn"}`}
          />
          {statusText}
        </div>
      </div>

      <PhaseRail current={phase} round={round} />

      <div className="transcript" ref={scroller} onScroll={onScroll}>
        {blocks.length === 0 ? (
          <div className="empty">
            <h2>Talk first. Build when you decide.</h2>
            <p>
              Ask questions, read the code, argue about the approach — Claude cannot modify
              anything while you are still deciding. When you commit, press{" "}
              <b>Build&nbsp;this</b>: Codex reviews the plan before a file is touched, then
              reviews the diff, and the loop repeats until it approves.
            </p>
            <button onClick={() => build(true)} disabled={running} style={{ marginTop: 6 }}>
              Watch a recorded run
            </button>
          </div>
        ) : (
          blocks.map((b) => <BlockView block={b} key={b.id} projectDir={projectDir} />)
        )}
      </div>

      {showSetup && doctor && (
        <div className="setup">
          {(
            [
              ["Builder", doctor.builder],
              ["Gatekeeper", doctor.gatekeeper],
              ["Project", doctor.project],
            ] as const
          ).map(([name, check]) => (
            <div className={`check ${check.ok ? "ok" : "bad"}`} key={name}>
              <span className="glyph">{check.ok ? "✓" : "✗"}</span>
              <span className="name">{name}</span>
              <span className="detail">{check.detail}</span>
            </div>
          ))}
        </div>
      )}

      <div className="composer">
        <div className="composer-row">
          <textarea
            value={draft}
            placeholder={
              projectDir
                ? hasContext
                  ? "Reply, or press Build this when you have decided…"
                  : "What are you thinking about? Nothing gets written yet."
                : "Choose a project to begin…"
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={running}
          />
          <div className="composer-actions">
            <button onClick={() => void send()} disabled={running || !draft.trim() || !projectDir}>
              Send
            </button>
            <button
              className="primary build"
              onClick={() => void build()}
              disabled={running || !projectDir || (!hasContext && !draft.trim())}
              title={
                hasContext
                  ? "Plan and build what you just discussed, with the gatekeeper reviewing"
                  : "Say what you want first, or type it here and press Build this"
              }
            >
              {building ? "Building…" : "Build this"}
            </button>
          </div>
        </div>
        <div className="composer-meta">
          <label>
            max rounds
            <input
              type="number"
              min={1}
              max={8}
              value={maxRounds}
              onChange={(e) => setMaxRounds(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
              disabled={running}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={!skipPlanReview}
              onChange={(e) => setSkipPlanReview(!e.target.checked)}
              disabled={running}
            />
            review the plan first
          </label>
          <div className="spacer" />
          <button className="link" onClick={() => void restart()} disabled={running}>
            new conversation
          </button>
          <button className="link" onClick={() => setShowSetup((v) => !v)}>
            {showSetup ? "hide setup" : "setup"}
          </button>
          <button className="link" onClick={() => void build(true)} disabled={running}>
            demo
          </button>
        </div>
      </div>
    </>
  );
}
