# Attention Register — context

**Kind:** core · **Date:** 2026-11-15

## Purpose

The Attention Register answers one question in the user's terms: *what is waiting on me, and
what did it become?* A conversation can end with a decision, an approval, a question, a risk or
a follow-up still open, and when the chat scrolls away the loop is lost. The register is the
install-wide durable memory of those loops: it gives each one an identity and a state, reserves
the user's attention for items whose existence rests on a fact or an explicit declaration,
records what the user decided and whether the work acted on it, and keeps the whole history as
a register the user can read back. It is the domain's core: every other context either feeds it
evidence, carries its decisions into the work, or shows it to the user.

## Position in the map

The register sits in the middle of the domain; [CONTEXT_MAP.md](../../CONTEXT_MAP.md) owns the
full picture and this section only names the edges.

- **Capture → Attention Register** is a **supplier/customer** relationship on the draft
  contract. Capture decides *how the register learns* that something waits; the register alone
  mints identity, applies dedupe, decides the initial tier and state, and closes items. The
  draft is the only thing that crosses; the register knows nothing about folds, artifacts in
  the abstract, or detection policy.
- **Model Contract & Consent → Capture → Attention Register.** A declaration made by the agent
  reaches the register as a draft through Capture; the register consumes the declaration's
  content, never the model-facing tool mechanics or consent decisions.
- **Attention Register → Answering & Delivery** publishes the legal lifecycle transitions and
  the record shapes. Delivery commands the lifecycle only through those transitions; it never
  edits an item's state or history directly.
- **Attention Register → Surfaces** publishes one read model: a merged snapshot, one Needs-you
  predicate, global counts, session and workspace rows, the register read and its revision.
  Surfaces hold no item semantics of their own.
- **Every writer → Durability & Integrity.** The register consumes the persistence contract
  (validated records, compare-and-set versions, migration, single writer) and publishes no
  record format of its own.
- **Session Topology** (the shared kernel defined in the map) supplies the session, turn and
  workspace facts every item is keyed to. The register stores them as pointers; it never joins
  across contexts at read time.

The dependency direction is inward: no context named above may depend on the register's
consumers, and the register may not depend on a surface concept.

## What this context owns

- **The item entity** — what an item is and is not, the eight item kinds, the two tiers
  (structural and candidate), severity 1–3, blocking, and the authored/derived/inferred origin
  classification.
- **Identity** — the item id, the two dedupe-key forms, the artifact id an item may mirror, the
  occurrence log, the suppressor record, and the tombstone.
- **The lifecycle** — the six states, the four resolution kinds and their three actors, the
  resolution log, reopen, snooze and wake, acknowledgement and its evidence, and the rule that
  state and history are different axes.
- **The attention predicate and its counts** — the one Needs-you predicate, the other count
  bands (candidates, awaiting, snoozed, resolved, new since last visit), the global-counts rule,
  and the invariants that keep the counts and the lists consistent.
- **The read model** — the merged snapshot, the item page, session rows, workspace rows, the
  register read, its ordering, paging, revision and completeness flag.
- **The register memory and its retention policy** — the acknowledgement window, the active
  register window before archive, the resolved-record cap, the live cap, prune, and the two
  meanings of "archived".

## What this context does not own

- **Reply and delivery** — the reply descriptor's control semantics, the answer matrix, the
  three delivery tracks, delivery state, delivery evidence, failure codes, settle, steer, wake
  and refusals. Those belong to Answering & Delivery; the register records what delivery
  reports and publishes the transitions it may command.
- **Detection, evidence and inference** — artifacts, detectors and closing detectors, the fold,
  the projection, backfill and rescan, the candidate gate and prose gate, extraction, capture
  evidence and quotes. Those belong to Capture. The register owns what a draft *becomes*, not
  how it was found.
- **Persistence mechanics** — the store, record schemas and their versions, validation at the
  durable boundary, compare-and-set mechanics, migration, single writer, and the absolute rule
  that the plugin never writes the session log. Those belong to Durability & Integrity; the
  register's own memory is the register, and its audit trail lives there.
- **Session topology** — root versus subagent classification, turn boundaries, workspace
  membership, message provenance and the identifier vocabulary. The shared kernel owns them;
  the register keys on them.
- **Presentation** — the page, nav dot, sections, grouping controls, rows, detail pane, card,
  panel, settings section, keyboard, accessibility, i18n, offline states, export formats and
  the trigger policy for freshness. Those belong to Surfaces. The register publishes the
  snapshot and the revision; Surfaces own what freshness *does*.
