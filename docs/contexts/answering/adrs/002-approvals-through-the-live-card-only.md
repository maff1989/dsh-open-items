# ADR 002 — Approvals through the live card only

**Date:** 2026-11-15 · **Context(s):** Answering & Delivery

## Context

An approval permits one action: it is granted for one request, once, and never retroactively. The
harness makes the permission a fact of the request's lifecycle — an answer that arrives after the
request settled cannot be applied, and the outcome set is closed (`allowed-once` or a rejection).
Two surfaces now show the same request: the chat's live card owns it, and the inbox mirrors it as an
item. A second answer path would create two decisions for one permission, and the easier of the two
lies is to send a message that says "approved" after the request expired — which looks like a grant
to the model but is not one to the harness.

The same item kind also exists with no request: the agent declares a sign-off through the tool, and
there is no card and nothing for the browser to settle. A host-side hold on the waterfall was
considered and rejected as a general mechanism: the harness has no timeout for a blocking request,
a hold blocks a turn, a host restart converts it into an unknown outcome, and a host that races the
connected card leaves a silently out-of-date Allow in the browser — a safety-adjacent failure.

## Decision

We will decide a **mirrored approval** only through the same live card the chat uses: the browser
settles the one request, and the host records the evidenced outcome on the client-settle track,
Allow once, never retroactive. No message may carry an approval decision for a mirrored item. An
approval item with **no** live request behind it is not a grant at all: its decision is delivered to
the session as an attributed instruction (`Approved (one-off).` / `Denied.` plus the user's note),
and it is never merely recorded. Where the request is gone, the honest recovery is "Approve &
retry" — an instruction to re-issue the action, producing a new request decided afresh.

## Why

The live request is the authorization boundary: the permission is bound to that request's identity,
so the only honest place to decide it is the control that holds it. Deciding it from a second
control races the first; deciding it by message cannot grant anything and misreports what the user
approved; deciding it late is a retroactive grant, which would make the transcript a fiction. The
origin split is structural for the same reason: whether a record names a request decides its only
legal track, and a field that could be edited into a different answer path would be a hole in the
fail-closed rule. Failing closed is the correct direction for the one item kind whose effect is a
real action; the comfort of a permissive inbox is worth less than a permission nobody can
misattribute.

## Alternatives considered

- **The inbox sends a message asking the agent to act.** This is what "approve" would look like
  without the live card. Rejected: a message is not a grant to the harness, it depends on the model
  choosing to retry, and it records an approval the user may believe was applied when it was only
  read.
- **The inbox holds the approval waterfall and answers it later.** Rejected: unbounded waits, a
  silent out-of-date card, an outcome that cannot survive a restart, and no late decision can apply
  once the request has ended.
- **Allow approvals only in the chat.** Rejected: it abandons the action-surface promise for the
  kind users need most and leaves the mirrored item as a pointer with no purpose.
- **Record a late decision on the item without applying it.** Rejected: it would claim an authority
  the user never exercised — the exact "recorded is not delivered" failure the product forbids.

## Consequences

- Both halves read one structural origin predicate; a mismatched origin/track combination is a
  typed refusal before any session work.
- The client needs a capability flag for recording a card settle and must degrade to an honest
  disabled state with a reason when the card is not reachable.
- An expired request produces a refusal plus the retry offer; the retry must not reuse the approval
  decision payload, and the work's new request is decided through its own live card.
- A denial's note stays on the item for a mirrored approval because the harness outcome set carries
  no note; the model sees the harness's fixed rejection instead. For an authored approval the note
  travels inside the delivered notice.
- A decided approval is not reopened: once the permission was exercised, the correction path is a
  new instruction, and the register's reopen rule must refuse it.
- Tests must assert what did *not* happen — no message for a mirrored decision, no grant after
  expiry, no second decision — because the failures prevented here are silent by nature.
