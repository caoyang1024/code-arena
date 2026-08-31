# CodeArena

Rules for this project. Both models read this file, and CodeArena quotes it to the reviewer,
so anything here is checked before a change is accepted.

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
