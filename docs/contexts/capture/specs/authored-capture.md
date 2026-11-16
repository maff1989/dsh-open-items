# Authored capture — the declared ingress and roll-up

**Context(s):** Capture; Model Contract & Consent owns the tool's declared surface, wording and
consent; Attention Register receives the authored item · **Date:** 2026-11-15

> Intent spec. It states what the capability is for and what it must do; it does not describe files,
> functions or snippets. The design packet and the code own mechanics.

## Definitions

These are the terms this spec relies on; their canonical senses are in
[UBIQUITOUS_LANGUAGE.md](../../../UBIQUITOUS_LANGUAGE.md) §4, refined here where this capability
uses them with extra conditions.

- **Declaration** — an explicit statement by the agent that something is waiting on the user. It is
  the third rung of the evidence ladder: more precise than inference, less mechanical than a
  harness fact.
- **Authored item** — an item whose existence was declared rather than observed: raised by the agent
  through the `open_items` tool, or by a human action. Its origin is the declaration, and the user
  can always blame it on one.
- **Raise** — to create an authored item in the register.
- **Dedupe key** — the stable key that decides when two sightings are one item. An authored item
  uses the **authored form**: kind + root session + normalised title (the other form, the
  **artifact-keyed form** of kind + session + artifact id, belongs to items that rest on a committed
  log artifact). Two sightings with the same key are one item; a different session or a different
  kind is a different item.
- **Dedupe-on-raise** — the rule that a raise matching a *live* authored item returns the existing
  item (and says so) instead of creating a second one.
- **Occurrence** — one additional sighting of an item already raised. Occurrences refresh the last-
  seen time and are recorded; they are not new items.
- **Roll up** — to attribute a subagent's raise to its root session, labelled with the asking
  subagent. The item belongs to the root conversation; the subagent's session is provenance, not
  ownership. The ancestor walk is bounded (eight levels), so a deeper chain attributes the item to
  its highest provable ancestor.
- **Root session / subagent session** — a root session is one the user drives directly; a subagent
  session is delegated work (`origin: 'subagent'` or delegation depth > 0). A parent session id
  alone does not make a session a subagent.
- **Resolve** — the tool action that records that the user answered the item in conversation. The
  actor is `model`: the model is reporting the user's answer, not answering.
