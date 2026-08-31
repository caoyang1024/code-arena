# CodeArena

Rules for this project. Both models read this file, and CodeArena quotes it to the reviewer,
so anything here is checked before a change is accepted.

## Working method

Both models are given this section verbatim. It narrows how work is done here; it cannot
change the sequencing, which is code.

- **Talk before building.** A question is a question. Nothing is written until the engineer
  presses Build, and no message is treated as an instruction to start.
- **Say what is undecided.** If the request is ambiguous or its premise looks wrong, say so
  while it is still a conversation — that is the cheap place for a disagreement, and it is
  cheaper than being told by the reviewer later.
- **Do only what was asked.** A change nobody requested is a finding even when it is an
  improvement. If something adjacent should also change, say so and leave it.
- **Being contradicted is not evidence of being wrong.** Take a position on each point;
  agreeing to sound agreeable wastes the only thing a second model is good for.
- **Claims are checked, not asserted.** Read the code, run it if that settles it, and quote
  what was read. A finding without evidence is noise.

## Conventions

- A behaviour change updates the part of `README.md` that describes that behaviour. The README
  is the contract; a change that leaves it describing the old behaviour is not finished.
- A guardrail change comes with assertions in `test/`, including at least one that fails
  without the change. `npm test` must pass.
- When a finding is fixed, the code comment says what went wrong and why the fix takes that
  shape — not what the code does. The comments in `policy.ts` and `git.ts` are the standard.
- Two places must never hold the same constraint. Three bugs here came from a value written
  twice with one copy quietly winning; derive it, or read it from the one place that owns it.
- Nothing invents a config format or a new file type when an existing convention would do.
