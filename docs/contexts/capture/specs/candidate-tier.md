# Candidate tier — inferred items behind a confirmation gate

**Context(s):** Capture, with Attention Register owning the candidate tier's meaning and Surfaces
rendering it · **Date:** 2026-11-15

> Intent spec. It states what the capability is for and what it must do; it does not describe files,
> functions or snippets. The design packet and the code own mechanics.

## Definitions

These are the terms this spec relies on; their canonical senses are in
[UBIQUITOUS_LANGUAGE.md](../../../UBIQUITOUS_LANGUAGE.md) §4, refined here where this capability
uses them with extra conditions.

- **Inference** — producing an item from a turn's text or from plan state by a heuristic, rather
  than deriving it from a harness artifact. An inferred item is always a candidate unless promoted.
- **Candidate** — the tier of an inferred item: never counted as Needs you, never answerable as an
  item, and shown in the Candidates section with its evidence. A candidate is not a state, not a
  severity and not a confidence percentage.
- **Candidate gate** — the bounded policy that turns inference into candidates: what may be
  inferred, how many, how it is corrected, and when it closes.
- **Prose gate** — the specific gate over one turn's final assistant text.
- **Ask** — one item-shaped request inside that text ("should I use A or B?"). A batch of asks from
  one turn is the unit the gate bounds and closes together.
- **Section mode** — the precision-first detection mode: the message's last heading is an ask
  heading and the top-level list items under it are the asks.
- **Strict fallback** — the recall-preserving mode used when no trailing ask section is found: a
  long enough message whose final tail carries a question mark or a decision marker yields exactly
  one ask.
- **Batch** — one turn's set of inferred asks, treated as a unit for bounds and closure. A batch
  never supersedes its own members.
- **Supersession** — closure of a candidate because a later turn or user message made it moot. Not
  dismissal; it writes no suppressor.
- **Promote** — the user's confirmation that a candidate is a real item: one compare-and-set write
  that makes it structural.
- **Correction** — the optional patch applied during promotion that fixes the inferred kind, title,
  body, quote or options.
- **Suppress** — the user's "not an item" action on a candidate: it resolves the candidate as
  dismissed and writes an exact-key suppressor so the same inference cannot re-raise.
- **Suppressor** — a durable record that a dedupe-key prefix is not an item.
- **Todo aggregate** — the single candidate a session may carry for a plan it left unfinished.
- **Extraction** — the optional, consented model-assisted second opinion on a new live prose
  candidate; it may drop the candidate or refine its kind and title, never create one.
- **Quote** — the verbatim, markdown-clean excerpt that proves an item; for an inferred candidate
  it is the ask itself, bounded to 300 characters. Evidence, never a summary.
- **Dedupe key** — the stable key that decides when two sightings are one item. Two forms exist:
  the **authored form** (kind + session + normalised title) and the **artifact-keyed form**
  (kind + session + artifact id), used for every item whose existence rests on a committed log
  artifact — detected or inferred. A candidate's key is the artifact-keyed form.
- **Per-item artifact id** — the deterministic identity of one ask of one turn; it is the
  candidate's identity inside the session and supplies the artifact id of its artifact-keyed dedupe
  key. The artifact id encodes the turn and the ask.

## Constraints

1. **Only two kinds may be inferred.** The prose gate emits `decision` or `question` and never
   `approval`: permission delivery belongs to the declared/approval path. Go-ahead and permission
   asks ("want me to…", "should I proceed?") are `question` because they need a yes/no answer,
   unless they present explicit alternatives, in which case they are `decision`.
2. **Kind precedence.** Explicit alternatives first (`decision`), then a questions-like heading
   (`question`), then a decisions-like heading (`decision`), then an interrogative (`question`),
   otherwise `decision`. The inferred kind is a labelled guess, correctable at confirmation.
3. **The default is no candidate.** A message that does not prove an ask produces nothing. The
   fallback's bare `confirm`/`approve` marker counts only inside a question or an imperative
   request, so a declarative "the confirm guard is in place" is not an ask.
