# Approval parity

**Context(s):** Answering & Delivery (owning); Attention Register; Capture; Surfaces · **Date:** 2026-11-15

> Intent spec. It states what the capability is for and what it must do; it does not describe
> files, functions or snippets. The design packet and the code own mechanics.

## Definitions

Canonical senses are in [UBIQUITOUS_LANGUAGE.md](../../../UBIQUITOUS_LANGUAGE.md); the notes below
state the extra conditions this spec uses.

- **Reply** — one submission for one item from one surface: the payload, the version the user saw,
  a delivery id and an optional requested track. An approval reply's payload is Allow once or Deny
  with an optional note, and nothing else.
- **Delivery attempt / delivery track** — the recorded try and the channel it used (`client-settle`
  for a mirrored decision, `session-message` for an authored one); the states, evidence and failure
  codes are in [delivery-and-evidence.md](delivery-and-evidence.md).
- **Claim** — the strongest true statement a surface may make: *Answer applied* for a settled
  request, *Sent to session* for a delivered notice, *Not applied* with the reason for a refusal.
- **Awaiting** — the register state after a recorded decision, before the work acknowledges it.
- **Approval** — the item kind for a permission the user must grant before a specific action
  runs. An approval always answers exactly one request.
- **Live request** — a harness question or approval that is currently pending in a session: a real
  request with an owner, a call id and, while a browser holds it, a card. A live request can be
  answered through its own channel and only through it.
- **Mirrored approval** — the register's item for a live approval request. It is the same decision
  the chat's card shows; the register holds a mirror, not a second control.
- **Authored approval** — an item of kind approval declared by the agent through the tool (or by a
  human action), with no harness request behind it. There is no card to settle, so the decision
  travels as an attributed notice.
- **Origin** — which of the two an approval is, decided structurally from the record: an approval
  that names a request identity is mirrored and stays bound to that request; a declaration never
  gains a request identity. One predicate, read by both halves, so the browser and the host cannot
  disagree.
- **Allow once** — the only approval outcome that permits anything: one request, one action, no
  persistence beyond that request. There is no "always allow" and no standing grant.
- **Deny** — the refusal outcome for one request. It carries an optional note from the user and is
  final for that request.
- **Fail closed** — when an approval or ask cannot be answered through its own channel, the outcome
  is a refusal with a named reason and an alternative — never a grant, never a silent success.
- **Expired ask** — a request that is no longer live: it settled elsewhere, its session ended, or
  it was cancelled. An expired ask cannot be answered; its decision cannot be applied late.
- **Out-of-date control** — a control that renders as answerable for a request that already
  settled. An out-of-date control must never silently discard an answer: the answer is refused as
  *not applied* and the user is told what happened instead.
- **Approve & retry** — the recovery offered when the request is no longer live: a plain
  instruction to the work to re-issue the action, delivered on the session-message track, producing
  a *new* request that must be decided through its own live card. It is its own reply intent — not
  an approval decision and never an approval payload — and it grants nothing: it records the user's
  willingness for a new attempt and its claim is *Sent to session*.
- **Retroactive grant** — applying a decision to a request that already ended, or to a different
  request than the one the user saw. It is a forbidden design, not a deferred feature.
- **Correction** — the honest way to change course after a decision was applied: a new instruction
  delivered to the work. A permission that was exercised cannot be un-exercised.
- **Liveness** — the host's positive evidence about the request behind a mirrored item: *live*,
  *not-live*, or *unknown* when the profile cannot prove either way. Only positive *not-live*
  blocks a recorded settle; unknown is not evidence of anything.
- **Reason the model sees** — for a denial, the harness's own rejection failure naming the tool.
  It is a fixed outcome, not the user's note; the note is recorded on the item. For an authored
  approval the delivered notice carries the user's note, because there the note is part of the
  instruction the work reads.
- **Exercise** — the work acting on a granted permission. After exercise the decision is history:
  the register does not reopen a decided approval, because reopening would offer a control for a
  request that no longer exists.
