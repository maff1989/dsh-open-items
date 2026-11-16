# Agent-declared contract

**Context(s):** Model Contract & Consent (owns) · Capture (declared raises, roll-up) · Attention
Register (identity, kind, severity, blocking, lifecycle) · Answering & Delivery (a recorded answer
is not a delivery) · Surfaces (the in-session card) · **Date:** 2026-11-15

> Intent spec. It states what the capability is for and what it must do; it does not describe
> files, functions or snippets. The design packet and the code own mechanics.

## Definitions

- **Agent** — a model-driven actor that can call tools. Subagents and teammates are agents too
  (see [glossary §1](../../../UBIQUITOUS_LANGUAGE.md#1-actors-and-places)).
- **Declaration** — an item's existence asserted by an agent in words, through the `open_items`
  tool. A declaration is authored evidence, not inference; it is the highest-precision source the
  register has and the only agent-controlled ingress.
- **`open_items` tool** — the single model-facing tool this capability publishes, with exactly
  four actions. "One tool" is part of the contract: the schema is re-sent on every admitted model
  request, so a second tool would tax every turn.
- **Raise action** — declares one item. It requires a title (at most 120 characters); everything
  else has a default: kind `decision`, severity 2, blocking true, no options, no quote, no detail.
  The optional detail is at most 2000 characters and is kept behind the card; options are trimmed,
  de-duplicated and bounded, with order preserved; the quote is evidence, at most 300 characters.
- **List action** — reads the register. It defaults to open items, newest first, and may be
  filtered by state and kind. It never changes a record.
- **Resolve action** — records that the user answered in this conversation. It requires an item
  id; the answer text is optional. It records a resolution; it does not settle a live ask, wake a
  session or deliver a message (that is Answering & Delivery's authority).
- **Dismiss action** — records that a declared item is not wanted. It requires an item id; a
  reason is optional. It is not a suppression: a suppression is a user action on a candidate and
  belongs to the register and the candidate surfaces.
- **Item / open item** — one durable record of something the user must supply; an *open item* is
  one in a live state. Defined by the register
  ([glossary §2](../../../UBIQUITOUS_LANGUAGE.md#2-the-item)).
- **Item kind** — the product-facing classification the model sees: `decision`, `approval`,
  `question`, `plan-review`, `blocker`, `risk`, `follow-up`, and the item kind `task` (always
  qualified; it is not team-task capture).
- **Tier** — the evidence class of an item's existence. A declaration produces a **structural**
  item; a **candidate** is inferred and is never answerable as an item until the user confirms it.
- **Severity** — the user-facing urgency class, 1 (needs you now), 2 (a decision), 3 (FYI). A
  declaring agent states it; the default for a declaration is 2.
- **Blocking** — whether the work is waiting on the item to continue. `true` (the default)
  means "I cannot proceed without this"; `false` means "deciding later is fine". It is the input
  to the answer matrix, not a display hint.
- **Authored item** — an item whose existence was declared rather than observed. A declaration
  through the tool is authored; the register dedupes it on its authored key.
- **Dedupe key** — the stable key that decides when two sightings are one item. The authored form
  is kind + session + normalised title; normalisation is case- and whitespace-insensitive. A later
  sighting under the same key is an **occurrence**, not a new item.
- **Session / root session / subagent session** — a durable conversation; the session the user
  drives directly; a session created by another session to delegate work. Classification is the
  harness's, not the presence of a parent id.
- **Register** — the durable domain memory holding the install's items; a declaration is recorded
  in it, and it (not the tool or the card) decides identity, dedupe and lifecycle.
- **Session log** — the harness's durable per-session event log. The plugin reads it and never
  writes it ([glossary §8](../../../UBIQUITOUS_LANGUAGE.md#8-durability-vocabulary)).
- **Inbox / panel** — the page's sections where the user meets open items; the per-session surface
  listing what that conversation still owes the user. Both are views of the register, not records.
- **Attention / Needs you** — the register's computed predicate for the user's live attention.
  A declaration is counted by it only through the same predicate every other item obeys, and a
  candidate never is ([glossary §9](../../../UBIQUITOUS_LANGUAGE.md#9-measures-and-predicates)).
- **Acknowledgement** — whether the work acted on the user's answer: `pending` when the answer is
  recorded, `observed` when evidence appears, `none` when the window elapses. The resolve action
  sets `pending` and makes no stronger claim.
- **Live ask** — a harness question or approval currently pending in a session, with a real request
  and an owner. The resolve action records an answer; it never settles a live ask
  ([glossary §5](../../../UBIQUITOUS_LANGUAGE.md#5-answering-and-delivery)).
- **Delivery** — putting a reply into a session as a message the agent will see. The tool does not
  deliver and never claims that anything was sent.
- **Settle** — answering a live ask or approval through its own channel, so the request resolves
  and the blocked turn continues. Settling requires a real request, which is why the resolve action
  records an answer instead of settling one.
- **Wake** — resuming a cold session by delivering a message into it; it costs residency and a
  model turn and needs the user's explicit confirmation. The tool never wakes a session.
- **Suppression** — a durable "the user said this is not an item" record, written only by the user
  acting on a candidate. The dismiss action is not a suppression.
- **Turn** — the durable unit of progress in a session, started at the turn boundary's start and
  ended at its end. "At most five in a turn" counts raises made during one turn.
- **Roll up** — attributing a subagent's or teammate's raise to its root session, with the asker
  recorded as provenance. The item belongs to the root conversation; the subagent is not its owner.
- **Resolution** — the recorded outcome that ends an item's open life, and *when* it is recorded
  depends on how the answer travelled. A **settle** records the answer's payload when the answer
  is accepted, and the item moves to `awaiting` carrying it. A **session-message** reply records no
  resolution at send: the item is `awaiting`, and the answer it carried becomes the resolution when
  the work acknowledges it or when the acknowledgement window elapses with no evidence. In both
  cases the item's state becomes `resolved` only then. A declaration's answer recorded through the
  tool was already given by the user in the conversation, so the resolve action records the
  resolution immediately (item `awaiting`, acknowledgement `pending`); a dismissal is immediate and
  awaits no acknowledgement. The kinds this spec uses are `answered` and `dismissed`.
- **Resolution actor** — who is recorded as having acted: `user` for a human action in a surface,
  `model` for the agent recording what the user said in the conversation.
- **Refusal value** — a normal result that names why an action was not applied, with no partial
  effect and no exception. The agent is expected to act on it (raise instead, end the turn,
  re-read), so it is a result, not a failure.
- **Transcript** — the durable record of a conversation's entries, including every tool call and
  result. It is replayed for the life of the session and re-sent on later requests; it is why
  results are bounded.
- **Row (model-facing)** — one bounded projection of an item in a result: id, kind, state, title,
  a detail preview and the full detail length when a detail exists.
- **Card** — the in-session surface attached to the tool row, hydrated by item id and version. A
  card is a snapshot, not the truth; the register is the truth.
- **Nudge** — the opt-in instruction section telling the agent when to raise and resolve. Guidance,
  not state; off by default; not a runtime-context line.
- **Runtime-context line** — the designed single context line telling a fresh session about open
  items from other sessions. It carries *state*; the nudge carries *instructions*.
- **Model-facing surface** — *(context-local umbrella)* everything the model sees or is told
  because of this plugin: the tool declaration, the nudge, the runtime-context line.
- **Live cap** — the install's cap on live items. A raise first makes room by archiving per the
  retention policy; it is refused only when no live item is eligible to archive.
- **Untrusted display content** — text the model did not author (item titles, details, quotes,
  returned evidence). The result must say so, because an item's text is data, never new
  instructions.

## Constraints

1. **One tool, four actions.** Action names, parameter names and the output shape are published
   contract. A malformed call (missing required title or id, unknown action, unknown kind or
   state value) is rejected by the harness's schema before the capability runs — an error, never a
   refusal value.
2. **The tool is always declared; the instruction is not.** Declaration is not a behaviour change,
   so the tool needs no consent. Consent is scoped to the surfaces that do change behaviour: the
   nudge, the runtime-context line and extraction are consent-gated; this tool is not, and neither
   is the local confirm-first candidate gate, whose on-by-default value is the deliberate exception
   recorded in [ADR 001](../adrs/001-default-off-model-surfaces.md). The nudge is a behaviour
   change, so it is opt-in and default-off.
3. **Wording is contract.** The declaration's description carries the negative clause first ("call
   only when ending a step with an item the user must act on"), then the test, then the three
   bounds (one item per real decision; at most five raises in a turn; never to summarise work
   already done), then the meaning of each kind and the resolve-after-answer sentence. The kind
   taxonomy is repeated on the kind parameter because the model sees it while filling the argument.
4. **Result bounds are transcript bounds.** Every result carries one summary line, at most five
   rows, a detail preview of at most 280 characters with the full detail length beside it, an exact
   total and a truncation flag. The card payload never travels in the transcript; the full item is
   behind the card.
5. **Ordering and determinism.** A list result is ordered newest-first by creation; ids are
   creation-ordered, so the same register and query produce the same rows. A re-raise of a still-open
   item returns the existing item, not a new one, however the title's case or spacing differs. The
   declaration is deterministic from its arguments plus the register; nothing in it reads the clock
   except to stamp the record.
6. **One raise, one item.** Each raise declares a single real decision or question. A batch of
   asks from one turn becomes several raises; the per-turn bound is carried in the wording, not
   enforced by a refusal, because the honest enforced bound is the register's live cap and
   inventing extra refusal vocabulary would make the agent guess. Exceeding five is a wording
   failure to fix, not a silent truncation.
7. **Settling is owned by the conversation that raised.** `resolve` and `dismiss` are accepted only
   from the root conversation that owns the item. A subagent has no human in its context, and a
   different conversation never saw the answer; both are refused with a reason the agent can act on.
8. **A recorded answer is never a delivery claim.** The resolve action records the answer with
   actor `model`, the item becomes `awaiting`, and the acknowledgement is `pending`. The claim
   "sent" or "applied" belongs to the delivery tracks and is only made with delivery evidence.
9. **No session-log writes, ever.** No action of this tool writes a session event; the item record
   and its bounded history are the audit trail. The tool stamps the calling session and the call
   that raised the item onto the record, and does nothing else to the conversation.
10. **The nudge applies immediately.** A preference change attaches or withdraws the instruction on
    the next model step, with no restart, for current and new sessions; a profile without the
    prompt-assembly seam degrades silently (the preference stores, the instruction does not appear,
    and no error reaches the user's turn).
11. **Consent outranks convenience.** No part of this capability sends bytes off the machine. The
    one egress path is a different capability with its own consent rule.
12. **The candidate gate is a shared boundary rule, not a tool detail.** A candidate is not
    answerable as an item: `resolve` or `dismiss` naming a candidate-tier item is refused with the
    published reason `invalid-transition`, because only the user's confirmation is a legal path out
    of candidate tier. The requirement is shared — Capture keeps candidates unanswerable
    ([candidate tier](../../capture/specs/candidate-tier.md)) and the reply contract must refuse a
    candidate reply with its own named refusal rather than plan one
    ([inline answering](../../answering/specs/inline-answering.md)). Which layer owns the guard is
    an open implementation question; whether the guard exists is not.

## Problem

The founding failure of the chat interface is that the reasons work stopped live and die in prose.
The agent writes "should I use A or B?" and the conversation moves on; the ask is neither a harness
approval nor a question card, so no *open item* is ever recorded and the decision is lost with the
session. Detectors can recover some of this from the committed log, but they are inference: their
output can only ever be a candidate, and inference is exactly the wrong tool for "the agent knows
it needs an answer".

A declaration has its own failure mode, and it is the opposite one: **over-raising**. Left alone,
an agent that has been told about an item tool will raise prose summaries of work it already
finished, duplicate a decision it already raised, and turn one turn's batch of asks into five
items the user has to triage. The register would then be full of things that are not decisions,
and the user's attention — the scarce resource — would be spent on the model's self-report.

The remaining gap is authority. An agent can describe what the user said, and a naive tool would
let it answer its own questions, confirm its own candidates, or dismiss what it finds inconvenient.
A register whose "answered" is written by the model is not evidence; it is decoration.

## Solution

One tool with four actions, always declared, with a wording discipline that is part of its
contract. The agent declares with `raise` (one real decision per call, the kind named correctly,
options when there are options, blocking when the work is blocked), re-reads with `list` (bounded,
newest first, open by default), records with `resolve` once the user has actually answered in the
conversation, and drops with `dismiss` when a declared item is no longer wanted. Every result is
terse: a summary line, at most five rows and a bounded preview, because the transcript keeps it
forever.

The agent gains exactly one authority: to declare. It cannot promote a candidate, suppress a
candidate, answer for the user, or settle a live request; and only the root conversation that owns
an item may record an answer for it. The nudge that tells the agent when to declare is a separate,
opt-in instruction, so the capability is available before it is recommended. What must remain true
afterwards: every item in the register can be traced to the evidence that created it — a detector's
artifact, a human action, or a declaration someone made.

## User Stories

1. As the user, I want an item the agent declares to appear in the register and in a card in the
   conversation, so the decision survives the chat and can be answered later.
2. As the user, I want a re-declaration of the same decision to merge with the open item, so my
   register does not fill with duplicates.
3. As the user in a conversation with a teammate, I want the teammate's declaration to reach my
   conversation, labelled with who asked, so delegation does not hide decisions from me.
4. As the user, I want the agent to be unable to answer or dismiss an item on my behalf, so the
   register's "answered" can be trusted.
5. As the user, I want the agent to be unable to turn an inferred candidate into an item, so the
   confirmation gate is mine.
6. As the user, I want the model-facing result to be short and bounded, so the transcript stays
   readable and future turns do not pay for a past listing.
7. As the user, I want the instruction that tells the agent to declare to be off unless I turn it
   on, and to take effect immediately when I do.
8. As a teammate agent, I want my declaration to reach my root conversation instead of dying in
   my own transcript, so the work I am blocked on is visible to the human.

## Acceptance Criteria

These criteria are the definition of done. They change only by amending the spec.

### Story 1 — A declaration with its full contract

```
Given root session "session-7" where the user has asked for a Friday deployment
When  the agent calls open_items with action "raise", kind "decision", title "Which rollout
      window should we use?", options ["Friday morning", " Friday morning ", "Monday evening"],
      detail "The release train closes on Thursday.", severity 3, blocking false, and
      quote "Should we ship Friday morning or Monday evening?"
Then  the result reports one raised item and the number of items that need the user
And   the register holds one open structural item of kind decision, severity 3, blocking false,
      with options ["Friday morning", "Monday evening"] and a quote bounded to 300 characters
And   the item is attributed to session "session-7" and is deduped on kind + session + title
```

### Story 2 — A re-raise merges instead of duplicating

```
Given the agent has raised title "Ship on Friday?" in root session "session-7" and that item is
      still open
When  the agent calls open_items with action "raise" and title "ship on  friday?" in the same
      session
Then  the result reports that the item was already open, returns the existing item id, and marks
      the result as deduped
And   the register still holds exactly one live item for that decision, with no second record
```

### Story 3 — A subagent's raise rolls up to its root conversation

```
Given root session "session-7", which has a subagent session "sub-3" doing delegated work, and a
      live agent registry that knows "sub-3" is owned by "session-7"
When  the subagent calls open_items with action "raise" and title "Ship the migration?"
Then  the register holds one item attributed to session "session-7", with session "sub-3" recorded
      as the asker and the item's dedupe key computed from "session-7"
And   the summary says the item was raised to the parent conversation
And   the item surfaces in the root conversation's panel and in the inbox, not in the subagent's
      transcript
```

### Story 4 — A subagent cannot settle for the user

```
Given root session "session-7" holds an open item "Ship the migration?" raised there
When  subagent session "sub-3" calls open_items with action "resolve", that item id and answer
      "invented"
Then  the result is a refusal naming that the caller is not the owner
And   the item is still open, with no resolution and no recorded answer
```

### Story 5 — A different conversation cannot settle someone else's item

```
Given root session "session-7" holds an open item "Ship on Friday?" and root session "session-9"
      has never seen that decision
When  session "session-9" calls open_items with action "dismiss" with that item id
Then  the result is a refusal naming that the caller is not the owner
And   the item is still open with no resolution
```

### Story 6 — The model cannot confirm, answer or dismiss a candidate

```
Given the register holds a candidate "Do you want me to run the full verification ladder?" in
      root session "session-7", and candidates are not answerable items until the user confirms
      them
When  the agent calls open_items with action "resolve", that candidate's item id and answer "yes"
Then  the result is a named refusal with reason "invalid-transition", because confirming is the
      user's act and the tool has no legal transition out of candidate tier
And   the candidate is still a candidate, unconfirmed, and not counted as needing the user
And   the same named refusal applies to action "dismiss" naming a candidate, and no suppressor,
      dismissal or answer is recorded either way
```

### Story 7 — The answer loop closes after the user answers

```
Given root session "session-7" holds the open item "Ship on Friday?" raised by the agent, and the
      user has answered "Friday morning. Run the release check first." in that conversation
When  the agent calls open_items with action "resolve", the item id and answer "Friday morning.
      Run the release check first."
Then  the item's resolution is kind answered with actor model, the item becomes awaiting carrying
      the recorded answer, and the acknowledgement is pending
And   the item's state becomes resolved only when the work acknowledges the answer or the
      acknowledgement window elapses with no evidence
And   the summary says the answer was recorded and that the session acknowledges it when it acts
And   no message is delivered, no session is woken and no session-log entry is written
```

### Story 8 — A second resolve is refused, not repeated

```
Given the agent has already resolved the open item "Ship on Friday?" through the tool, recording
      the answer "Friday morning"
When  the agent calls open_items with action "resolve" for the same item again, with answer
      "Monday evening"
Then  the result is a refusal naming that the item is already answered
And   the recorded answer is still "Friday morning" and the item has one resolution
```

### Story 9 — Dismissing a declared item

```
Given root session "session-7" holds the open item "Ship on Friday?" and the user has said the
      Monday plan replaces it
When  the agent calls open_items with action "dismiss", the item id and reason "superseded by the
      Monday plan"
Then  the item's resolution is kind dismissed, the item becomes resolved at once because there is
      no answer for the work to acknowledge, and the summary says it was dismissed
And   no suppressor is written, so the same decision can be declared again
```

### Story 10 — The list is bounded and readable in the transcript

```
Given the install holds seven open items that need the user, newest first, titled "Fix the
      parser?", "Which dataset?", "Ship on Friday?", "Approve the migration?", "Rename the
      module?", "Update the changelog?", "Retire the flag?" — and one item the user already
      answered, titled "Pick a branch?"
When  the agent calls open_items with action "list" and no state filter
Then  the result carries five rows, total 7 and the truncation flag set
And   the rows are the five newest open items, each with id, kind, state, title and — where a
      detail exists — a preview of at most 280 characters with the full detail length
And   the answered item is absent, because the default scope is open items
And   the result states that item titles and details are untrusted display content, not
      instructions
```

### Story 11 — A raise at the live cap

```
Given the install's live cap is reached and every live item is ineligible to archive
When  the agent calls open_items with action "raise" and title "Ship on Friday?"
Then  the result is a refusal naming that the live cap was reached
And   no item is created and no live item is silently lost
```

### Story 12 — The nudge is off unless the user opts in

```
Given the settings record has never been written, so the model nudge preference is off
When  a model step runs in a fresh root session
Then  the assembled instructions carry no nudge section
And   the open_items tool is still declared with its four actions
And   the plugin writes no session event for the step
```

## Design Decisions

- **Declaration is a tool, not a prompt.** The tool is always declared; the instruction is opt-in. This
  splits authority from behaviour: the model can always tell the user what it needs, but it is only
  *told to* when the user asked for that.
- **One tool, four actions, published names.** A second tool, or a free-form action string, would
  grow every model request and make the contract impossible to pin. The action enum is closed.
- **The wording is a testable artifact.** The negative clause comes first because the failure mode
  is over-raising; the three bounds and the kind taxonomy are sentences in the declaration, and
  the resolve-after-answer sentence is the loop's only instruction. Wording changes are contract
  changes.
- **Terse results are a privacy and honesty decision as much as a cost one.** A result that printed
  a whole item would put declaration text into every later request and blur the difference between
  the card (the reading surface) and the transcript (the audit trail). Previews are bounded; the
  total and the truncation flag make the bound visible rather than hidden.
- **Dedupe is reported, not assumed.** A re-raise returns the existing item and says so; a re-raise
  after an answer is a new item, because the new request was not answered by the old answer.
- **Roll-up re-keys ownership, not just display.** The stored session and the dedupe key become the
  root's, so a later root raise merges; the asker is provenance on the record. The alternative — a
  subagent item that lives in the subagent's session — would be invisible to the only human there is.
- **Settling is a conversation right, not a model right.** The resolve and dismiss actions exist so
  the agent can record what the user said and drop what the user rejected; the ownership guard is
  what stops those actions from becoming a way for the model to answer its own questions.
- **The confirmation gate is inviolable.** No action of the tool operates on a candidate: no
  promote, no suppress, no answer, no dismissal. A `resolve` or `dismiss` naming a candidate-tier
  item is refused with the published reason `invalid-transition` — the candidate is not answerable
  until the user confirms it. The set is shared across the register boundary: Capture's
  [candidate tier](../../capture/specs/candidate-tier.md) keeps candidates unanswerable, and
  [Answering's reply contract](../../answering/specs/inline-answering.md) must refuse a candidate
  reply with its own named refusal instead of planning one. Only the layer that owns the guard is
  open (see Open Questions); the requirement is not.
- **The nudge is guidance.** It cannot enforce, cannot write a session event, and cannot change the
  register. Its only effect is what the model reads on its next step, which is why it can be
  attached and withdrawn instantly.
- **The runtime-context line is a different surface.** It would carry state (counts of what waits
  in other sessions), not instructions, so it is not folded into the nudge; it is deferred rather
  than rejected (see below).

### Deferred Decisions

- **The runtime-context line and its carrier** — the state line telling a fresh session about open
  items from other sessions is deferred. What is already decided: it carries state, not
  instructions; it is refreshed at assembly from in-memory register state; it is never emitted for
  a subagent session; it is never written as a human message. The seam is that it is one more
  model-facing context contribution with its own consent preference, so it can be added without
  touching the tool contract or the existing settings fields. Undecided: its exact copy, its
  counts' scope (which sessions count as "other"), its refresh cadence, and whether the nudge is
  then redundant.
- **Team-task actions** — the tool cannot Complete or Reassign an item of kind `task`: those
  actions belong to the reply contract's task-action control, owned by Answering & Delivery. The
  seam is the item kind and that control; the four-action enum does not grow for it.
- **Turning the per-turn bound into an enforced refusal** — the "at most five in a turn" rule is
  carried by wording and measured by the register's live cap. Enforcing it would add a refusal
  value to a published contract and could leave an agent unable to declare a real sixth decision;
  the seam is the refusal vocabulary, which is extensible in one place.
- **Nudge copy and localisation** — the text is documentation-owned English at intent level.
  Exact copy, length budget and whether it follows the active locale are deferred; the seam is
  that the nudge is one text section, not protocol.

## Testing Strategy

- The tool is exercised through its published interface (schema-validated arguments in, result
  value out), one action per test; the register is inspected afterwards rather than mocked.
- The harness is the only mock boundary: the tool registry, the agent/session registry, the
  prompt-assembly seam and the settings read path. Register and store behaviour is real, so dedupe,
  lifecycle and attribution are tested as behaviour rather than stubs.
- Wording assertions are contract tests: the declaration text must carry the negative clause, the
  one-item rule, the per-turn bound, the kind taxonomy and the resolve-after-answer sentence.
- Ownership and roll-up are tested from three identities: the root, a direct subagent, and an
  unrelated root. The subagent case is the one that must refuse; "same title from two roots"
  stays two items.
- Determinism: the clock is injected, ids are creation-ordered, and list queries fix the fixture
  order; a test that depends on wall-clock time or on hash ordering is a test defect.
- The no-session-log-write policy is a standing test across every action: the count of appended
  session events after the full lifecycle (raise, list, resolve, reopen, dismiss) is zero.

## Out of Scope

- Delivering, settling, waking or steering — Answering & Delivery owns those, and this spec only
  records.
- The item's lifecycle, identity and dedupe implementation — the register owns them; this spec
  states what the agent may ask for.
- The candidate gate, the prose gate and extraction — Capture owns when they run; the consent
  spec owns whether extraction may run.
- The card's rendering and interaction, and the settings section — Surfaces owns them.
- Team-task capture — the item kind exists, but the liveness gate that would justify capturing
  team tasks is deliberately not designed (recorded in Capture's context).
- Model access to the register beyond these four actions: no bulk read, no query language, no
  write beyond a declaration, an answer record and a dismissal.

## Open Questions

- **Which layer owns the candidate guard?** The requirement is settled — a `resolve` or `dismiss`
  naming a candidate is refused, and a candidate reply is refused — but not where the guard lives:
  the tool handler, the register's transition layer (so every caller shares it), or the delivery
  guard. The register's transition layer is the natural single owner because it sees the tool, the
  reply route and any future caller. Answerable by the register's owner with the Lead.
- **Does the agent's list include candidates, and how can it tell?** Candidates are in a live
  state, so a state-filtered list reaches them, and the model-facing row carries no tier. The
  likely answer is to expose the distinction the agent needs (tier on the row, or candidates out
  of the tool's default scope) — the register and this context must agree. Answerable by the
  product owner with the register's owner.
- **Which actor records an agent-invoked dismissal?** A resolve through the tool records `model`;
  a dismissal through the tool says the user said this is not an item. Whether the recorded actor
  should be `model` (the agent acted) or `user` (the resolution's meaning) is not settled; the
  register owns the actor vocabulary, so the answer belongs there and the tool contract follows it.
- **Should a raised item count as "Needs you" before the user has seen the declaration?** A
  severity-1 declaration is counted immediately by the Needs-you predicate; whether declarations
  should be exempt until the card is first shown is a product question for the attention register,
  and this context will follow whatever the register decides.
