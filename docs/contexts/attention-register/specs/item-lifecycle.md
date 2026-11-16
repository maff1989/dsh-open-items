# Item lifecycle

**Context(s):** Attention Register; publishes the draft response to Capture, the legal
transitions to Answering & Delivery and Surfaces · **Date:** 2026-11-15

> Intent spec. It states what the capability is for and what it must do; it does not describe
> files, functions or snippets. The design packet and the code own mechanics.

## Definitions

The canonical entries are in [UBIQUITOUS_LANGUAGE.md](../../../UBIQUITOUS_LANGUAGE.md). Every term
the spec relies on is defined here with the precise sense this spec gives it; where the glossary
also defines the term, this section states the conditions the register adds.

- **Item** — one durable record of something the user must supply before the work can be
  considered done. The item is the unit of identity, state, history and evidence. It is never a
  note: if the user never answers it, the work is wrong or incomplete.
- **Open item** — an item in a live state that the user has not answered, dismissed or lost.
  "Open item" is never used for a resolved, tombstoned or archived-item-state record.
- **Live item** — the spec's local term for an item in `open`, `snoozed` or `stale`. These are
  the states the live cap counts; they are what "still in the register" means for attention.
- **Item kind** — the product-facing classification of what the user must supply. Exactly eight
  exist: `decision` (choose or settle a direction), `approval` (permission for one action),
  `question` (supply information or a go-ahead), `plan-review` (approve or reject a plan before
  work continues), `blocker` (work cannot proceed), `risk` (accept or mitigate), `follow-up`
  (agreed work not yet scheduled), `task` (a team-board task the user must act on).
- **Tier** — the evidence class of the item's existence. **Structural** means a harness fact or
  an explicit declaration proves it; structural items are answerable as items immediately.
  **Candidate** means a heuristic inferred it; a candidate is never Needs you. No surface offers
  an answer control for a candidate, and the reply contract refuses a candidate-tier reply with a
  named refusal; promote is the only path that makes a candidate answerable.
- **Severity** — the urgency class 1–3. Severity 1 is something blocked; 2 is a decision the
  work expects; 3 is FYI, never counted as Needs you. Severity comes from the artifact's nature
  or from the declaring agent, never from a model's guess.
- **Blocking** — whether the work waits on this item to continue (`true`) or can proceed without
  it (`false`). Blocking is a different axis from severity and is the input the answer matrix
  consumes; this spec fixes what it is, not how it routes a reply.
- **Authored item** — an item whose existence was declared: raised by the agent, or by a human
  action. Its identity comes from the declaration (kind, session, normalised title).
- **Derived item** — an item whose existence was observed from a committed harness fact (an
  approval pair, a pending call, a goal change, an interrupted turn, a job). Its identity comes
  from the artifact it mirrors, and it is structural unless a detector explicitly makes it a
  candidate. Prose is not derived: a prose item is a heuristic reading of the log, so it is
  inferred.
- **Inferred item** — an item a heuristic produced from a turn's text or plan state. Inferred
  items are candidates until confirmed; "inferred" describes how they came to exist,
  "candidate" describes what the user may do with them. A prose candidate's evidence is derived
  from the log record, but the item is inferred — the two words are not interchangeable.
- **Item id** — the durable identity of an item. It is ordered by
  creation time, stable across moves, edits and reopens, and never reused. It is not the dedupe
  key and not the artifact id.
