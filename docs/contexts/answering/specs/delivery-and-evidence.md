# Delivery and evidence

**Context(s):** Answering & Delivery (owning); Attention Register; Capture; Durability & Integrity · **Date:** 2026-11-15

> Intent spec. It states what the capability is for and what it must do; it does not describe
> files, functions or snippets. The design packet and the code own mechanics.

## Definitions

Canonical senses are in [UBIQUITOUS_LANGUAGE.md](../../../UBIQUITOUS_LANGUAGE.md); the notes below
state the extra conditions this spec uses.

- **Reply** — one submission for one item from one surface, carrying the item id, the item version,
  a delivery id, the payload and an optional confirmation. This spec covers what happens to it
  after the host accepts it; the answer matrix that chose the path is in
  [inline-answering.md](inline-answering.md). A reply is planned only for an answerable item: a
  reply for a candidate is a named not-answerable refusal and never becomes a delivery attempt.
- **Live request** — a harness ask or approval that is pending in a session: the only thing that
  can be settled, and only once.
- **Mirrored approval / authored approval** — an item of kind approval either mirrors a live
  request (its only legal track is the live card) or was declared with no request behind it (its
  decision is delivered as a notice). The full rule is in
  [approval-parity.md](approval-parity.md).
- **Awaiting** — the register state after a reply that the work has not acknowledged yet; the item
  is in flight, neither back in the user's list nor an outcome.
- **Delivery attempt** — one recorded try at carrying a reply: its delivery id, time, track,
  payload, state, evidence and, when it failed, a failure code. Attempts are append-only; the
  newest attempt for an item is what a surface reads, and an earlier attempt is never rewritten
  except to add the evidence that proves its next state.
- **Delivery id** — the client-minted identity of one attempt. It travels in the reply, in the
  recorded attempt and (for a message) in the transcript source, which is what makes a lost
  response recoverable without a second send.
- **Delivery track** — how the reply travelled. Exactly three exist:

  | Track | What carries the reply | What its success proves |
  |---|---|---|
  | `client-settle` | The live card owned by the browser; the host records the decision the card already made. | The live request resolved, once. |
  | `host-settle` | The ask channel for a continued question; needs a reachable session, or the explicit confirmed wake to resume a cold one. | The ask resolved without a browser. |
  | `session-message` | An attributed notice queued into the session. | The message was accepted, and later that it landed. |

- **Delivery state** — the evidenced state of one attempt: `sending`, `settled`, `queued`,
  `delivered`, `acknowledged`, `failed`. `sending` exists only while a request is in flight; it is
  never a resting state of a durable attempt.
- **Delivery evidence** — the log coordinates that prove what happened: a sequence, message id,
  call id or inbox id. Evidence is what a claim rests on; a claim without evidence is not made.
- **Two-phase delivery** — the gap between a session accepting a message into its queue
  (`queued`) and a step claiming it as a transcript message (`delivered`). Only the second phase is
  visible to the work; a restart, an archive or a cancellation in between leaves the reply parked
  or dropped.
- **Settle** — answer a live ask or approval through its own channel so the request resolves; used
  only of tracks 1 and 2, and only once per request. Its claim is *Answer applied*.
- **Deliver** — put the reply into the session as a notice; used only of track 3. Its claim is
  *Sent to session* — never that the work acted on it.
- **Record** — keep the answer on the item without any message; used when no channel can honestly
  carry it. Its claim is *Recorded*; it is not a delivery track and produces no delivery evidence.
  The answered resolution is recorded and the item becomes `awaiting`; its state becomes `resolved`
  only on acknowledgement evidence or at the window's end. A recorded outcome is distinguishable in
  the durable record from a settled or sent one, because a later reader must derive the *Recorded*
  claim rather than guess it.
- **Acknowledgement** — the register's record of whether the work acted after the answer:
  `pending`, `observed` or `none`. This context owns what counts as evidence and the window policy;
  the register owns the record and applies the transition.
- **Acknowledgement evidence** — the closed kinds that prove the work acted: a tool result, a
  continued turn, a retried call, a resumed goal, a completed team task, a next turn.
