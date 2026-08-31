/**
 * The conversation, held so the gatekeeper can see what the engineer actually asked for.
 *
 * Why this exists: the gatekeeper used to receive the literal string `(see the plan)` as the
 * task description, because the only thing the main process kept was an opaque Claude session
 * id. Everything it judged -- the plan, and the diff against that plan -- was authored by the
 * builder, so a review could only ever establish that the builder had not contradicted
 * itself. "You built the wrong thing" was structurally undiscoverable, which is the one class
 * of error the plan-review phase exists to catch.
 *
 * Two properties this is built around:
 *
 *   - **The engineer's own words are the independent signal.** They are the only text in the
 *     exchange the builder did not write. They are labelled as such and never summarised by
 *     the builder on the way through -- a builder that misread the request would carry the
 *     misreading into its own summary, and the gatekeeper would inherit it.
 *
 *   - **The builder's replies come along, but as claims, not requirements.** They have to:
 *     "throw. use RangeError." means nothing without the question it answers. The gatekeeper
 *     is told which is which.
 *
 * This lives in memory in the main process for the duration of a conversation. It is never
 * written to disk. It *is* sent to the gatekeeper -- that is the entire point -- so a
 * conversation now reaches both vendors, which the README says plainly.
 */

export interface TranscriptEntry {
  role: "engineer" | "implementer";
  text: string;
}

/** Roughly the budget a conversation may occupy in the gatekeeper's prompt. */
const MAX_CHARS = 12_000;
/** Long single turns are clipped before whole turns are dropped. */
const MAX_ENTRY_CHARS = 2_000;

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  const head = trimmed.slice(0, Math.floor(limit * 0.7));
  const tail = trimmed.slice(-Math.floor(limit * 0.25));
  return `${head}\n… [${trimmed.length - head.length - tail.length} characters elided] …\n${tail}`;
}

/**
 * Render the conversation for the gatekeeper.
 *
 * When the budget is tight the implementer's turns are dropped first, oldest first: they are
 * the recoverable half. Every engineer turn is kept if it is at all possible, because losing
 * one loses a requirement.
 */
export function render(entries: TranscriptEntry[]): string {
  if (entries.length === 0) return "";

  const clipped = entries.map((e) => ({ ...e, text: clip(e.text, MAX_ENTRY_CHARS) }));
  const size = (list: typeof clipped) =>
    list.reduce((n, e) => n + e.text.length + 24, 0);

  const kept = [...clipped];
  // Drop implementer turns from the front until it fits.
  for (let i = 0; i < kept.length && size(kept) > MAX_CHARS; ) {
    if (kept[i]!.role === "implementer") kept.splice(i, 1);
    else i++;
  }
  // Still too big: drop the oldest engineer turns, which at this point is unavoidable.
  while (kept.length > 1 && size(kept) > MAX_CHARS) kept.shift();

  const dropped = entries.length - kept.length;
  const body = kept
    .map((e) => (e.role === "engineer" ? `ENGINEER: ${e.text}` : `IMPLEMENTER: ${e.text}`))
    .join("\n\n");

  return dropped > 0
    ? `[${dropped} earlier turn(s) omitted for length]\n\n${body}`
    : body;
}

/** Keeps the conversation for one project. Cleared when the project or conversation changes. */
export class Transcript {
  private entries: TranscriptEntry[] = [];

  add(role: TranscriptEntry["role"], text: string): void {
    const trimmed = text.trim();
    if (trimmed) this.entries.push({ role, text: trimmed });
  }

  clear(): void {
    this.entries = [];
  }

  get length(): number {
    return this.entries.length;
  }

  /** The conversation as the gatekeeper should see it, or "" when there has been none. */
  render(): string {
    return render(this.entries);
  }
}
