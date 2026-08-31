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

**Layer 1 — the OS sandbox.** `sandbox: { enabled: true }` on the Agent SDK, on by default.
Kernel-enforced, not defeatable by clever quoting. Owns *location*: what the builder can reach.
Measured: `node -e "fs.writeFileSync('/tmp/x')"` writes the file with it off and fails with
`EPERM` from the kernel with it on.

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

**Where the two meet.** Build mode legitimately needs script interpreters — tests, build
scripts — so no allowlist can keep `node -e` out, and no string analysis reaches inside one.
That escape is closed by layer 1, at the syscall, which is why it is on.

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

**The gatekeeper sees what you asked for, not only what the builder wrote.** The conversation
goes to it alongside the plan and the diff, with your lines marked `ENGINEER` and the
builder's marked `IMPLEMENTER` — yours are the requirement, the builder's are claims.

This is load-bearing. It used to receive the literal string `(see the plan)` as the task,
because the only thing kept between turns was an opaque session id. Everything it judged was
authored by the builder, so a review could establish that the builder had not contradicted
itself and nothing more — "you built the wrong thing" was structurally undiscoverable, which
is the one class of error the plan-review phase exists to catch. With the conversation in
hand it rejects a plan that says `TypeError` when you said `RangeError`, or that touches a
function you asked it to leave alone; both were APPROVE before.

Your words are passed verbatim, never summarised by the builder on the way through: a builder
that misread the request would carry the misreading into its own summary and the gatekeeper
would inherit it. When a long conversation has to be trimmed, the builder's turns go first —
losing one of those costs context, losing one of yours costs a requirement.

**Privacy, stated plainly:** this means your conversation reaches OpenAI as well as Anthropic.
Before, only the plan and the diff did. It is held in memory in the main process, never
written to disk, and cleared when you switch projects or start a new conversation.

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

**The gate has a latch.** When the gatekeeper does not approve — rounds exhausted, or you
pressed Stop — the outcome offers **Discard changes** or **Keep them**, and discarding is
itself undoable: the state being thrown away is snapshotted first and the ref shown, so
`git checkout <ref> -- .` brings it back.

Until this existed, approval and rejection left the working tree identically changed and
neither offered a way out. The review only altered the colour of a label, `restore()` had no
caller anywhere in the product, and the argument in `policy.ts` for denying `git commit` —
that CodeArena's rollback guarantee depends on the snapshot baseline — was protecting a
feature that had never been wired up. "A review that has to pass before the diff is accepted"
described nothing the code did.

Discarding is never automatic. Rounds of rejected work are usually partly usable, and throwing
them away on the model's say-so is not the same as gating.

**The planning phase is read-only, and getting there took two attempts.** The SDK's plan mode
looks like the right tool and its enforcement is real, but it ships with its own exit:
`ExitPlanMode` is auto-approved by the mode, and `permissionMode` auto-approvals never reach
`canUseTool` — so the callback cannot refuse it. Once it lands the mode is gone and every
later write is auto-approved too, silently, with no denial recorded. Observed twice on real
runs: a phase labelled "PLANNING (read-only)" performed Writes and Edits, and the "plan" the
reviewer received was a report of finished work, written in the past tense.

Denying `ExitPlanMode` in `canUseTool` did not help, for exactly the reason it could not have.
The fix was to stop using plan mode: in `default` mode there is no mode to escape and writes
fall through to `canUseTool`, the path `policy.ts` covers with 109 assertions. Planning and
chatting now differ only in the prompt, which is the only thing that should ever have differed.

Measured on the same task before and after: three writes and two files changed during
planning, versus none — and the builder's cost fell from $2.09 to $0.48, the difference being
implementation work it was doing under the label of planning and which was discarded at
escalation.

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
| OS sandbox (`sandbox: true`) | verified, **on by default** — blocks an out-of-project write with `EPERM`, and a full build with tests runs under it untouched |
| Full loop end-to-end | **unverified** — same blocker |
| Electron desktop UI | not started |

## Known sharp edges

**A quota or billing failure arrives as a *successful* result.** `subtype: "success"`, with
the entire assistant text being `"Credit balance is too low"`. Without a check, the
orchestrator hands that string to the gatekeeper as if it were a plan. `builder.ts` pattern-
matches a short, single-turn, tool-free result against known account-failure phrasings and
throws instead. It is a heuristic; a new phrasing will slip through until it is added.

**Input methods work.** `keydown` fires during IME composition, so an unguarded Enter handler
sends the message while you are still choosing characters — typing Chinese meant every Enter
that should have picked a candidate sent the raw pinyin instead. Enter and Escape are both
guarded by `isComposing`, `keyCode === 229`, and the composition events, because no single one
of those is reported everywhere.

**You can stop a turn.** `Stop`, or `Esc` in the composer. The message you sent goes back into
the box so a typo can be fixed and resent rather than retyped — reaching for Stop almost always
means the input was wrong, not that the work was.

Stopping mid-build keeps whatever the builder already wrote and snapshots it, so you can see
what landed. It is an abandon, not a pause: there is no resume point inside a model turn.

**A measurement is only as good as the thing it measured.** The sandbox was off for a while on
the strength of a real observation drawn from a broken setup: a sandboxed `query()` emitted
`system:init` and never yielded again, so "the sandbox hangs" went into this file. Two things
were wrong with the setup — the account had no plan attached, and the call ran against the
SDK's *bundled* cli.js rather than the Claude Code the user is signed in to. It is the bundled
binary that hangs (nothing ends it, not even an AbortController). Against 2.1.247 the same call
returns in 4.9s. By the time the auth work had switched CodeArena to the user's own binary the
degradation had already gone; nobody re-measured for hours.

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
