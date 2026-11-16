# Persistence and migration

**Context(s):** Durability & Integrity · **Date:** 2026-11-15

> Intent spec. It states what the capability is for and what it must do; it does not describe
> files, functions or snippets. The design packet and the code own mechanics.

## Definitions

The canonical senses are in [UBIQUITOUS_LANGUAGE.md](../../../UBIQUITOUS_LANGUAGE.md); this spec
adds precise local senses where the durability contract needs them.

- **Store** — the host-side persistence mechanism holding the register's records. A mechanism, not
  the register itself.
- **Record** — one durable document in the closed vocabulary: an item record, a detection-cursor
  record, a suppressor record, or a meta row (install identity, the settings record, the backfill
  report).
- **Item record** — the record holding one item: its identity, kind, tier, severity, state,
  resolution, deliveries, occurrences, retention class, bounded audit history and compare-and-set
  version.
- **Detection-cursor record** — the record proving how far a bounded scan or fold has processed one
  session.
- **Suppressor record** — the durable "the user said this is not an item" row, matched by a dedupe
  key prefix.
- **Meta row** — one row of the shared meta table. The three shapes (install identity, the settings
  record, the backfill report) are told apart by their own required fields, not by a table per kind.
- **Install identity** — the durable id minted once per install and stamped as the `origin` of every
  record it writes.
- **Durable boundary** — the point at which a value is written or loaded: validation, size bounds,
  the version check and the write itself. Nothing unvalidated crosses it.
- **Validation** — the single, shared decision that a value is a well-formed record of its kind;
  pure and deterministic.
- **Quarantine** — renaming a corrupt legacy input (unparseable or schema-invalid) aside, byte for
  byte, so it is preserved and never overwritten, and activation continues without it.
- **Backup-and-skip** — the load rule for a record that fails validation: the platform backs the
  offending document up, the record is skipped, and the rest of the register opens.
- **Compare-and-set (CAS)** — a write carries the version the writer read; the write applies only if
  the stored version still matches, and the store re-checks inside its own atomic write. A mismatch
  is signalled internally as a typed failure and reported at the boundary as a refusal.
- **Conflict** — a compare-and-set mismatch. Internally it is a typed failure carrying the attempted
  and current versions; at the host/browser boundary it is reported with the stable `conflict` code
  and recovery copy, and the writer re-reads. The one write whose conflict is a value carrying the
  live record is the settings write.
- **Write version** — the record version a writer read before mutating it; a user-facing mutation
  must carry it.
- **Idempotency key (delivery id)** — the identity of one reply attempt, carried from the browser
  through the record and into the delivered message. One key is one attempt.
- **Dedupe key** — the stable stored identity of an item; one dedupe key is one item while it is
  live.
- **Record schema version** — the version of one record family's shape. A reader refuses a record
  newer than it knows, and it never reads an older record under the current shape: an explicit
  migration transforms it and writes it in the current shape, and a record with no such path is
  set aside. Every family carries its own version in-record; the identity probe reports the
  item-record family's value, and the browser does not act on it.
- **Domain format version** — the version of the durable vocabulary itself: the table set, the
  layout and the invalid-record policy of the store. Adding a row shape inside an existing table is
  not a format change; adding or rekeying a table is.
- **Wire protocol version** — the version of the request/response envelope and endpoint set between
  the host half and the browser half.
- **Identity probe** — the route request that answers with the install identity, the capability
  flags and all three versions, and never requires a session. The record-schema value it reports is
  the item-record family's; the settings record and the backfill report carry their own schema
  versions in-record.
- **Migration** — a bounded, idempotent, one-time transformation of durable state at activation:
  record upgrades that have an explicit migration path, the legacy document import, the retirement
  of false or superseded rows, suppressor widening, and reconciliation of replay duplicates.
- **Retirement** — closing a false or superseded row as detector-closed with a named reason, so the
  register explains why it closed instead of losing it silently.
- **Reconciliation** — the post-scan pass that closes a candidate a replay re-offered for an ask the
  user already confirmed.