- **Reopen** — the register action that returns a resolved item to `open`; see
  [Attention Register](../../attention-register/CONTEXT.md). It does not apply to an approval whose
  decision the work acted on.
- **Compare-and-set (CAS)** — every approval write carries the item version the user acted on; a
  mismatch is a named conflict refusal with a recovery, so a second decision loses cleanly and the
  caller re-reads.
- **Deliberate decision** — an Allow or Deny is submitted only after an explicit confirmation that
  names the action and states its one-off nature. A one-click grant or a one-click denial is a
  defect: for a permission control, friction that says what is happening is part of the contract.

## Constraints

- **The approval vocabulary is closed.** The only payloads are Allow once and Deny, each with an
  optional note. An unknown outcome is refused as a bad request; it is never downgraded to a
  denial, because a denial is a decision the user did not make.
- **The origin decides the track, before any session work.** A mirrored *decision* may be carried
  only on the client-settle track; an authored decision may be carried only on the session-message
  track. Host-settle, an unnamed track, or the wrong track for the origin is refused before the
  host probes a session, queues a message or records an attempt. The only session-message content an
  expired mirrored approval can produce is the retry instruction, which is not a decision.
- **A mirrored decision is never a message.** A message cannot grant a live request, and a message
  claiming to grant would misreport what happened. The only path is the card that owns the
  request.
- **An authored decision is never merely recorded.** If it cannot be delivered, the Host refuses
  and asks for the explicit confirmed send. Recording it would claim a grant the work never saw.
- **One request, one decision, settle-once.** Once a decision is recorded the item leaves the open
  state; a second decision, however it arrives, loses to the state and version guards. The same
  decision resubmitted with the same delivery id returns the recorded attempt and applies nothing.
- **Liveness is checked before a client-settle is recorded.** The host re-reads whether the request
  is still live: positive *not-live* refuses as *not applied* and records no settle; *live* records
  the decision the card made; *unknown* proceeds only because the browser is reporting a card it
  actually held, and the profile cannot prove otherwise.
- **A stale control never silently discards an answer.** If the request settled elsewhere between
  the render and the click, the user is told the answer was not applied and shown the current
  state; the control is then removed or made read-only.
- **Never race a connected client.** When a browser holds the request's card, the inbox settles
  that same card and does not hold, claim or duplicate the request. An answer from a second
  surface loses at the request, which settles once.
- **Deny is deliberate and final for the request.** It carries the optional note; for a mirrored
  approval the note is recorded on the item and the model sees the harness's fixed rejection
  outcome; for an authored approval the note is part of the delivered notice. A denial is never
  reversible by reopening the same request.
- **Expiry fails closed and offers the retry instruction.** An expired request produces a named
  refusal — *not applied* when the request settled elsewhere, *cannot apply* when it can no longer
  be answered through its channel — plus the Approve & retry offer. Choosing it submits a distinct
  instruction intent on the session-message track: a plain notice asking the work to re-issue the
  action, with the claim *Sent to session*, carrying no approval payload and no approval outcome
  against the dead request.
- **No reopen after exercise.** Once the decision has been acted on, the approval item is not
  returned to `open`; the offered correction is a new instruction, and the work's next attempt
  creates a new request.
- **The decision's evidence is recorded.** The attempt names the track and state. A settled
  decision's resolution carries the exact payload the user submitted at acceptance; a delivered
  decision's payload lives in the attempt until acknowledgement records it as the resolution. The
  acknowledgement follows the same evidence rule as every other answer.
- **Liveness is read once, at record time.** The same item, decision and liveness observation
  produce the same outcome; a request that ends between two reads is reported by the second read,
  never averaged into a guess, so the suite and the product see one deterministic rule.

## Problem

