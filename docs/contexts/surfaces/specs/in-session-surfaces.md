# In-session surfaces — capability spec

**Context(s):** Surfaces · **Date:** 2026-11-15

> Intent spec. It states what the capability is for and what it must do; it does not describe
> files, functions or snippets. The design packet and the code own mechanics.

## Definitions

Canonical meanings are in [UBIQUITOUS_LANGUAGE.md](../../../UBIQUITOUS_LANGUAGE.md). Every term
this spec relies on:

- **Card** — the surface attached to the `open_items` tool row: the item as it was raised, answerable
  in place. One card per tool call, at the row of the call that raised it; the call is the card's
  identity, and an item raised by a different call is never answerable here.
- **Raise snapshot** — the durable, bounded description of the raised items carried by the tool
  result (identity, kind, initial state, title, preview, options, version, reply descriptor). It is
  what a transcript row can always render, including years after the raise.
- **Hydration** — re-reading an item's live record by its item id (and preferring the newer
  version). A card renders the snapshot first, then hydrates; **the snapshot is not the truth, the
  record is**. A card that fails to hydrate keeps the snapshot readable and offers no false control.
- **Replayed or out-of-date row** — a card whose durable tool result is committed but whose item has
  moved on: remounted after an answer, replayed after a reload, or rendered from an old transcript
  window. The rule is the same in every case: render the receipt, never an answerable control.
- **Receipt** — the one-line statement a card shows once its item is no longer answerable there:
  what happened, when, and against which item. A receipt is not a second record; it is a rendering
  of the durable state.
- **Answer-as-delivery** — the card's write path: the answer goes into the session as a message the
  agent will see (the `session-message` delivery track), because a transcript card cannot own a live
  request's own answer channel. The host may downgrade the requested track; the card renders the outcome.
- **Answerable / reply descriptor** — answerable is whether an item can be settled or delivered from
  this surface now; the descriptor states the controls, options, free-text allowance and copy note
  that make it answerable. An unanswerable item shows the reason, never a dead control.
- **Settle / deliver** — settling answers a live ask through its own channel; delivering puts the
  answer into the session as a message. A card can only deliver, and the receipt says which happened.
- **Delivery attempt / delivery id** — one logged attempt and the identity that makes one user
  action one delivery across a double click or a lost-response recovery. A retry after a **failed**
  attempt is a new attempt with a new identity; the same identity is reused only to recover the
  unknown outcome of an attempt that was accepted or still in flight. The evidenced states are
  sending, settled, queued, delivered, acknowledged and failed.
- **Immediate outcome vs durable claim** — the result of a write is an immediate outcome: applied,
  sent or recorded, as the host returned it for that attempt. A later rendering — a replayed row, a
  remounted card, another surface — may state only what the durable record proves. *Recorded* is
  shown only when the outcome received was recorded; where the record cannot tell an applied answer
  from one that was only recorded, the honest rendering is the neutral in-flight state **waiting on
  the work**, never "applied" or "sent to session".
- **Conflict** — a compare-and-set mismatch on an item transition: another writer (often the model
  resolving the item from the conversation) changed the item after the card read it. Unlike the
  settings write, an item transition does not hand back the live record as a value: the write is
  refused with a named conflict, the card shows the recovery copy and re-reads the item, and the
  next attempt acts on the version actually shown.
- **Panel** — the per-session right-panel tab: what *this* conversation still owes the user. It has
  a header filter row (All / Needs you / Waiting on the agent), the section lists it filters, a
  Candidates hand-off row, and a collapsed Resolved-here disclosure. Its session scope is
  structural — it is handed one session and can list no other.
- **Tab visibility** — whether the panel's tab is on screen. A collapsed or hidden panel must not
  read or poll; a visible one may.
- **Needs you / waiting on the work / resolved here** — the panel's three section groupings, shown
  after its filter row. Needs you uses the published predicate; *waiting on the work* is the
  `awaiting` state (the user has answered and the session has not acted yet); *resolved here* is
  this session's active resolutions, newest first, inside a collapsed disclosure by default.
- **Candidate** — an inferred item of the candidate tier. In-session it is review-only: the card and
  panel point to the Candidates section; neither answers it.
- **Live ask / mirrored approval** — a harness question or approval currently pending in a session,
  whose answer surface is the harness's own card. In every Open Items surface that ask is
  hand-off-only.
- **Authored approval** — an approval declared through `open_items`, with no live request behind it.
  Its decision travels as a message, including from the panel.
