# Engineering Guidelines

## Core
Code must be easy to change safely. Future human/AI must: find edit point, know allowed behavior, change one thing without breaking others, catch mistakes fast, diagnose prod failures.

AI failure modes: incomplete context, premature abstraction, missed deps, "looks right" over safe-to-evolve, happy path bias.

## Priority when rules conflict
1. Correctness, data integrity
2. Clear contracts, explicit boundaries
3. Simplicity, readability
4. Locality, low coupling
5. Consistency w/ codebase (tiebreaker, not veto)
6. Reuse, dedup, perf

Resolutions:
- Dup vs abstraction: dup over wrong abstraction; centralize only when shared+stable
- Fail fast vs degrade: fail fast on broken invariants; degrade only for expected boundary failures
- Boundary validation vs runtime asserts: validate untrusted input at boundary; keep focused asserts for "never happens"
- Immutability vs practical: default immutable; mutate only with clear ownership + reason
- Clean redesign vs safe evolve: weigh by real migration cost / blast radius, not deference to what exists. Low cost (few/no dependents) → prefer the correct design; as real dependents grow → prefer back-compat or a clear migration path

---

# Rules

## 1. Understand before coding
No coding against guesses. Identify goal, constraints, invariants, failure modes, existing patterns, ambiguities. AI fills gaps with confident wrong assumptions.

## 2. Smallest safe change
Small, isolated, reversible diffs. Separate behavior change from refactor. AI tends to "improve" adjacent code → 1 change becomes 5 risks.

## 3. Respect existing codebase, but challenge the premise
Follow project naming, structure, patterns, error style by default — consistency is a tiebreaker, not a veto. But if the current architecture, stack, data model, or contract is a poor fit for the task/requirements — or there's a clearly better way — surface it before implementing, with a clear recommendation + trade-offs. Don't cargo-cult an existing pattern just because it's there. Surfacing is mandatory; for anything big or cross-cutting, get buy-in before switching. Minimal-diff discipline (Rule 2) still governs how the approved change lands.

## 4. Organize by feature, not layer
Group by capability (`auth`, `billing`, `sync`) not (`controllers`, `services`, `utils`). Keeps related context together.

## 5. Separate domain from framework/infra
Keep business rules out of UI/HTTP/DB/FS/queues/SDKs. Core logic portable; outer layers adapt world to core, not reverse.

## 6. Modules = black boxes
Small explicit contract, hidden internals. Depend only on public API. Low coupling, high cohesion. Minimal API surface. Deps point inward (infra → domain).

## 7. Small focused units
One responsibility per function/class/file. Readable in one pass. Big files/functions = design smell. AI degrades w/ many concerns per file.

## 8. Boring > clever
Straightforward control flow, obvious names, visible behavior. Avoid: hidden control flow, surprise side effects, language tricks, abstractions hiding more than they clarify.

## 9. Abstract late
No generalizing for imagined needs. Extract only after repeated, stable patterns.

Dup vs reuse: dup workflows until shared behavior proven. Centralize business rules, schemas, contracts, invariants once truly shared. Two similar snippets ≠ same concept.

## 10. Precise consistent names
Names reveal intent. One domain term per concept everywhere. Don't mix `tenant`/`workspace`/`account`/`org`.

Avoid generic param/var names (`kind`, `type`, `item`, `val`) for domain unions. Use the domain concept: `maType: 'sma' | 'ema'`, not `kind`. Reserve short generic names for truly generic callbacks (`map(item => ...)` is fine).

## 11. Pure functions, isolate side effects
Pure where possible. Push effects to edges. Side effects = DB, net, FS, time, random, shared mutation, UI. Shape: collect input → pure transform → effect.

## 12. Explicit dependencies
Pass via params, constructors, module boundaries. No hidden globals, ambient context, invisible singletons. Hidden deps make functions lie.

## 13. Validate at boundaries, normalize once, explicit contracts
Reject bad input early. Normalize once near boundary. Explicit types/schemas/interfaces.

After boundary: code may trust inputs, but keep runtime asserts for critical invariants + impossible states. Asserts catch broken assumptions and future bad edits.

## 14. Make invalid states unrepresentable
Use types, enums, state machines, contracts to prevent impossible combos by design. Better than runtime checks everywhere.

## 15. Minimize state, control mutation
Smallest state. One source of truth per fact. Derive over store. Explicit transitions.

Default immutable. Mutate only when tightly controlled, single-owner, justified. Hidden shared mutation = non-local bugs.

## 16. Don't hide errors
Never swallow. Each error: handle intentionally, transform meaningfully, or propagate w/ context.