- **Acknowledgement window** — the policy bound after which a `pending` acknowledgement becomes
  `none` (24 hours by default, configurable within a bounded range). "No acknowledgement observed"
  is the honest report when the window elapses; it is not a failure claim about the plugin.
- **Resolution** — the recorded outcome that ends an item's active life (answered, dismissed,
  superseded, detector-closed). This context supplies the answer payload and the delivery id; the
  register records the resolution at acceptance for a settle, and for a session message only when
  acknowledgement or the window's end supplies it.
- **Claim** — the strongest true statement a surface may make about a reply: *Answer applied*,
  *Sent to session*, *Recorded*, or *Not applied* with the failure's reason. A claim is derived
  from the durable attempt's evidence; any later reader must derive exactly one claim from the
  record, and a surface that cannot derive it must not guess or label it *Answer applied* or
  *Sent to session*.
- **Notice** — a transcript entry written by the plugin rather than by the user. A delivered reply
  is a notice labelled by the plugin's own source kind, carrying the item id and delivery id.
- **Confirmed wake** — the explicit user confirmation that a send may resume a cold or idle
  session and spend a turn. It rides the reply and appears in the control's copy.
- **Parked** — a message that was accepted into a session's queue but that nothing will claim: no
  turn is open and no wake occurred. `parked` is a reserved outcome with a recovery, not a silent
  limbo; recognising it needs a reconciliation pass over accepted attempts, and that pass is a
  deferred decision (see Deferred Decisions).
- **Lost response** — a reply whose result never reached the surface though the attempt may exist.
  Recovery reads the attempt by delivery id; if none exists, resubmitting the same delivery id is
  safe.
- **Failure code** — the named reason an attempt failed: `was-not-applied`, `cannot-apply`,
  `session-archived`, `agent-unavailable`, `operator-cancelled`, `unknown-outcome`, `parked`. It
  is never a bare boolean and it is never silently retried. `parked` is reserved for a queued
  delivery nothing claims (classification deferred); `operator-cancelled` is reserved for an
  operator cancel — the design has no operator-cancellation surface, so no user-facing claim
  depends on it.
- **Durability barrier** — the step after a queue write that waits for the session's write to be
  durable. Its failure weakens the restart guarantee, so the claim must say so.
- **In flight** — the register's view of a reply with no terminal acknowledgement: the item is
  `awaiting` and the attempt is `settled`, `queued` or `delivered`.

## Constraints

- **Evidence or nothing.** Each state has exactly one admissible proof: `settled` needs the settling
  channel's acceptance; `queued` needs the session's queue commit; `delivered` needs a committed
  message carrying our delivery id; `acknowledged` needs one of the closed evidence kinds; `failed`
  needs its code. No state is set from timing, from a resolved agent, or from a successful-looking
  request.
- **A claim is read from the record, never inferred from the click.** The durable attempt must let
  any later reader derive exactly one of the four claims. Where the record cannot distinguish a
  recorded outcome from a settled or sent one, no surface may label it *Answer applied* or
  *Sent to session*; the honest fallback is that the answer was saved and its transport is not
  recorded.
- **A settle never resumes a session silently.** Track 2 needs a reachable session, or the same
  explicit confirmed wake a message needs, with the resume-and-spend cost shown and confirmed. A
  settle that cannot show that confirmation records the answer instead, and says the work has not
  seen it.
- **Append-only attempts.** A new fact appends a new attempt entry with the same delivery id; the
  prior entry is never rewritten. A repeated delivery id returns the recorded attempt only while
  that attempt is accepted or in flight — the lost-response recovery case — and it does so before
  the state and version guards. A *failed* attempt is never replayed under its old id: retrying it
  mints a new delivery id and appends a new attempt.
- **No automatic retry.** A failed or unknown attempt stays failed or unknown until the user acts.
  Lost-response recovery reuses the delivery id of the accepted or in-flight attempt; retrying a
  failed attempt mints a new delivery id, and a different attempt always gets a new one.