- **The model-facing contract** — the `open_items` tool's wording and actions, the nudge, the
  runtime-context line, consent, egress and the settings record. Model Contract & Consent owns
  them, and Capture executes the ingress.
- **The route and the wire protocol** — the single host/browser envelope, capability flags and
  skew tolerance. The halves own them; the read model is one payload on that route.

## Invariants

These are the rules that must hold whatever the implementation becomes. Each says what must
never happen and why.

1. **One loop, one item.** An item id is minted once, is never reused, and survives every edit,
   move and reopen. Two items must never describe the same open loop.
2. **One dedupe key, one live item.** Two sightings of the same key merge into one item while
   it is live; they never create a second row. A resolved item's key may be shared by a later
   item — that is a re-decision, not a duplicate — and the register never rewrites the resolved
   record.
3. **State is not history.** State answers *what is the item doing now*; the resolution answers
   *what happened*. A resolved item always carries a resolution and a resolution time; an
   awaiting item always carries an acknowledgement. A state value must never encode a past
   event, and a resolution must never be used to mean "still open".
4. **The vocabulary sets are closed.** Exactly eight item kinds, two tiers, severities 1–3,
   four resolution kinds, three resolution actors and six states. Adding a member is a
   deliberate vocabulary decision (a glossary change first), never an implementation extension.
5. **One Needs-you predicate.** There is exactly one definition of "Needs you": state `open` or
   `stale`, tier `structural`, severity 1 or 2, not a tombstone. Every count, the nav row, the
   page, section badges, session rows and workspace rows use it. No second predicate may be
   introduced, and no surface may redefine attention locally.
6. **Counts are global.** Counts describe the whole install and never change because the user
   filters, searches or groups the list. A filtered list may be shorter; the number beside the
   page may not move.
7. **A guess never claims attention.** A candidate-tier item is never "Needs you" and never
   leaves the candidate tier except by an explicit confirmation. No surface offers an answer
   control for a candidate, and the reply contract must refuse a candidate-tier reply with a
   named refusal; promote is the only path that makes a candidate answerable. The user is the
   only authority that turns inference into attention.
8. **Nothing is deleted by time or cap.** Retention and the live cap archive; they do not
   delete. The only removals are an explicit, confirmed delete forever (which leaves a
   tombstone) and cap-driven pruning of the oldest archived resolutions, which must be declared
   wherever the affected read is presented.
9. **A tombstone is final and is not a resolution.** It is excluded from every read, count and
   export, it cannot be re-raised by capture, and it is exempt from archive and prune. Treating
   it as an ordinary resolution would let retention destroy the proof that the user deleted it.
10. **The register never writes the session log.** The session's transcript belongs to the
    harness; the register's audit is its own history, delivery attempts and resolutions. A reply
    may enter a session only as a labelled transcript notice, through Answering & Delivery.
11. **Every write is validated and version-checked.** A mutation carries the version it read; a
    mismatch is a conflict, never a lost update. A rejected write leaves memory untouched and
    applies nothing partially.
12. **An exercised permission is not reopenable.** An approval settled through its live request
    has no undo: the honest follow-up is a correction sent to the session. Reopen must refuse
    it rather than pretend the act did not happen.
13. **The register never claims completeness it does not have.** A read is a whole snapshot with
    a revision; a pruned register says so; an unavailable register is a named error with a
    retry, never an empty list and never a fabricated success.

## Inbound contracts

**The draft contract (from Capture).** A draft carries: the item kind and tier; the severity and
the evidence behind it; a normalised title and body; a verbatim quote where the item was
inferred; the capture evidence that proves it (the artifact id, session, sequence, turn and call
identities, and the detector or declaration that produced it); the workspace snapshot resolved
at raise time; the reply descriptor for the kind; the blocking flag; and the detection sources.
It says either "this exists" or "this closed" — never "this is item X". Capture guarantees that
the same committed log produces the same artifact ids; the register guarantees that applying the
same draft twice is one item, so replay is idempotent. If a draft is malformed or carries an
identity the register cannot resolve, the register refuses it with a named code and stores
nothing; a close for an artifact it never saw is a no-op, not an error.