- **Legacy document** — the earlier whole-register document imported once into the store; it is
  read only, and renamed aside after a complete import.
- **Replay** — a re-fold of a session's committed log after a capture-semantics change; the store's
  obligation is that it cannot churn, duplicate or undo authored state.
- **Live item** — an item in the `open`, `stale` or `snoozed` state.
- **Tombstone** — the record left by delete forever: the item resolved, its transcript-derived text
  replaced by a deletion marker, its identity and dedupe key kept.
- **Retention plan** — the pure, deterministic set of changes one retention action should make:
  acknowledgement windows elapsed, resolved items to move to the archived retention class, and
  archived resolutions to prune for the resolved-record cap. The raise path asks the same planner
  for live items to archive under the live cap; a sweep does not enforce the live cap.
- **Retention class** — `active` (a resolved item whose transcript-derived text is kept) or the
  **archived retention class** (text dropped, decision kept). Distinct from the archived item state,
  which is a live item moved out of the active register.
- **Live cap** — the cap on live items. It is enforced on the raise/append path: when the next
  raise would breach it, the excess live item is archived, never deleted. The retention sweep does
  not enforce it.
- **Resolved-record cap** — the cap on stored resolutions; excess prunes the oldest archived
  retention class rows. This is the canonical name.
- **Prune** — deleting an archived retention class row to satisfy the resolved-record cap. It is the
  only retention deletion.
- **Completeness flag** — the register's visible claim that older records were pruned, labelled
  `earlier records pruned` on the wire and in the UI, so a register that lost its oldest history
  says so instead of looking complete.
- **Backfill report** — the counts-only durable record of the last *completed* bounded scan.
- **Settings record** — the one versioned per-install preferences row; its defaults are served
  without materialising a row.
- **Single writer** — exactly one host instance owns an install's records; there is no
  cross-process lock and no guarantee for a second process.
- **Closure code** — the stable named reason recorded in a detector-closed resolution.
- **Activation** — the moment the host half starts for an install: it opens the store, ensures the
  install identity, runs the one-time migrations, then makes the register readable and writable.

## Constraints

- **Validation is pure and deterministic.** The same bytes produce the same record or the same named
  refusal; validation never reads the clock, the locale or the environment.
- **Records are replaced whole.** A write is a validated candidate replacing one stored document; no
  reader can observe a partially written record.
- **Timestamps are data.** All times are epoch-millisecond values from the single injected host
  clock; a record never stores a formatted date, never depends on a time zone, and a timestamp is
  never part of an item's identity.
- **Ordering is explicit.** Item ids are time-sortable; lists order by their own timestamp and then
  by item id; migrations process rows in id order; nothing observable depends on hash order or
  iteration order.
- **Bounded size.** Titles, bodies, quotes and options are capped, and per-record lists (audit
  history, delivery attempts, occurrences, earlier resolutions) are bounded; a caller cannot grow a
  record past its bound.
- **One concurrency rule.** Every mutation of existing state is a compare-and-set on the write
  version; a user-facing mutation without a version is refused, and a stale version is refused with
  the published conflict code and recovery copy while the caller re-reads. Only the settings write
  reports its conflict as a value carrying the live record.
- **One idempotency rule.** A delivery id identifies at most one attempt; a repeat returns the
  recorded attempt and never writes a second one.
- **Migration is bounded and idempotent.** A migration either completes or is retried; a second run
  changes nothing; the legacy input is renamed aside only after every record was accepted; a corrupt
  input is quarantined (renamed aside, never overwritten) and activation continues.
- **Only corruption is contained; I/O failure aborts activation.** A legacy document that cannot be
  parsed or validated is quarantined and reported, and activation continues with the store. An I/O
  failure — a read error other than "missing", or a failure to rename the input aside — is a named,
  reported failure that aborts activation with an explanation. It is never a silent success and
  never a half-migrated state: a run that did not complete leaves the import retryable from a
  consistent starting point.
- **No implicit upgrade.** A reader never reads an older record under the current shape: an older
  shape is transformed only by an explicit migration with a written path, and a record with no such
  path is set aside (backup-and-skip).