- **Two-phase honesty.** A message that is queued is never reported as a message the work saw. The
  field that changes `queued` to `delivered` is the committed log fact, never a timer or a guess.
- **Message content is bounded and verbatim.** The message is one attribution line naming the
  channel and the item, followed by the user's answer exactly as submitted (an approval decision
  is stated in the plugin's own words because there are no user words to quote). The item title and
  body are never interpolated: the model must not read model-authored prose as a user instruction.
- **One message per attempt, one attempt per action.** A settling attempt sends no message; a
  session-message attempt queues exactly one notice. No reply stacks two deliveries into one
  settle.
- **The archived check comes before any session work.** Delivering to an archived session is
  silently destroyed, so the refusal happens before resolving an agent, queuing or recording an
  attempt.
- **A settle records the resolution at acceptance; a message resolves only on evidence.** A settle
  (tracks 1 and 2) records the answered resolution with its payload and delivery id, and the item
  becomes `awaiting` carrying it. A session-message reply records **no** resolution at send: the
  item becomes `awaiting`, the answer it carried lives in the delivery attempt, and it becomes the
  resolution when acknowledgement is observed — or when the acknowledgement window elapses with
  `none`. In both cases the item's *state* stays `awaiting` until acknowledgement evidence or the
  window ends it as `resolved`; no claim that the work acted is made before that evidence.
- **The window is deterministic.** It is measured from the answer's recorded time with one injected
  clock; at the window's end `pending` becomes `none`. Nothing else in this spec depends on wall
  clock ordering.
- **Attribution is closed.** A delivered reply's source kind is the plugin's own; reusing the user's
  source kind is forbidden, because the harness treats direct human input as authority in several
  places.
- **Refusals are honest failures.** Every refusal, failure and unknown outcome names its reason and
  the recovery the user can take; nothing is shown as an empty list or a disabled control with no
  explanation.

## Problem

A reply can fail in ways that look identical from the outside: the request was already answered in
another window, the session is archived and would swallow the message, the agent is gone, the
message was accepted but nothing will ever wake it, the host restarted mid-operation, the response
to the click was lost. The naive surface reports one of two lies — success because the request
returned, or a bare failure that hides a message that actually landed. Meanwhile the user's real
question is not "did the API return?" but "did my answer reach the work, and did the work act on
it?". Without a delivery ledger, a claim vocabulary and an evidence rule, the register cannot
answer that question, and its whole point is that it can.

## Solution

Every reply becomes one recorded attempt with a track, a state, its evidence and — when it fails —
a named reason. The states follow an evidence ladder: a live request is settled (applied), a
message is accepted (queued), a message is proven in the transcript (delivered), and the work acts
(acknowledged). The surfaces may claim only what the newest attempt proves, and four claims are
kept apart on purpose: *Answer applied*, *Sent to session*, *Recorded*, and *Not applied*. Recovery
is by delivery id, so a lost response cannot produce a second message. The acknowledgement window
supplies the one honest negative — "no acknowledgement observed" — rather than silence. A delivered
reply is a labelled notice, never an impersonation of the user.

## User Stories

1. As a user, I want to know what stage my answer reached — applied, sent, recorded, delivered,
   acted on — so that I can tell "the agent has it" from "the agent never saw it".
2. As a user, I never want a saved answer described as sent, or a sent answer described as applied,
   because those are different facts with different consequences.
3. As a user, I want a message that reached the session's log distinguished from one that only
   entered its queue, so that a restart cannot make me believe something I cannot prove.
4. As a user, I want the register to say "waiting on the work" and later either that the work acted
   or that no acknowledgement was observed, so that a quiet session is reported honestly.
5. As a user whose click response was lost, I want the system to recover the recorded attempt
   instead of sending a second message.
6. As a user, I want every failure to carry its reason and a recovery, so that a refusal is
   actionable rather than a dead end.
7. As a user reading the transcript, I want a delivered reply to appear as a labelled Open Items
   notice with my words, so that I can see what was said without the transcript claiming I typed it
   in that chat.
