# ADR 002 — Every artifact family names a closing detector

**Date:** 2026-11-15 · **Context(s):** Capture (with Attention Register consuming the closures)

## Context

Detection is the easy half of a register and the half that looks like progress. Closing is the
hard half: an item that is raised and never resolved is worse than an item never raised, because it
teaches the user that the list cannot be trusted and turns the product into a second inbox to
triage by hand.

The artifact families are asymmetric in what evidence can close them. Some have an unconditional
later event: a question's tool result, a job's settled event, a goal phase change. Some close only if
the agent acts again: a blocked approval that is retried and granted is resolved, but a blocked
approval the agent abandons has no later log event at all. And a real decision — the user must
choose between two approaches — is closed by nobody but the user, correctly. The temptation is to
paper over the asymmetry with a timer: after some hours, close it. That is not evidence; it is a
guess dressed as a resolution, and it makes "automatically closed" mean "we gave up".

The domain's rule is therefore stated as a design invariant: **every artifact family must name its
closing detector.** A family that cannot name one is not dispatched. The team-task family is the
concrete case: it could be detected, but the rule that proves a team task is *orphaned* rather than
*merely waiting on a running owner* was not designed, so the family produces nothing. The closure is
declared per family as a policy — detector, conditional or user-only — and the acceptance contract
checks the declaration exists for every emittable family and that the declared detector closer is
observed where the artifact resolves.

## Decision

We will dispatch an artifact family only when it names its closing detector, and we will record that
closure policy as a first-class part of the capture contract. Closures are evidenced: a later
committed event, a declared user action, or — for a family declared conditional or user-only — the
honest admission that only the user can resolve it. No family is closed by time, by absence of
evidence or by a global sweep that cannot name what it closed.

## Why

- **The register's value is that a row means something.** An item leaves the list because something
  happened, and the resolution records what and by whom. A timer cannot produce a resolution that
  is true.
- **The declaration makes closure auditable.** Each detector-closed resolution carries the code of
  the rule that closed it; the per-family closure map is the contract the acceptance suite asserts
  against, so a new family cannot silently arrive without an exit.
- **The asymmetry is information, not a defect.** A blocked approval that was never retried is a
  decision the user must make; a question whose result lands is closed by that result. Declaring the
  policy lets the product say which is which instead of pretending every item resolves itself.
- **Refusing to dispatch is cheaper than raising noise.** The team-task family is a real
  detection capability, and withholding it until its liveness gate exists is the honest trade: a
  family that raises more false items than it can close costs the user more than its absence.

## Alternatives considered

- **Close every family on a timer.** Rejected: a timer is not evidence, it records a resolution that
  did not happen, and it hides the decision the user never made.
- **Close on any later turn.** Rejected: a later turn is evidence that the user moved on, which is
  supersession for an inferred candidate, not an answer for a structural decision. Using it
  everywhere would silently discard real decisions.
- **Rely on the user to dismiss everything.** Rejected: it makes the register a manual triage list
  and the user the closure mechanism for facts the harness could have proved.
- **Let each detector choose its own closure ad hoc.** Rejected: no audit, no acceptance invariant,
  and the first family to forget a closer rots the list.
- **Exclude the closure question from the draft contract and handle it in the register.** Rejected:
  the register would then need to know what a fold is; closure is detection's counterpart and must
  be declared where the artifact is understood.

## Consequences

- Detector-closed resolutions carry a closure code; the code is how the register and the acceptance
  report can attribute a closure to its family without guessing from wording.
- Some items are legitimately standing: the blocked approval nobody retried, the decision nobody
  answered. They stay until the user acts, and that is correct — not a detection gap.
- Adding a family later requires designing its closer first, plus a kind, a severity and an
  artifact-id convention; the dispatch table and the fold-version bump are the seams.
- The team-task family stays outside dispatch, and its closure rules stay recorded so a redesigned
  liveness gate can re-enable it without changing the draft contract. That boundary is stated in
  [structural capture](../specs/structural-capture.md) Out of Scope.
- The acceptance contract must keep a per-family closure map in sync, and a new family that skips
  the map is a failure, not a warning.