An approval is the one decision whose effect is a real action, so a second control or a late
decision is not a UX nicety but a safety fact. The chat already has a card that holds the request;
if the inbox implements its own answer path, two surfaces can disagree about one request, a stale
button can silently swallow an Allow, or a message can be mistaken for a grant that arrived after
expiry. The agent-declared approval has the opposite problem: there is no request at all, so a
design that only knows how to settle live cards leaves it unanswerable — and a design that records
it without delivering claims an authority nobody exercised.

## Solution

One request, one decision, two presentations. A mirrored approval is decided through the same live
card the chat uses; the inbox row mirrors it and the host records the outcome the card produced,
Allow once, never retroactive, bounded by the request's identity. Where the request is gone, the
honest outcome is a refusal with the retry offer: the user can tell the work to try again, and a
new request is decided afresh. An authored approval has no request to settle, so it is delivered as
an attributed notice — `Approved (one-off).` or `Denied.` plus the user's note — and it is never
recorded without being delivered. Deny is as deliberate as Allow, and a decided approval is not
reopened: what has been exercised can be corrected, not undone.

## User Stories

1. As a user, I want Allow in the inbox to be the same decision as Allow in the chat, so that one
   request cannot be answered twice or two ways.
2. As a user, I want an approval whose request expired to be refused honestly and offered
   "Approve & retry", so that I am never granted something after the fact and never left at a dead
   control.
3. As a user, I want to deny with a reason and see that the decision was recorded, so that a
   refusal is as deliberate and as visible as a grant.
4. As a user, I want an approval the agent merely declared to be answerable too — through a
   message the work reads — so that a sign-off request does not need a live request to exist.
5. As a user, I want a stale Allow that arrives after the request settled to say "not applied"
   instead of silently doing nothing, so that I never believe an action was approved when it was
   not.
6. As a user who approved something that should not have been approved, I want a way to correct it
   by instructing the work, so that the system does not pretend a used permission can be revoked.
7. As an auditor, I want every approval to show one request, one allow-once decision, its track and
   its acknowledgement, so that the permission trail is checkable.

## Acceptance Criteria

### Story 1 — The same decision through the same card

```
Given a mirrored approval (item-30, version 4) whose live request is held by an answerable card
When  the user confirms "Allow once" in the inbox
Then  the live request settles exactly once with the allow-once outcome
  and the host records track client-settle, state settled, payload allow-once
  and the claim is "Answer applied"
  and item-30 becomes awaiting, and no message is sent to the session
```

### Story 2 — The origin decides the track

```
Given a mirrored approval (item-31, version 2) with a live request
When  a reply for it names the session-message track with an approval payload
Then  the host refuses with a bad request naming the live card as the only path
  and no session work happens and no attempt is recorded
```

```
Given an authored approval (item-32, version 1) with no request behind it
When  a reply for it names the client-settle track with an approval payload
Then  the host refuses with a bad request naming the message track as the only path
  and no session work happens and no attempt is recorded
```

```
Given an authored approval (item-33, version 3)
When  a reply carries an approval payload without naming a track
Then  the host refuses the reply as a bad request
  and nothing is applied, recorded or sent
```

### Story 3 — Never retroactive, never a silent stale control

```
Given a mirrored approval (item-34, version 5) whose request is proven no longer live
When  a client-settle Allow once arrives for it
Then  the host records a failed attempt with the failure code was-not-applied
  and the claim is "Not applied"
  and item-34 stays open and no grant is recorded anywhere
```

```
Given a mirrored approval (item-35, version 6) whose live card can no longer be reached
When  the user opens its row
Then  no Allow control is offered
  and the row states that the request is no longer live and offers "Approve & retry"
  and local resolution remains available
```

### Story 4 — Expiry offers a new request, not a late grant

```
Given an expired mirrored approval (item-36, version 7) and no live request
When  the user chooses "Approve & retry"
Then  the host delivers a notice instructing the work to re-issue the action
  and the reply carries no approval payload and no approval outcome is recorded against the
    expired request
  and the notice states the approval is one-off and applies to the new attempt only
  and the attempt is recorded as a session-message delivery with the claim "Sent to session"
  and item-36 becomes awaiting its acknowledgement
```

