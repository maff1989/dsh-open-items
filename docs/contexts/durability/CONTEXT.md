# Durability & Integrity — context

**Kind:** generic · **Date:** 2026-11-15

## Purpose

The register exists so that a decision the user made is still there tomorrow — after a restart,
after an upgrade, and after a race between the agent and the page. This context exists to answer
one question, in the user's terms: **how does the register survive restarts, upgrades and races —
and how does the plugin avoid corrupting the harness?**

It is the domain's persistence authority: everything another context decides about an item, a
cursor, a preference or a backfill report becomes durable only through the contract published
here, and no writer holds its own copy of a record format. It also owns the one hard boundary that
runs the other way — the plugin reads the session log and never writes it, because a write there
would make the user's own conversations fail to restore. The user never meets this context; they
meet its evidence: answers are still there, a deletion stays deleted, a lost race says so instead
of losing the decision, and installing the plugin never makes a chat unopenable.

## Position in the map

Durability & Integrity sits underneath every context as the **persistence authority**. The map
records the relationship as *all writers → published persistence contract*: the Attention Register
(item records), Capture (detection cursors and the writes its drafts cause), Answering & Delivery
(delivery attempts and resolutions), Surfaces (settings writes) and Model Contract & Consent (the
settings record) all go through it. See [CONTEXT_MAP.md](../../CONTEXT_MAP.md).

- **Storage platform → Durability & Integrity — conformist.** The host's per-record storage
  facility supplies documents, load-time validation and backup; this context adapts its record
  vocabulary to it and never assumes an index, a join or a cross-table transaction.
- **Durability & Integrity → every writer — published persistence contract.** One place knows
  record formats, write mechanics, versions and migration; a writer sends a validated intent or
  record and receives acceptance or a named refusal. Only the settings write returns a conflict
  value carrying the live record; every other refused write is reported with a stable code and
  recovery copy, and the writer re-reads.
- **DSH harness → the domain — read-only conformance.** The session log and its restore validator
  are the harness's; this context carries the argument that the domain may read them and must never
  write them, and the obligations that keep that true across upgrades
  ([session-log integrity](specs/session-log-integrity.md)).
- **Host half only.** The store is host-side; the browser half holds no durable state. It reads
  through the read model and writes only by sending intents, which cross this context on the host.

## What this context owns

- **The store and the durable vocabulary.** One record per document; item records, detection-cursor
  records, suppressor records and the meta rows for install identity, the settings record and the
  backfill report. Adding a record kind or a table is this context's decision. Every raised item —
  derived or authored — is an ordinary durable record in the item table once raised; the
  rebuildable, checkpointed layer is Capture's per-session fold ledger and detection checkpoint,
  not the register's item records.