4. **The final visible text only.** The gate reads the turn's final assistant text (text blocks;
   reasoning and tool-call parts are ignored), strips fenced code blocks, treats a full-width
   question mark as a question mark, and keeps only a bounded line-bound tail of the raw text so
   structure survives.
5. **Bounds.** At most **5 candidates per turn** (further asks are counted, never invented) and at
   most **8 open prose candidates per session**. The session bound is batch-aware: after a batch
   opens, only the oldest open candidates *outside the current batch* are closed, until the bound
   holds. A batch never supersedes itself.
6. **Markdown-clean evidence.** The title is `"<label> — <first sentence>"` (first sentence alone
   when unlabelled), markdown markers removed, one line, bounded to 120 characters. The quote is the
   author's cleaned words, verbatim, bounded to 300 characters on a word boundary. The body states
   which of the turn's asks this is and asks the user to confirm it into an item. Nothing is
   summarised, invented or HTML-rendered.
7. **Identity is per ask and deterministic.** A candidate's artifact id carries the turn and a hash
   of the ask's cleaned text and label; duplicate identical asks in one turn take `~2`, `~3`… It is
   stable across replay, restart and a cold baseline, independent of the message head and of later
   item edits, and independent of the inferred kind (so a correction never forks the row).
8. **Options are never fabricated.** Options come only from explicit labelled alternatives (at most
   four, each bounded) or one clean "either A or B"; a yes/no question carries none. The reply
   descriptor offers option controls only when real options exist, always allows free text, and
   always requires confirmation.
9. **Candidates are never attention.** Candidate tier, severity 2, non-blocking for prose asks
   (severity 3 for the plan aggregate); the only path to attention is promotion.
10. **The preference gates prose raises only.** With prose candidates switched off, no new *prose*
    candidate is raised; the unfinished-plan aggregate is not governed by this preference and is
    always produced; every closure still passes, so an open candidate can never be stranded.
11. **The gate never fires twice for one turn.** A turn whose fold already raised a blocking
    structural item produces no candidate from its text; a replay of the same turn produces no
    second candidate.
12. **Supersession is not dismissal.** A later user message or turn start closes every prose
    candidate of an earlier turn with the supersession code and writes no suppressor. Only Suppress
    writes a suppressor.
13. **Promotion is one correction-and-confirmation write.** Promotion makes the item structural with
    the structural defaults (severity 2, blocking, a structural reply descriptor without a
    confirmation step), keeps its occurrence evidence, appends history, and applies an optional
    kind/title/body/quote/options correction in the same write. A kind change rekeys the
    artifact-keyed dedupe key and the exact-key suppressor follows the new key.
14. **Suppression is exact and remembered.** Suppress resolves the candidate as dismissed by the
    user and writes an exact-key suppressor keyed by the item's own dedupe key; the same inference
    cannot re-raise, and a plain dismiss of a structural item writes no suppressor. The only wider
    key is the migration of legacy pre-split suppressors, described under Migration and
    reconciliation closures.
15. **Extraction cannot change existence beyond dropping or refining.** One bounded, consented call
    per new **live** prose raise, over the turn's text tail only; it may drop the candidate or
    refine kind/title, never create, close, rekey or touch a closure or a historical candidate. Any
    failure, timeout, low confidence or missing permission keeps the gate's candidate unchanged.
16. **Determinism.** The gate is pure: the same text and turn produce the same asks, ids, titles,
    quotes, kinds and order. Extraction is the only non-deterministic participant and is contained:
    it can only drop one candidate it was given or refine its kind/title; the register after a failed
    extraction is identical to the gate-only state.

## Problem

The decisions that actually end long sessions are usually not structured artifacts. The agent
finishes a report and asks, in prose, "should I go with option A or B?" or "want me to implement
this?"; or it writes a plan, completes half of it and stops. None of that is an approval pair or an
unanswered tool call, so a capture that reads only committed artifacts sees nothing — and the user's
inbox is empty while real work waits.

