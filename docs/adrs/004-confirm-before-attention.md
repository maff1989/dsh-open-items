# ADR 004 — Confirm before attention

**Date:** 2026-11-15 · **Context(s):** Capture, Attention Register, Surfaces

## Context

The product's founding measurement was uncomfortable: in a real corpus, the structured channel
(failed approvals, unanswered structured questions, interrupted turns) captured almost none of
the decisions that actually ended sessions. The genuine open loops lived in the **prose** at the
end of long reports ("want me to…?", "should I use A or B?") and in plans the agent wrote but
never finished.

The obvious fix — scan the prose for ask-like patterns — is unsafe at full recall: a permissive
keyword scan flags the majority of sessions, mostly false, because words like "confirm" and
"approve" appear in every report. At the same time, an artifact-only capture showed the user a
0-item inbox while real decisions were waiting.

So the design needed both: much higher recall than the structural channel, and a guarantee that
a guess never masquerades as a fact. A forty-item inbox is the failure mode this product exists
to prevent.

## Decision

Split attention into **two evidence tiers**:

- **Structural** — an item whose existence rests on a harness fact or an explicit declaration.
  Structural items are attention immediately.
- **Candidate** — an item *inferred* by a heuristic. A candidate is never "Needs you", no
  surface offers an answer control for it, and the reply contract refuses a candidate-tier
  reply with a named refusal — confirming, correcting or suppressing it is the only thing the
  user can do with one. Confirmation is the only path from inference to attention, and the
  agent cannot take that path on the user's behalf.

## Why

- It preserves both goals: the prose heuristic can be tuned for recall (and for a bounded number
  of items per turn), while the user's attention stays reserved for evidence.
- The user remains the authority on what is real; an inferred kind is a labelled guess that the
  user can correct when confirming.
- It draws the line where the two sources genuinely differ: a fact cannot be wrong about whether
  the work is blocked, while a reading of a sentence can.

## Alternatives considered

- **Structural capture only** — rejected: the measured founding failure; most real open loops
  never produce a structured artifact.
- **Permissive inference straight into the inbox** — rejected: measured false-positive rates make
  it a noise generator, and the product's whole promise is a small, trustworthy list.
- **Model-assisted classification as the primary detector** — rejected: cost, latency, consent and
  egress; it exists only as an optional confirm/refine second opinion, never as the detector.
- **A confidence score on one tier** — rejected: a percentage invites the user to trust a guess
  proportionally, when the honest rule is binary: fact or confirmation required.

## Consequences

- A candidate lifecycle is part of the product: promote with correction, suppress with a remembered
  exact key, per-turn and per-session bounds, batch-aware supersession, and closure on a later
  user turn.
- Surfaces need a separate Candidates section and must never count candidates as Needs you.
- Retention and the read model must exclude candidates from the attention predicate while keeping
  them visible and counted separately.
- Inference may never be silently promoted; any future automation that confirms candidates on the
  user's behalf would overturn this decision, not extend it.