- **Read-only peer / subagent session** — a browser that may not write to the session, and a session
  the harness classifies as delegated work. Both get honest explanations instead of controls.
- **Reveal** — focusing the transcript row that belongs to an item. It is best effort: the row may be
  folded, windowed out or gone, and the surface must never promise a scroll position.
- **Handoff** — leaving the card/panel for the surface that owns the answer or the history: the
  inbox detail, the Candidates section, or the session's own ask card.
- **Confirmed wake** — the user's explicit consent to resume a cold session and spend a turn, given
  only after the surface has stated that cost. Any path that would resume a cold session needs it —
  a delivered message **and** the settle of a continued ask — and no surface suppresses the wake
  line because the path happens to be a settle. The answer matrix owns which path applies; the
  surface owns showing its cost.

## Constraints

- **Only its own call's items are answerable.** A card answers only items whose recorded call is the
  call the card renders. Another call's item, another session's item, or a live ask the card does not
  own is never answerable there.
- **The snapshot is a fallback, never the truth.** The card hydrates by item id on mount and after
  its own write; the newer version wins. A settled, dismissed, superseded, closed or otherwise
  unanswerable record renders a receipt even when the snapshot still says `open`.
- **One attempt, one identity; a retry is a new attempt.** The first click mints the delivery id and
  disables the controls; a second click while in flight is a no-op. A lost response is recovered by
  re-reading the delivery under its original id, and only that recovery may reuse it. Retrying an
  attempt that is known to have **failed** mints a new delivery id, because the failed attempt is a
  closed record and replaying it would either duplicate work or misstate what happened.
- **Claims never merge, and durable claims are narrower.** The immediate result of a write may say
  applied, sent or recorded, and a failure names its reason. A rendering after a reload or replay
  states only what the durable record proves: where the record cannot distinguish an applied answer
  from one that was only recorded, the card shows the neutral in-flight state **waiting on the
  work**. "Applied" and "sent to session" are never used for a record-only outcome, and *recorded*
  is never inferred from a delivery state.
- **No silent loss.** A failed write keeps the item and its controls, states the reason, and offers
  Retry. A named conflict refusal says the item changed elsewhere; the card re-reads the item from
  the host and shows the winning answer when it exists.
- **The card never throws.** Unreadable, absent or older card data degrades to the recorded generic
  row plus one note; an error result renders as an error row; nothing here disappears silently.
- **In-session bounds.** At most five items are printed per card; the remainder collapse to a count
  and a link to the inbox. Titles and previews are bounded and markdown-projected; the payload is
  versioned and carries ids and enumerated values only, because a transcript entry is retained.
- **The panel is session-scoped by construction.** It may render only records whose session is the
  session it was handed; anything else is dropped. It has no cross-session list, no search, no bulk
  actions and no paging beyond Show more; its one filter row (All / Needs you / Waiting on the
  agent) narrows its own sections, candidates appear as a hand-off row rather than as rows, and
  Resolved here is a collapsed disclosure.
- **The panel is cheap when closed.** No read and no poll while the tab is hidden; a read on the
  visible edge and on mount-while-visible; focus and carrier-reset re-reads are gated on visibility.
- **A restored panel is cold.** Identity and expanded state survive a reload; data does not. First
  paint is a skeleton, never a false "nothing open" empty state.
- **No second answer control for a live ask.** The panel renders a live ask as a hand-off row
  ("Answer in chat"); the card never renders approval controls. An authored approval is decided as a
  message; a mirrored approval only through its own live card. A live ask whose request has expired,
  or whose card no owning browser holds, is never answered from a card or panel: the card
  points at the inbox, where the row offers **Approve & retry** or reports **waiting for a client**
  ([approval parity](../../answering/specs/approval-parity.md),
  [inline answering](../../answering/specs/inline-answering.md)).
- **A cold-session resume is always announced.** Any answer that would resume a cold session — a
  delivered message **or** the settle of a continued ask — states that the session resumes and
  spends a turn, and requires the user's explicit confirmation before the write. The wake line is
  never suppressed because the path is a settle; which path applies is the answer matrix's decision
  ([inline answering](../../answering/specs/inline-answering.md)), and showing its cost is this
  surface's.
- **No false deletion of "no session title".** A missing title renders as an untitled label; the
  card and panel resolve it from the live session catalogue when they can.
