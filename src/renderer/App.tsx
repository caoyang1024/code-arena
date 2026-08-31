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
  recentProjects(): Promise<string[]>;
  lastProject(): Promise<string | null>;
  rememberProject(dir: string): Promise<void>;
  forgetProject(dir: string): Promise<void>;
  newProject(): Promise<{ dir?: string; reason?: string }>;
  chat(opts: TurnOptions & { message: string }): Promise<{ started: boolean; reason?: string }>;
  build(
    opts: TurnOptions & { instruction?: string; demo?: boolean },
  ): Promise<{ started: boolean; reason?: string }>;
  stop(): Promise<{ stopped: boolean }>;
  reset(): Promise<void>;
  loginStart(email?: string): Promise<{ ok: boolean; url?: string; reason?: string }>;
  loginCode(code: string): Promise<{ ok: boolean; detail: string }>;
  loginCancel(): Promise<void>;
  onLoginDone(cb: (result: { ok: boolean; detail: string }) => void): () => void;
  openExternal(url: string): Promise<void>;
  revert(opts: {
    projectDir: string;
    baseline: string;
  }): Promise<{ ok: boolean; undo?: string; reason?: string }>;
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
  | { kind: "note"; id: number; level: "info" | "warn" | "error"; message: string }
  | { kind: "stopped"; id: number };

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

    case "cancelled":
      return [...blocks, { kind: "stopped", id: nextId++ }];

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

    case "stopped":
      return <div className="mark stopped">stopped by you</div>;

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
      const { phase, rounds, diff, cost, baseline } = block.result;
      const title =
        phase === "approved"
          ? "Approved by the gatekeeper"
          : phase === "escalated"
            ? "Not approved — your call"
            : phase === "cancelled"
              ? "Stopped"
              : "Failed";
      const changed = diff ? diff.split("\n").filter((l) => /^[+-][^+-]/.test(l)).length : 0;
      return (
        <Outcome
          phase={phase}
          title={title}
          rounds={rounds.length}
          changed={changed}
          cost={cost}
          diff={diff}
          baseline={baseline ?? null}
          projectDir={projectDir}
        />
      );
    }
  }
}

/**
 * The end of a build, and the decision it forces.
 *
 * Approval and rejection used to differ only in the colour of a label: both left every change
 * in the working tree, and neither offered a way out, so the gate was nominal -- "a review
 * that has to pass before the diff is accepted" described nothing the code did.
 *
 * When the gatekeeper does not approve, the choice belongs here and it belongs to the human.
 * Reverting automatically would throw away rounds of work that are often partly usable;
 * offering nothing at all is what made gating a word rather than a behaviour. Discarding is
 * itself undoable -- the state being thrown away is snapshotted first and the ref shown.
 */