8. As an auditor, I want each answer's track, evidence, resolution and acknowledgement to be
   recorded, so that "what did I decide, and what came of it?" has an answer.

## Acceptance Criteria

### Story 1 — Applied and sent are never conflated

```
Given an open mirrored approval (item-21, version 5) whose live ask is observed as live
When  the reply records the card's decision with the client-settle track and Allow once
Then  the attempt is recorded as track client-settle, state settled, with the Allow once payload
  and the claim is "Answer applied"
  and item-21 becomes awaiting carrying its answered resolution with the Allow once payload
  and no message is sent to the session
```

```
Given an open blocking decision (item-22, version 2) in session "sess-zeta" with a running turn
When  the user replies with the text "ship it on Friday"
Then  the attempt is recorded as track session-message, state queued
  and the claim is "Sent to session", never "Answer applied"
  and item-22 becomes awaiting with no resolution recorded yet — the answer it carried lives in
    the delivery attempt until acknowledgement
```

```
Given a reply for item-23 (version 1) accepted while its session "sess-iota" is not running
  and the answer was persisted on the item with no message delivered
When  a later reader reads item-23's attempts
Then  the derived claim is "Recorded" and the reader says the work has not seen the answer
  and no surface labels the outcome "Answer applied" or "Sent to session"
```

### Story 2 — Queued is not delivered

```
Given item-22 awaiting with a queued attempt "delivery-9" for session sess-zeta
When  the committed log is folded and shows a message with delivery id "delivery-9"
      at sequence 41, message id "msg-4"
Then  a delivered attempt is appended for delivery-9 with evidence { seq: 41, messageId: "msg-4" }
  and item-22 is still awaiting with its claim unchanged at "Sent to session"
```

```
Given the delivered attempt for delivery-9 already recorded at sequence 41
When  the same log message is folded again by a replay
Then  no second transition is appended and the attempt count for delivery-9 is unchanged
```

### Story 3 — Refuse before anything is swallowed

```
Given an open item whose source session "sess-epsilon" is archived
When  the reply sends the text "use the corporate registry"
Then  the host refuses with session-archived before resolving an agent
  and no attempt is recorded, no message is queued, and the item stays open
```


### Story 4 — Failure and unknown are values

```
Given a running turn in sess-zeta and a session bridge whose queue write throws
When  the reply steers the text "ship it on Friday"
Then  a failed attempt is recorded with the failure code unknown-outcome
  and the claim is "Not applied — outcome unknown" and the item stays open
  and no surface reports success or schedules an automatic retry
```

```
Given the queue write succeeded but the durability barrier failed
When  the attempt is recorded
Then  the attempt is queued and its note says a restart may lose the message
  and the claim stays "Sent to session" with that warning, never a silent success
```

```
Given the message was queued for item-22 and the item then changed before the attempt was stored
When  the host persists the attempt
Then  the host reports a conflict naming the queued delivery
  and does not hide that the message is already in the session's log
```

### Story 5 — A lost response costs nothing

```
Given a reply for item-22 with delivery id "delivery-2f1c" whose response was lost
When  the surface asks for the delivery by that id
Then  the recorded attempt is returned and no second message is sent
  and the surface renders the claim that attempt proves
```

```
Given a failed attempt "delivery-7" for item-22 recorded with the failure code unknown-outcome
When  the user retries the same reply from the surface
Then  the surface submits a new delivery id and a second attempt is recorded
  and the failed attempt is not replayed as a success
```


### Story 6 — Acknowledgement is evidenced, then honestly absent

```
Given item-22 is awaiting with a delivered attempt for delivery-9
When  the log fold reports the work acting after the answer (a retried call at sequence 88)
Then  the acknowledgement becomes observed with kind call-retried and sequence 88
  and item-22's state becomes resolved and the answer it carried is now recorded as its answered
    resolution with delivery-9
  and the attempt is marked acknowledged
```

```
Given an item answered at 10:00 with a 24-hour acknowledgement window and no evidence after
When  the retention sweep runs at 09:59 the next day
Then  the item is still awaiting with acknowledgement pending
```