**The persistence contract (from Durability & Integrity).** Records are validated at the durable
boundary; older record versions are upgraded on write and newer ones are rejected by the reader;
a corrupt stored record is quarantined and skipped rather than disabling the register; every
write is version-checked. The register may rely on these guarantees and must not add a second
truth beside the durable record. If a durable write fails, the in-memory authoritative state is
resynchronised from durable truth or left untouched; the read path never throws because a write
could not land.

**The delivery and acknowledgement outcomes (from Answering & Delivery).** One reply action
yields one evidenced delivery attempt and may yield the resolution it settled; acknowledgement
evidence arrives as a specific kind with a log coordinate. The register records these facts and
never invents a delivery, a resolution or an acknowledgement.

**Session topology (the shared kernel).** Root versus subagent classification, the turn
boundary, workspace identity by membership in the workspace's session ids, message provenance
and the join identifiers. When the workspace is unknown the item belongs to Ungrouped — a real
bucket, not an error — and the fallback is never a path match or the session's current
directory.

**Policy configuration.** Retention values are deployment configuration with published
defaults and bounds (see the [retention spec](specs/retention-and-caps.md)). The register treats
the supplied policy as authoritative for its sweep; it never silently substitutes a different
number.

## Outbound contracts

**The lifecycle transitions.** The register publishes exactly which transitions are legal, what
each requires, and which are refused: answer into `awaiting`; dismiss, detector closure or
acknowledgement into `resolved`; snooze and wake; reopen (a `resolved` item, or a cap-archived
`archived` item, returns to `open`); delete forever; promote and suppress for candidates; the
retention transitions (window elapse, archive, prune, and the live-cap archive on any write
that adds or returns a live item). Every item-transition refusal is an error envelope with a stable
code — invalid transition, conflict, not found, limit — and recovery copy; it does not carry the
live record or its version, and the caller recovers by re-reading. (The settings write is the one
exception: it returns a conflict value carrying the live settings record.) Every accepted
transition is one version-checked write that appends its own audit entry. Stability: the
transition set is additive only; a new transition is a vocabulary decision, and consumers must
treat an unfamiliar transition name as a refusal rather than guess.

**The read model.** One merged snapshot carries: the page of items matching the query, session
rows, workspace rows, the global counts, the revision, the read's generation time, the
refreshing flag, the paging cursor when more items match, and the completeness flag. The one
Needs-you predicate is applied identically for the list, every count, session rows and workspace
rows; counts are global and independent of filters; ordering is total and deterministic; the
register read returns resolutions and in-flight answers. The contract is additive: new optional
fields may appear, existing meanings may not change, and a breaking change bumps the wire protocol
version. Detail: [inbox-read-model.md](specs/inbox-read-model.md).

**The draft response.** For each draft the register returns either the created or merged item,
or the fact that it was a duplicate or a suppressor match, or a named refusal. Capture needs
that answer to report honestly to the user, but may never write the item itself.

**The register read and the completeness flag.** The register read publishes the resolutions and
in-flight answers with their retention class and acknowledgement; the list read publishes the
completeness flag (earlier records pruned) alongside the counts. That flag is a promise to
Surfaces that the list is not the whole history, and it must be rendered wherever the affected
rows are shown.

**The state of an item for other contexts.** Answering & Delivery and Surfaces receive the item's
state, resolution, acknowledgement, delivery attempts and retention class by reading the record.
They may not mutate them directly; they command a published transition and trust the register's
answer.

## Key concepts

The canonical entries are in [UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md); every term
below means exactly what it says there, with the local conditions noted. Do not invent synonyms
for these words.

- **Item / open item** — the durable record of one loop; *open item* is the subset the user has
  not answered, dismissed or lost. In this context an item in any state is an *item*; "open
  item" is never used for a resolved or tombstoned record.
- **Item kind** — the product-facing classification, one of the eight. The kind is what the
  user sees; finer detector vocabulary never reaches the item.
- **Tier** — the evidence class: structural (fact or declaration, attention immediately) or
  candidate (inferred, confirmation required). No surface offers an answer control for a
  candidate; the reply contract refuses a candidate-tier reply with a named refusal, and promote
  is the only path that makes a candidate answerable. Tier is a policy field on one record, not a
  separate collection and not a confidence score.
- **Severity** — the urgency class 1–3, taken from the artifact or the declaration, never
  guessed by a model. Severity 3 is FYI and never counts as Needs you.
- **Blocking** — whether the work waits on this item to continue. It is an input to the answer
  matrix but is a different axis from severity: a severity-3 follow-up can be blocking, and a
  severity-2 decision can be non-blocking.