- **The three independent versions.** The record schema version (per record family — the identity
  probe reports the item-record family's value, while the settings record and the backfill report
  carry their own versions in-record), the domain format version (the durable vocabulary's tables)
  and the wire protocol version (the envelope between the halves), each with its own bump rule and
  compatibility obligation. The browser acts on the wire protocol and domain format it must speak;
  it does not act on the record schema version, which is a host-side persistence concern
  ([ADR 001](adrs/001-three-independent-versions.md)).
- **The durable boundary.** Validation and normalisation of everything that becomes durable, the
  bounded size of a record, and quarantine/backup-and-skip for a document that is corrupt or of an
  unknown shape; an I/O failure is reported and aborts activation instead of being contained.
- **Compare-and-set.** Every mutation of existing state carries the version the writer read; a
  mismatch is a refusal, never a lost update. Internally the store may signal it as a typed failure;
  the boundary converts it into the published refusal — a stable code and recovery copy — and the
  caller re-reads. The one conflict that carries the live record is the settings write.
- **Migration.** The bounded, idempotent, audited, one-time transformations run at activation:
  record upgrades that have an explicit migration path, the legacy document import, the one-time
  retirements of false or superseded rows, suppressor widening, and reconciliation of replay
  duplicates. A corrupt legacy document is quarantined and activation continues; an I/O failure is
  reported and aborts activation, so a half-migrated register is never served.
- **Tombstone mechanics.** What delete forever keeps, drops and excludes; why a tombstone is not a
  resolution.
- **Retention mechanics.** Applying the register's published retention policy through the same
  compare-and-set path: the acknowledgement-window resolution, the active-to-archived retention
  class move, cap pruning with its completeness flag (`earlier records pruned`), and the live cap —
  enforced on the raise path, where a breach archives the excess live item but never deletes. The
  retention sweep does not enforce the live cap.
- **The single-writer rule.** Exactly one host instance owns an install's records; the design makes
  no promise about a second process and does not pretend to.
- **The no-session-log-writes constraint** and the obligations — and boundary guards — that keep it
  true.

## What this context does not own

- **The item and its lifecycle** — kinds, tier, severity, blocking, state, resolution, reopen,
  identity, dedupe, retention *policy* and the Needs-you predicate — belong to
  [Attention Register](../attention-register/CONTEXT.md). This context guarantees a write is
  atomic, validated and version-checked; it does not decide whether a transition is legal.
- **What a record means** — evidence, quotes, detection sources and draft semantics — belongs to
  [Capture](../capture/CONTEXT.md); this context persists cursors and the records drafts cause
  without interpreting them.
- **Delivery semantics and what may be claimed** — tracks, evidence, failure codes and
  acknowledgement — belong to [Answering & Delivery](../answering/CONTEXT.md); this context stores
  delivery attempts inside the item record and guarantees their append-only boundedness.
- **The settings record's meaning** — each preference, its default, consent and egress — belongs to
  [Model Contract & Consent](../model-contract/CONTEXT.md); this context owns its durability only.
- **The backfill pass** — eligibility, scanning and counts belong to Capture; this context owns that
  the completed report survives a restart and carries counts only.
- **The route's business behaviour and its presentation** — endpoints, payloads, security, copy and
  retry affordances belong to the publishing half and [Surfaces](../surfaces/CONTEXT.md); this
  context owns the wire protocol *version* and its compatibility rule.
- **The session log and its format** — harness-owned. The domain reads; it never writes.

## Invariants

1. **No unvalidated record becomes durable.** Every record passes the same validator at the
   durable boundary; a document that fails is backed up and skipped, never loaded and never
   overwritten, and the register still opens. *Prevents:* a hand-edited, truncated or future-shaped
   document from silently becoming domain state — or taking the whole feature down.
2. **Every accepted write is validated, version-checked and atomic per record.** A record is
   replaced whole by a checked candidate, so readers never observe half a write. *Prevents:* two
   contexts disagreeing about what was stored.
3. **A write carries the version it read; a mismatch is refused.** The losing writer gets the
   published conflict refusal — a stable code with recovery copy — and re-reads the current state;
   it is never silently overwritten and never shown a stale success. *Prevents:* the agent's
   resolve and the user's answer losing each other, and any last-writer-wins outcome for a human
   decision.
4. **A refusal is a named outcome, never a crash and never a silent success.** Missing version,
   stale version, illegal transition, invalid draft, reached cap: each is reported with a stable
   code, a recovery, and — where the state moved — the fact that the caller must re-read.
   *Prevents:* the product inventing state, and a bad write taking the feature down.
5. **A reader never guesses a shape it does not know.** A record whose schema version is newer than
   the reader is refused and set aside, never coerced or downgraded. An older shape is never read
   under the current one: an explicit migration transforms it and writes it in the current shape,
   and a record with no such migration path is set aside rather than guessed at. *Prevents:* a
   future record being read as if its fields still meant the old thing.
6. **The three versions are independent.** Each changes only when its own contract changes, and no
   version may be inferred from another. Each is acted on by the half that must honour it: the
   browser on the wire protocol and domain format, the host on the record schema version — and the
   probe's record-schema value is the item-record family's, not every family's
   ([ADR 001](adrs/001-three-independent-versions.md)). *Prevents:* a wire change forcing a data
   migration, and an additive data change silently breaking a client.
7. **Migration is bounded, idempotent, one-time, and fatal only to its own activation when the
   environment fails.** A migration either completes or is retried; running it again changes
   nothing; a crash mid-import cannot duplicate a record. A corrupt legacy document is quarantined
   and never overwritten, and activation continues. An I/O failure — a read error other than
   "missing", or a rename/quarantine failure — is reported and aborts activation with an
   explanation, never a silent success and never a half-migrated register. *Prevents:* an upgrade
   losing data, multiplying history, or serving a register that was only partly migrated.
8. **Migration never deletes a user-authored record and never hides a closure.** A retirement
   closes a false or superseded row as detector-closed with a named reason the register can show; it is
   not a silent disappearance. *Prevents:* the register quietly forgetting what it used to hold.
9. **Replay cannot undo a human decision.** A re-fold must not reopen a human resolution,
   demote a promoted item, duplicate a raise, or bump a version without cause; where a replay
   contradicts authored state, the authored state wins and only evidence is merged. *Prevents:* a
   plugin upgrade changing what the user already decided.
10. **Delete forever is final.** A tombstone is kept as a record, excluded from every read surface,
    count and export, exempt from retention and caps, and cannot be re-raised by a later fold; it
    is not a resolution. *Prevents:* a fold, a cap or an import resurrecting a decision the user
    erased.
11. **Retention never deletes by decay.** The only deletions are an explicit delete forever and
    pruning of the archived retention class past the resolved-record cap; caps archive and always
    say when rows were pruned. *Prevents:* a quiet graveyard, and a register that cannot tell the
    user its history is incomplete.
12. **The plugin never writes the session log.** No plugin-owned event type, no declaration
    merging, no ignorable plugin record; a session that used the plugin restores whether the plugin
    is installed or not. *Prevents:* the product corrupting the user's chat history — the worst
    failure it could cause.
13. **Exactly one host instance owns an install's records.** There is no cross-process lock and the
    durability story is the single writer's; a second process is outside the contract. *Prevents:*
    claiming protection the design does not provide.
14. **Restart is not a reset.** Reopening an install yields the same records, the same install
    identity, the settings last written (or the documented defaults when none were) and the last
    completed backfill report. *Prevents:* a restart silently changing what the user sees.

## Inbound contracts

| From | What this context needs | Guarantee | When it is missing |
|---|---|---|---|
| Every writer — Attention Register, Capture, Answering & Delivery, Model Contract & Consent | A validated intent or record in the closed vocabulary; the version read for a mutation of existing state; a delivery id where a reply is recorded; timestamps from the host clock | No writer holds its own record format; a read that precedes a write is a versioned read | The write is refused with a named reason and nothing durable changes; a stale version is refused with the published conflict code and the writer re-reads |
| Storage platform — the host's per-record facility | One document per record, a load-time validation hook, a backup of a document that fails validation, durable replacement, open/close lifecycle | Whole-document replacement; no cross-table transaction; durable across process restarts | The capability that needs the missing guarantee is refused or degraded honestly; persistence is never simulated |
| DSH harness — session log and restore format | Committed events read-only; the restore validator's rule for unknown event types | The log, its format and its allow-list are the harness's, not ours to extend | Capture cannot read the log; the store is unaffected. There is no write-path fallback |
| Host process — clock | One epoch-millisecond clock for timestamps and windows | The clock is injectable so tests are deterministic | Times and retention windows are supplied by the host; the store does not invent a second clock |
| Install configuration | Caps, windows, install identity and the optional legacy document location | Documented defaults when a value is absent | Documented defaults apply; nothing else degrades |
| Migration sources | An optional legacy document and the record shapes it may carry | Reading it never mutates it; absence is normal | No import runs; that is not an error and nothing is reported as one |
| Model Contract & Consent — settings contract | The meaning, defaults and consent rule of the settings record | Defaults are served without materialising a row | Documented defaults are served; no write is invented |

## Outbound contracts

**Persistence contract (published to every writer).** The record vocabulary — item records,
detection-cursor records, suppressor records and meta rows for install identity, the settings
record and the backfill report — with the validation and normalisation bounds that keep each record
bounded, the durable-boundary rule, compare-and-set, the named refusals with their stable codes and
recovery copy, migration guarantees, tombstone rules and the three versions. The guarantee: an accepted write is durable, validated and
version-stamped, and a read after acceptance sees it. Stability: the contract changes only by the
version whose concern changed ([ADR 001](adrs/001-three-independent-versions.md)).

**Concurrency contract.** Every mutation of existing state is a compare-and-set on the version the
writer read. A mismatch is a refusal, not a lost update: internally a typed failure, and at the
host/browser boundary the published `conflict` code with recovery copy, so the writer re-reads and
re-decides. The one conflict returned as a value carrying the live record is the settings write; a
duplicate delivery id returns the recorded attempt instead of writing again. This is the only
concurrency rule in the domain; no caller may retry a stale write as if it were new.

**Settings and backfill-report durability.** The settings record is one versioned row per install;
reading serves the defaults without materialising a row, and a write is a compare-and-set patch
whose conflict is a value. The backfill report is one counts-only row describing the last
*completed* pass; it survives a restart, and a pass that failed writes none. Both share the meta
rows, so adding either is not a domain format change.

**Durability of the capture checkpoint.** Detection cursors survive restarts, so a replay or rescan
resumes from a proof of coverage rather than from the beginning; the record's meaning is Capture's,
its durability and validation are this context's guarantee. What is rebuildable is the per-session
fold ledger and checkpoint behind that cursor: every item a fold raises becomes an ordinary durable
record, so losing the fold state cannot lose an item or a human outcome on it.

**Read-model revision.** Every accepted durable mutation advances the process revision a surface
reads, so a stale client is detectable and cheap to correct; a successful write is never followed by
a read that pretends it did not happen.

**The no-session-log-writes guarantee.** The whole domain, and the user, may rely on the plugin
never having written a session-log event: not while installed, not after uninstall, not for an
audit trail. The argument and its guards are [session-log integrity](specs/session-log-integrity.md)
and [ADR 002](../../adrs/002-no-session-log-writes.md); the operator-facing statement is
[session-log-policy.md](../../session-log-policy.md).

**Migration audit.** What a migration did — records imported, skipped, quarantined, retired,
reconciled — is reported and audited; a one-time transformation that changed durable state is never
silent. An I/O failure is reported as a failure that aborted activation, with the preserved state
explained; it is never swallowed.

## Key concepts

The canonical senses are in [UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md) §8 and §5; this
context uses them as follows.

- **Store / record** — the host-side persistence mechanism, and one durable document in the closed
  vocabulary. The store is a mechanism; the register is the domain memory it holds. Every raised
  item, derived or authored, is one of those records; only Capture's fold ledger is rebuildable
  state.
- **Durable boundary** *(local term)* — the moment a value is written or loaded: validation, size
  bounds, the version check and the write happen there, so no unvalidated value ever becomes state.
- **Quarantine / backup-and-skip** *(local terms)* — what happens to data that cannot be
  understood: the offending document is backed up or the corrupt legacy file is renamed aside, the
  rest opens, and nothing is overwritten. An I/O failure is not contained this way — it is reported
  and aborts activation.
- **Meta row** — one row of the shared meta table; the three shapes are dispatched by their own
  fields, which is what lets a new metadata shape arrive without a new table or a domain version.
- **Install identity** *(local term)* — the durable id minted once per install and stamped on every
  record as its origin.
- **Compare-and-set (CAS) / conflict** — a write carries the version it read; a mismatch is a
  refusal with a stable code and recovery copy so the writer re-reads, never a lost update. A
  conflict returned as a value carrying the live record belongs to the settings write only.
- **Record schema version / domain format version / wire protocol version** — the shape of one
  record family (per family; the probe reports the item family's value); the table set and layout of
  the durable vocabulary; the envelope between host and browser. Three promises, three bump rules,
  no inference between them; the browser acts on the protocol and domain format only, and the record
  schema version is host-side.
- **Migration / retirement** — a bounded one-time transformation at activation; the closure of a
  false or superseded row as detector-closed with a named reason.
- **Replay** *(Capture's term, used here for the store's obligation)* — a re-fold after a detection
  change; it must not churn, duplicate or reopen what the store already recorded.
- **Tombstone** — the record left by delete forever; kept, stripped, excluded everywhere, not a
  resolution, never archived, pruned or re-raised.
- **Retention / live cap / resolved-record cap / prune** — the register's policy plan and its
  durable application here: the acknowledgement window, the active-to-archived retention class
  move, pruning of the archived retention class with its completeness flag (`earlier records
  pruned`), and the live cap applied when a raise breaches it (archive, never delete).
- **Backfill report / settings record** — the counts-only record of the last completed scan, and the
  one versioned preferences row; the first is Capture's state, the second Model Contract's meaning —
  both are this context's durability.
- **Single writer** — exactly one host instance owns an install's records; no cross-process lock and
  no promise about a second writer.
- **Session log** — the harness's durable per-session event log: read-only to the whole domain, and
  the reason for this context's integrity role.

## Design decisions in force

- [ADR 001 — Three independent versions](adrs/001-three-independent-versions.md): the record, the
  domain format and the wire protocol version separately; the identity probe reports all three.
- [ADR 002 — The plugin never writes the session log](../../adrs/002-no-session-log-writes.md): the
  constraint and its rationale.
- [ADR 003 — Separate detection state from the register; merge one view](../../adrs/003-three-storage-layers.md):
  the per-session detection ledger is rebuildable and checkpointed; every raised item — derived or
  authored — is a durable register record carrying its origin and user outcomes; in-flight asks are
  observed only; and one read view merges them with one identity and one revision.
- [ADR 001 — Compose published seams; never fork the harness](../../adrs/001-compose-published-seams.md):
  why no in-tree fork can be assumed as the compatibility story.
- Spec decisions a reader must know: durable-boundary validation and backup-and-skip, the
  settings-write conflict value and the named transition refusals, migration ordering and
  idempotence, the meta-row dispatch rule, tombstone finality, the sweep applied through
  compare-and-set and the raise-path live cap
  ([persistence and migration](specs/persistence-and-migration.md)); read-only conformance,
  audit-in-the-store and notice-only conversation writes
  ([session-log integrity](specs/session-log-integrity.md)).

## Deferred and open

- **Cross-process locking is excluded by assumption, not deferred as a feature.** The single-writer
  rule is the design's boundary: a second owner would need an owner epoch or lease at the store
  boundary and a migration of every write path. No part of the design may claim safety it does not
  provide. Recorded as **Out of Scope** in
  [persistence and migration](specs/persistence-and-migration.md).
- **Decay policy belongs to the register, not here.** Which items go `stale` and when an untouched
  item is archived is the Attention Register's retention decision; this context only applies a
  published plan through compare-and-set and never invents a clock-driven transition.
- **A backend beyond the host's per-record storage.** The record vocabulary and durable boundary are
  backend-neutral, but no second backend is designed. Seam: the persistence contract every writer
  already goes through.
- **The bump rule for a purely additive optional field.** A record family carries its own schema
  version; whether a new optional field with a default is worth a bump is not yet a written rule.
  Seam: each family's own version and the "absent means its default" rule.
- **Surfacing skipped records.** Backup-and-skip is honest at the durable boundary, but whether the
  user should be told that a document was set aside (rather than only logged) is a Surfaces
  decision that is still open.
- **Operator backup and restore of the store directory** is operator documentation
  ([install](../../install.md)), not a domain contract; the domain guarantees what survives a
  restart of a healthy store.

## Reading

Start with [UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md) §8 (durability) and §5
(compare-and-set, idempotency). Then [persistence and migration](specs/persistence-and-migration.md)
— the durable boundary, the three versions, migration and replay, tombstones and the retention write
path — and [session-log integrity](specs/session-log-integrity.md) — why the log is read-only, what
that obliges, and the guards that keep it true. The rationale for the version split is
[ADR 001](adrs/001-three-independent-versions.md); the operator-facing evidence of the log policy is
[session-log-policy.md](../../session-log-policy.md).

The design packet at the repository root owns the mechanics and the measured evidence:
[DESIGN.md](../../../../DESIGN.md) §3.5 (the record), §7.1 (where the bytes live) and §7.4 (the
resolution register). Read it after these documents, not instead of them.