```
Given the same item and window
When  the retention sweep runs at 10:01 the next day
Then  the acknowledgement becomes none and the item resolves
  and the register reports "no acknowledgement observed", not a failure of the answer
```

### Story 7 — The reply is a notice, not an impersonation

```
Given a delivered reply for item-22 whose message a turn has claimed
When  the transcript renders it
Then  the message's source is the plugin's own notice kind carrying item-22 and delivery-9
  and its body is one attribution line followed by "ship it on Friday"
  and the item title "Release sign-off" appears nowhere in the message
  and the source is never the user's own kind
```

## Design Decisions

- **Four claims, four proofs, each derivable from the record.** *Answer applied* needs a settled
  request; *Sent to session* needs a queued or delivered message; *Recorded* needs an answer that
  was persisted with no message; *Not applied* needs a named reason. The claim vocabulary is the
  closed contract the surfaces render, and the durable record must carry the fact that separates a
  recorded outcome from a settled or sent one — a claim is never inferred from the click or the
  surface's optimism.
- **The delivery ledger is append-only; its delivery id is idempotent for accepted attempts.** The
  attempt list is the audit trail, the recovery index and the idempotency key in one structure; no
  second structure may hold a competing version of the same fact. Replaying a *failed* attempt
  under its old id would turn a known failure into an unknown outcome, so a retry after failure is
  a new attempt with a new id.
- **Two-phase delivery is modelled, not hidden.** Because the harness makes `queued` and
  `delivered` different facts, the register must too. The `parked` outcome names the gap; the pass
  that recognises a parked attempt is a deferred decision (see below), and until it exists no
  surface may claim a parked state it has not evidenced.
- **Evidence is folded from committed events.** Delivery and acknowledgement evidence arrives from
  the same read-only capture fold that observes everything else; this context never polls a
  session's internals to guess what happened, and a resolved agent is never evidence.
- **A settle records the decision; a message earns its resolution from the evidence.** A settled
  answer (tracks 1 and 2) is the decision the user gave, so it is recorded as the item's answered
  resolution at acceptance and `awaiting` carries it. A session-message reply is only an attempt
  until the work acts: no resolution is recorded at send, and the answer the attempt carried
  becomes the resolution when acknowledgement is observed or when the window elapses with `none`.
  Either way the item's *state* stays `awaiting` until that evidence; recording a message's
  resolution at send would claim an effect the register cannot see.
- **The acknowledgement window is the honest negative.** The window exists so a delivered-but-
  ignored answer is reported, not forgotten; a `none` acknowledgement is a fact about the session,
  not a defect to hide.
- **Failure codes are a closed vocabulary with a recovery each.** `was-not-applied` means the
  request resolved elsewhere; `cannot-apply` means it can no longer be answered through its
  channel; `session-archived` means restore the session or resolve locally; `agent-unavailable`
  means nothing was sent; `unknown-outcome` means re-read, never assume. Two codes are reserved
  rather than produced: `operator-cancelled` names an operator cancel the design has no surface
  for, and `parked` names a queued delivery nothing claims, whose recognition is the deferred
  reconciliation decision. No user-facing claim depends on a reserved code.
- **Queue-write failure and durability-barrier failure are different claims.** The first is a
  failure with no message; the second is a queued message whose restart guarantee is weaker. The
  surface's words must differ.
- **The notice source is the only write into a session.** It carries the item and delivery ids so
  the fold can prove the landing, and it never reuses the user's source kind. No session event,
  no composer call, no queue prepend — see
  [docs/adrs/002-no-session-log-writes.md](../../../adrs/002-no-session-log-writes.md).
- **No settle resumes a session silently.** A continued ask in a cold session is settled only
  with the explicit confirmed wake and its resume-and-spend copy; without that confirmation the
  answer is recorded and the surface says the work has not seen it. Settling must not be a
  loophole in the wake rule.
- **Recovery precedes retry.** Reading by delivery id is always safer than resubmitting; recovery
  reuses the accepted or in-flight attempt's id, while a retry after a failure mints a new one.

### Deferred Decisions

