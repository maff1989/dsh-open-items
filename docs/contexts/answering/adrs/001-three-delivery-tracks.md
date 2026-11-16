# ADR 001 — Three delivery tracks

**Date:** 2026-11-15 · **Context(s):** Answering & Delivery

## Context

The inbox is an action surface, not a triage list: every item must be answerable from the surface
where it is seen, and the answer must reach the work. The harness offers three genuinely different
ways to carry an answer, and they do not substitute for one another:

- a **live request** (an ask or approval) that a browser's card owns and can settle in place, with
  the harness's own machinery deciding the outcome;
- an ask channel for a **continued** question that no card holds any more, which the host can
  answer out-of-band;
- an ordinary **message** into the session, which is the only path for a decision that has no live
  request behind it and the only path when no browser is connected to a live one.

They differ in cost (a message spends a turn; a settle does not), in safety (a grant is a harness
fact bound to its request; a message cannot grant), in evidence (a settle is proven by the settling
channel, a message only when it lands in the log) and in availability (the halves upgrade
independently). Pretending one path serves all is wrong in at least one direction: it spends a turn
for every answer, claims an authority a message does not have, or strands items with no browser.

## Decision

We will route every reply through one host-side router with exactly three named delivery tracks —
`client-settle`, `host-settle` and `session-message` — each with fixed preconditions and its own
evidence. The surface shows one control generated from the item's reply descriptor and may name the
track it believes applies; the host validates that request, may downgrade it to a weaker channel,
and never silently upgrades it. Every attempt records the track it actually used, and the surface
renders the outcome rather than its own intent.

## Why

The track is where honesty, cost and safety meet, so it is decided once, by the party that can see
the session: the host. Letting the browser choose would let a newer browser invent a channel a host
cannot carry; letting each surface choose would let the page, the panel and the card disagree about
one click. Three tracks are the smallest set that keeps each answer truthful, and the cost is the
user's to see: a steer joins a running turn for free, a record spends nothing, and a follow-up wakes
the session and costs a turn with the user's confirmation.

## Alternatives considered

- **One universal message path.** Simple, and it makes every answer identical to record. Rejected:
  it cannot settle a live blocking ask honestly, it spends a turn for every answer, and it turns
  approvals into instructions that pretend to be grants.
- **Client-side settlement only.** Rejected: it cannot answer when no browser holds the request,
  cannot answer a decided-later prose item, and leaves the host unable to record what happened.
- **Host holds every ask/approval waterfall.** One channel for everything, and the request stays
  answerable until the user reaches it. Rejected: the harness has no timeout for a blocking ask, a
  hold that ignores cancellation hangs the turn, a host restart converts the hold into an unknown
  outcome, and a race won by the host leaves a silent, out-of-date control in the browser.
- **Per-kind answer surfaces** (approvals in the chat, prose in the inbox). Rejected: the product
  promise is that every item is answerable where it is seen, and the right channel depends on the
  item's origin and the moment, not on its kind.

## Consequences

- The reply contract carries capability flags and a stable refusal vocabulary, and every surface
  must degrade visibly rather than guess which channel is available.
- Each track needs its own evidence rule and failure taxonomy; the register's claims — *Answer
  applied*, *Sent to session*, *Recorded*, *Not applied* — follow from which track ran.
- A downgrade is a normal, reported outcome; surfaces must render the host's outcome even when it
  is weaker than the control the user pressed.
- The approval path is constrained by track availability (see
  [ADR 002](002-approvals-through-the-live-card-only.md)), and a future capability (for example a
  bounded hold for unattended asks) must arrive as a *new named track with its own claim*, never by
  stretching one of these three.
- Any later proposal to collapse the tracks must first solve the evidence and approval-safety
  problems that made them separate.