Inferring from prose at full recall is the mirror failure. Decision words appear everywhere in a
long report; a permissive keyword scan flags most sessions and a large share of them falsely. A
register that guesses is worse than one that misses: it asks the user to triage the model's
speculations, and the failure mode this product exists to prevent — a forty-item inbox — is reached
from the other side.

## Solution

Two tiers, one gate. Inference is allowed, but only produces candidates — and a candidate is a
different kind of object from an item: it is shown with the exact sentence that raised it, it never
counts as Needs you, and it cannot be answered until the user says it is real.

The gate reads the turn's final assistant text in two additive modes:

- **Section mode** — when the message's last heading is an ask heading ("Decisions I need from
  you", "Open questions", "Your call", "Sign-off"), every top-level list item under it that reads
  as an ask becomes one candidate. Nested sub-bullets stay with their parent; non-ask bullets are
  dropped. This is where a single turn legitimately produces a handful of decisions.
- **Strict fallback** — when no trailing ask section exists but a long enough message ends on a
  question or carries a decision marker in its final tail, one candidate is emitted from the
  marker sentence. This preserves the recall of the single-ask gate; the two modes are additive, so
  adding section mode never costs a fallback hit.

The lifecycle makes the tier safe:

- **Confirm** — "It's an item" promotes the candidate into attention, with an optional correction
  of the inferred kind, title, body, quote or options in the same write. A corrected kind rekeys
  the identity and moves the suppressor, so a correction cannot leave a duplicate behind.
- **Suppress** — "Not an item" resolves the candidate as dismissed by the user and remembers the
  exact identity, so the same inference cannot come back.
- **Supersede** — when the user moves on (a later message or a later turn), the candidates of the
  earlier turn close as superseded. That is a closure of opportunity, not a judgement, so it is
  not a dismissal and writes no suppressor.
- **Bound** — a turn may contribute at most five asks; a session may hold at most eight open
  candidates. When a new batch would exceed the session bound, the oldest candidates from *other*
  turns close first; the batch that just arrived is never a casualty of its own arrival.

The plan aggregate is the second inferred family: when a session ends a turn with plan items
unfinished, it carries **one** candidate per session ("Plan left unfinished (N items)", kind
follow-up, severity 3) rather than one row per item — the plan is the unit of intent. It closes
only when a later plan write has nothing pending; a user message does not close it, because a plan
may legitimately span turns.

Outside the lifecycle, one-time and post-scan repairs close candidates the fold must not strand —
pre-split candidates retired at activation, a candidate duplicating an already-promoted item
reconciled after a scan, and rows from a family withdrawn from dispatch. They are store-side
closures, not lifecycle closers, and are specified under Design Decisions.

The extraction hand-off is a boundary, not a detector. When the user has consented and the
deployment has configured a model, one bounded one-shot call per new live prose candidate may drop
it or refine its kind and title. It cannot create an item, cannot close one, cannot run over
history, cannot change a closure — and if it fails, times out, is uncertain or is switched off, the
gate's candidate stands. Inference remains the gate's job; the model only gets a veto and a
correction.

## User Stories

1. As the user, I want the decisions the agent asked for in its final message to appear as
   candidates with the exact sentences, so I can confirm the real asks.
2. As the user, I want an unrecognised ask that ends a turn not to be lost, so a single-question
   message still surfaces.
3. As the user, I want candidates to never count as Needs you and never be answerable before I
   confirm, so inference cannot demand my attention.
4. As the user, I want to confirm a candidate and correct its inferred kind and title in one action,
   so the item is right the first time.
5. As the user, I want to reject a candidate once and never see that same inference again.
6. As the user, I want candidates I have moved past to close quietly instead of accumulating.
7. As the user, I want a turn's asks bounded so confirming five of them does not push out the rest
   of my candidates.
8. As the user, I want one row for a plan left unfinished rather than one per plan item.
9. As the user, I want turning prose candidates off to stop new inferences without stranding the
   ones already open.