- **Replay runs after migration.** Retirements that would otherwise be re-offered by a replay run
  before capture re-folds a session; reconciliation runs after each completed scan.
- **Retention policy is computed, then checked again.** The plan is pure over a snapshot; each
  planned change is re-checked against the live record under compare-and-set, and a record that
  changed in the meantime is skipped rather than overwritten.
- **The live cap is an append-path rule.** It is applied when the next raise would breach it: the
  excess live item is archived, never deleted. The retention sweep does not enforce the live cap;
  the resolved-record cap and its prune are applied on both the append path and the sweep.
- **Reads do not invent writes.** The only durable effect a read may have is completing a transition
  already due (a snooze whose instant has passed), and that write goes through the same validated,
  version-checked path and is retried rather than thrown.
- **Time windows are numeric comparisons,** not calendar arithmetic: an elapsed window is
  `now − timestamp ≥ window`, evaluated once per plan.
- **Skew is stated, not guessed.** The identity probe reports the wire protocol version, the domain
  format version and the item-record family's schema version (the settings record and the backfill
  report carry their own schema versions in-record). The browser acts on the wire protocol and the
  domain format it must speak; it does not act on the record schema version, which is a host-side
  persistence concern. A participant that cannot honour a version it must speak degrades truthfully
  instead of misreading payloads or records.
- **No silent loss.** Every refused write, set-aside record, quarantine, retirement and prune has a
  named outcome that is audited or reported.

## Problem

A user's decision is worth more than the process that happens to hold it. Three failures keep that
decision from being safe:

- **Ordinary restarts.** A plugin process ends; the next one must serve exactly what the last one
  accepted — same items, same versions, same preferences, same last scan — or the user will not
  trust the register with a real decision.
- **Upgrades.** Record shapes, the durable vocabulary and the wire contract change at different rates.
  If an upgrade cannot transform old records safely, or cannot tell an old record from a future one,
  it either loses history or corrupts it. A migration that reruns on every activation, duplicates
  records, deletes a user's resolution or fails activation turns an upgrade into an incident. A
  replay after a detection change is especially dangerous: it can resurrect what a user answered or
  dismissed, demote what a user confirmed, or duplicate a raise.
- **Races.** The user answers from the page while the agent resolves the same item; two surfaces
  write at once; a lost response re-sends a reply. Without one concurrency rule the register
  silently loses one of the two writes and cannot say which. Without one idempotency rule a
  double-click becomes two attempts and a lost response becomes a duplicate message.

Meanwhile each context would be tempted to own its own record format and write path. That produces
drift: two answers to "what is a valid item", two notions of version, and corruption nobody owns.

## Solution

One store, one durable vocabulary, one write path. Every record is validated at the durable
boundary; every mutation of existing state is a compare-and-set whose loser is refused with a stable
code and recovers by re-reading — the settings write alone returns its conflict as a value carrying
the live record; every reply carries an idempotency key; every one-time change is an idempotent,
audited migration; every replay is subordinate to authored state; every deletion is explicit and
every retention action is either an archive or a reported prune.

Afterwards the user can rely on: the register is the same after a restart; a deletion stays deleted;
a race shows the current state instead of discarding a decision; a double send is one send; a broken
document loses at most itself; an upgrade transforms the old records it has an explicit migration
path for, sets the rest aside, and explains what it did; and the register never silently forgets. The domain can rely on: one place knows record formats, and the
three versions change independently.

## User Stories

1. As a user, I want my register to be exactly as I left it after a restart, so a process restart
   never costs me a decision.
2. As a user, I want my answer never silently discarded when the agent acts at the same time, so a
   race shows me what happened instead of losing my reply.
3. As a user, I want a repeated send to be the same send, so a lost response cannot create a second
   message or a second decision.
4. As a user, I want a damaged or unfamiliar stored document to lose at most itself, so one bad
   record cannot empty my register.
5. As a user, I want an upgrade to transform the old records it has a migration path for, set the
   rest aside safely, and tell me what it did, so history is kept and nothing is misread.
