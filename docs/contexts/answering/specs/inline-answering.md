# Inline answering

**Context(s):** Answering & Delivery (owning); Attention Register; Capture; Surfaces · **Date:** 2026-11-15

> Intent spec. It states what the capability is for and what it must do; it does not describe
> files, functions or snippets. The design packet and the code own mechanics.

## Definitions

Canonical senses are in [UBIQUITOUS_LANGUAGE.md](../../../UBIQUITOUS_LANGUAGE.md); the notes below
state the extra conditions this spec uses.

- **Answerable item** — an item the user can still answer: a live item (`open`, and `stale` while
  it is presented as needing the user) whose tier is structural. A candidate is not answerable — a
  reply for one is a named refusal — and a `snoozed`, `awaiting`, `archived` or `resolved` item is
  not answerable until the register returns it to a live state.
- **Reply** — one submission for one item from one surface: the item id, the item version the
  user saw, a client-minted delivery id, the payload, an optional requested track and an optional
  confirmed wake. A reply is an attempt; it is not a resolution.
- **Reply payload** — the closed set of answer shapes: an option, free text, an approval outcome
  (Allow once or deny), a team-task action, or a dismissal. Only option, text and approval can
  become a message; a dismissal is its own register action.
- **Reply descriptor** — the item's declaration of what its answer control accepts: which
  controls exist, the verbatim options, whether free text is allowed, whether the send will wake a
  session, and a short note to show beside the control. The descriptor describes the item; it does
  not choose the track.
- **Answer** — the substantive content the user supplied; the thing a later reader wants to know.
- **Requested track** — the track a surface believes applies. A hint the host validates, not a
  decision.
- **Delivery attempt** — one recorded try at carrying a reply: its delivery id, track, state,
  evidence and failure. The list of attempts is the ledger the register and the surfaces read; the
  full state vocabulary is in [delivery-and-evidence.md](delivery-and-evidence.md).
- **Delivery id** — the client-minted identity of one reply attempt, carried across the request,
  the recorded attempt and (for a message) the transcript source. It is what makes a retry
  idempotent.
- **Answer matrix** — the rule table that maps an item's origin and tier, its blocking flag, the
  payload and the session's observed state to one outcome: settle through the live card, settle
  through the ask channel, steer, deliver, record, or refuse. Every surface uses it; no surface
  chooses the track.
- **Settle** — answer a live ask or approval through the request's own channel, so the request
  resolves and the work continues. Only a live request can be settled, and it settles once.
- **Steer** — put the reply into a turn that is already running, at the agent's next step. Steer
  does not wake anything and does not open an extra turn.
- **Deliver** — send the reply into the session as an attributed notice the agent sees at its next
  step; delivering to an idle or cold session costs a turn, so it needs a confirmed wake.
- **Record** — keep the answer on the item without sending it anywhere. The answered resolution is
  recorded and the item becomes `awaiting`, saying honestly that the work has not seen it; its
  state becomes `resolved` only on acknowledgement evidence or at the window's end.
- **Awaiting** — the register state after a reply that has not yet been acknowledged by the work:
  the item is in flight, not back in the user's list, and not yet an outcome.
- **Delivery state** — what one attempt has evidenced: `settled`, `queued`, `delivered`,
  `acknowledged` or `failed`. The claim a surface may make follows from this state.
- **Claim** — the strongest true statement a surface may make about a reply: *Answer applied*,
  *Sent to session*, *Recorded*, or *Not applied* with its reason. A claim comes from the outcome,
  never from the click.
- **Acknowledgement** — the register's record of whether the work acted after the reply. This spec
  only produces the reply that starts that watch; the evidence and the window are in
  [delivery-and-evidence.md](delivery-and-evidence.md).
- **Resolution** — the recorded outcome that ends an item's active life (answered, dismissed,
  superseded, detector-closed). A reply is not a resolution; the register records the resolution the
  reply earned.
- **Refuse** — decline the reply with a named reason and a recovery, applying nothing.
- **Live ask** — a harness question or approval that is currently pending in a session: a real
  request with an owner, a call id and, while a browser holds it, a card.