- **Accessibility and locale.** Card and panel controls are keyboard reachable, async results are
  announced, focus moves sensibly after an item settles, and all copy is locale-owned with complete
  dictionaries. The panel's own arrow/`j`/`k` movement never fires while typing and releases focus on
  Escape.
- **Determinism for non-deterministic presentation.** Receipt times come from one injected clock;
  the same durable record and snapshot always render the same receipt, the same disabled reasons and
  the same next controls.

## Problem

The moment a decision is raised, the user is usually looking at the conversation that raised it —
and the message immediately scrolls away. Making the user leave for a cross-session page at that
moment is friction at exactly the point where the work is blocked. But the alternative, a second
answer card inside the transcript, is worse: the harness's own question and approval cards already
own live requests, and two controls over one request race each other and can grant twice.

There is a second, quieter problem: a transcript is durable and replayable, so a card rendered from
last week's log must not offer to answer something that was answered long ago. And while the user
works inside one conversation, they need the answer to a different question — *what does this chat
still owe me?* — which neither the cross-session page nor the transcript row answers.

## Solution

Two session-scoped surfaces, each with a different job and neither competing with the other.

The **card** appears at the `open_items` tool row, at raise time, and answers the item there: it
renders the raise snapshot, hydrates the live record by id and version, writes through the one
delivery path, and collapses to a receipt. It is a view of a durable item — a replayed or remounted
card shows the receipt, never a live control for something already settled.

The **panel** is the conversation's standing list: an All / Needs you / Waiting on the agent filter
row over Needs you, waiting on the work, and resolved here — this session only — plus a Candidates
hand-off row and a collapsed Resolved-here disclosure, with a footer that states the cross-session
total and a doorway to the inbox filtered to the session. It answers tool-raised items in place
through the same write path, hands live asks back to the card that owns them, and opens the
session's history through the register.

When the model and the user race — the model resolving from the conversation while the user clicks
in a surface — compare-and-set decides, and the loser is told honestly what happened and which
answer won.

## User Stories

1. As a user reading a conversation, I want to answer the item the agent just raised without leaving
   the chat, so that the work can continue immediately.
2. As a user returning to an old conversation, I want a replayed card to tell me what was decided
   instead of offering to answer it again, so that the transcript never lies about its state.
3. As a user whose item was settled, sent, saved or changed elsewhere, I want each of those outcomes
   stated for what it is, so that I do not believe a stale click took effect.
4. As a user working in one chat, I want this chat's list of what it owes me, so that I do not have
   to hunt for it in the cross-session page.
5. As a user, I want live approvals and questions answered where they were raised, so that two
   surfaces never race to answer the same request.
6. As a user in a delegated subagent session, a read-only browser or an old transcript, I want an
   explanation instead of a control that cannot work.
7. As a user in the panel, I want to jump to the session's inbox view or back to the answer, so that
   history and action stay one action away.

## Acceptance Criteria

Per story, the scenarios that define done, written as behaviour, not code. One scenario = one
action; several assertions about that action are fine, a second action is a second scenario.

### Story 1 — answer where it appeared

```
Given the agent calls open_items with 7 items while the user is reading the session "Mock query builder"
      the first 5 items are decisions with the options "Corporate registry" and "Public npm"
When  the tool result commits and its row renders
Then  the card appears at that row with a count of 7 raised items
      it prints the first 5 items with kind, title and options, and states "and 2 more" with a link
      to the inbox
```

```
Given the card for item H is showing the option question "Which registry?" and is answerable in place
When  the user submits the answer "Corporate registry" from the card
Then  exactly one reply leaves with the option payload, the item's compare-and-set version and one
      delivery id
      the card collapses to a receipt naming the answer, the time and the outcome the host
      returned — and claims nothing beyond that outcome — and its controls are disabled
```

### Story 2 — a replayed card never lies

```
Given a transcript row whose raise snapshot still says item H is open and answerable at version 4,
      and whose live record was resolved at version 6 after the user answered in the inbox
When  the user reopens that conversation and the card hydrates on mount
Then  the card renders the receipt "Answered in Open items" with the item's answer
      no answer control, checkbox or send button is rendered for H
```

### Story 3 — honest outcomes

```
Given the card for item H is answerable and the session's turn has already ended
When  the user sends the free-text answer "Ship the dual-write path"
Then  the receipt says the answer was saved and that the agent will see it when it next runs — never
      that it was sent
```