6. As a user, I want an interrupted upgrade to be retried safely, so a crash during migration cannot
   strand the install or duplicate my history.
7. As a user, I want a disabled or superseded detection rule to close its stale rows visibly, so
   they do not linger or vanish without explanation.
8. As a user, I want an upgrade never to undo what I already decided, so a replay cannot reopen my
   resolution or demote what I confirmed.
9. As a user, I want delete forever to be final, so nothing I erased comes back from retention or a
   later scan.
10. As a user, I want retention to compact and hide rather than delete, and to tell me when it had to
    prune, so the register never silently forgets.
11. As a plugin author, I want protocol skew detectable and harmless, so a newer browser half cannot
    misinterpret an older host half.
12. As an operator, I want a corrupt legacy document preserved and set aside, and an I/O failure to
    abort activation with an explanation, so an upgrade never destroys the only copy of old data and
    never serves a half-migrated register.

## Acceptance Criteria

These criteria are the definition of done. They change only by amending the spec.

### Story 1 — An install reopens as it was left

```
Given an install whose register holds three item records (one at version 4), two detection-cursor
      records, a written settings row and a completed backfill report
When  the host half closes the store and opens the same install again
Then  the three item records are served with the same ids and versions, the cursors still prove
      their scan coverage, the settings row is served as written, the backfill report is readable
      with counts only, and the install identity is unchanged
```

### Story 2 — Concurrent writers race without losing a decision

```
Given an item at version 7, read by both the page and the agent
When  the agent resolves it with write version 7 after the page's delete-forever with version 7 has
      already been accepted
Then  the agent's write is refused with the published conflict code and recovery copy, the caller
      re-reads the item and finds the tombstone at version 8, the tombstone is the only durable
      outcome, and no field of the item is written from the stale read
```

### Story 3 — A reply is recorded once

```
Given an item at version 3 and a reply already accepted under delivery id "d-1"
When  the same delivery id "d-1" is submitted again after a lost response
Then  the recorded attempt is returned, the item still holds exactly one delivery attempt for "d-1",
      no second message is sent, and the repeat does not advance the item's version
```

### Story 4 — Damaged or unfamiliar data never takes the register down

```
Given a store holding one valid item, one document whose required fields are missing and one
      document whose record schema version is newer than the reader knows, beside a legacy document
      holding one item written in an older record shape
When  the install activates
Then  the missing-fields and newer-version documents are backed up and skipped, the legacy item is
      transformed by the import and written as the current shape, the valid item is served, the
      register opens, and neither set-aside document is overwritten
```

### Story 5 — Versions change independently

```
Given a host speaking a wire protocol version the browser half does not recognise, while the host's
      domain format version is one both halves speak and the item-record schema version is one the
      host's reader understands
When  the browser half sends the identity probe
Then  the answer states the wire protocol version, the domain format version and the item-record
      family's schema version; the browser identifies only the protocol mismatch as skew and
      degrades truthfully, it does not act on the record-schema value, and no record is migrated or
      rewritten because the protocol differs
```

### Story 6 — One-time migrations are safe to interrupt

```
Given a legacy document holding three items, an activation that stopped after accepting two of them,
      and no completed migration report
When  the next activation runs the legacy import again
Then  all three items exist exactly once, the legacy document is renamed aside only after the third
      is accepted, and the report states how many records were imported and skipped
```

```
Given a legacy document that cannot be parsed or validated, beside a store that already holds one
      item
When  activation runs the legacy import
Then  the corrupt document is renamed aside as quarantined, its bytes are unchanged, the existing
      item is served untouched, and activation completes with the quarantine reported
```

```
Given a readable legacy document and an I/O failure while renaming it aside after the import
When  activation runs the legacy import
Then  activation aborts with a named, reported failure that explains the I/O fault and the preserved
      state; it is not a silent success, no half-migrated register is served, and the accepted
      records remain retryable without duplication
```