### Story 5 — An authored approval is delivered, never assumed

```
Given an authored approval (item-37, version 2) in a live idle session "sess-theta"
When  the user confirms "Send & resume now" with Allow once
Then  one notice carrying "Approved (one-off)." is queued into sess-theta
  and the claim is "Sent to session", never "Answer applied"
  and item-37 becomes awaiting and no grant is recorded
```

```
Given the same authored approval item-37 in sess-theta
When  the user submits Allow once without the wake confirmation
Then  the host refuses with a bad request that asks for the explicit confirmed send
  and nothing is recorded, nothing is sent, and item-37 stays open
```

### Story 6 — Deny is deliberate and its meaning is recorded

```
Given a mirrored approval (item-38, version 3) whose live request is held by a card
When  the user confirms Deny with the note "staging is still down"
Then  the request settles with the rejection outcome exactly once
  and the model sees the harness's rejection failure naming the tool
  and the note "staging is still down" is kept on item-38's resolution
  and the claim is "Answer applied"
```

```
Given an authored approval (item-39, version 1) with no request behind it
When  the user sends Deny with the note "not while staging is down"
Then  the delivered notice carries "Denied." and the note verbatim
  and the claim is "Sent to session"
```

### Story 7 — A decision is made once

```
Given item-30 has already been decided and is awaiting its acknowledgement
When  a second Allow once arrives with a new delivery id
Then  the host refuses with a conflict and applies nothing
  and the recorded decision and its evidence are unchanged
```

```
Given item-30 at version 4 on the user's screen and the item now at version 5
When  the user submits the decision from the older render
Then  the host refuses with a conflict before any request work
  and nothing is recorded
```

### Story 8 — Correction, not reopen

```
Given an approval (item-40) whose granted decision the work has exercised
  and whose acknowledgement is observed
When  the user asks to reopen item-40
Then  the register refuses the reopen because the permission was exercised
  and the surface offers to send a correction to the session as a new instruction
```

## Design Decisions

- **Parity is a request-identity rule, not a synchronisation feature.** The chat and the inbox are
  two presentations of one request; the request owns its single decision, and every surface's
  control either drives that decision or mirrors its outcome. Nothing needs to reconcile two
  decisions because only one can exist.
- **The origin split is structural.** Whether an approval names a request decides its track, and
  that fact is read by both halves through one predicate. A field that could be edited to change
  the answer path would be a hole in the fail-closed rule.
- **Client-settle records the card's decision; it does not re-make it.** The host's job on that
  track is to verify the item, prove liveness where it can, and write the evidenced outcome. It
  never claims an outcome it did not see the card produce.
- **Fail closed is a contract, not an error state.** An approval is the one item kind whose
  failure direction is chosen: when in doubt, refuse and offer the alternative. That posture is
  why approval parity needs a spec of its own.
- **Expiry maps to a retry instruction, and the instruction maps to a new request.** When the
  mirrored request is no longer live, the only offered action is an instruction asking the work to
  re-issue the action. It travels as a plain notice on the session-message track — a distinct reply
  intent, never an approval payload — and its claim is *Sent to session*. The permission grant is
  bound to the request boundary, so an instruction cannot authorize the old call: that is exactly
  why it is not a retroactive grant, and the work's new request is decided through its own card.
- **Deny is final for the request and deliberate for the user.** A denial that could be reopened
  would be a second decision on a request that already settled; the honest correction path is a
  new instruction about the action.
- **No reopen after exercise.** The register's reopen is for items whose life was closed without
  the work acting; a used permission is the one decision that cannot be undone, so its item is not
  reopened.
- **The note is not smuggled into the model's view.** For a mirrored approval the user's note is
  evidence on the record while the model sees the harness's fixed rejection; for an authored
  approval the note is part of the notice the work reads. The two cases are different channels and
  the design keeps them distinguishable.