- **Artifact id** — the identity of the observed harness fact inside its session (an approval
  call, a question call, a goal, a job, a turn's prose ask, a plan snapshot). Replaying the same
  committed log produces the same artifact ids. Users never see them.
- **Dedupe key** — the key a sighting is matched on, in exactly two forms: the **authored form**
  (kind + session + normalised title, minted when an agent declares an item) and the
  **artifact-keyed form** (kind + session + artifact id, used for every item whose existence
  rests on a log artifact, whether it is detected or inferred). One dedupe key means one live
  item. The key is contextual on the session, so the same decision in two sessions is two
  items.
- **Occurrence** — one additional sighting of a detected or inferred (artifact-keyed) item that
  already exists. Occurrences advance the item's last-seen time and are recorded, bounded; they
  are evidence, not new items. An authored re-raise of a still-open item is not an occurrence: it
  merges silently, returns the existing item, reports the dedupe and writes nothing.
- **Suppressor** — a durable "the user said this is not an item" record. It is written only by
  the candidate's **suppress** action and matched by dedupe-key prefix, so the same inferred ask
  cannot be raised again. A plain dismissal writes none.
- **Tombstone** — the record left by **delete forever**: the item is resolved, its title and
  body are replaced by a deletion marker, its transcript-derived text is dropped, and its
  identity and dedupe key are kept so it can never be re-raised. A tombstone is not a
  resolution and is excluded from the register.
- **State** — one of exactly six lifecycle values: `open` (live, waiting on the user),
  `snoozed` (deferred by the user until a stated instant), `awaiting` (the user answered; the
  work has not yet shown it acted), `stale` (the raising context went quiet; still tracked),
  `archived` (a live item moved out of the active register by the live cap; content intact),
  `resolved` (terminal outcome; the item is a register entry from then on).
- **Resolution** — the recorded outcome that ends an item's active life, of exactly four kinds:
  `answered` (the user supplied the decision, or the detector's own mechanism resolved it),
  `dismissed` (the user said this is not an item), `superseded` (a later turn or message made it
  moot), `detected-closed` (a detector closed it without a human answer). A resolution records
  exactly one **actor**: `user` (a human action in a surface), `model` (the agent recording the
  user's answer from the conversation), or `detector` (a closure rule). Timing differs by path: a
  settle (client- or host-settle) records the payload when the answer is accepted and the item
  moves to `awaiting` carrying it; a session-message reply records no resolution at send — the
  item is `awaiting`, and the answer it carried becomes the resolution when the work acknowledges
  it or when the acknowledgement window elapses with no evidence. In both cases the item becomes
  `resolved` only then.
- **Closure** — the act of a closing detector resolving an item. A closure is a
  `detected-closed` resolution and carries the closing detector's code; "closed automatically"
  is UI copy, not a state or a resolution kind.
- **Resolution log** — the bounded history of earlier resolutions kept when an item is reopened,
  so the current resolution is never rewritten.
- **Reopen** — the user action that returns a settled item to `open`: a `resolved` item moves its
  prior resolution into the resolution log, and a cap-archived `archived` item returns with its
  content intact and no resolution to move. Both increment the reopen count. An approval whose
  permission was exercised is refused.
- **Acknowledgement** — the register's record of whether the work acted on the user's answer. Its
  state is `pending` (no evidence yet), `observed` (evidence exists, with its kind) or `none`
  (the window elapsed with no evidence). The evidence kinds are specific: a tool result, a
  continued turn, a retried call, a resumed goal, a completed team task, a next turn.
- **Acknowledgement window** — the policy bound after which a `pending` acknowledgement becomes
  `none`; the retention spec owns its value and boundary. This spec owns what the three states
  mean.
- **Promote** — the user's confirmation of a candidate: tier becomes structural, blocking is
  true, severity is 2, and any correction the user made (title, body, quote, options, kind) is
  applied in the same write. A change of kind rekeys the dedupe key rather than duplicating the
  item. Promotion is the only path from candidate to an answerable item.
- **Suppress** — the candidate action that resolves the candidate as dismissed and writes the
  suppressor for its dedupe key prefix.
- **Snooze / wake** — the user defers a live item until a stated instant (`snoozed`); when the
  instant is reached the register returns it to `open`.
- **Delete forever** — the explicit, confirmed user action that writes a tombstone. It is the
  only user action that removes an item from the register's reads.

## Constraints

- **Closed vocabularies.** Eight kinds, two tiers, severities 1–3, six states, four resolution
  kinds, three resolution actors. Adding a member is a vocabulary decision that changes the
  glossary first; it is never an extension made in passing.
- **Bounded text.** A title is one line, whitespace-collapsed, at most 120 characters, and may
  not be empty. A body and a quote are whitespace-collapsed and at most 2000 characters. Reply
  options are verbatim, at most ten, and bounded in length. A quote is never a summary: it is
  the evidence.
- **Bounded history.** The audit history keeps the most recent 50 entries; the delivery attempt
  list 50; the occurrence list 50; the resolution log 50. When the bound is reached the oldest
  entry is dropped and the newest is kept. No bound may be exceeded by a write.
- **Identity rules.** An item id is minted once at raise and never changes; it is ordered by
  creation time. An authored dedupe key is minted from the declaration (case-insensitive,
  whitespace-collapsed title) and an artifact-keyed key from the artifact id of a detected or
  inferred item; a key is recalculated only when a promotion corrects the kind, in the same write
  that corrects the record.
- **State and evidence must agree.** A `resolved` item always has a resolution and a resolution
  time. An `awaiting` item always has an acknowledgement, `pending` at the moment it enters the
  state. A candidate is always in a live state or resolved; it is never structural and candidate
  at once. These are durable-boundary invariants, not conventions.
- **One write per transition.** Every state change is one version-checked write that increments
  the item's version and appends one audit entry. No transition may apply partially, rewrite the
  audit history, or move a record's times backwards.
- **Refusals are explicit.** A transition that is illegal for the item's state, a version
  mismatch, a missing item, or a cap that cannot be satisfied is refused with a stable code and
  recovery copy; the caller recovers by re-reading. It is never a silent no-op and never a
  partial write.
- **No clock mixing.** Every recorded time comes from the register's one clock at the moment of
  the write. A client-supplied instant may be a target (a snooze's wake time) but is never
  written as the time an event happened.
- **Determinism of evidence.** Occurrences are deduplicated by session and sequence, so the same
  sighting recorded twice advances the last-seen time but does not duplicate the entry; ordering
  within every bounded list is chronological with the oldest dropped first.

## Problem

The chat is the wrong place to be accountable. A conversation raises a decision, the user
answers in passing, and then either the answer is buried under later turns or the agent moves on
without acting on it. There is no durable place that says *this is still open*, *you answered
this*, or *the work never acted on it*. Three specific failures follow.

First, the register's list fills with guesses. A permissive reading of the agent's final prose
produces more false items than real ones, and a single false item teaches the user to ignore the
list. Second, identity is lost. Re-raising the same decision, replaying a session, or retrying a
failed call produces either a duplicate or a silent override, so the user cannot trust that one
decision is one row. Third, endings are not recorded. A dismissed item, a detector closure and a
permission that was granted all look the same from the outside — gone — and there is no way to
read back what was decided, by whom, or whether it was carried out.

## Solution

Every loop becomes one item with a durable identity, a closed-kind classification, a tier that
gates attention, and an honest state. Declarations and observations share one identity rule, so a
re-raise merges and a replay is idempotent. Inferences arrive as candidates and stay out of
attention until the user confirms them; confirmation can correct the guess in place. Answering
moves the item to `awaiting` until the work shows evidence, at which point (or when the window
elapses) it resolves. Every ending records one of four resolutions with one of three actors, the
exact payload and the time, and the register keeps earlier resolutions when an item is reopened.
Deletion is explicit and leaves a tombstone; nothing about an item's history is rewritten by
time, by a cap, or by a later scan.

## User Stories

1. As the user, I want every loop to be one durable item whose identity never changes, so that a
   re-raise, a replay or an edit can never duplicate or silently override what I already have.
2. As the user, I want an inferred ask to wait for my confirmation before it can claim attention,
   so that a heuristic can never put words in my list or make me answer a guess.
3. As the user, I want severity and blocking to be separate facts about the work, so that an
   urgent-looking item that no longer blocks does not shout, and a quiet item that truly blocks
   does not hide.
4. As the user, I want my answer to put the item into "waiting on the work" rather than "done",
   so that the register tells me the truth about whether the work acted on it.
5. As the user, I want every ending recorded with who ended it and how, so that I can read back
   what I decided and what closed on its own.
6. As the user, I want an explicit delete forever to be final, and a permission I already
   exercised not to be reopenable, so that the register never offers me an undo that would be a
   lie.

## Acceptance Criteria

Each scenario is one action with inline fixture data. Assertions about that action may be several.
The register's clock is fixed for every scenario; item ids are ordered by creation time, and no
assertion depends on the random tail of an id.

### Story 1 — One loop, one item

```
Given session "s-42" holds no item whose dedupe key matches a decision titled "Ship the migration before Friday?"
When  the agent declares a decision titled "  ship the   MIGRATION before friday? " in session "s-42"
Then  exactly one item exists: state `open`, tier `structural`, severity 2, blocking, with a new item id,
      a normalised title "ship the MIGRATION before friday?", and session "s-42" as its owner
```

```
Given an open authored decision titled "Ship the migration before Friday?" in session "s-42", version 4
When  the agent declares the same kind and the same title in session "s-42" again
Then  the register returns that item, reports the raise as a duplicate, and still holds exactly one
      live item with that dedupe key
```

```
Given an open derived plan-review mirroring artifact "plan:turn-9" in session "s-7" with 49 occurrences
When  a further sighting of artifact "plan:turn-9" at sequence 120 reaches the register
Then  the item holds 50 occurrences with the new sighting last, its last-seen time advances, and no
      second item exists
```

### Story 2 — Inference waits for confirmation

```
Given the prose gate reports an inferred decision in session "s-9" quoting "Should I use A or B?"
When  the draft reaches the register as a candidate
Then  the item exists with tier `candidate`, the quote as its evidence, and the Needs-you predicate
      does not hold for it
```

```
Given an open candidate titled "Use the 5-colour palette?" in session "s-9", version 3
When  the user confirms it as an item, correcting the title to "Use the five-colour palette?"
Then  one item remains, tier `structural`, blocking, severity 2, with the corrected title stored and
      the Needs-you predicate holding for it
```

### Story 3 — Answering is not finishing

```
Given an open decision titled "Which rollout window?" in session "s-42", version 5, mirrored by a
      live ask the user settles through its own control
When  the user settles it with "Friday morning"
Then  the item is in state `awaiting` with acknowledgement `pending`, its resolution is
      `answered` by actor `user` with that payload recorded at acceptance, and the Needs-you
      predicate no longer holds
```

```
Given an open decision titled "Which rollout window?" in session "s-42", version 5, with no live
      request to settle
When  the user sends the answer "Friday morning" to the session
Then  the item is in state `awaiting` with acknowledgement `pending`, it carries no resolution yet,
      and the answer is held as the delivery's payload until acknowledgement or the window
      elapses
```

```
Given an `awaiting` decision whose last activity was at 09:00 with acknowledgement `pending`
When  the register's sweep runs at 09:00 the next day with no evidence in between
Then  the item is `resolved` with acknowledgement `none` and the resolution is not described as a
      failure anywhere the register reports it
```

```
Given a decision already in state `resolved` with an `answered` resolution
When  a second answer for that item is submitted
Then  the register refuses the transition as a named invalid-transition value and the record,
      including its version and history, is unchanged
```

### Story 4 — Every ending is recorded

```
Given an open blocker titled "Vendor credentials missing" in session "s-12"
When  the closing detector for the goal artifact reports that the goal resumed
Then  the item is `resolved` with resolution `detected-closed` by actor `detector`, carrying the
      closing detector's code, acknowledgement `observed` with the goal-resumed evidence kind, and
      the register records it as an outcome, not a disappearance
```

```
Given a resolved decision whose resolution was `dismissed` by the user, reopen count 0
When  the user reopens it
Then  the item is `open`, the dismissed resolution is preserved as the first entry in the
      resolution log, the reopen count is 1, and the Needs-you predicate holds again
```

```
Given an item in `archived` state at version 6, moved there by the live cap, with its title and body
      intact and no resolution, reopen count 0
When  the user reopens it
Then  the item is `open` with its content intact, no resolution-log entry is added, the reopen count
      is 1, and the Needs-you predicate applies again
```

```
Given a resolved approval whose `allow once` permission was exercised and whose acknowledgement is
      `observed`
When  the user reopens it
Then  the register refuses the transition as a named invalid-transition value and the record is
      unchanged
```

### Story 5 — Precedence and resurrection

```
Given a derived item resolved by the user with resolution `answered`
When  a later scan of the same session reports the same artifact again
Then  the item stays `resolved`, the sighting is recorded as a suppressed occurrence, and no new
      Needs-you item appears
```

```
Given an item `detected-closed` by a goal detector
When  the same goal artifact is observed live again
Then  the item reopens to `open`, its prior resolution moves into the resolution log, the reopen
      count increments, and the Needs-you predicate holds again
```

### Story 6 — Deferral with an end

```
Given a live decision snoozed until 2030-01-01T09:00:00Z
When  the register's sweep runs at 2030-01-01T09:00:00Z
Then  the item is `open` again, its snooze instant is cleared, a woken audit entry is recorded, and
      the same read counts it as Needs you instead of as snoozed
```

## Design Decisions

- **State and resolution are separate axes.** The six states describe what the item is doing now;
  the four resolutions describe what ended it. No state encodes a past event, and no resolution
  is ever used to mean "still open". Reopen and re-decision append to the resolution log; they
  never rewrite the resolution they replace. A cap-archived item has no resolution to append:
  reopening it returns it to the live register with its content intact.
- **The dedupe key is identity for merging, never identity for the record.** The item id is the
  durable identity; the dedupe key only decides when two sightings are one item. This is why a
  resolved record and a later re-decision can share a key: they are two items with one topic, and
  read-back across them is by key, not by a pointer the schema would have to keep.
- **Tier is a policy field on one record, not a separate collection.** Confirmation is one write:
  candidate becomes structural, blocking becomes true, severity becomes 2, corrections apply,
  and a kind change rekeys the dedupe key in the same write. A candidate re-raise can therefore
  never demote or overwrite a confirmed item.
- **Merge precedence is a human resolution over a detector re-raise.** A user's answer is not
  undone by a fold re-reading an old artifact; the scan's evidence is kept as a suppressed
  occurrence so the record stays explainable. A detector closure is different: it has no human
  answer to protect, so the artifact's reappearance reopens the item. A tombstone protects
  itself against both.
- **Every ending names its actor and its evidence.** `answered`, `dismissed`, `superseded` and
  `detected-closed` are not interchangeable labels: they tell the user whether a human acted, a
  rule closed the loop, or a later event made it moot. The actor records who is accountable for
  the decision, and a detector closure carries the code that proves what happened.
- **Acknowledgement measures the work, not the user.** Three states are enough: no evidence yet,
  evidence (with its kind), and the window elapsed with none. A delivered answer with no
  acknowledgement is reported honestly and stays reopenable; the register never upgrades an
  unobserved delivery into a success claim.
- **Nothing about an item's history is silent.** Every transition appends an audit entry; every
  refusal names its code; a tombstone keeps the identity that proves the deletion. The vocabulary
  this adds is internal to the register and does not change the glossary.
- **The invariants become tests.** The closed vocabularies, the state/evidence agreement, the
  dedupe-merge identity, the merge precedence, the bounds and the refusals are all asserted as
  invariant tests rather than left to individual story tests.

### Deferred Decisions

- **Cross-session identity.** When two items in different sessions are "the same decision" is not
  decided; the register treats them as two items. The seam is the dedupe key containing the
  session id, so a future read-time grouping can be added without changing stored records.
- **A visible link from a re-decision to the earlier resolution.** The read-back exists through
  the shared dedupe key, but whether the user is shown "you answered this on …" from inside a
  later item is not decided. The seam is the key plus the occurrence evidence; adding a pointer
  later would be a new record shape, not a re-interpretation of this one.
- **The decay policy that fills `stale` and archives live items by age.** The state, the
  predicates and the retention rules that respect it are fixed here; the trigger policy is the
  retention spec's deferred decision. The seam is the live-state vocabulary plus the retention
  sweep.
- **Corrections after an exercised permission.** The register refuses reopen after an approval
  was exercised and says the honest action is a correction; what a correction is (a new item, a
  notice, or a reply variant) belongs to Answering & Delivery. The seam is the delivered-notice
  path and the item kind `approval`.

## Testing Strategy

- **Invariants first.** Closed vocabularies, state/evidence agreement, the dedupe-merge rule,
  merge precedence, the bounded lists and every refusal are asserted as invariant tests before
  story tests, because they are the rules that must hold for every story.
- **Behaviour through the published contract.** Tests go through the draft contract, the
  lifecycle transitions and the read model, one concept per test; no test reaches into a stored
  record to assert an internal shape. A fixture is a draft or a transition request, not a
  partially built record.
- **Fixtures are inline and complete.** Every scenario in this spec is reproducible with the data
  it carries; a test may share a fixture builder but not a hidden precondition.
- **Only boundaries are mocked:** the harness's session facts, the storage medium and the clock.
  The register's predicates and merge rules are the behaviour under test and are never mocked.
- **Time and identity are pinned.** The register's clock is injected and fixed; item ids are
  seeded from that clock, and no assertion depends on a random tail. Acceptance tests advance the
  clock by exact offsets rather than sleeping.
- **Refusals assert the name, not the wording.** A refusal is checked by its named code (invalid
  transition, conflict, not found, limit) and by the unchanged record on re-read; recovery copy is
  not part of the contract.
- **Determinism is a test, not a hope.** Every ordering this spec relies on is total, and the
  same fixture with the same clock produces the same record versions, the same history order and
  the same bounded-list contents.

## Out of Scope

- **Reply mechanics** — which delivery track a reply takes, settle versus record versus steer,
  wake confirmation, delivery state and failure codes. Answering & Delivery owns them; this spec
  owns only the transitions they command.
- **Detection and inference policy** — what may be inferred, how many candidates per turn or
  session, the prose gate's bounds, extraction and backfill. Capture owns them; this spec owns
  what a draft becomes once it arrives.
- **Persistence mechanics** — record validation, schema versions, compare-and-set mechanics,
  migration and the single-writer rule. Durability & Integrity owns them; this spec states the
  invariants those mechanics must preserve.
- **Presentation** of state, resolution, acknowledgement and history — sections, rows, glyphs,
  copy, filters, keyboard. Surfaces owns them.
- **The model-facing tool's wording and actions**, the nudge, the runtime-context line and
  consent. Model Contract & Consent owns them; the tool's raise and resolve result in drafts and
  transitions, not in a second item model.
- **Team-task actions** (complete, reassign) for the item kind `task`, and the liveness gate for
  raising team-task items. Capture's scope records both.
- **Any cross-session linking or decision journal beyond the register read** — the shape exists
  in the read model; a dedicated linkage feature is not in this spec.

## Open Questions

- **May promotion correct a candidate's kind outside the inferred families?** The register permits
  the full eight-kind vocabulary on promote; the inference side must say which kinds it may
  propose. Answer: Capture and the product owner.
- **Should a re-decision be presented as a continuation of the earlier item?** The data (shared
  dedupe key, occurrence evidence) supports it, the presentation decision is not made. Answer:
  Surfaces and the product owner.
- **Should the resolution log hold the delivery attempts of earlier resolutions as well as the
  resolutions?** The current split keeps deliveries on the record and resolutions in the log;
  a future read-back may need both. Answer: Answering & Delivery with Attention Register.