```
Given one open derived item from a disabled artifact family and one open item from a live family
When  activation runs the one-time retirement for the disabled family
Then  the false row is resolved as detected-closed with a named closure code visible in the
      register, the live item is untouched, and the run reports exactly one retirement
```

### Story 7 — Replay cannot undo a human decision

```
Given a resolved item whose recorded resolution names the user as actor, and a replay that
      re-emits the same artifact as a raise
When  the replay lands
Then  the item keeps its state and resolution, only its occurrence evidence is merged, and no
      human resolution is reopened
```

```
Given a promoted structural item for one ask, an unconfirmed sibling candidate from the same turn
      and session, and a replay that re-offers both
When  the post-scan reconciliation runs
Then  the promoted item is not demoted or re-keyed, the candidate duplicating the promoted ask is
      closed as detected-closed with a named closure code, and the sibling candidate stays live
```

### Story 8 — Delete forever is final

```
Given a resolved item the user deletes forever with its current write version
When  the write is accepted
Then  the record becomes a tombstone: its title and body are the deletion marker and empty, its
      delivery attempts and resolution log are gone, its identity and dedupe key are kept, it is
      absent from lists, counts and exports, it is not a resolution, and its version advanced once
```

```
Given the tombstone left by delete forever
When  capture folds the same artifact again
Then  no item is raised or reopened, and the tombstone is unchanged
```

### Story 9 — Retention is applied through the same write rule

```
Given a resolved item older than the active window, archived retention class rows beyond the
      resolved-record cap, and one tombstone
When  one retention sweep runs
Then  the resolved item moves to the archived retention class with its transcript-derived text
      dropped and its decision kept, the oldest archived rows are pruned and the completeness flag
      is set, no live item is archived by the sweep, and the tombstone is unchanged
```

```
Given a live item set at the live cap
When  the next raise would add one more live item
Then  the raise archives the excess live item — not deletes it — and the new item is written, so the
      live cap is enforced on the append path
```

### Story 10 — Preferences and the report share durable rows without interfering

```
Given a settings row at version 2 and a completed backfill report, and a settings write that
      carries expected version 1
When  the settings write is submitted
Then  the write returns a conflict value carrying the live settings at version 2, no preference
      field changes, no exception escapes the durable boundary, and the backfill report is untouched
```

## Design Decisions

- **The durable vocabulary is closed and table-shaped.** Four record kinds — items, cursors,
  suppressors and meta rows. Adding a record kind or a table is a domain format change; adding a row
  shape inside the existing meta table is not. That is why the settings record and the backfill
  report are meta rows distinguished by their own fields: an existing install keeps opening without
  a domain migration.
- **One validator defines "a valid record".** Validation runs identically at write, at load and in
  migration, so there is no second opinion about what a record is. The record families carry their
  own schema version because they evolve at different rates.
- **Every raised item is a durable record.** A derived item is not cache-only state: once a fold
  raises it, the item record is written through the same validated, version-checked path as an
  authored one, carries its human outcomes, and survives restart. What is rebuildable and
  checkpointed is Capture's per-session fold ledger and detection checkpoint, not the register's
  item records.
- **The three versions, each with its own rule and its own failure behaviour.** They are never
  inferred from one another and never bumped together for convenience
  ([ADR 001](../adrs/001-three-independent-versions.md)):

  | Version | Changes when | Bump rule | Failure behaviour |
  |---|---|---|---|
  | **Record schema version** — one record family's shape | A required field is added or removed, a field's meaning or type changes, or a stored value can no longer be read the same way | One bump per affected record family; a purely additive optional field with a documented default does not need one | A reader refuses a newer record (backed up and skipped, never coerced or downgraded); an older record is never read under the wrong shape — an explicit migration transforms it and writes it as the current shape, and a record with no such path is set aside |
  | **Domain format version** — the durable vocabulary: table set, layout, keying, invalid-record policy | A table is added, removed or rekeyed, or the store's layout or invalid-record policy changes | Only when the format itself changes; a new row shape inside an existing table does not | The store must be opened at the version it was written with; a store written by a newer format is refused rather than reinterpreted as the old one, and the install says so instead of guessing |
  | **Wire protocol version** — the envelope and endpoint set between the halves | The envelope, an endpoint's meaning or a payload field changes in a way an existing peer cannot honour | Only breaking changes; additive capability is advertised and feature-detected instead | The identity probe states the version; a peer that cannot honour it degrades truthfully (says so, retries, refuses the action) and never misreads a payload — the durable records are untouched |