## 17. Expected failures vs broken assumptions
- Expected/recoverable: bad input, missing record, timeout, denied, conflict → model + handle cleanly
- Broken/unrecoverable: impossible branch, corrupt state, violated invariant, missing config → fail fast loudly

## 18. External systems unreliable
DBs, nets, queues, FS, browsers, cloud, 3rd-party APIs can fail/delay/duplicate/reorder/partially succeed. Use timeouts, cancellation, safe retries, idempotency for retriable, partial success handling, dup delivery, no order assumption unless guaranteed.

## 19. Observable behavior
Logs/metrics/traces/events at boundaries, state transitions, failures. Must answer: what happened, where failed, how often, which input, did retry/timeout/fallback occur. No leaking secrets.

## 20. Minimize + isolate dependencies
Fewest deps. Don't import 3rd-party deep into core. Wrap a lib behind a small internal interface only when there's a concrete reason: likely to be swapped, volatile/immature API, you use only a thin slice, or you need a test seam. Don't wrap stable foundational libs (ORM, framework, well-fitting SDK) just for purity — needless indirection hides capability and fights the lib (see Rule 9).

## 21. Tests = executable spec
Test externally visible behavior, not internals. Names read like spec: `returns_not_found_when_user_does_not_exist`, `rejects_empty_password`, `retries_idempotent_requests_on_timeout`.

## 22. Test edges, failures, weird cases
Not just happy path. Test: null/undefined/missing, empty str/arr/obj, zero/neg/min/max/overflow, malformed, large inputs, perm errors, timeouts, partial failures, concurrency/order.

## 23. Independent tests
Each sets up own state. Runnable alone, any order, parallel. Order-dependent = flaky accident, not spec.

## 24. Bug → regression test
Fixing a bug: add a test that would've caught it.

## 25. Don't edit tests to make code pass
If behavior unchanged, code is the bug, not test. AI shortcut: rewriting test to match wrong behavior — destroys safety net.

## 26. Document why, not what
Comments/docs explain decisions, assumptions, constraints, trade-offs, edge cases.

Comments = instructions for next AI. If weird code exists for a reason, say so or future model "simplifies" → bug. Also doc: module responsibility, caller expectations, guarantees, allowed failures, what may safely change.

## 27. Preserve compat or provide migration
Changing interfaces/events/schemas/APIs/config/data shapes used by others: weigh by real blast radius / migration cost. When few/no consumers depend on the old shape, prefer the correct design and update consumers in the same change. As real dependents grow, prefer back-compat or a clear migration path.

## 28. Remove dead/speculative code
Delete unused branches, abandoned abstractions, commented blocks, stale flags, "future-proof" code w/ no current need. Dead code misleads future AI into thinking it matters.

## 29. Review AI code skeptically
Treat as untrusted until reviewed. Check: hidden coupling, over-abstraction, missing validation, swallowed errors, wrong assumptions, broken invariants, inconsistent naming, mutation leaks, weak tests, unrelated diff noise.

---

# Definition of Done (AI agents)

1. Goal + assumptions explicit; ambiguities asked or recorded
2. Diff minimal + focused; unrelated edits removed
3. Follows local conventions
4. Contracts explicit; new/changed I/O, schemas, types updated
5. Boundary validation for new untrusted inputs
6. Errors intentional; nothing swallowed; failures visible
7. Observability for new important workflows/failure points
8. Tests added/updated: happy + edges + regression
9. Existing tests not weakened
10. Formatter + linter + types + build + tests pass
11. Final diff manually reviewed: API changes, hidden coupling, dead code, naming
12. Public contract changes → compat/migration notes
13. New external interaction → timeout/retry/idempotency considered

---

# Mechanical enforcement

CI gates: formatter, linter, type/static analysis, tests, build.

Structural: arch tests, import rules → feature boundaries, no module-internal imports, dep direction, no cycles, 3rd-party isolation, no empty catch, no unused exports, file/function size limits.

Contract: schema validation, API contract tests, ser/deser tests, migration checks.

Review gates (PR template): assumptions, tests added, migrations, compat, observability, dep impact.

Anything repeatable → automate.

---

# Multi-agent / long sessions

1. **One owner per area at a time** — no parallel uncoordinated edits to same module/contract
2. **Shared contracts first** — define/update interface before consumers
3. **Re-read latest state before editing** — long sessions drift, stale context fails
4. **Running decision log** — what changed, why, open assumptions, affected modules, follow-ups
5. **Short-lived small changes** — merge often, avoid speculative rewrites
6. **Overlap detected → stop, re-plan** — resolve ownership/sequencing first