```
Given a replayed card whose durable record shows a completed answer attempt that the record cannot
      distinguish as applied or only recorded
When  the user reopens the conversation
Then  the card renders the neutral in-flight state "waiting on the work"
      it never states "Applied" or "Sent to session", and it does not show "Recorded" because this
      rendering received no such outcome
```

```
Given the user has item H open in the card and the model resolves H from the conversation first
When  the user activates Answer on the card
Then  the card shows the named conflict, re-reads the item from the host, and offers to show the
      answer that won
      it does not claim the user's answer was applied or sent
```

```
Given the card is answerable and the harness is unreachable
When  the user activates Answer and the write fails
Then  the card keeps the item and its controls, states that the answer was not sent, and offers Retry
      a Retry is a new attempt with a new delivery id; only a lost response of the in-flight attempt
      is recovered under its original id, so a delivery that had landed is not duplicated
```

### Story 4 — this chat's list

```
Given the session "Mock query builder" has 2 structural items that need the user, 1 answer waiting on
      the work, 2 unconfirmed candidates and 4 resolved items, and the install's global Needs-you
      count is 7
When  the user opens the session's Open items panel tab
Then  the panel header offers the All / Needs you / Waiting on the agent filter row
      the panel lists 2 Needs you rows, 1 Waiting on the agent row, and a collapsed "Resolved here · 4"
      disclosure, and a Candidates hand-off row offers to review the 2 candidates without listing
      them as Needs you
      its footer states that 7 are open across all sessions and offers the session-filtered inbox
      a record belonging to another session is not rendered in any section
```

```
Given the panel tab has been closed and no other panel content is shown
When  the user reveals the tab
Then  no read occurred while it was hidden, and the first visible paint after revealing is a skeleton
      the panel then fills from the session-scoped read rather than ever claiming "nothing open"
```

### Story 5 — live asks are answered where they were raised

```
Given an item in the card's payload is an approval, mirrored from a live request in this session
When  the user opens the conversation and the card renders
Then  the card shows the approval's kind, title and blocking state and offers no Allow or Deny
      it points at the session's own approval card and offers a link into Open Items
```

### Story 6 — an explanation, not a dead control

```
Given the session is a subagent session and its transcript contains an open-items tool result
When  the user opens that conversation
Then  the card explains that a subagent session cannot answer items and that the parent conversation
      answers them
      no reply control is rendered
```

```
Given a tool result whose card payload is absent, an older version or unreadable
When  the user opens the conversation containing it
Then  it renders the recorded generic result with a note that this surface cannot show the card
      nothing throws and the tool row does not disappear
```

### Story 7 — one action away

```
Given the session has a live blocking question whose answer surface is the harness's own card
When  the user activates the panel row's "Answer in chat"
Then  the harness's own question card is revealed and focused if it exists
      if it cannot be revealed, the panel opens the inbox detail for the item instead
      the panel never renders a second answer control for that item
```

## Design Decisions

- **The tool row is the only in-session seat for a card.** A transcript row is per-call, additive and
  arbitrarily interactive; a turn-tail, composer or custom chat-node seat would either miss a raise
  made mid-turn or require writing the session log. The card is a rendering of a durable event and a
  durable item, so absence from the screen never means absence from the system.
- **The card is a view, not a copy, and hydration decides.** Rendering the raise snapshot first keeps
  a replayed transcript readable; hydrating by id and preferring the newer version keeps it honest. A
  settled record always wins over a snapshot that says open — this is the rule that makes "replay
  shows the receipt" a contract rather than a best effort. The receipt also distinguishes the
  immediate outcome from the durable claim: only the rendering that received an outcome may state
  applied, sent or recorded; a later rendering states what the record proves, or the neutral
  waiting-on-the-work state.
- **Answering from a card is delivery.** A transcript card is a post-hoc raise; it cannot own a
  live request's own answer channel, so its write is a message the agent sees at its next step,
  with the delivery claims the reply contract publishes. The host validates the requested track and
  may downgrade it; the card renders whatever came back.
- **One attempt identity for one action, and a retry is a new attempt.** A delivery id minted at the
  first click collapses a double click and a lost response into one durable attempt. Retrying an
  attempt that failed mints a new identity, because the failed attempt is a closed record: replaying
  it would either duplicate work or misstate what happened.
- **The panel is a scope, not a smaller inbox.** It is handed a session and renders only that
  session's records: one filter row over three section groupings, a Candidates hand-off row, a
  collapsed Resolved-here disclosure — no search, no bulk actions, no paging beyond Show more. Its
  footer count is the global count from the probe, so the panel can never invent a different meaning
  of "open".
