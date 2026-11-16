# <Capability name>

**Context(s):** <owning context, plus any it touches> · **Date:** YYYY-MM-DD

> Intent spec. It states what the capability is for and what it must do; it does not describe
> files, functions or snippets. The design packet and the code own mechanics.

## Definitions

The terms this spec depends on, defined precisely enough to implement without guessing. Link
the canonical entry in [UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md); add an entry
there if the term is new or refined. Define every noun and verb the spec relies on, including
the ones that look obvious — an undefined term is the most common cause of a correct-looking
implementation that does the wrong thing.

- **<term>** — <precise, unambiguous definition as this spec uses it>

## Constraints

Cross-cutting rules that apply to all behaviour here, stated separately from the behaviour:
comparison rules, ordering guarantees, size bounds, timeouts, determinism, defaults, consent
rules.

## Problem

The problem from the user's perspective: what is broken, missing or dishonest today.

## Solution

The solution from the user's perspective: what they will be able to do, and what must remain
true afterwards.

## User Stories

1. As a <actor>, I want <capability>, so that <benefit>.
2. …

Cover the full scope, including edge cases and failure scenarios.

## Acceptance Criteria

Per story, the scenarios that define done, written as behaviour, not code. One scenario = one
action; several assertions about that action are fine, a second action is a second scenario.
Cover the happy path **and** the failure modes, boundaries and refusals. Include fixture data
inline so a scenario is reproducible as written. Where behaviour is non-deterministic, state
the seeding or ordering rule.

These criteria are the definition of done. They change only by amending the spec.

### Story 1 — <short name>

```
Given <initial state / fixture>
When  <the action>
Then  <the observable outcome>
```

### Story 2 — …

## Design Decisions

Decisions this spec makes, stated by domain concept: which concepts gain capability, what the
contract between them is, what vocabulary changes, which invariants become tests. Cross-context
contracts changed here must be reflected in [CONTEXT_MAP.md](../../CONTEXT_MAP.md).

### Deferred Decisions

Decisions this spec deliberately does **not** make, and the seam that keeps each one open.
Deferring is a design virtue; commit only where the capability cannot proceed without it.

- <deferred decision> — <the interface or boundary that lets it be decided later>

## Testing Strategy

- Which behaviours carry automated acceptance tests, and in what order.
- What makes a good test here: behavioural, through the public interface, one concept at a time.
- What may be mocked (only system boundaries: the harness, storage, the model provider).
- How non-determinism is made controllable (clock, seeded ids, explicit ordering) so the suite
  is repeatable rather than occasionally red.

## Out of Scope

What this spec explicitly does not cover, and where the boundary is recorded.

## Open Questions

Unresolved decisions that need answers before or during implementation, each with who can
answer it.