10. As the user, I want the model-assisted second opinion to be unable to create, close or rekey an
    item, and to leave the gate's candidate when anything goes wrong.

## Acceptance Criteria

Fixtures are the turn's final assistant text, the fold's turn context and the candidate actions.
"Raised" means a draft with the candidate tier reached the register.

### Story 1 — Reading the turn

```
Given a turn's final message ends with the heading "## Decisions I need from you" whose list holds
  two real asks ("**A** — Use the existing queue", "**B** — Introduce a new queue"), a non-ask
  bullet "Context: the queue is busy", and a nested sub-bullet under "B"
When  the turn's turn/end is folded
Then  exactly two candidate drafts are raised, both kind decision, severity 2, blocking false,
  candidate tier, detector code "prose-gate:decision-request", titled with their labels and
  presenting no fabricated options; the non-ask bullet is dropped and the nested sub-bullet is not
  a separate candidate
```

```
Given a turn's final message is long, has no ask heading, and ends "Want me to proceed with the
  refactor?"
When  the turn's turn/end is folded
Then  one candidate question is raised, quoting "Want me to proceed with the refactor?"
```

```
Given a turn's final message ends with an ask heading and seven ask-like top-level items
When  the turn's turn/end is folded
Then  five candidates are raised and the two beyond the per-turn bound are counted, not invented
```

```
Given a turn's final message is long and ends "The confirm guard is in place."
When  the turn's turn/end is folded
Then  no candidate is raised
```

```
Given a turn's final message asks "Want me to implement (1) + (2)?"
When  the turn's turn/end is folded
Then  the candidate's kind is question — never approval
```

### Story 2 — Bounds and supersession

```
Given a session already holds eight open prose candidates from earlier turns
  (turns 1 to 4, two each)
When  a new turn ends with a batch of two candidates
Then  exactly eight prose candidates remain open, the two oldest candidates outside the new batch
  are closed with code "prose-gate:superseded-by-cap", and both members of the new batch stay open
```

```
Given a turn raised two candidates
When  a later user message is committed in the same session
Then  both candidates close with code "user/message:superseded", and no suppressor is written
```

### Story 3 — Confirmation, correction and suppression

```
Given a candidate for "B — Introduce a new queue" with kind decision, severity 2, blocking false
When  the user promotes it without a correction
Then  it becomes a structural decision, severity 2, blocking true, with a structural reply
  descriptor that requires no confirmation, and its history records the promotion
```

```
Given a candidate whose inferred kind is decision and whose title is "B — Introduce a new queue"
When  the user promotes it with kind question and title "Choose the queue approach"
Then  the item is structural with the corrected kind and title, its artifact-keyed dedupe key is
  rekeyed to the question identity, its history records promoted and reclassified, and a later
  inference of the same ask does not create a duplicate
```

```
Given a candidate raised from the turn's final message
When  the user suppresses it ("not an item")
Then  it resolves as dismissed with the user as the actor, an exact-key suppressor is written, and
  a replay of the same log raises no candidate for that ask
```

### Story 4 — The plan aggregate

```
Given a session's last todo write lists three unfinished plan items and its turn ends
When  the turn's turn/end is folded
Then  one candidate is raised, kind follow-up, severity 3, blocking false, titled
  "Plan left unfinished (3 items)", listing at most three labels in its body
```

```
Given the plan aggregate candidate is open
When  a later todo write completes the whole list
Then  the aggregate closes with code "todo/write:completed"
```

```
Given the plan aggregate candidate is open
When  a user message is committed without a completed plan write
Then  the aggregate stays open
```

### Story 5 — The extraction hand-off

```
Given two root sessions: in "s-1" extraction is switched on and the deployment configured, and the
  extractor returns {keep: false} for the new live prose candidate; in "s-2" extraction is
  switched off or unconfigured
When  the live drive folds those turns
Then  no candidate from "s-1" reaches the register, the gate's candidate from "s-2" reaches it
  unchanged, and no extraction call is made for "s-2"
```