- **Mirrored item** — the register's item for a live ask; the same decision the chat's card shows.
- **Authored approval** — an item of kind approval with no live request behind it; its decision
  travels as a message, never as a grant.
- **Turn state** — the session observation the matrix uses: a running agent, an open turn on an
  otherwise idle agent, an idle live session, or a cold session. The observation never wakes
  anything.
- **Candidate** — an inferred item that is not answerable as an item until the user confirms it.
  A reply for a candidate is refused as a named not-answerable outcome, never planned as a settle
  or a delivery; the only actions are to confirm it into a structural item or to suppress it. See
  Capture's [candidate tier](../../capture/specs/candidate-tier.md) for how a candidate is made and
  [Attention Register's context](../../attention-register/CONTEXT.md) for what changes on confirm.
- **In-session card** — the answerable card rendered at the item's tool row in the transcript. A
  post-hoc raise: it hydrates by item id and version and can never own a harness request.
- **Compare-and-set (CAS)** — every write carries the version the user acted on. A mismatch is
  never a lost update: an item transition returns a named conflict refusal with a recovery and the
  surface re-reads the item (only the settings write, outside this context, returns a conflict
  value carrying the live record).
- **Model race** — the model recording the same item's outcome in the conversation while the user
  answers from a surface. The register holds one item, so the CAS decides.
- **Owner fence** — the rule that the reply route admits only the install owner's browser; every
  other peer is refused.

## Constraints

- **One reply, one attempt.** A reply is submitted once; its control disables while the request is
  in flight; a second click with the same delivery id returns the recorded attempt while that
  attempt is accepted or in flight (lost-response recovery), and never replays a failed attempt.
- **One writer.** The surface never writes the item, the session or the composer. It sends one
  reply intent and renders the returned outcome. The host owns the transition and the send.
- **The descriptor bounds the payload.** An empty answer is refused; an option must be one of the
  descriptor's verbatim options; a free-text answer is bounded by the record's text bound; an
  approval payload is only Allow once or deny.
- **The plan is deterministic.** Planning is a pure function of the item as read, the payload, the
  requested track, the confirmed-wake flag and one non-waking session observation. The observation
  is taken once, at send time, so a turn ending between the click and the send produces a reported
  outcome — record or refusal — never an unstable or retried send.
- **Downgrade, never upgrade.** The host may reject a requested track that is illegal for the
  item's origin before any session work, and may downgrade a legal request to a weaker channel
  (for example host-settle → steer → record); it never silently uses a stronger channel than the
  one requested, and it reports which channel it used.
- **Never wake unconfirmed, with no settle exception.** A cold session is resumed only when the
  confirmation flag is set and the surface has already told the user that the resume spends a turn.
  This holds for every path, including settling a continued ask: a settle that cannot show that
  confirmation is not made — the answer is recorded instead, with the claim *Recorded* and the
  statement that the work has not seen it.
- **Never interrupt what moved on.** A non-blocking item is recorded rather than steered unless
  the user explicitly chooses the sending action.
- **Never record a decision.** An approval payload whose only possible outcome is recording is
  refused with an instruction to confirm the send; a decision that nobody delivered is not a
  decision.
- **Candidates are refused, not answered.** A reply for a candidate item is refused as a named
  not-answerable outcome and is never planned as a settle or a delivery; the only actions a
  candidate row offers are to confirm it or to suppress it. The requirement is the contract; which
  layer enforces it is an open question (see Open Questions).
- **One canonical guard order.** Every reply passes the same sequence, and no surface or later
  section may reorder it: (1) request identity and a delivery id; (2) payload validation; (3) item
  exists; (4) the approval origin/track combination; (5) duplicate delivery id — an accepted or
  in-flight attempt is returned, a failed attempt requires a new id; (6) the item is answerable
  (candidates never are, and a settle must be legal for the item); (7) the expected version and
  state check; (8) the session is not archived; (9) delivery planning. The order is observable: a
  malformed payload for a missing item is refused as a bad payload, not as a missing item, and the
  origin/track refusal happens before any duplicate-id bookkeeping.
- **No silent retry.** Nothing is retried automatically. Lost-response recovery reuses the
  delivery id of the accepted or in-flight attempt; retrying a failed attempt mints a new delivery
  id, and a different attempt always needs a different id.
- **Never throw at the user.** Business failures are returned as values with a named reason and a
  recovery; an unexpected failure is reported as unknown, never as success.

## Problem

The user meets the same item on different surfaces and at different moments: the page while the
work is blocked, the panel while the session is on screen, the card while reading the transcript,
and sometimes hours later when the session is cold or archived. A surface that invents its own
answer path is wrong in one of two ways: it interrupts work that moved on, or it spends a turn the
user did not ask for, or it pretends a click reached the work when only a local record changed.
Worse are the dead controls — a button that looks answerable for an item whose request already
settled, or for a candidate that was never confirmed as an item.

## Solution

Every open item is answerable from the surface where it is seen. The control is generated from the
item's reply descriptor, so it accepts exactly the answer shapes the item supports. One host-side
answer matrix decides how that answer travels — through the live request's own channel when a real
request exists, into a running turn when the work is waiting, into the session as an attributed
notice when the user explicitly sends and confirms the cost, or onto the item alone when nothing
can honestly carry it — and the surface says which of those happened. Items that genuinely cannot
be answered say so and offer what can be done instead. The answer matrix, the guard order and the
idempotency rule are the same everywhere; the transcript card answers by delivery and never claims
to have settled a harness request it does not own.

### The answer matrix

Origin and the session's observed state decide the path; the item kind alone never does.

| Item origin | Turn still running | Live, between turns | Cold session | Archived or gone |
|---|---|---|---|---|
| Declaration, `blocking` | **Steer** into the turn; no wake, no extra turn | **Record**, and offer the explicit send | **Record**, and offer the confirmed send | **Record**; delivery refused, local resolution remains |
| Declaration, non-blocking | **Record**, never interrupt; an explicit send steers | **Record**; an explicit confirmed send follows up | **Record**; an explicit confirmed send wakes | **Record**; delivery refused, local resolution remains |
| Mirrored live ask — an owner browser holds the card (question, plan review) | **Settle** through that same card; a card settle resumes nothing and needs no wake | Same | Same — a cold session changes nothing while a browser holds the card | **Record** or resolve locally; no request is left to settle |
| Continued timed question — no card left, the ask channel can answer | **Host-settle** through the ask channel | **Host-settle** through the ask channel | **Host-settle** only with the explicit confirmed wake and its resume cost shown; otherwise **record** and say the work has not seen it | **Record**; no settle is possible once the request is gone |
| Mirrored approval | **Settle** through the live card; never a message, never retroactive | Same; an expired request fails closed and offers Approve & retry | Same — a card settle resumes nothing, so the cold session changes nothing; an expired request fails closed | **Fail closed** once the request is gone; Approve & retry or local resolution |
| Authored approval (no request behind it) | **Deliver** the decision as a notice (steer) | **Deliver** only with the confirmed wake; never record | **Deliver** only with the confirmed wake; otherwise refuse | **Refuse** (archived); local resolution remains |
| Candidate | **Not answerable**: confirm or suppress first; a reply is a named refusal, never a settle or a delivery | Same | Same | Same |
| Harness artifact with no live request | **Record or deliver** — never settle: no request exists, so the answer travels the message matrix; the artifact's own mechanism may close the item independently | Same | Same | Same |

The two question cases are different. A **live ask** whose owning browser is disconnected is
observed only: the row says it is waiting for a client, the request parks and is re-delivered to
the next client, and no reply is recorded as a settle — when a client holds the card again, the row
settles through it. A **continued timed question** has no card at all: the ask channel can settle
it, and on a cold session only behind the explicit confirmed wake (otherwise the answer is
recorded, as its row says).

## User Stories

1. As a user, I want any open item answerable from the row where I see it, so that I never have to
   hunt for the chat that raised it.
2. As a user, I want the control to tell me what the click will do — steer, send and resume, save
   only, or answer the live request — so that I never spend a turn by surprise.
3. As a user answering a blocking item while the work is still running, I want the answer to land
   at the agent's next step, so that the work continues without an extra turn.
4. As a user answering after the turn ended, I want the answer saved honestly and an explicit
   offer to resume the session, so that a click is never quietly turned into a wake.
5. As a user answering an item that does not block the work, I want it kept without interrupting
   what the agent has moved on to.
6. As a user with a stale list or two tabs, I want one attempt and a clear conflict, so that I
   cannot answer the same item twice.
7. As a user whose agent resolved the item in the conversation, I want the surface to show the
   winner instead of my lost answer, so that the transcript and the register agree.
8. As a user reading a transcript, I want the in-session card to answer by delivery on the same
   plumbing, so that the card never claims a live-card settle it does not own.
9. As a user, I want an item that cannot be answered where I am — archived session, no live
   request, candidate — to say why and offer the honest alternative, so that a dead end is never
   disguised as a broken control.

## Acceptance Criteria

### Story 1 — Answer from wherever the item is seen

```
Given an open item "Ship the 3.2 release?" (item-7, version 3) in session "sess-alpha"
  and sess-alpha has a running turn
When  the user answers "yes — ship it" from the per-session panel
Then  the panel reports the host's outcome for exactly that one reply
  and the answer is steered into the running turn as an attributed notice
  and item-7 becomes awaiting
```

```
Given a candidate item (item-12, version 1, tier candidate) whose evidence is a quoted prose ask
When  a reply for item-12 is submitted with the text "yes, do it"
Then  the host refuses it as a named not-answerable outcome
  and nothing is settled, delivered or recorded as an answer
  and the row offers only "It's an item" and "Not an item"
```

### Story 2 — The cost is visible before the click

```
Given an open blocking item (item-8, version 2) whose session "sess-beta" is live and idle
When  the user selects "Send to session" on the row
Then  the surface asks for the explicit confirmation naming sess-beta and the turn the send spends
  and no reply is sent until that confirmation is given
```

### Story 3 — Steer while the work is running

```
Given an open blocking item (item-8, version 2) and session "sess-beta" with a running turn
When  the user answers with option "Option B" and names no track
Then  exactly one delivery attempt is recorded on the session-message track with state queued
  and the claim is "sent to session", never "answer applied"
  and item-8 becomes awaiting
```

### Story 4 — Record when the turn has ended

```
Given the same item-8 at version 2, and sess-beta live with no running turn
When  the user answers "Option B" without confirming a wake
Then  the outcome is recorded: the answer is kept on item-8 and no message is sent to sess-beta
  and the surface says it was saved, not sent, and offers the explicit "Send & resume now"
  and no turn is spent
```

```
Given item-9 (version 1) in a cold session "sess-gamma"
When  the user answers "proceed" without the wake confirmation
Then  the host does not resume sess-gamma and records the answer on item-9
  and the surface says the session is not running and offers "Send & resume now"
```

### Story 5 — Confirmed wake delivers

```
Given item-9 in cold session sess-gamma and a user who confirmed "Send & resume now"
When  the reply is submitted with the confirmation
Then  sess-gamma is resumed, the notice is queued and the attempt is recorded as queued
  and the claim is "sent to session", with the surface naming the turn that is spent
```

```
Given a continued ask (item-15, version 6) in a cold session "sess-kappa" and no wake confirmation
When  the user answers with the option "Keep planning"
Then  the host records the answer on item-15 and does not resume sess-kappa
  and the claim is "Recorded" and the surface says the work has not seen the answer
```

### Story 6 — Never interrupt work that moved on

```
Given an open non-blocking risk item (item-10, version 4) and a running turn in sess-beta
When  the user acknowledges it with the text "accepted"
Then  the answer is recorded on item-10 and no steer is attempted
  and the running turn is not interrupted
```

```
Given the same non-blocking item-10 and a running turn
When  the user explicitly chooses "Send to session"
Then  the answer is steered into the running turn as an attributed notice
  and the claim is "sent to session"
```

### Story 7 — Downgrade, never upgrade

```
Given a question item (item-11, version 6) in sess-delta with a running turn
  and a host that cannot settle a continued ask in place
When  the reply names the host-settle track
Then  the attempt is steered into the running turn on the session-message track
  and the surface says which channel was used
  and the claim is never "answer applied"
```

### Story 8 — One attempt, one decision

```
Given item-13 open at version 5 on the user's screen
  and the model recorded an answer for item-13 in the conversation meanwhile (now version 6)
When  the user replies from the stale row
Then  the host refuses with a conflict before any session work
  and the surface re-reads item-13 and reports that the answer was not applied because the item moved
```

```
Given a reply in flight for item-14 with delivery id "delivery-2f1c"
When  the same reply is submitted again with the same delivery id
Then  the host returns the recorded attempt and no second message is queued
  and the surface keeps the receipt it already had
```

### Story 9 — Refuse when the channel cannot carry it

```
Given an open item whose source session "sess-epsilon" is archived
When  the user replies with the text "use the corporate registry"
Then  the host refuses with session-archived before probing the agent
  and no message is queued and the item stays open
  and the surface offers the local resolution it can still perform
```

```
Given an item raised by the tool in the session on screen, whose turn has already ended
When  the user answers at the in-session card
Then  the reply travels as a delivery attempt decided by the answer matrix, never as a card settle
  and the card renders a receipt from the returned outcome
  and a replayed card row shows that receipt instead of answerable controls
```

## Design Decisions

- **One host-side router, every surface.** The answer matrix is decided in one place at send
  time; surfaces request and display. This is the only way the page, the panel and the card can
  never disagree about what a click did.
- **The matrix splits on origin and turn state, not on kind alone.** A declaration that blocks the
  work behaves differently from a declaration that does not, and a live request behaves differently
  from both; the same kind of item can therefore need different channels at different moments. The
  table above, not the item kind, is the source of truth for every planned outcome.
- **Record is a first-class outcome, not a failure.** When nothing can honestly carry the answer,
  keeping it on the item is better than an unrequested wake or a silent drop — provided the
  surface says "saved, not sent" and offers the explicit send.
- **Steer is preferred for a blocking item whose turn is still running.** It costs no wake, no
  extra turn and no interruption of the agent's context; it is the only branch that gets the
  answer in front of the agent for free.
- **A wake is always a confirmed action, including for a settle.** The surface shows the resume
  cost before the click, and no path resumes a cold session on the strength of a reply that did not
  carry the confirmation: a continued ask that cannot be settled without the resume is recorded
  instead, and the claim says the work has not seen the answer.
- **The in-session card answers by delivery.** A card is a rendered tool row — a post-hoc raise —
  so it cannot own a waterfall. It uses the same reply contract as the page and may be downgraded
  to a record; claiming a card settle would claim a request the card never held.
- **Candidates are refused, not answered.** A reply for a candidate is a named not-answerable
  refusal and is never planned as a settle or a delivery. Confirming or suppressing is the only
  action a candidate has; confirming is what changes its tier, and only a structural item carries
  an answer control.
- **Answerability does not require a live request.** An item with no live request — an artifact
  with no card, a candidate once confirmed, an authored decision — is answered on the message
  matrix (record or deliver); only the settle branches require a live request.
- **The canonical guard order and the CAS are the race policy.** The model, a second tab and a
  double click all lose cleanly at the version check; the loser learns it lost instead of
  overwriting a decision. The order above is the only order, and its position is observable.
- **One delivery per action, one identity per attempt.** The delivery id is minted by the client
  and is the idempotency key across the route, the stored attempt and the transcript source; it is
  reused only for lost-response recovery of an accepted or in-flight attempt, while a retried
  failure is a new attempt with a new id.

### Deferred Decisions

- **Answering a multi-question ask from the inbox** — the row can name only one choice, so the
  ask is refused as needing a batch and handed to the session. The seam is a batch reply intent in
  the payload vocabulary.
- **Coalescing several answers to one session into one turn** — each reply is its own attempt. The
  seam is the delivery ledger, which could carry one attempt covering several items.
- **Withdrawing a queued delivery** — the delivery id is already known to the session queue, so a
  later withdrawal intent can be added without changing the record; nobody may withdraw a settled
  decision.
- **Re-sending a recorded answer later** — the answer is durable on the item; whether a later
  click delivers it as a new attempt or requires a reopen is not decided. The seam is the answer
  payload kept on the item.
- **Whether a recorded outcome may be offered as automatically deliverable** — the honest copy and
  the explicit send exist; anything automatic would need the wake and evidence rules first.

## Testing Strategy

- **The matrix is a table test.** Every cell of origin × tier × blocking × turn state × requested
  track × confirmation is asserted through a pure planner, with no store, clock or session — the
  table in this spec is the fixture list.
- **The engine is tested through the reply contract**, with the session bridge and the store port
  as the only fakes (they are the system boundaries: harness, storage). A test names one concept:
  the track, the claim, the guarded refusal, the recorded attempt.
- **Order and idempotency are asserted as behaviour**, not as implementation shape: a duplicated
  delivery id returns the recorded attempt only while it is accepted or in flight, a retried
  failure gets a new attempt, a stale version loses, a payload illegal for the origin is refused
  before any session call is made, and a candidate reply is refused as not answerable.
- **The guard order is pinned by a test per step**, including its observable consequence: a
  malformed payload for a missing item is refused as a payload error, and the origin/track refusal
  happens before duplicate-id bookkeeping.
- **Non-determinism is controlled**: the clock is injected, delivery ids and request ids are fixed
  by the test, and the session observation is a supplied fixture, so the same case always produces
  the same plan.
- **Surface-level criteria** (the descriptor being rendered, the confirmation before a send) are
  tested at the component boundary against a fake reply port; they may not re-derive the matrix.
- **Refusals carry their reason** in every test that expects one; a bare failure is a test defect.

## Out of Scope

- Rendering, copy, focus, keyboard behaviour and layout of controls — owned by
  [Surfaces](../../surfaces/CONTEXT.md); this spec owns only what the descriptor means.
- Detection, inference, the candidate gate and promotion/suppression mechanics — owned by
  [Capture](../../capture/CONTEXT.md) (see its
  [candidate tier](../../capture/specs/candidate-tier.md)) and the register. The model-facing
  ingress contract is owned by
  [Model Contract & Consent](../../model-contract/specs/agent-declared-contract.md).
- Storing and querying the item lifecycle, and the acknowledgement window policy — the register
  and durability own the record; the delivery spec owns what evidence may move it.
- Team-task board actions from the inbox: the item hands off to its session, and the action
  payload is applied by the session's team-task service, not by a reply message.
- Holding, parking or racing a harness waterfall for an unattended ask — see the deferred hold in
  [delivery-and-evidence.md](delivery-and-evidence.md).
- Batch or "approve all" answering: one item, one deliberate action.
- Any write to the session log, and any use of the composer as a reply channel.

## Open Questions

- Should a recorded answer become deliverable later as a distinct "send the saved answer" action,
  or must the user reopen the item and answer again? *The product owner decides; the durable answer
  payload supports either.*
- Is a `stale` item answerable in place, or must the register re-activate it first? *The register
  design says a stale item still counts as needing the user, which argues for answerable; the
  answerability rule above takes that position and should be confirmed by the register's owner.*
- Should the page offer the explicit wake when the session state is unknown, or keep the control
  disabled until the state is known? *Surfaces owns the interaction choice; the reply contract
  already supports both because the confirmation flag is explicit.*
- Which layer enforces that a candidate cannot be answered — the reply route, the model-facing
  ingress, or both? *The contract here requires that no candidate reply is planned as a settle or
  a delivery; the enforcement layer is decided with the model contract's
  [agent-declared contract](../../model-contract/specs/agent-declared-contract.md) and Capture's
  [candidate tier](../../capture/specs/candidate-tier.md).*
