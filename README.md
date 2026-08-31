# CodeArena

One AI builds. Another AI decides whether it's good enough.

**You talk to Claude the way you always do.** Nothing is planned and nothing is written until
you decide. When you do, a second model from a different vendor has to agree before the work
lands.

CodeArena runs that decision through two independent models with different roles:

- **Builder** — Claude, via [`@anthropic-ai/claude-agent-sdk`](https://code.claude.com/docs/en/agent-sdk).
  Plans in read-only mode, then implements.
- **Gatekeeper** — Codex, via [`@openai/codex-sdk`](https://developers.openai.com/codex/sdk).
  Reviews with **read-only** access to the repo. Never writes. Returns a structured verdict.

The premise: a single model grades its own homework. A second model, from a different
vendor with a different training run, does not share the first one's blind spots.

## The loop

```
      you ⟷ builder            read-only. explore, argue, change your mind.
         │                     no gatekeeper, nothing written, no plan.
         │
         ▼  ← YOU press "Build this".  This is the only way anything gets written.
      planning ──▶ plan review ──request changes──┐
         ▲            │                           │
         └────────────┘  (≤ maxRounds)            │
                      │ approve                   │
                      ▼                           │
      implementing ──▶ diff review ──request changes──┐
         ▲                 │                          │
         └─────────────────┘  (≤ maxRounds)           │
                           │ approve                  │
                           ▼                          │
                      approved ──▶ back to talking ◀──┘  (escalates if rounds run out)
```

The conversation and the build are **one Claude session**. That is what makes "build what we
just discussed" mean something: the constraint you mentioned in passing, the approach you
rejected, the file you pointed at — all of it is still there when planning starts. Starting a
fresh session at build time would throw that away and make the model guess again.

The plan is reviewed **before a single file is touched** — the cheapest place to catch a wrong
approach. The diff is reviewed after. Both phases loop automatically; both are capped.

**Deciding is a separate, explicit act.** A message that merely sounds like an instruction
never triggers a build. That distinction is the product.
## Setup

Both SDKs authenticate off existing subscription logins; no API keys required.

```bash
npm install
npx install-electron
npm run doctor
```

`doctor` checks both agents and the project. For the builder it asks `claude auth status`
rather than inspecting credential storage — including `subscriptionType`, which is the field
that decides whether requests will actually go through.

**`subscriptionType: null` with `loggedIn: true` is the trap.** Authentication succeeds, so
nothing looks wrong, but requests fall through to API credit billing and the first symptom is
`Credit balance is too low` arriving from the middle of a build. An earlier version of
`doctor` reported a green tick here, because it only checked that the `Claude Code-credentials`
keychain entry existed — on this machine that entry held nothing but MCP OAuth tokens. A
preflight that lies is worse than no preflight.

CodeArena drives the Claude Code binary you are already signed in to
(`~/Library/Application Support/Claude/claude-code/<version>/…`, or the `claude` CLI), not the
copy bundled with the SDK — the same reasoning as the codex binary. Override with
`CODEARENA_CLAUDE_PATH`.

## Use

Desktop app:

```bash
npm run app
```

It reopens the project you were last in. The title-bar chip lists recent projects, opens
another, or creates a new one — **New project…** makes the folder and runs `git init`, since
CodeArena needs a repository to snapshot against and sending you elsewhere to run one command
first is a strange thing for a desktop app to demand. No initial commit is made; that one is
yours to author.

Then talk. Press **Build this** when you have decided.

Or headless, same orchestrator:

```bash
npm run arena -- --project ../my-repo
```

Type to talk; `/build` when you have decided (`/build <what>` to skip the conversation),
`/reset` to forget it, `/exit`. Flags: `--project DIR`, `--rounds N` (default 3),
`--no-plan-review`.

### Seeing it without an account

`npm run app` and click **Watch a recorded run** — a real recorded transcript replays through
the live UI. To iterate on the UI itself without launching Electron at all:

```bash
npx vite
```

then open `/preview.html`. The renderer touches Node only through `window.arena`, so stubbing
that one object runs the entire interface in an ordinary browser tab.

## Two layers of containment

The builder edits your real working tree, so its blast radius is contained twice. The layers
are not redundant — each catches what the other structurally cannot.

**Layer 1 — the OS sandbox.** `sandbox: { enabled: true }` on the Agent SDK. Kernel-enforced,
not defeatable by clever quoting. Owns *location*: what the builder can reach.
**Currently off by default because it hangs** — see Status. Turn it on with `sandbox: true`
once you have verified it works on your setup.

**Read-only until you decide.** While you are still talking, bash runs against an
*allowlist* — `ls`, `cat`, `grep`, `find`, `sed -n`, `git` reads and friends. Everything else
is denied, script interpreters included: `python3 -c "open('x','w')…"` and `node -e "…"` walk
straight through any denylist of shell verbs, and the chat phase has no need to execute code.
`npm test` is denied here too, for the same reason — it runs whatever `package.json` says.

**Path containment.** Every bash command, in both modes, is checked for credential paths
(`~/.ssh`, `~/.aws`, `~/.codex/auth.json`, …) and for writes landing outside the project —
including redirect targets, which name no command at all (`echo x >> ~/.zshrc` has argv
`["echo", "x"]`). Also denied: piping a download into a shell, and `curl`/`wget` upload flags.

*This was missing entirely until CodeArena reviewed its own source.* `checkSegment` inspected
command names and git subcommands and never once called the path checks, so `Write` to
`~/.zshrc` was denied while `echo pwned >> ~/.zshrc` was allowed, and `rm -rf ~/Documents`
and `cat ~/.ssh/id_rsa` were allowed during the build phase — the one phase where files
actually change. `shell.ts` enumerated every command hidden in a pipeline and then did nothing
with the arguments it had extracted.

**What this still does not stop.** In build mode, script interpreters are legitimately needed
(tests, build scripts) and cannot be allowlisted away, so `node -e "fs.writeFileSync('/etc/x')"`
remains reachable. No amount of string analysis closes that; it is the OS sandbox's job, and
the OS sandbox is currently off (see Status). Layer 2 raises the floor a long way — it is not
a ceiling, and this README will not pretend otherwise.

**Layer 2 — the policy** (`policy.ts`). Owns *meaning*: constraints a filesystem sandbox
cannot express. The load-bearing case is git. `git commit` and `git reset --hard` write only
to files inside the project directory, so no sandbox will ever stop them — but CodeArena's
rollback guarantee rests on git history staying exactly where we left it. A builder that
commits or resets mid-task silently invalidates the snapshot baseline, and "roll back the
agent's work" starts destroying yours instead. So git reads are free, git history writes are
denied, and the denial explains why so the model adapts rather than retrying.

Also denied: writes outside the project or into `.git`, reads of `~/.ssh` / `~/.aws` /
`~/.codex/auth.json` and friends, `sudo`, keychain access, and publish/release verbs
(`npm publish`, `gh pr create`, `docker push`) — outward-facing and irreversible, so they stay
a human decision. Opt out per-task with `allowGitWrites` / `allowPublish`; `sudo` is not
overridable.

Layer 2 analyses shell strings, and string analysis of shell is not a security control — it
enumerates commands hidden in pipelines, `;` chains, `$(...)` and backticks precisely because
prefix-matching is trivially evaded, but Layer 1 is what actually holds. `npm run test:policy`
covers 109 cases, roughly half of them evasion attempts.

**One non-obvious interaction:** the SDK's `autoAllowBashIfSandboxed` looks like a free
convenience, but auto-approved calls bypass `canUseTool` — which would silently disable
Layer 2 entirely, git rule included. It is deliberately left off.

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

Everything runs at the repository **top level**, not at the directory you picked. Choosing a
subdirectory is one click in the folder picker, and staging with `add -A .` from one stages
only that subtree — so a change elsewhere in the repo vanishes from the diff and the gatekeeper
reviews an incomplete change believing it saw everything. Quieter, and worse, than the crash it
was hiding behind. The scratch index lives in the temp directory for the same family of
reasons: `<dir>/.git/` does not exist in a subdirectory, and in a worktree or submodule `.git`
is a file.

Snapshot refs are pruned when a build finishes, keeping the latest baseline so a rollback stays
possible. Each ref pins an entire working tree, and nothing used to prune them.

**Round caps are the safety mechanism.** Two models that disagree will ping-pong forever.
`maxRounds` turns that into an escalation instead of a runaway bill.

## Layout

| Path | What lives there |
|---|---|
| `src/core/` | orchestrator, both agent drivers, git, policy — no UI, no Electron |
| `electron/` | main process (hosts the orchestrator) and the preload bridge |
| `src/renderer/` | React app: a pure fold over `ArenaEvent` |
| `src/cli/` | terminal front-end and `doctor`, same event stream |
| `test/` | offline suites (`policy`, `git`) and one live suite (`gatekeeper`) |

The renderer cannot reach the filesystem, spawn a process, or touch either SDK:
`contextIsolation` is on, `nodeIntegration` is off, and the preload exposes exactly five
calls.

## Status

| Component | State |
|---|---|
| `policy.ts` + `shell.ts` guardrails | verified — `npm run test:policy` (109 assertions) |
| `git.ts` snapshot / diff / rollback | verified — `npm run test:git` (13 assertions) |
| `gatekeeper.ts` Codex review + structured verdict | verified live — `npm run test:gatekeeper <repo>` |
| `codex-path.ts` signed-binary resolution | verified |
| `doctor` preflight | verified |
| Electron app + IPC + transcript UI | verified against the recorded fixture |
| Conversation mode (chat → decide → build) | UI and policy verified; the live chat turn shares the builder blocker below |
| `builder.ts` Claude drive | **unverified** — blocked on Claude account credit balance |
| OS sandbox (`sandbox: true`) | **broken on this setup — off by default.** On claude-agent-sdk 0.1.77 / macOS 25.6, `query()` emits `system:init` at ~0.6s and then never yields again. The identical call without it returns in 3.7s. Worse, the hang swallows account errors, so a failed run is indistinguishable from a slow one. Layer 2 runs either way; location containment currently rests on the policy's lexical path checks. |
| Full loop end-to-end | **unverified** — same blocker |
| Electron desktop UI | not started |

## Known sharp edges

**A quota or billing failure arrives as a *successful* result.** `subtype: "success"`, with
the entire assistant text being `"Credit balance is too low"`. Without a check, the
orchestrator hands that string to the gatekeeper as if it were a plan. `builder.ts` pattern-
matches a short, single-turn, tool-free result against known account-failure phrasings and
throws instead. It is a heuristic; a new phrasing will slip through until it is added.

**You can stop a turn.** `Stop`, or `Esc` in the composer. The message you sent goes back into
the box so a typo can be fixed and resent rather than retyped — reaching for Stop almost always
means the input was wrong, not that the work was.

Stopping mid-build keeps whatever the builder already wrote and snapshots it, so you can see
what landed. It is an abandon, not a pause: there is no resume point inside a model turn.

**A hung SDK looks exactly like a slow model.** There is a watchdog, but it is deliberately
generous (15 minutes). Messages arrive between tool calls, not during them, so the timer
cannot tell "the SDK has wedged" from "`npm test` is still running" — and running the tests is
exactly what the build phase should be doing. At its original 150s it would have killed any
turn containing a slow command. It is a backstop against a wedged subprocess; deciding that
work is taking too long is the user's call, which is what Stop is for.

## History

This repository previously held a different take on the same instinct: a Python engine that
had Claude, GPT and Gemini debate a code review between themselves. That work is preserved in
git history (`git show 23e6ede`) rather than deleted.

The idea here is narrower and, I think, more useful. Adversarial review is not the product —
*gating the work on it* is. A review you can ignore changes nothing; a review that has to pass
before the diff is accepted changes what gets written.

## Next

The CLI is deliberately throwaway. It renders the same `ArenaEvent` stream the Electron app
will consume, so the UI is a rendering problem, not an architecture problem.