- **Backup-and-skip, not fail-fast.** A record that cannot be understood loses only itself; the
  platform preserves the offending document and the register opens with the rest. Corrupt data is a
  fact to contain, not a reason to disable the feature.
- **Refusals cross the boundary as values, not exceptions.** Inside the host a refused transition is
  a typed failure; the boundary converts it into the published result — an error envelope with a
  stable code and recovery copy for an item transition, and a conflict value carrying the live
  record for the settings write. The caller recovers by re-reading. No caller retries a stale write
  as if it were new, and no internally generated write (detector, retry, retention) may overwrite a
  user's write.
- **The delivery id is the identity of an attempt, not of its content.** A repeated id returns the
  recorded attempt; a new id is a new attempt. The id also rides the delivered message's source, so a
  duplicate send is detectable across the store and the transcript.
- **Migration is a bounded, named list of one-time steps.** Each step is idempotent, counted and
  audited; retirements close rows as detector-closed with a closure code instead of deleting them;
  the legacy document is renamed aside only after a complete import; a corrupt input is quarantined.
  An I/O failure is a named, reported failure that aborts activation and leaves no half-migrated
  state. Only explicit migrations exist: an older shape with no written migration path is set aside,
  never read under the current shape.
- **Replay is always subordinate to authored state.** Where a re-fold would contradict a human
  resolution or a promoted item, the replay merges evidence only; a replay that re-offers an already
  confirmed ask is closed as a duplicate only when the ask identity matches, so a partially
  confirmed multi-ask turn keeps its unconfirmed siblings live.
- **Tombstones are records, not deletions.** Keeping the row is what makes the deletion final: the
  identity still answers dedupe, so a later fold cannot re-raise the artifact, and the row is outside
  the register, its counts, its exports, its retention plan and its caps.
- **Retention is plan-then-check.** The plan is a pure function of a record snapshot so the awkward
  boundaries are testable; each planned change is re-validated against the live record under
  compare-and-set, so a concurrent user action always wins. The plan never deletes except pruning
  the archived retention class past the resolved-record cap, and pruning always sets the
  completeness flag. The live cap is not part of the sweep plan: it is applied when a raise would breach it, so
  live items are archived on the append path and never deleted.
- **The single writer is a stated assumption, not an enforcement claim.** All writes go through one
  persistence contract on one host instance; the design does not pretend to lock another process
  out, and nothing in the product may claim cross-process safety.
- **The three versions are reported, not inferred.** The identity probe is the one place a
  participant can see all three and decide whether it can proceed; no participant may derive one
  version from another or from a package version. The probe's record-schema value is the item-record
  family's (other families version themselves in-record); the browser acts on the wire protocol and
  domain format it must speak, and the record schema version is a host-side concern it does not act
  on.

### Deferred Decisions

- **A general migration framework.** Migrations are a bounded named list executed once at
  activation, not a versioned transform registry. The seam: each step is an idempotent, audited
  transformation with a report, so a registry could be added without changing the store contract.
- **The bump rule for a purely additive optional field.** A record family carries its own schema
  version and an absent optional field means its default; whether such a field ever deserves a bump
  is not yet a written rule. The seam: the per-family version and the default rule.
- **A backend other than the host's per-record storage.** The record vocabulary and the durable
  boundary are backend-neutral; a second backend (indexed, SQL, remote) is not designed. The seam:
  the persistence contract every writer already goes through.
- **Surfacing skipped records to the user.** Backup-and-skip is honest in the operator log; whether
  the product should tell the user that a document was set aside is a Surfaces decision. The seam:
  the migration and load reports that already count skips and quarantines.
