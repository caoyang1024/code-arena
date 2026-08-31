# CodeArena

One AI builds. Another AI decides whether it's good enough.

CodeArena runs a software task through two independent models with different roles:

- **Builder** — Claude, via [`@anthropic-ai/claude-agent-sdk`](https://code.claude.com/docs/en/agent-sdk).
  Plans in read-only mode, then implements.
- **Gatekeeper** — Codex, via [`@openai/codex-sdk`](https://developers.openai.com/codex/sdk).
  Reviews with **read-only** access to the repo. Never writes. Returns a structured verdict.

The premise: a single model grades its own homework. A second model, from a different
vendor with a different training run, does not share the first one's blind spots.

## The loop

```
              ┌──────────────── request_changes (< maxRounds) ───────────┐
              ↓                                                          │
task → planning → plan_review → implementing → diff_review → approved    │
         (Claude)   (Codex)       (Claude)       (Codex)   ↑             │
                                       ↑                   └─────────────┘
                                       └── request_changes (< maxRounds) ─┘

exceeding maxRounds in either phase → escalated (stops, hands you the transcript)
```

The plan is reviewed **before a single file is touched** — the cheapest place to catch a
wrong approach. The diff is reviewed after. Both phases loop automatically, both are capped.

## Setup

Both SDKs authenticate off existing subscription logins; no API keys required.

```bash
npm install
npm run doctor
```

`doctor` checks: Claude credentials (login Keychain or `ANTHROPIC_API_KEY`), a code-signed
codex binary and its ChatGPT login, and that the target directory is a git repo.

## Use

```bash
npm run arena -- --project ../my-repo --rounds 3 "add retry with backoff to the http client"
```

Flags: `--project DIR`, `--rounds N` (default 3), `--no-plan-review`.

## Design decisions worth knowing

**The gatekeeper is structurally incapable of writing.** `sandboxMode: "read-only"` is set at
the SDK level in `gatekeeper.ts`. A reviewer that can edit is not a reviewer.

**The gatekeeper gets the repo, not just the diff.** It reads surrounding files to verify its
own claims. In the first live test this is what let it catch a missing guard by cross-checking
the project's stated `TypeError` convention in README.md — invisible from the diff alone.

**Verdicts are data, not prose.** `thread.run(prompt, { outputSchema })` forces a
schema-conforming verdict (`schema.ts`), which is what makes the loop automatable at all.

**Never the npm-vendored codex binary.** `@openai/codex-sdk` ships an unsigned native binary
that macOS XProtect flags as malware and deletes. CodeArena resolves a codex that is
code-signed by OpenAI (Team ID `2DC432GLL2`) instead — see `codex-path.ts`. Override with
`CODEARENA_CODEX_PATH`.

**Snapshots never touch your git history.** The builder edits your real working tree; `git.ts`
captures state into dangling commits via an alternate index, so your branches, HEAD, index and
history are untouched. Pre-existing uncommitted work is part of the baseline and is never
attributed to — or destroyed by — the builder.

**Round caps are the safety mechanism.** Two models that disagree will ping-pong forever.
`maxRounds` turns that into an escalation instead of a runaway bill.

## Status

| Component | State |
|---|---|
| `git.ts` snapshot / diff / rollback | verified — `npm run test:git` (13 assertions) |
| `gatekeeper.ts` Codex review + structured verdict | verified live — `npm run test:gatekeeper <repo>` |
| `codex-path.ts` signed-binary resolution | verified |
| `doctor` preflight | verified |
| `builder.ts` Claude drive | **unverified** — blocked on Claude account credit balance |
| Full loop end-to-end | **unverified** — same blocker |
| Electron desktop UI | not started |

## Next

The CLI is deliberately throwaway. It renders the same `ArenaEvent` stream the Electron app
will consume, so the UI is a rendering problem, not an architecture problem.