- **Classifying and recovering a parked delivery** — `parked` is the reserved name for a queued
  delivery that nothing claims, and recognising one needs a reconciliation pass over queued and
  delivered attempts with no acknowledgement. Deciding that pass is deferred, together with
  whether the host may re-wake a parked delivery on its own; the seam is the append-only attempt
  list plus the two-phase state, and the delivery id is what a recovery or a withdrawal would name.
- **Withdrawing a queued delivery** — a message that is queued but not yet claimed could be
  withdrawn; the seam is the delivery id in the session queue, and a settled decision can never be
  withdrawn.
- **Whether `none` acknowledgement should re-offer the item** — the register owns reopen and the
  acknowledgement record; the seam is that the evidence and the window result are both retained on
  the item.
- **Delivery ledger retention** — attempts are bounded by the register's record policy; the seam is
  the append-only list, which can be bounded without changing its meaning.
- **Pushing delivery progress to the browser** — the read model is pull-based (revision, focus,
  visible-window poll); a pushed channel is a read-model decision, not a delivery one.
- **Coalescing several answers to one session into one turn** — each reply is its own attempt; the
  seam is the attempt list, which could carry a shared delivery for several items.

## Testing Strategy

- **Contract tests through the reply route**: each acceptance scenario is driven as a reply or a
  delivery read against the real delivery engine with the session bridge and storage faked — they
  are the only system boundaries, and they are exactly where the failures live.
- **Evidence tests drive the real register**: the delivery and acknowledgement transitions are
  asserted through the store/service boundary, so an attempt's append-only behaviour, the item's
  state and the resolution are checked together rather than mocked apart.
- **Claim vocabulary is asserted as a table**: every outcome maps to exactly one claim sentence,
  derived from the durable attempt alone; a test fails if a claim could be produced by two
  different outcomes, or if a recorded outcome resolves to *Answer applied* or *Sent to session*.
- **Failure codes are tested by cause**, one per scenario: archived, unavailable, thrown queue
  write, failed barrier, lost CAS after queue. The two reserved codes are tested only for the
  absence of a claim: no user-facing outcome may depend on `parked` or `operator-cancelled`.
- **Non-determinism is bounded**: one injected clock for the window and timestamps, and fixed
  delivery ids and message ids in fixtures; the suite must not depend on real elapsed time.
- **Idempotency is tested as behaviour**: a repeated delivery id for an accepted or in-flight
  attempt produces one attempt and one message; a retry after failure produces exactly one new
  attempt under a new id; a replayed evidence fold produces no second transition.

## Out of Scope

- The acknowledgement record and its state field — the register owns and transitions it; this
  spec owns the evidence kinds and the window policy that move it.
- The item lifecycle and the register's presentation of in-flight rows — owned by
  [Attention Register](../../attention-register/CONTEXT.md).
- Control rendering, copy, toast behaviour and the live region — owned by
  [Surfaces](../../surfaces/CONTEXT.md). This spec states the claim; the surface words it.
- Approval parity and the origin split — [approval-parity.md](approval-parity.md).
- The harness's own delivery mechanics (queue commit, claim event, flush listener) and the session
  log format — outside the domain.
- Model-facing reporting of answers, and consent for any egress — owned by
  [Model Contract & Consent](../../model-contract/CONTEXT.md).

## Open Questions

- What field carries the distinguishing fact that lets every later reader derive the *Recorded*
  claim — a track value, an outcome discriminator, or a dedicated recorded attempt? *The claim must
  be derivable either way; the representation is undecided. The register and durability owners
  should answer it before a surface renders a stored claim.*
- Once the deferred reconciliation pass exists, should a parked delivery be re-woken automatically
  at the next host activation, or always wait for the user? *The product owner decides; the
  reserved code and the delivery id already support either.*
- Should the register show the raw delivery evidence (sequence/message id) to the user, or only the
  plain-language claim? *Surfaces and register decide; the evidence is retained regardless.*
- Is one acknowledgement window right for every item kind, or should blocking items get a shorter
  window than follow-ups? *Retention's owner decides; the evidence kinds are unaffected.*