- **How much migration history to keep.** Migration reports are counted and logged; whether past
  runs need a durable audit list is undecided. The seam: the same audit vocabulary the record
  history uses.

## Testing Strategy

- **Order of coverage.** Restart round-trip first (nothing else is meaningful if reopening loses
  state), then the CAS race, then idempotency, then the durable-boundary matrix (valid, missing
  field, wrong type, older version with a migration path, older version with none, newer version),
  then migration interruption and rerun, then replay precedence and reconciliation, then tombstone,
  the sweep's resolved-record cap and prune, the raise-path live cap, then settings and the report.
- **Behavioural, through the public contract.** Tests exercise the store and the route as a caller
  would — write, refusal, conflict, reopened store — not private maps or write ordering. One concept
  per test; a table test is appropriate for the version matrix and for retention boundaries.
- **Only system boundaries are mocked.** The storage platform (a deterministic in-memory document
  backend), the clock and the logger. Validators, migration steps and the retention planner are
  production code under test, never mocked.
- **Determinism.** The clock is injected and pinned; item ids come from a deterministic id seam in
  tests so ordering assertions are stable; migrations and plans iterate in id order; timestamps are
  fixed fixture values; assertions compare records and final state, not intermediate console output.
  A test that needs two writers interleaved uses an explicit step barrier, never a sleep.
- **Failure injection.** A crash between import and rename, a corrupt document, an I/O failure while
  reading or renaming the legacy input, a newer-version document, a conflict after a plan is
  computed, and a failed scan pass are each exercised directly. The suite asserts that corruption is
  contained and activation continues, that an I/O failure aborts activation with a named report and
  no half-migrated state, and that no record is duplicated or overwritten on retry.
- **The two retention paths are tested where they exist.** The resolved-record cap and prune are
  exercised on both the append path and the sweep, with the same expected result; the live cap is
  exercised on the raise path only, and a sweep is asserted to leave live items untouched.
- **Invariant checks after every mutating test.** No record exceeds its bounds; every item's lists
  respect their caps; every resolved record has its resolution and resolved time; every awaiting
  record has its acknowledgement; a tombstone appears in no read result.
- **Boundary guards.** The session-log guard suite and the build-time bundle check are part of this
  spec's definition of done; see [session-log integrity](session-log-integrity.md).

## Out of Scope

- **Cross-process locking, leases and multi-host ownership.** The single-writer rule is an
  assumption, not a wish. A second process writing one install's records is outside the contract;
  if a second owner is ever wanted it needs an owner epoch or lease at the store boundary and a
  migration of every write path. Recorded in [CONTEXT_MAP.md](../../../CONTEXT_MAP.md) as deferred
  and here as excluded by assumption.
- **Decay policy.** Which items become `stale` and when an untouched item is archived is the
  Attention Register's retention policy; this spec only applies a published plan through
  compare-and-set.
- **The meaning of the settings and of the backfill pass.** Defaults, consent and egress belong to
  Model Contract & Consent; eligibility, scanning and counts belong to Capture. This spec owns their
  durability only.
- **The route's business semantics and the item lifecycle.** Endpoints, payloads, failure copy and
  the legality of a transition are owned elsewhere; here they appear only as the versioned envelope
  and as named refusals at the boundary.
- **Operator backup and restore of the store directory.** Documented as operator procedure; this
  spec guarantees only what survives a restart of a healthy store.
- **The session log.** Harness-owned and read-only to the domain; the constraint is specified in
  [session-log integrity](session-log-integrity.md).

## Open Questions

- **Should set-aside records be visible to the user?** Backup-and-skip is honest to the operator; if
  a document is silently missing from the register, is that a "degrade truthfully" case for
  Surfaces? Who can answer: the Surfaces owner, with the Lead.
- **Is a migration report durable history or an activation log?** Counts are reported at activation;
  whether an install should keep the last N migration reports durably is undecided. Who can answer:
  the Lead, as it changes the durable vocabulary.
- **What is the record-schema bump rule for adding an optional field?** A written rule would remove
  a recurring judgement call. Who can answer: the schema owner, once a second additive change is
  proposed.