- **A stale control is a defect even when the state is safe.** The request state is safe because
  it settles once; the user's understanding is not, so a discarded answer must always be reported
  as not applied.

### Deferred Decisions

- **Automatic tracking and closure of a retried approval** — the retry instruction is core intent,
  but how the item closes after it, and how the work's new request is related to it, are not
  decided: the retry item is resolved by its own delivery, while the new request arrives as a new
  item under the register's request-identity dedupe key. The seam is the delivery id on the
  instruction plus the new item's dedupe key; closing the loop automatically would need a link
  between them.
- **Delivering the deny note to the model for a mirrored approval** — the harness's approval
  outcome set is closed and carries no note, so the note stays on the record. The seam is the
  harness outcome vocabulary; if it gains a reason channel, the note can travel.
- **How a re-asked approval relates to a denied item** — a new request is a new decision and the
  register's dedupe key is request-identity based. The seam is the item's dedupe key: the new
  request is a new item rather than a reopen of the denied one.
- **Approval context depth for an authored approval** — a declared sign-off has no harness reason
  or call context; what the user should see to decide safely is a surface decision that depends on
  what the tool can carry. The seam is the item body and the reply descriptor.
- **Approving several requests in one action** — deliberately not designed; one decision at a time
  keeps every grant bound to one request.

## Testing Strategy

- **The parity contract is tested end to end through the reply route**: same item, both origins,
  every track combination, with the live-ask liveness signal and the session bridge as the only
  fakes. Each test asserts the decision outcome, the recorded attempt's track and state, and that
  nothing else was sent.
- **Refusals are tested by rule order**: track/origin mismatch before session work, version
  conflict before request work, duplicate delivery before both. The order is part of the contract,
  so each guard gets a test that proves what did *not* happen.
- **Liveness is a table**: live, not-live, unknown, and absent-capability, each with the expected
  outcome, so the positive-evidence rule cannot drift into a guess.
- **Expiry and retry are separate tests**: the refusal of the late decision, and the delivery of
  the retry instruction, so neither can accidentally be satisfied by the other.
- **The register boundary is exercised for reopen**: an exercised approval must refuse reopen,
  tested through the register's public actions rather than by inspecting fields.
- **Determinism**: fixed item versions, fixed delivery ids, an injected clock and an explicit
  liveness fixture per case.

## Out of Scope

- **A retroactive approval grant — forbidden by design.** No seam keeps it open; the request
  identity rule exists to make it unrepresentable.
- Approval policies such as "never ask for this tool", and the harness's own approval waterfall —
  outside the domain.
- The rendering of the confirmation (title, acknowledgement checkbox, modal layout) and the copy
  of the risk warning — owned by [Surfaces](../../surfaces/CONTEXT.md); this spec requires the
  decision to be deliberate and boundary-bound.
- Holding an approval waterfall for an unattended ask, and any host-side race for a live request —
  see the deferred hold in [delivery-and-evidence.md](delivery-and-evidence.md).
- Team-task permissions and board actions — outside the reply contract.
- The register's dedupe and storage of the resolution — owned by
  [Attention Register](../../attention-register/CONTEXT.md); this spec supplies the payload and
  the delivery identity.

## Open Questions

- Should "Approve & retry" require its own confirmation naming that it asks the work to re-issue
  the action (and may therefore cost a turn)? *The product owner and Surfaces decide; the reply
  contract supports it because the retry is a delivery, and a delivery already has a warned-wake
  step.*
- When the profile cannot prove an ask's liveness, should a client-settle be recorded (trusting the
  card the browser held) or refused until liveness is provable? *The design refuses only
  on positive evidence that the ask is dead; the question is whether a stricter posture is worth
  losing the settle in profiles without an observation carrier.*
- How much approval context can an authored approval carry so the user can decide safely without a
  harness reason? *The tool contract's owner and Surfaces decide; the item body is the seam.*