## Design Decisions

- **Confirm before attention.** The candidate tier is the compromise that makes high-recall
  inference safe: recall is the gate's job, attention is the user's decision. (Cross-context
  decision: [ADR 004 — Confirm before attention](../../../adrs/004-confirm-before-attention.md).)
- **Additive, never a replacement.** Section mode adds multi-ask recall on top of the strict fallback;
  replacing the fallback would drop the single-ask cases it already catches.
- **The batch is the closure unit.** Supersession closes all asks of a turn because the user's next
  message is evidence about the turn, not about one item; the session bound closes only other
  turns' oldest rows so a batch never truncates itself.
- **Identity is per ask, not per turn.** One turn can legitimately contain several independent
  decisions; per-item ids keep their evidence and their corrections separate, while a cold baseline
  still emits every still-open ask.
- **The inferred kind is a guess with a repair path.** Confirming is the moment the user knows the
  truth, so correction rides the same compare-and-set write as promotion; the rekey keeps dedupe
  honest.
- **Suppression is exact; supersession is not a judgement.** Only "not an item" writes a durable
  suppressor. A closure because the user moved on must not teach the system to ignore that ask
  forever.
- **Suppressor scope is decided, not open.** A new suppression is exact-key by design: it
  suppresses exactly the inferred ask the user rejected, not a phrasing in general. The one wider
  key is the migration of legacy pre-split suppressors to the session-scoped per-kind prose prefix,
  which deliberately over-suppresses that session's other prose candidates of the kind because a
  dismissal quietly resurfacing is the worse failure. The widening is specified under Migration and
  reconciliation closures; nothing in the design generalises a live suppression.
- **The plan aggregate is one row per session, and it is not governed by the prose preference.**
  A whole-list plan write has no per-item identity; the plan is the unit of intent, and per-item rows
  would be noise. The prose-candidate preference gates the prose gate only; the aggregate is always
  produced, and every closure always passes.
- **Extraction is a veto and a correction, not a detector.** It is granted one call per new live
  prose raise so it can remove a false positive or improve a label without ever expanding what
  capture claims exists.

### Migration and reconciliation closures

Some candidates leave the open set because a stored identity changed or a product boundary moved,
not because the user or the lifecycle acted. These are store-side repairs, not lifecycle closers:
the retirement and reconciliation closures resolve a candidate as `detected-closed` under a named
code, the suppressor migration rewrites a suppressor instead. Each runs at a defined moment, is
idempotent, counted and logged, and is never fatal to activation.

- **`prose-gate:superseded-by-scope-change` — one-time retirement at activation.** Before the
  fold-version replay, a live candidate whose identity predates the per-item prose gate is retired,
  so an old single-ask candidate is not re-offered as if it were new. Promoted rows are structural
  and are preserved.
- **`prose-gate:duplicate-of-promoted` — reconciliation after each completed scan.** After a
  backfill pass, a live candidate that duplicates an already-promoted item from the same session
  and turn is closed, matched by ask identity (the normalised title, with the quote as secondary
  evidence) rather than by the turn alone. It must never close the unconfirmed siblings of a
  promoted multi-item turn; it closes only the candidate a replay would otherwise re-offer.
- **`team/task:alerts-disabled` — one-time retirement at activation.** Items raised by the
  team-task family before it was withdrawn from dispatch are retired with this audit code; the
  family's own closure rules are recorded in [structural capture](structural-capture.md) Out of
  Scope.
- **Legacy-suppressor migration.** At activation, a suppressor written as an exact pre-split prose
  key is widened to the session-scoped per-kind prefix of the artifact-keyed form (stored as
  `derived|<kind>|<session>|prose:`), so a dismissal of a heuristic candidate can never resurface
  after the gate's identity changed. The
  widening deliberately over-suppresses that session's later prose candidates of the kind — the
  safe direction, because a dismissal must never be undone by an identity migration. New
  suppressors stay exact-key.