- **The non-duplication rule is ownership, not preference.** Tool-raised items are answerable in the
  panel because the panel's write is the same route and guards as the card. A live ask is hand-off
  only, because the harness card owns the request; rendering a second Allow/Deny would be two
  controls racing for one grant (see
  [ADR 001](../adrs/001-no-custom-pending-interaction-kind.md)).
- **Missing evidence degrades to an explanation.** Legacy metadata, subagent sessions and read-only
  peers get words, not disabled-looking controls that appear broken; the card also contains its own
  render failure so a bug cannot look like a vanished tool call.
- **Reveal is best effort, handoff is guaranteed.** The transcript belongs to the harness; the panel
  can focus a row when the anchor exists and otherwise falls back to the inbox detail, and it never
  promises a scroll it cannot deliver.

### Deferred Decisions

- **A live delta channel for session-scoped surfaces** — the panel and card re-read on visible edges,
  focus, reset and their own writes. *Seam:* the read model's revision; a delta channel would change
  the trigger, not what is rendered.
- **Panel evidence reveal and scroll-through to a windowed transcript row** — a supported reveal seam
  would let the panel focus more rows than the mounted anchor exposes. *Seam:* reveal already returns
  a value the caller can branch on, so adding a stronger seam does not change the handoff contract.
- **Card density and a transient in-session notice for a new item** — a notice shown when an
  item is raised in the visible session is a separate opt-in decision; the card itself already
  states the raise. *Seam:* the card contract is versioned and additive.
- **Approval-question batch answers in a card** (a single ask with several sub-questions) — a card
  renders one choice per ask; a batch control is an answer-contract decision, not a card
  decision. *Seam:* the reply contract's payload vocabulary.
- **A truthful per-session indicator on the sidebar or session header** — no seat exists; recorded
  with the other doorway decisions in [../CONTEXT.md](../CONTEXT.md).

## Testing Strategy

- **Behavioural tests through the rendered card/panel and through the request builders.** Order:
  card rendering and caps; hydration/newer-version receipt; one-attempt idempotency and disable; the
  claim vocabulary; conflict and failure recovery; disabled explanations; panel section derivation,
  session scoping and visibility-gated reads; handoff and reveal fallbacks.
- **A good test** gives one tool result or one session read, performs one user action, and asserts
  the rendered words and the exact request (endpoint, version, delivery id) that left. Copy is
  asserted through locale keys, never by snapshotting markup.
- **Mock only system boundaries:** the host route, the harness's session catalogue/ask reveal seams,
  the primitives package and the clock. The card's merge rule, the panel's derivations and the
  attempt bookkeeping run for real.
- **Non-determinism control:** injected clock for receipts, fixed delivery ids and fixed record
  versions in fixtures, and one fake transport whose responses are scripted per test, so a conflict,
  a lost response and an offline failure are reproducible rather than racy.
- **Invariants pinned by tests:** a settled record never renders an answerable control; a card never
  renders another call's or another session's rows; the panel never reads while hidden. These are the
  three places where a future change could start lying.
- **Locale parity** for the card's and the panel's dictionaries is asserted key-for-key.

## Out of Scope

- The page and its sections: [inbox-page.md](inbox-page.md); the register and export:
  [resolved-register-and-export.md](resolved-register-and-export.md).
- The answer matrix, delivery tracks, evidence and refusal semantics — published by Answering &
  Delivery; these surfaces render the outcome and never choose the track.
- The harness's own question and approval cards, the composer, and the session log: outside this
  context; no surface writes the session log.
- Approval parity rules (allow once, never retroactive) and wake economics: Answering & Delivery.
- The cross-session navigation and layout services: harness-owned shell.

## Open Questions

- **Should the panel open automatically when a new item is raised in the visible session?** Opening
  is user-initiated by decision, because auto-opening reflows the conversation and steals the active
  tab. The product owner may revisit once a transient raise notice exists.
- **How should a card present a single ask with several sub-questions?** The delivery contract can
  carry one answer batch; whether a card shows the batch or hands it off to the session is an answer
  UX decision that needs the reply-descriptor owner.
- **Should a resolved card offer "answer again" for the same decision?** Every other reopen path goes
  through the register's explicit Reopen; offering it inside a transcript row would be a second
  write surface. Open with the register owner.