- **Authored / derived / inferred** — how the item came to exist. Authored means declared by the
  agent or a human (identity from the declaration); derived means observed from a committed
  harness fact (identity from the artifact); inferred means produced by a heuristic (always a
  candidate until confirmed). Prose is not derived: the log gives the text, but the item is a
  heuristic reading of it, so a prose item is inferred. Inferred is never a third tier.
- **Item id** — the durable identity, ordered by creation time, stable across edits and reopens
  and never reused. It is not the dedupe key and not the artifact id.
- **Artifact id** — the identity of the observed harness fact inside its session; replaying the
  same log produces the same value. Users never see it.
- **Dedupe key** — the identity a sighting is matched on, in two forms: the authored form (kind +
  session + normalised title, minted when an agent declares an item) and the artifact-keyed form
  (kind + session + artifact id, used for every item whose existence rests on a log artifact,
  whether detected or inferred). One key means one live item; the key is contextual on the
  session, so the same decision in two sessions is two items.
- **Occurrence** — one extra sighting of a detected or inferred (artifact-keyed) item that
  already exists. Occurrences are evidence, not new items; they advance the item's last-seen time
  and are kept bounded. An authored re-raise of a still-open item is not an occurrence: it
  merges silently, returns the existing item, reports the dedupe and writes nothing.
- **Suppressor** — the durable "the user said this is not an item" record, written only by the
  candidate's "not an item" action, matched by dedupe-key prefix so the same inferred ask cannot
  come back. A plain dismissal writes no suppressor.
- **Tombstone** — the record left by delete forever: content dropped, identity kept, excluded
  from every read and count, exempt from retention, not a resolution and not re-raisable.
- **State** — one of the six lifecycle states: `open`, `snoozed`, `awaiting`, `stale`,
  `archived`, `resolved`. A *live item* (the local term for the states the live cap counts) is
  one in `open`, `snoozed` or `stale`.
- **Resolution** — what ended the item's active life: `answered`, `dismissed`, `superseded` or
  `detected-closed`, recording the actor (`user`, `model`, `detector`), the exact payload and
  the time. A detector-closed resolution carries the closing detector's code; that is what
  *closure* means. A settle (client- or host-settle) records the payload when the answer is
  accepted and the item moves to `awaiting` carrying it; a session-message reply records no
  resolution at send — the item is `awaiting`, and the answer it carried becomes the resolution
  when the work acknowledges it or when the acknowledgement window elapses with no evidence. In
  both cases the item becomes `resolved` only then.
- **Resolution log** — the bounded record of earlier resolutions kept when an item is reopened,
  so history is appended to and never rewritten.
- **Reopen** — the user action that returns a settled item to `open`: a `resolved` item moves
  its prior resolution into the log, and a cap-archived `archived` item returns with its content
  intact and no resolution to move. Both increment the reopen count. An approval already
  exercised is refused.
- **Acknowledgement** — the register's answer to "did the work act on the user's answer?", with
  states `pending`, `observed` and `none` and specific evidence kinds. It is about the work,
  never about the user having answered.
- **Acknowledgement window** — the configurable policy bound (24 hours by default) after which
  a pending acknowledgement becomes `none`. "No acknowledgement observed" is an honest report,
  not a failure claim.
- **Archived item state / archived retention class** — two different things, always qualified.
  The item state hides a live item that the live cap moved out of the active register, content
  intact; the retention class compacts a resolved register entry older than the active window,
  dropping transcript-derived text but keeping the decision.
- **Prune** — removing the oldest archived retention class entries when the resolved-record cap
  is exceeded; a cap behaviour on archived entries only, never a user action and never decay.
- **Needs you** — the computed predicate, never a state and never a tab label. It is the only
  definition of attention in the product; the nav row, page count, section badges, session rows
  and workspace rows all follow from it.
- **Global counts** — counts over every stored record, unaffected by filters or paging.
- **New since last visit** — the count of items first seen at or after the user's last-visit
  watermark; it drives the nav dot and the register's period window, and is never a filter on
  the inbox list.
- **In flight / waiting on the work** — an answered item awaiting acknowledgement: the user has
  done their part and the work has not yet shown that it acted. It is the register's top band
  and a different fact from "open" and from "answered".
- **Register (noun)** — the durable memory of every item and resolution, not the page. The page
  is a surface; the register is what the surfaces read.