Rules for all four: they never touch a promoted structural row or an item the user resolved; they
never run from the fold, so a replay cannot re-close anything; they are idempotent, so a second
activation is a no-op; and the closures record their code so the register can show why the item
left. The
register executes them; Durability & Integrity owns the migration mechanics, ordering and audit
([Durability & Integrity](../../durability/CONTEXT.md)), and this spec owns what each closure means.

### Deferred Decisions

- **Candidate expiry by time.** The design closes candidates by supersession, suppression, the
  session bound, or the migration and reconciliation closures above; a time-to-live is deliberately
  not defined. Seam: the supersession codes and the bound are the lifecycle closure paths, so a TTL
  could be added as another bounded closer.
- **A model-proposed item (a detector, rather than a second opinion).** Extraction may not create.
  Whether any model may ever *propose* a candidate is a consent question for
  [Model Contract & Consent](../../model-contract/CONTEXT.md); the seam is the extraction verdict's
  shape, which has no "create" outcome.
- **Bulk confirmation.** The Candidates section may let the user confirm several candidates in one
  review step. Whether a bulk action is one write per item or a batch contract is not decided;
  the seam is promotion's per-item compare-and-set write.

## Testing Strategy

- Gate tests over fixture assistant texts, one behaviour per case: section accept/reject anchors,
  the fallback's recall cases, kind precedence, option extraction, markdown projection,
  full-width punctuation, the per-turn bound and the duplicate-id suffixes. Assertions are on asks,
  ids, titles, quotes, kinds and options.
- Lifecycle tests through the fold and the candidate actions: raise at turn end, supersession,
  batch-aware session bound, replay idempotence, cold baseline emitting every still-open ask, and a
  log ending inside a turn still raising its asks.
- Action tests through the published candidate actions: promote (plain, corrected, kind-change
  rekey, suppressor follow, history), suppress (dismissed resolution plus exact-key suppressor,
  replay blocked), and the refusal paths (a structural item cannot be promoted or suppressed).
- Migration and reconciliation tests over a fixture register: a pre-split candidate retires exactly
  once; a promoted row survives both retirement and reconciliation; reconciliation closes the
  promoted duplicate and leaves the unconfirmed siblings of that turn live; the legacy suppressor
  widens to both kind prefixes; and a second activation is a no-op.
- Extraction tests with a fake extractor only (the model boundary is the mock): drop, refine,
  malformed verdict, low confidence, timeout, budget exhaustion, absent permission, and the
  assertion that a closure and a historical candidate are never extracted.
- Determinism: the gate is tested as a pure function with a fixed turn number; a replay test folds
  the same log twice and asserts identical ids and no second raise.
- Copy honesty: the Candidates surface copy says the check is a heuristic on the final message, may
  miss decisions, and that the kind is a correctable guess.

## Out of Scope

- **The item lifecycle the candidate enters on promotion** — Attention Register's.
- **How the Candidates section renders evidence, the inferred-kind badge and the controls** —
  Surfaces'.
- **The tool's declared surface, the consent record and the egress policy** — Model Contract &
  Consent's; this spec states only the hand-off the boundary must respect.
- **Structural detection and its closers** — [structural capture](structural-capture.md).
- **Backfill, rescan and hydration** — [historical capture](historical-capture.md); historical
  candidates are gate-only and never extracted.

## Open Questions

- **Should the plan aggregate be promoted at all?** Promotion makes it severity 2 and blocking — a
  confirmed plan left unfinished may be a follow-up rather than a demand for the user now.
  Answerable by the product owner, constrained by the register's severity semantics.
- **Should section-mode asks with no question mark but a labelled decision verb count** (for
  example "A — reuse the settled design")? The design accepts them as labelled decisions, on the
  theory that a decision list's members are asks; a stricter rule would trade recall for precision.
  Answerable by the Capture owner with corpus evidence.
- **What is the right session bound** (eight open prose candidates) as sessions grow longer? The
  bound is a product judgement; answerable by the product owner with measured candidate volume.