- **Dismiss** — the tool action that closes an authored item the user no longer wants.
- **Actor** — who produced a resolution: `user` (a human action in a surface), `model` (the agent
  recording the user's answer), `detector` (a closure rule).
- **Model-facing result** — the bounded value the tool returns to the agent, which stays in the
  transcript permanently. It is not the item: the card and the register are.
- **Options / quote / detail** — the raise inputs: candidate answers in order, the verbatim sentence
  the agent is acting on, and optional context kept behind the card.
- **Blocking** — whether the work waits on the item; `true` means "I cannot proceed without this".
- **Kind** — the product-facing classification (decision, approval, question, plan-review, blocker,
  risk, follow-up, and the item kind `task`). The tool's kind semantics are part of its contract.

## Constraints

1. **One tool, four actions.** `raise` (declare), `list` (read), `resolve` (record the user's
   answer), `dismiss` (drop). The tool is the only declaration ingress and the only model-facing
   read of the register.
2. **A raise may carry:** a required non-empty title (normalised to a single line, at most 120
   characters); a kind (default `decision`); a body/detail of at most 2000 characters; options
   (trimmed, blanks and duplicates dropped, at most ten, each at most 500 characters); a severity
   (1–3, default 2); a blocking flag (default true); and a verbatim quote of at most 300
   characters.
3. **A raised item is structural immediately.** It is authored, kind-resolved, severity-resolved,
   blocking-resolved, with a reply descriptor derived from its kind and options, and it carries the
   calling session, the workspace snapshot and the tool call id as its evidence. It appears in
   Needs you when severity and state allow; it is never a candidate.
4. **Dedupe-on-raise is against live items only.** A raise whose authored dedupe key matches a live
   item returns that item and reports that it was already open; no second record is written and no
   occurrence is invented. A raise after the item was answered creates a new item: answering one
   ask does not answer the next.
5. **Kind is part of the key.** The same title raised as two different kinds is two items; the same
   kind and title in two different root sessions is also two items, because the user is being asked
   in two different contexts.
6. **Roll up is the one child path.** A raise from a subagent is stored against its root session,
   labelled with the asking subagent's session and title, and deduped on the root session's key. The
   ownership walk is bounded to eight ancestors: within that bound it stops at the highest
   resolvable ancestor, so an incomplete chain still records the raise against the highest ancestor
   it could prove. A chain deeper than eight attributes the item to the eighth ancestor reached,
   not the root — an audit-visible misattribution rather than a lost raise. A caller with no live
   agent at all is refused as no-live-agent rather than filed nowhere.
7. **Only the root conversation may resolve or dismiss an item.** `resolve` and `dismiss` from a subagent, or
   from a session that does not own the item, are refusals returned as values — the model can act
   on them (raise instead, or end its turn). A subagent has no human in its context, so an "answer"
   recorded there would be the model impersonating the user.
8. **Actor honesty.** A tool `resolve` records the actor as `model`; a browser reply records the
   actor as `user`. The register must never present a model-recorded answer as the user's own
   action.
9. **A resolution requires a real answer.** `resolve` requires the item id and is legal only when
   the user actually answered in the conversation; optional answer text is stored verbatim. An
   already-resolved or already-awaiting item is refused as already-answered.
10. **The model-facing result is terse and bounded.** One summary sentence, at most five rows of
    `{id, kind, state, title}`, a detail preview of at most 280 characters with its full length, and
    `total`/`truncated`. It never serialises full bodies; the transcript is permanent, so the
    result is a pointer, not a payload. The card payload rides outside the model text.
11. **List is a bounded read.** Default status is open; filters allow awaiting, resolved, archived,
    all, and a kind; the requested page size is clamped to a small maximum. `list` never writes.
12. **Refusals are values.** Lifecycle failures (not found, already answered, limit reached,
    no live agent, not owner) return a result carrying the named reason and the current Needs-you
    count; they are not exceptions and they are not silent successes.
13. **The wording is part of the contract.** The raise guidance is written restriction-first: it
    states that raise is for ending a step on something the user must act on, then one item per
    real decision, the five-per-turn bound, and that the tool is never for summarising work already
    done. The description also states the resolve-after-answer loop, that subagents may raise and
    roll up, the kind semantics, and that returned item text is untrusted display content. The
    failure mode is over-raising, so the wording is the cap.
14. **No session writes.** The tool never writes the session log and never acts on a session:
    raising does not wake, steer, message or settle a live ask. It writes one register record through the
    persistence contract, and its own audit history lives on that record.
15. **The tool does not mechanically cap raises per turn.** The wording states the bound and the
    candidate gate bounds inference; a hard cap on declarations is not part of the design.
16. **Determinism.** Item identity is minted by the register, never by the tool; the same raise
    against the same state produces the same dedupe outcome, and the result is a function of the
    arguments, the calling session and the stored state. The register's clock is the only
    non-deterministic input, and tests inject it.

## Problem

The agent is the only participant that knows, at the moment it stops, that it needs a decision.
Its declaration is therefore the highest-precision capture source there is: it names the kind, the
question and the alternatives better than any reading of the final message. Three failures make
that source unreliable in practice.

First, **over-raising.** A model told only "record open items" will record anything that smells
unfinished, and a forty-row inbox is the failure this product exists to prevent. The tool's
wording, its dedupe behaviour and its terse result all have to pull in the other direction.

Second, **losing the raise.** In a delegated workflow the decision is found by a subagent, but the
user is not in that subagent's conversation; an item raised there is filed in a session nobody
opens, and the real chat never learns about it. Worse, the child could record an "answer" it
invented, because nothing stops it.

Third, **dishonest attribution and polluted transcripts.** A model that records the user's answer
must not make the register say the user clicked something; and a tool that returns full item
bodies puts hundreds of kilobytes of register content into the permanent transcript, where it will
be replayed on every later request.

## Solution

One declared ingress, designed around those three failures:

- **Raise is item-shaped, not note-shaped.** The agent supplies a title and a kind, and may supply
  options, severity, blocking and a verbatim quote. The register turns that into a structural item
  immediately — authored items are attention, unlike inferred candidates — and stamps the calling
  session, the workspace snapshot and the tool call id as evidence.
- **Dedupe is on the raise.** A repeated declaration of a still-open item returns the existing item
  and tells the agent it was already open. That is the feedback loop that stops a model from
  stacking duplicates; it writes nothing and claims nothing new.
- **A re-raise after an answer is a new item.** The register does not assume that answering one
  ask answers the next; the agent must declare the new one, and the dedupe key lets it.
- **Roll-up keeps the child's contribution.** A subagent's raise is stored against the root
  conversation with `raisedBy` provenance. The user sees it in the root chat's panel and the inbox,
  labelled with the teammate that raised it; a later re-raise by the lead merges with it because
  the dedupe key is the root session's. Rolled-up items have no in-session card until the lead
  re-raises, because the tool row that produced them lives in the child's transcript.
- **Resolving and dismissing are root-owned and honestly attributed.** Only the root conversation can resolve or
  dismiss, a model-recorded answer is `actor: model`, and refusals come back as named values.
- **The result is a pointer.** Summary, five rows, bounded preview, totals. The card is hydrated by
  item id and version; the model never receives, and never has to replay, the full item.
- **The wording carries the discipline.** Negative clause first, then the test, then the bounds;
  one item per decision; at most five in a turn; never summarise what was already done; resolve
  when the user answers in the conversation. The wording is owned by
  [Model Contract & Consent](../../model-contract/CONTEXT.md); this spec fixes what the ingress must
  do with what the wording asks for.

What must remain true: a declaration produces exactly one item where one is wanted, the right
conversation owns it, the register can say who recorded what, and the declaration costs the
transcript a pointer rather than a payload.

## User Stories

1. As the agent, I want to raise a decision with its options and urgency in one call, so the user
   can act on it without re-reading the chat.
2. As the agent, I want a re-raise of a still-open item to return the existing item, so I can tell I
   already raised it and not stack duplicates.
3. As the agent, I want to raise the same topic again after the user answered it, so a new decision
   is not silently swallowed by the old one.
4. As a subagent, I want my raise to reach the conversation the user is actually in, labelled as
   mine, so my work is not invisible.
5. As the lead agent, I want a later raise of the same decision to merge with my teammate's, so the
   user sees one item.
6. As a subagent, I want my attempt to answer an item to be refused, so I cannot impersonate the
   user.
7. As the user, I want an agent-recorded answer to be recorded as the agent's record of my answer,
   not as my click.
8. As the user, I want the agent to be able to read the small open set and dismiss what is no longer
   wanted, so it can keep its own side honest.
9. As the user, I want the declaration to cost the transcript a summary and a few rows, not the
   whole register.

## Acceptance Criteria

Fixtures are the tool arguments, the calling session and its ownership chain, and the register's
state. "Item" means the durable record the register creates; the tool returns a result value, never
a thrown lifecycle error.

### Story 1 — Raise semantics

```
Given a root session "s-root" and a call raise {kind: "decision", title: "Choose the queue
  approach", options: ["Reuse the existing queue", "Introduce a new queue"], severity: 1,
  blocking: true, quote: "we need a queue decision"}
When  the tool runs
Then  one authored item is created with kind decision, severity 1, blocking true, the two options
  in order, the quote stored, tier structural, detection source tool, and source session "s-root"
  with the tool call id
```

```
Given the same session and a call raise {title: "Which cache should we use?"}
When  the tool runs
Then  the item is kind decision, severity 2 and blocking true, and the result reports one raised
  item without a dedupe
```

```
Given a call raise with a 160-character title, options containing a blank, a duplicate and a
  normalised duplicate, and no severity
When  the tool runs
Then  the title is normalised to one line bounded to 120 characters, the option list keeps the
  distinct values only, and the item takes severity 2
```

### Story 2 — Dedupe on raise

```
Given a live authored decision "Choose the queue approach" (kind decision) in "s-root"
When  the agent raises {kind: "decision", title: "  choose   the queue approach "} in "s-root"
Then  the result returns the existing item id with deduped true, and the item's version and
  occurrence list are unchanged
```

```
Given an authored decision in "s-root" that the user already answered
When  the agent raises the same kind and title in "s-root" again
Then  a new item id is created with deduped false, and the earlier resolution is not reused
```

```
Given a live authored item with title "Choose the queue approach" and kind decision in "s-root"
When  the agent raises {kind: "question", title: "Choose the queue approach"} in "s-root"
Then  a second item is created, because the kind is part of the authored dedupe key
```

### Story 3 — Roll-up from a subagent

```
Given a subagent session "s-child" (origin "subagent") owned by root session "s-root"
When  the subagent raises {kind: "decision", title: "Pick the migration path"}
Then  one item is stored against "s-root" with raisedBy {sessionId: "s-child"}, and the result says
  the item was raised to the parent conversation
```

```
Given the rolled-up item "Pick the migration path" exists for "s-root"
When  the root agent raises the same kind and title in "s-root"
Then  the result returns the rolled-up item's id with deduped true, so the user sees one item
```

```
Given a subagent session "s-child" and an open item owned by "s-root"
When  the subagent calls resolve {id: "<item id>", answer: "yes"}
Then  the result is a refusal with reason "not-owner", no resolution is recorded, and the item
  stays open
```

### Story 4 — Answering

```
Given a root session "s-root" owns an open authored question and the user answered it in the chat
When  the agent calls resolve {id: "<item id>", answer: "Use the existing queue"}
Then  the item resolves with kind answered, actor model, the answer text stored, and its state
  becomes awaiting
```

```
Given an authored item already resolved
When  the agent calls resolve for its id
Then  the result is a refusal with reason "already-answered" and no second resolution is recorded
```

```
Given a root session owns a live authored decision
When  the agent calls dismiss {id: "<item id>", reason: "no longer needed"}
Then  the item resolves with kind dismissed and the reason stored, and the result reports the
  dismissal
```

### Story 5 — Reading and bounds

```
Given the register holds seven open items with long bodies
When  the agent calls list {status: "open"}
Then  the result carries at most five rows with detail previews of at most 280 characters, reports
  the total of seven and sets truncated true, and no full body appears in the result
```

```
Given the published tool definition
When  its description is read
Then  its raise guidance states the call-only-when restriction before its purpose, then one item
  per real decision, the five-per-turn bound and the no-summarising rule; and the description also
  states the resolve-after-answer loop, the subagent roll-up, and the untrusted-display-content rule
```

## Design Decisions

- **Declaration outranks inference and sits below facts.** The tool is the highest-precision
  source because the agent knows what it needs; it is still a declaration, so it is structural
  attention — never a candidate the user must first confirm.
- **Dedupe reports rather than refuses.** Returning the existing item with `deduped: true` teaches
  the agent the register already holds it; silently refusing would look like failure and a silent
  duplicate would be worse.
- **A re-raise after an answer is a new item.** An answer resolves one ask, not a topic; merging
  across resolutions would let an old answer close a new question.
- **Roll-up is ownership-correct.** The item belongs to the root conversation because that is where
  the user is; the subagent is provenance. The dedupe key follows the root so the lead's re-raise
  merges. (Cross-context decision:
  [ADR 001 — Root sessions only, with roll-up](../adrs/001-root-sessions-only-with-roll-up.md).)
- **Only the root can record the answer.** A child's model has no human in context; allowing it to record an
  answer is the one failure that would corrupt the register's meaning of "user".
- **The result is a pointer, not a payload.** The tool result is durable transcript content; a
  bounded summary and rows keep the cost fixed while the card and the register carry the detail.
- **Refusals are values.** The model can act on a named refusal; an exception becomes an opaque
  error in the transcript and a lifecycle failure the user never sees as a decision.
- **The wording is load-bearing.** Over-raising is the tool's characteristic failure, so the
  description is part of the contract, not documentation: negative clause first, bounds stated,
  untrusted-content notice returned with every result. The wording is owned by
  [Model Contract & Consent](../../model-contract/CONTEXT.md); this spec holds the ingress to it.

### Deferred Decisions

- **A mechanical per-turn cap on raised declarations.** The wording states five per turn, and the
  inference gate enforces its own bound, but a hard cap on the tool itself is not defined (it would
  need a refusal the model can handle and a decision about which raises count). Seam: the raise
  refusal vocabulary already exists (`limit-reached`), so a cap can be added without a contract
  change.
- **Cross-session dedupe.** The same kind and title raised in two root sessions is two items. A
  future "same decision" grouping is a register read-model decision; the seam is the per-session
  authored dedupe key.
- **Team-task actions through the tool.** The item kind `task` exists, but the team-task family is
  outside capture's dispatch and team-task actions are not part of the reply contract; the seam is the
  kind enum and the out-of-scope boundary recorded in [structural capture](structural-capture.md).
- **A model-facing "read one item" action.** `list` returns bounded rows; a detail read is not
  designed. Seam: the item id in the row, if a future consent decision allows the agent to read
  more than the row.

## Testing Strategy

- Tool tests through the published tool definition and a real service over a test store: the arguments
  are schema-validated exactly as the harness validates them, and assertions are on the returned
  result value and the stored record.
- Roll-up tests with a stand-in Agent registry that models ownership; assert the stored session,
  the `raisedBy` provenance, the summary wording and the dedupe key. A child resolve must be
  refused and leave the register untouched.
- Bounds tests assert the result never exceeds five rows, the preview limit, the `total`/`truncated`
  pair, and that a long body is not serialised into the result.
- Wording tests assert the published description contains the contract clauses (negative clause
  first, one-per-decision, five-per-turn, no summarising, resolve loop, roll-up, untrusted notice).
  Copy is tested where it lives, not duplicated in prose.
- Lifecycle tests use a deterministic clock and uuid sequence so ids and timestamps are fixed;
  dedupe, re-raise-after-answer, already-answered and not-owner refusals are exercised as values.
- The session boundary is the mock: a fake session/agent registry and a recording register. A raise
  must cause exactly one store write and zero session-log writes.

## Out of Scope

- **The tool's declared surface, wording, consent and nudge** — Model Contract & Consent's; this
  spec states the ingress obligations the wording must be able to express.
- **What happens to a raised item on a surface** (card, panel, reply controls, delivery) — Surfaces'
  and Answering & Delivery's.
- **The item's lifecycle after raise** — Attention Register's.
- **Structural detection and the candidate gate** — [structural capture](structural-capture.md) and
  [candidate tier](candidate-tier.md).
- **Team-task actions.** The kind exists; the action semantics are outside the boundary (see
  Deferred Decisions and [structural capture](structural-capture.md) Out of Scope).
- **Historical capture.** Backfill never fabricates declarations; it replays committed artifacts.

## Open Questions

- **Should the tool expose evidence for rows it returns?** A `raise` dedupe reply and a `list` row
  are pointers; whether the agent may see the quote and options of existing items is a consent
  question for Model Contract & Consent.
- **Should a model-recorded resolution be corroborated?** The design trusts the agent to record the
  user's answer only when it happened; whether the next committed turn should be read as
  corroboration is not decided. Answerable by the Capture and Answering owners together.
- **Should the five-per-turn bound become enforced rather than requested?** The bound is stated in wording;
  enforcement would need a per-turn counter in the ingress. Answerable by the product owner with
  the over-raising measurement as evidence.