- **Retention** — the policy that keeps the register honest over time: the acknowledgement
  window, the active register window, the resolved-record cap and the live cap.

## Design decisions in force

- **ADR 003 — separate detection state from the register, merge one view**
  ([link](../../adrs/003-three-storage-layers.md)): the detection ledger is replayable,
  checkpointed state; every raised item — derived or authored — is a durable register record, and
  live asks are observed only. The read model merges detection and register state once per read
  with one identity, one predicate and one revision; races are resolved by the durable register's
  compare-and-set. This context's merge-precedence rules (which re-raise wins, which human
  resolution is final) implement that ADR.
- **ADR 004 — confirm before attention** ([link](../../adrs/004-confirm-before-attention.md)):
  the two evidence tiers and the candidate gate. The register owns the tier field, the promote
  and suppress transitions, and the rule that candidates never claim attention.
- **ADR 002 — the plugin never writes the session log**
  ([link](../../adrs/002-no-session-log-writes.md)): the register's memory is the register, and
  the transcript receives only a labelled notice from Answering & Delivery.
- **ADR 001 — compose published seams; never fork the harness**
  ([link](../../adrs/001-compose-published-seams.md)): the read model is published through the
  one host/browser route, and a missing capability is reported honestly rather than fabricated.
- Decisions recorded in this context's specs, not as separate ADRs: the state/resolution split
  and the four resolutions with three actors ([item-lifecycle](specs/item-lifecycle.md)); the one
  Needs-you predicate and the global-counts rule ([inbox-read-model](specs/inbox-read-model.md));
  the tombstone's exemption from retention and the archive-never-delete rule
  ([retention](specs/retention-and-caps.md)).

## Deferred and open

Each item names the seam that keeps the decision open. None of these is a missing capability to
be discovered later; each is a decision this context deliberately has not made.

- **The decay trigger policy** — what turns `open` into `stale` and `stale` into the archived
  item state, per severity and per activity. The `stale` state and every rule that respects it
  exist; the trigger policy does not. The seam is the retention sweep plus the per-severity
  windows recorded with the [retention spec's deferred decisions](specs/retention-and-caps.md).
- **Cross-session identity** — when two items in different sessions are "the same decision". The
  register deliberately treats them as two items; the seam is the dedupe key being contextual
  on the session, so a future grouping decision can be made at read time without changing
  records.
- **A pushed read channel** — the read model is pull-based: whole snapshots, a revision and the
  surface's own re-read triggers. A live delta channel would change the contract for every
  surface; the seam is the revision plus the snapshot shape
  ([read model's deferred decisions](specs/inbox-read-model.md)).
- **Host-side register filters beyond the published vocabulary** — acknowledgement/outcome and
  "has this come up before?" lookups are decisions this context has not made; the seam is the
  register query, which can gain named filters without touching records.
- **Whether the completeness flag is durable** — the read model must never claim completeness it
  lacks; whether that fact survives a restart is recorded as an open question in
  [inbox-read-model](specs/inbox-read-model.md).
- **A second owner of the register** — multi-host or cross-device access is outside this map;
  the single-writer rule is a stated assumption owned by Durability & Integrity, not a wish.

## Reading

- **Specs, in order:** [item-lifecycle.md](specs/item-lifecycle.md) — what an item is, the
  identity rules and the state/resolution machinery; [inbox-read-model.md](specs/inbox-read-model.md)
  — the predicate, counts, rows, ordering and the snapshot Surfaces render;
  [retention-and-caps.md](specs/retention-and-caps.md) — the time and size policy that keeps the
  register honest.
- **The design packet** (mechanics and implementation history, repository root):
  `DESIGN.md` §2.1–2.6 (product definition, scope, zero-item state, resolutions as records),
  §3.5 (record vocabulary), §5.2 (badge semantics), §7.3–7.4 (retention and the register);
  `UI.md` §4.4 (the register view); `OPEN-ITEMS.md` locked decisions OI-04, OI-05, OI-11 and
  D11.
- **Glossary terms to read first:** item, open item, tier, severity, state, resolution, Needs
  you, acknowledgement, retention, archived retention class, prune.
- **Map companions:** [CONTEXT_MAP.md](../../CONTEXT_MAP.md) for the boundaries and published
  contracts; [ARCHITECTURE.md](../../ARCHITECTURE.md) for why the system is shaped this way.