function Outcome({
  phase,
  title,
  rounds,
  changed,
  cost,
  diff,
  baseline,
  projectDir,
}: {
  phase: TaskResult["phase"];
  title: string;
  rounds: number;
  changed: number;
  cost: TaskResult["cost"];
  diff: string;
  baseline: string | null;
  projectDir: string;
}) {
  const [state, setState] = useState<"open" | "confirming" | "working" | "reverted" | "kept">(
    phase === "approved" ? "kept" : "open",
  );
  const [undoRef, setUndoRef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canRevert = Boolean(baseline) && changed > 0;

  const revert = async () => {
    if (!baseline) return;
    setState("working");
    setError(null);
    const res = await window.arena.revert({ projectDir, baseline });
    if (res.ok) {
      setUndoRef(res.undo ?? null);
      setState("reverted");
    } else {
      setError(res.reason ?? "Could not discard the changes.");
      setState("open");
    }
  };

  return (
    <div className={`outcome ${phase}`}>
      <div style={{ flex: 1 }}>
        <div className="outcome-title">{title}</div>
        <div className="outcome-meta">
          {rounds} review round{rounds === 1 ? "" : "s"} · {changed} changed lines
          {" · "}builder ${cost.builderUsd.toFixed(4)} · gatekeeper{" "}
          {(cost.gatekeeperInputTokens / 1000).toFixed(1)}k in /{" "}
          {(cost.gatekeeperOutputTokens / 1000).toFixed(1)}k out
        </div>

        {state === "reverted" && (
          <div className="outcome-note">
            Discarded.
            {undoRef && (
              <>
                {" "}Still recoverable: <code>git checkout {undoRef.slice(0, 8)} -- .</code>
              </>
            )}
          </div>
        )}
        {state === "kept" && phase !== "approved" && (
          <div className="outcome-note">Kept in your working tree.</div>
        )}
        {error && <div className="outcome-note error">{error}</div>}
      </div>

      {state === "open" && canRevert && (
        <div className="outcome-actions">
          <button className="danger" onClick={() => setState("confirming")}>
            Discard changes
          </button>
          <button onClick={() => setState("kept")}>Keep them</button>
        </div>
      )}
      {state === "confirming" && (
        <div className="outcome-actions">
          <span className="outcome-confirm">Discard {changed} lines?</span>
          <button className="danger" onClick={() => void revert()}>
            Yes
          </button>
          <button onClick={() => setState("open")}>Cancel</button>
        </div>
      )}
      {state === "working" && <div className="outcome-actions">working…</div>}
      {(state === "kept" || state === "reverted") && (
        <div className="outcome-actions">
          <button onClick={() => window.arena.revealDiff(projectDir)}>Open project</button>
        </div>
      )}
    </div>
  );
}

/**
 * The decision, in the transcript, under the reply that produced something worth building.
 *
 * It used to be a button beside the composer, paired with Send as though the two were
 * alternatives. They are not: Send submits what you typed, this acts on the conversation and
 * usually ignores the box entirely. Putting it here also puts it where you are already
 * reading -- you finish the reply, and the choice is on the next line.
 *
 * The price is next to it because compiling is free and this is not, and no developer has
 * the reflex to estimate it. The focus note is a setting on this build, not a message: the
 * reviewer can be told to look harder somewhere, never to look away.
 */
function BuildDecision({
  onBuild,
  note,
  onNote,
  rounds,
  onRounds,
}: {
  onBuild: () => void;
  note: string;
  onNote: (v: string) => void;
  rounds: number;
  onRounds: (n: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="decision">
      <button className="decision-go" onClick={onBuild}>
        Build this
      </button>
      {/*
        Not a dollar figure. total_cost_usd is what the work would have cost at API rates,
        which is not what a subscription user pays, and the gatekeeper reports no cost at all
        -- its ~100k tokens per build were simply missing from the number. A price that shows
        a charge which will not happen, for half the work, is worse than no price.
      */}
      <span className="decision-price">a full build · up to {rounds} rounds each way</span>
      <div className="spacer" />
      <button className="link" onClick={() => setOpen((v) => !v)}>
        {open ? "− options" : "+ options"}
      </button>
      {open && (
        <>
          <input
            className="decision-note"
            value={note}
            autoFocus
            placeholder="Anything the reviewer should look at especially closely?"
            onChange={(e) => onNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) onBuild();
            }}
          />
          <label className="decision-rounds">
            give up after
            <input
              type="number"
              min={1}
              max={8}
              value={rounds}
              onChange={(e) => onRounds(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
            />
            rounds each way
          </label>
        </>
      )}
    </div>
  );
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
  const [recent, setRecent] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);

  // Sign-in. `code` lives here only long enough to be handed to the main process, which
  // forwards it to the official binary; nothing is persisted on either side.
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginNote, setLoginNote] = useState<string | null>(null);

  /**
   * What was sent on the turn in flight. If the user stops it, this goes back into the
   * composer -- the reason people reach for Stop is usually a typo, and retyping the whole
   * message to fix one word is its own small insult.
   */
  const inFlight = useRef("");

  const [blocks, setBlocks] = useState<Block[]>([]);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [round, setRound] = useState(1);
  const [running, setRunning] = useState(false);

  const [draft, setDraft] = useState("");
  const [maxRounds, setMaxRounds] = useState(3);
  /** True once the conversation has something in it worth building. */
  const [hasContext, setHasContext] = useState(false);
  /** Optional steer for the reviewer. A setting on this build, not a message to anyone. */
  const [focus, setFocus] = useState("");

  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /**
   * True while an input method is composing.
   *
   * keydown fires during composition, so an unguarded Enter handler sends the message while
   * the user is still choosing characters -- typing Chinese, Japanese or Korean meant every
   * Enter that should have picked a candidate sent the raw pinyin instead. `isComposing` on
   * the native event is the modern signal; keyCode 229 is the legacy one browsers still emit;
   * the composition events are the belt-and-braces for anything that reports neither.
   */
  const composing = useRef(false);
  /** Read inside long-lived listeners, which must not close over a stale projectDir. */
  const projectDirRef = useRef(projectDir);
  useEffect(() => {
    projectDirRef.current = projectDir;
  }, [projectDir]);

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
    // The sign-in usually completes in the browser without a pasted code; close the flow
    // when it does rather than leaving the user staring at a code box.
    const offLogin = window.arena.onLoginDone((result) => {
      setLoginBusy(false);
      setLoginNote(result.detail);
      if (result.ok) {
        setLoginUrl(null);
        setCode("");
      }
      void window.arena.doctor(projectDirRef.current).then(setDoctor);
    });
    return () => {
      offEvent();
      offIdle();
      offLogin();
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

  // Reopen where you left off. Re-picking the project on every launch was pure friction.
  useEffect(() => {
    void (async () => {
      const [last, list] = await Promise.all([
        window.arena.lastProject(),
        window.arena.recentProjects(),
      ]);
      setRecent(list);
      if (last) setProjectDir(last);
    })();
  }, []);

  /** Switch projects. The conversation was about other code, so it does not come along. */
  const openProject = useCallback(async (dir: string) => {
    setProjectDir(dir);
    setBlocks([]);
    setHasContext(false);
    setPhase(null);
    setMenuOpen(false);
    await window.arena.rememberProject(dir);
    setRecent(await window.arena.recentProjects());
  }, []);

  const pick = useCallback(async () => {
    const dir = await window.arena.pickProject();
    if (dir) await openProject(dir);
    else setMenuOpen(false);
  }, [openProject]);

  const createProject = useCallback(async () => {
    const res = await window.arena.newProject();
    if (res.dir) {
      await openProject(res.dir);
    } else {
      setMenuOpen(false);
      if (res.reason) {
        setBlocks((prev) => [
          ...prev,
          { kind: "note", id: nextId++, level: "error", message: res.reason! },
        ]);
      }
    }
  }, [openProject]);

  const dropRecent = useCallback(async (dir: string) => {
    await window.arena.forgetProject(dir);
    setRecent(await window.arena.recentProjects());
  }, []);

  const turnOptions = useMemo(
    // Reviewing the plan is the point of the product, not a preference. It used to be a
    // permanently visible checkbox that nobody touched, and turning it off also made the
    // phase rail advertise a step that would never run.
    () => ({ projectDir, maxRounds, skipPlanReview: false }),
    [projectDir, maxRounds],
  );

  const fail = useCallback((reason: string) => {
    setRunning(false);
    setBlocks((prev) => [...prev, { kind: "note", id: nextId++, level: "error", message: reason }]);
  }, []);

  /** Enter sends a message. Nothing is written; this is just conversation. */
  const send = useCallback(async () => {
    const message = draft.trim();
    if (running || !message || !projectDir) return;
    inFlight.current = message;
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
  /**
   * The decision. Everything before it was read-only; this is where the gatekeeper enters and
   * files start changing. It acts on the conversation, which is why it does not live next to
   * the composer and does not consume what you typed there.
   */
  const build = useCallback(
    async (demo = false) => {
      if (running) return;
      if (!demo && !projectDir) return;
      if (demo) {
        setBlocks([]);
        setPhase(null);
      }
      const instruction = focus.trim();
      pinned.current = true;
      setRunning(true);
      const res = await window.arena.build({
        ...turnOptions,
        ...(instruction ? { instruction } : {}),
        demo,
      });
      if (res.started) setFocus("");
      else fail(res.reason ?? "Could not start.");
    },
    [running, projectDir, focus, turnOptions, fail],
  );

  const signIn = useCallback(async () => {
    setLoginBusy(true);
    setLoginNote(null);
    const res = await window.arena.loginStart();
    setLoginBusy(false);
    if (res.ok && res.url) {
      setLoginUrl(res.url);
      void window.arena.openExternal(res.url);
    } else {
      setLoginNote(res.reason ?? "Could not start sign-in.");
    }
  }, []);

  const submitCode = useCallback(async () => {
    if (!code.trim()) return;
    setLoginBusy(true);
    const res = await window.arena.loginCode(code);
    setCode("");
    setLoginBusy(false);
    setLoginNote(res.detail);
    if (res.ok) setLoginUrl(null);
    void refreshDoctor(projectDir);
  }, [code, projectDir, refreshDoctor]);

  const cancelSignIn = useCallback(async () => {
    await window.arena.loginCancel();
    setLoginUrl(null);
    setCode("");
    setLoginNote(null);
  }, []);

  /** Stop the turn in flight and give the user their words back. */
  const stop = useCallback(async () => {
    if (!running) return;
    await window.arena.stop();
    if (inFlight.current) {
      setDraft((d) => (d.trim() ? d : inFlight.current));
      inFlight.current = "";
    }
  }, [running]);

  const restart = useCallback(async () => {
    if (running) return;
    await window.arena.reset();
    setBlocks([]);
    setHasContext(false);
    setPhase(null);
  }, [running]);

  const canBuild =
    !running && hasContext && Boolean(projectDir) && blocks.at(-1)?.kind === "builder";

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
        <div className="project-picker">
          <div
            className="project"
            onClick={() => setMenuOpen((v) => !v)}
            title={projectDir || "Choose a project"}
          >
            {projectDir ? shortenPath(projectDir.replace(/^\/Users\/[^/]+/, "~")) : "Choose project…"}
            {doctor?.project.branch && <span className="branch">{doctor.project.branch}</span>}
            <span className="caret">▾</span>
          </div>

          {menuOpen && (
            <>
              <div className="menu-scrim" onClick={() => setMenuOpen(false)} />
              <div className="menu">
                {recent.length > 0 && (
                  <>
                    <div className="menu-label">Recent</div>
                    {recent.map((dir) => (
                      <div
                        key={dir}
                        className={`menu-item${dir === projectDir ? " current" : ""}`}
                        onClick={() => void openProject(dir)}
                      >
                        <span className="menu-name">{dir.split("/").pop()}</span>
                        <span className="menu-path">
                          {shortenPath(dir.replace(/^\/Users\/[^/]+/, "~"))}
                        </span>
                        <button
                          className="menu-drop"
                          title="Remove from this list (the folder is not touched)"
                          onClick={(e) => {
                            e.stopPropagation();
                            void dropRecent(dir);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <div className="menu-sep" />
                  </>
                )}
                <div className="menu-item" onClick={() => void pick()}>
                  <span className="menu-name">Open a project…</span>
                </div>
                <div className="menu-item" onClick={() => void createProject()}>
                  <span className="menu-name">New project…</span>
                  <span className="menu-path">creates the folder and runs git init</span>
                </div>
                <div className="menu-sep" />
                <div
                  className="menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    void restart();
                  }}
                >
                  <span className="menu-name">New conversation</span>
                  <span className="menu-path">forget what we discussed</span>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="spacer" />
        {/*
          Setup used to be a permanent link in the composer. It is only ever wanted when
          something is broken, and the status pill already says so -- so the pill is the way
          in, and only when there is something to fix.
        */}
        <button
          className={`status${ready ? " status-ok" : " status-actionable"}`}
          onClick={() => !ready && setShowSetup((v) => !v)}
          disabled={ready}
          title={ready ? undefined : "Show what needs fixing"}
        >
          <span className={`dot${running ? " live" : ready ? "" : " warn"}`} />
          {statusText}
        </button>
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
          <>
            {blocks.map((b) => <BlockView block={b} key={b.id} projectDir={projectDir} />)}
            {canBuild && (
              <BuildDecision
                onBuild={() => void build()}
                note={focus}
                onNote={setFocus}
                rounds={maxRounds}
                onRounds={setMaxRounds}
              />
            )}
          </>
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

          {!doctor.builder.ok && !loginUrl && (
            <div className="signin">
              <button onClick={() => void signIn()} disabled={loginBusy}>
                {loginBusy ? "Starting…" : "Connect Claude account"}
              </button>
              <span className="signin-note">
                Opens Anthropic's own sign-in in your browser. CodeArena never sees your
                password and stores no token.
              </span>
            </div>
          )}

          {loginUrl && (
            <div className="signin-flow">
              <div className="signin-step">
                <b>1.</b> Approve in the browser tab that just opened.{" "}
                <button className="link" onClick={() => void window.arena.openExternal(loginUrl)}>
                  reopen it
                </button>
              </div>
              <div className="signin-step">
                <b>2.</b> Paste the code it gives you:
              </div>
              <div className="signin-row">
                <input
                  className="code-input"
                  value={code}
                  placeholder="authorization code"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submitCode();
                    }
                  }}
                  disabled={loginBusy}
                />
                <button
                  className="primary"
                  onClick={() => void submitCode()}
                  disabled={loginBusy || !code.trim()}
                >
                  {loginBusy ? "Signing in…" : "Sign in"}
                </button>
                <button onClick={() => void cancelSignIn()} disabled={loginBusy}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {loginNote && <div className="signin-note result">{loginNote}</div>}
        </div>
      )}

      <div className="composer">
        <div className="composer-row">
          <textarea
            value={draft}
            placeholder={
              running
                ? "Stop (Esc) to take it back and edit…"
                : projectDir
                  ? hasContext
                    ? "Keep talking — Build this appears when there is something to build."
                    : "What are you thinking about? Nothing gets written yet."
                  : "Choose a project to begin…"
            }
            onChange={(e) => setDraft(e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(e) => {
              const midComposition =
                composing.current || e.nativeEvent.isComposing || e.keyCode === 229;

              if (e.key === "Enter" && !e.shiftKey && !midComposition) {
                e.preventDefault();
                void send();
              }
              // Escape closes the candidate window; it must not also stop the turn.
              if (e.key === "Escape" && running && !midComposition) {
                e.preventDefault();
                void stop();
              }
            }}
          />
          {/*
            One field, one button.
            `Send` and `Build this` used to sit here as peers, but Build usually ignores this
            box entirely -- it builds the conversation, not the draft. Two buttons on one
            field where one of them does not read the field is incoherent. The build decision
            moved into the transcript, under the reply that produced something worth building.
          */}
          {running ? (
            <button className="stop" onClick={() => void stop()}>
              Stop
            </button>
          ) : (
            <button
              className="primary"
              onClick={() => void send()}
              disabled={!draft.trim() || !projectDir}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </>
  );
}
