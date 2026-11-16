# Inbox and register read model

**Context(s):** Attention Register; consumed by Surfaces (page, card, panel) and by the
model-facing list through Model Contract's bounds · **Date:** 2026-11-15

> Intent spec. It states what the capability is for and what it must do; it does not describe
> files, functions or snippets. The design packet and the code own mechanics.

## Definitions

The canonical entries are in [UBIQUITOUS_LANGUAGE.md](../../../UBIQUITOUS_LANGUAGE.md). These are
the terms this spec relies on, with the sense it gives them.

- **Register (noun)** — the install-wide durable memory of items and resolutions. The read model
  is the only way a surface sees it; the read model is not the register and holds no state.
- **Read model** — the merged, bounded, read-only view the register publishes: a snapshot of the
  items matching a query, the counts, the session and workspace rows, the register read, the
  revision and the freshness facts. Merging, filtering, counting ordering and paging happen
  inside the register; a surface never re-derives them from a different rule.
- **Snapshot** — one whole read: a page of items, session rows, workspace rows, the counts, the
  revision, the generation time, the refreshing flag, the next page's cursor when more items
  match, and the completeness flag. A read returns a snapshot or a named error; it never
  returns a patch.
- **Item page** — the bounded, ordered slice of items that match a list query. It is not a
  section; sections are surfaces of populations the list can be asked for.
- **List query** — the filters a read may carry: the session scope and workspace scope; a status
  band; exact states; tiers; kinds; the source facet; the `since`/`until` window; a search
  string; a page size; a paging cursor. A surface may combine them, and the register applies all
  of them before paging.
- **Status band** — the coarse filter the list understands: needs-you states, awaiting,
  resolved, the archived item state, or all. It is a transport filter, not a definition; the
  Needs-you population is defined only by the predicate below.
- **Needs-you predicate** — the single rule that decides attention: state `open` or `stale`,
  tier `structural`, severity 1 or 2, and not a tombstone. The sentence is the definition; every
  surface, count and row uses it and nothing else.
- **Counts** — the seven facts a snapshot carries: needs you, candidates, awaiting, snoozed,
  resolved, new since last visit, and the completeness flag. Except for the last two, each is an
  exact count of stored records satisfying its rule, over the whole install.
- **Global counts** — counts over every stored record. Query filters, search, grouping and
  paging never change them; only the last-visit watermark changes "new since last visit".
- **Last-visit watermark** — the instant of the user's previous visit, supplied with a read. It
  is not a filter: in the list it feeds only the "new since last visit" count, and in the
  register it is the period's lower bound. An item first seen at or after the watermark counts
  as new.
- **Candidate count** — the number of items whose tier is candidate, whose state is `open` or
  `stale`, and which are not tombstones. Candidates are counted separately and never as needs
  you.
- **Awaiting count** — the number of items in state `awaiting`. It is the in-flight population;
  it is neither needs you nor resolved.
- **Snoozed count** — the number of items in state `snoozed`.
- **Resolved count** — the number of items in state `resolved`, excluding tombstones.
- **Session row** — the aggregation of one owning session's items: the session id, its title
  snapshot, its workspace identity, the time of its latest item activity, and its needs-you and
  awaiting counts. The owning session is the root session an item belongs to; a subagent
  roll-up is provenance on the item, never a change of owner.
- **Workspace row** — the aggregation of one workspace bucket's needs-you items: the workspace
  id, its title, its display path, the number of needs-you items and the number of sessions that
  own them. The bucket is the workspace id stored on the item, and the Ungrouped bucket is the
  one for items without a workspace identity. The row does not claim whether the workspace still
  exists; a surface resolves that from its own workspace registry.
- **Grouping** — how a surface arranges the same list: by session (the default) or by workspace.
  Grouping changes arrangement only; it never changes the population, the counts or the
  predicate.
- **Triage order** — the one order of the item list: severity ascending (1 first), then
  first-seen time ascending (the item that has waited longest first), then item id ascending.
- **Register read** — the resolutions view: the resolved items plus the in-flight answers, newest
  first. It is a different read from the item list and has its own page, total, filters and
  completeness flag.
- **In flight** — an item in state `awaiting`: the user has answered and the work has not yet
  acknowledged it. It is neither open nor resolved, and it is the population at the top of the
  register read.
- **Resolution time** — the time a resolved item resolved; the register read orders the resolved rows
  by it. An in-flight row has no resolution time yet and is ordered by the time of its latest
  update.
- **Source facet** — the filter over where a row came from. In the item list it separates
  authored items from detected items (an inferred candidate's evidence is detected from the log
  even though its tier is candidate); in the register read it separates resolutions by actor
  (`user` versus `detector`). The register names which sense it is applying; a surface never
  reinterprets it.
- **Result page** — one slice of an ordered read, with a page size between 1 and 200 and a
  default of 50. The register read has its own page default.
- **Paging cursor** — the opaque token a read returns when more results match, and the caller
  passes back to continue. It is not Capture's per-session cursor; it is a continuation token
  for a list read and carries no authority.
- **Revision** — the monotonic number a snapshot carries for the life of one host process, so a
  surface can tell whether its snapshot is older than the register's state. It is not a
  transaction id, not durable, and not comparable across host restarts.
- **Generation time** — the instant the snapshot was read; a surface may display it ("read at …")
  but must not use it as a revision.
- **Refreshing** — the flag that the register is still assembling a newer read; while it is set,
  a surface may render the snapshot it has but must not present it as final.
- **Completeness flag** — whether a cap has removed earlier resolutions from the register. Its
  wire and UI label is "earlier records pruned". It is carried by the list counts and by the
  register read, and it is a promise to the surface that the register is not claiming to be
  whole.
- **Freshness** — how a surface learns the register changed. The read model publishes the facts
  (revision, generation time, refreshing, completeness); the re-read triggers (own writes,
  focus, connection reset, polling) belong to Surfaces.
- **FYI** — severity 3. Never counted as needs you and not part of the default attention
  population.

## Constraints

- **One predicate, used everywhere.** The Needs-you population, the needs-you count, session
  rows, workspace rows and the page title all use the single rule in the definition. A second
  predicate anywhere — a "minor" variant, a per-surface rule, a different severity cut — is a
  defect even if it produces the same number for a given fixture set.
- **Counts are computed before filtering.** Every count that has a record rule is computed over
  every stored record, not over the returned page and not over the filtered set. The list may be
  narrowed; the counts may not.
- **The count invariants are contracts.** The counts reported by the capability/identity probe
  equal the snapshot's counts for the fields they share, and the needs-you count equals the sum
  of the workspace rows' item counts including Ungrouped. Session rows use the same predicate.
  These hold by construction, not by coincidence, and are asserted as invariants.
- **Tombstones are invisible.** A tombstone is excluded from the item page, session rows,
  workspace rows, every count, and the register read. Its exclusion is not a visibility toggle;
  it is the definition of a tombstone.
- **Ordering is total and deterministic.** Every list has an explicit final tie-break, so the
  same records and the same clock always produce the same order. No order depends on locale,
  timezone, hash order or insertion luck. In every item list, ties are broken by item id, never
  by title collation; every other row order names its own final key. Times are compared as
  instants, not as formatted strings.
- **The row orders are explicit.** The item page is in triage order. Session rows are ordered by
  latest item activity descending, then session id ascending. Workspace rows are ordered by
  needs-you item count descending, then by a code-unit comparison of the stored workspace title
  (locale-independent by construction, never locale collation), then by workspace id ascending as
  the final tie-break; the Ungrouped bucket's placement is a surface arrangement. The register read
  is ordered by resolution time descending, with in-flight rows ordered by their latest update,
  then item id. A surface may arrange groups; it may not re-order the rows inside one.
- **`since` is a window, not a filter, in the list.** In the item list, `since` affects only
  "new since last visit"; it never removes items from the page. In the register read it is a real
  lower bound on resolution time (using the resolution time, or the update time for an in-flight
  row). A page that used `since` as a list filter while the counts did not would make the list
  and the badge contradict each other.
- **Paging is a slice of an order, not a transaction.** The item list is ordered, then sliced;
  the cursor continues the order. An item never appears twice in one page. Because the register
  can change between two pages, a surface must join the pages by item id and must clear the
  cursor on a new read; the read model does not promise two pages of one order are a frozen
  result set.
- **Page bounds.** Page sizes are clamped between 1 and the maximum of 200; the default is 50.
  A query the register cannot decode (an unreadable cursor) is treated as the first page, never
  as an error, because a list read has no side effects.
- **The register read is resolutions, not items.** Its population is resolved items plus
  in-flight answers, ordered newest first; it excludes tombstones, open items, candidates,
  snoozed items and the archived item state. A cap-archived item is shown only by the item list's
  archived status filter. It carries each row's acknowledgement and retention class so a surface
  can show what happened next without a second read.
- **Session rows are one per owning session; workspace rows one per bucket with needs-you
  items.** A session with no item gets no row. A workspace with no needs-you item gets no row
  from the register; a surface may add known workspaces with a zero count from its own registry
  to show "clear", but that entry is not a register row.
- **Grouping keys are identities, never paths.** A session is the owning session id; a workspace
  is the stored workspace id; an item without a workspace identity is Ungrouped. A path, a
  current directory, a title or a workspace's position is never a grouping key. A workspace that
  no longer exists keeps its stored title and is never merged into another id; ids are never
  reused. Whether a workspace has been removed is resolved by the surface from its own registry,
  not asserted by the row.
- **Freshness is honest by construction.** A read is whole: a surface renders a snapshot, keeps
  its last good one while refreshing, or shows a named error with a retry. A read that cannot
  be served is never an empty snapshot. The register reports the wire protocol, domain format
  and record schema versions so a newer client can detect an older host and degrade visibly
  instead of rendering a shape it does not understand.
- **Revision never regresses within a process.** Every write and every read-time retention
  effect advances it; two reads at the same revision describe the same register contents (their
  generation times may differ). A client that holds a higher revision and reads a lower one has
  met a restarted host, and must replace its view rather than merge.
- **The completeness flag is declared, not inferred.** When a cap has pruned resolutions, the
  list counts and the register read say so; a surface that shows a pruned register as complete is
  lying. The flag is never cleared by a later read in the same host process.

## Problem

The user's register spans every session, every workspace and every restart, but each surface sees
it through one narrow window. That produces four failures the read model has to prevent.

Counts disagree with lists. A badge that changes when the user filters, or a page header whose
total covers only the page, turns the register into a set of overlapping half-truths; the user
cannot tell how much work is waiting. Lists reorder under the reader: a "load more" that
interleaves rows, an order that depends on which session was scanned last, or a group that
disappears because its workspace was renamed. The register read loses the distinction between
"what I decided" and "what has not landed yet", so in-flight answers look like history. And
freshness is guessed: a surface patches its list from a partial response, or shows an old
snapshot without saying so, and the user acts on a stale picture.

## Solution

One snapshot answers every read. It carries the page, the global counts, the session and
workspace rows, the register read, a per-process revision and the completeness flag; every list
is a deterministic slice of one total order; every count is computed before filtering; and every
row derives its group from an identity the register stored. A surface renders what it received
or says that it could not read. Freshness is pull-based: the snapshot's revision lets a surface
know when it is behind, and the surface's own triggers decide when to re-read — the read model
never pushes a half-updated truth.

## User Stories

1. As the user, I want the count beside Open Items to describe every stored item, so that
   filtering my list never changes what I am told is waiting.
2. As the user, I want the list ordered by urgency and by how long I have left something
   waiting, so that I never have to hunt for the item that matters most.
3. As the user, I want to group the same list by the chat that raised it or by the workspace it
   belongs to, so that I can answer in context without losing the population or the counts.
4. As the user, I want "load more" to extend the list I am already reading, so that pages never
   reshuffle rows I have seen.
5. As the user, I want the register to show my answers that are still in flight above the
   resolutions, newest first, so that I can tell what I decided from what has not landed yet.
6. As a surface, I want every read to be one whole snapshot with a revision, so that I can tell
   when I am stale and never patch a lie into the list.

## Acceptance Criteria

Every scenario fixes the register clock and the last-visit watermark; counts are asserted over a
record set that is stated inline.

### Story 1 — One predicate, global counts

```
Given items in session "s-1": three structural items in states open/stale with severities 1, 2 and 2,
      one candidate in state open, one snoozed, one awaiting and one resolved, plus one structural
      severity-3 item and one tombstone
When  a list read is issued scoped to session "s-1"
Then  the counts report needs you 3, candidates 1, awaiting 1, snoozed 1, resolved 1, while the page
      contains only session "s-1" open and stale rows, including the candidate and the FYI item but
      not the snoozed, awaiting or resolved rows
```

```
Given two needs-you items in workspace "w1", one in workspace "w2", one with no workspace identity,
      and one candidate in workspace "w1"
When  a list read is issued with no filters
Then  the needs-you count is 4 and the workspace rows' item counts sum to 4, including an
      Ungrouped row for the item without a workspace identity
```

```
Given a candidate of severity 1 and a structural FYI item of severity 3, both in state `open`
When  a list read is issued
Then  the needs-you count is 0, the candidate count is 1, and neither item is in the Needs-you
      population
```

### Story 2 — Deterministic order and paging

```
Given four needs-you items: severity 1 first seen at 10:00, severity 2 first seen at 09:00,
      severity 2 first seen at 11:00, and severity 3 first seen at 08:00
When  a list read is issued
Then  the page orders them severity 1 at 10:00, severity 2 at 09:00, severity 2 at 11:00,
      severity 3 at 08:00
```

```
Given a list read with page size 50 already returned 50 rows and a cursor, over 60 needs-you items with
      the same severity and the same first-seen time, ids "item-000"…"item-059"
When  the next page is requested with that cursor
Then  10 rows are returned, no item id appears twice across the two pages, the ids are in ascending
      order, and the page carries no further cursor
```

### Story 3 — Grouping by identity

```
Given two needs-you items and one awaiting item in session "s-1" (one of the needs-you items rolled up
      from subagent session "s-9"), and one needs-you item in session "s-2"
When  a list read is issued
Then  the session rows are "s-1" (needs you 2, awaiting 1) and "s-2" (needs you 1), ordered by latest
      item activity, and no row is labelled subagent
```

```
Given four needs-you items: two with workspace snapshot "w1" titled "Hookshot", one with a stored
      workspace id "w2" titled "NX2navi" that no longer exists in the workspace registry, and one with no
      workspace identity and path "/tmp/scratch"
When  a list read is issued
Then  the workspace rows sum to 4, the row for "w2" keeps the remembered title and is not merged
      into another bucket, the item with no identity is in Ungrouped, and no row is grouped by
      "/tmp/scratch"
```

### Story 4 — The register read

```
Given a resolution answered at 14:00, a dismissal resolved at 16:00, an in-flight answer updated at
      17:00, and a tombstone
When  the default register read is issued
Then  the in-flight answer is first, then the 16:00 and 14:00 resolutions in that order, the total is
      3, the tombstone is absent, and each row carries its acknowledgement and retention class
```

```
Given a resolution by the user at 14:00, a detector closure at 15:00, and an archived resolution by the
      user at 16:00
When  the register read is issued filtered to source user and since 14:00
Then  only the user resolution at 14:00 is returned; the archived resolution is not in the default
      register population because archive rows belong to the archive status
```

```
Given the register pruned the oldest archived resolutions during a stored-resolution cap sweep
When  a register read is issued
Then  the read reports that earlier records were pruned, so no surface can present the result as
      complete
```

### Story 5 — The freshness contract

```
Given a surface holds a snapshot with revision 7 and generation time 13:00, and an item has since been
      dismissed
When  the surface reads the list again
Then  the new snapshot's revision is greater than 7 and its generation time is later; equal revision
      would have meant the surface need not re-read
```

```
Given the register cannot serve a read
When  a surface asks for a snapshot
Then  it receives an error envelope with a retryable reason and no items, never an empty register
```

## Design Decisions

- **The read model is one merged snapshot, computed per read.** The register merges its records
  once and the surface renders the result; there is no cached snapshot to invalidate and no
  second merge rule on the client. This keeps the counts and the lists consistent by
  construction and makes a stale client detectable by comparison, not by guesswork.
- **The one predicate is the product's definition of attention.** No surface may derive attention
  from a state, a severity or a tab; it may only consume the predicate's population and count.
  Candidates, in-flight answers, snoozed items and FYI are separate populations with their own
  counts, never a widened "needs you".
- **Counts are global, lists are filtered, and the difference is visible in the copy.** The
  register reports both honestly: the list is "what you are looking at", the counts are "what
  exists". A surface that shows a filtered list must not imply the count describes the filter.
- **Ordering states a product opinion once.** Triage order is "most urgent, then longest
  waiting", not "newest first"; the register newest-first is a journal, not a queue. Both orders
  are total so paging and tests are stable, and neither depends on locale.
- **Grouping keys are durable identities.** Session ownership is the root session an item
  belongs to; workspace membership is the snapshot taken when the item was raised, matched by
  workspace id. The register never re-derives grouping from a path, a current directory or a
  title, because those change and the record must not.
- **The register read is a separate read.** Resolutions and in-flight answers are a journal with
  its own population, order and completeness flag; folding them into the item list would blur
  the item state and the resolution and make one read lie about the other.
- **Freshness is pull, evidence is the revision.** The read model publishes a per-process
  revision and a generation time; it does not push deltas. A surface may re-read whenever it
  likes, but it may never patch its list from a partial response or present an older snapshot as
  current.
- **The completeness flag has no default.** A pruned register says so wherever the affected rows
  are shown; silence is not an option, because a complete-looking list is indistinguishable from
  a broken one.

### Deferred Decisions

- **A pushed delta channel.** The read model is pull-based; a live pushed update would change
  the contract for every surface and needs its own invalidation and ordering story. The seam is
  the revision plus the whole-snapshot shape: a future channel can be added without changing what
  a snapshot means.
- **Host-side outcome and lookup filters.** Narrowing the register by acknowledgement outcome
  (observed, none, in flight) or answering "has this dedupe key come up before?" host-side is not
  part of the read contract. The seam is the register query vocabulary and the dedupe key on
  every record: named filters can be added without changing a record.
- **Grouping duplicate topics across sessions.** The read model groups by session and workspace
  only. Whether the list should also group "the same decision asked in two sessions" is the
  cross-session identity deferral in the [item lifecycle](item-lifecycle.md); the seam is the
  dedupe key, which is contextual on the session.
- **Zero-count workspace entries.** The register emits workspace rows only for buckets with
  needs-you items; whether the facet's zero-count entries come from the read model or from the
  surface's own workspace registry is not decided. The seam is workspace identity: either side
  can read the same ids.
- **Run and archived state on a session row.** A session row carries the session identity and
  item counts; whether it also carries the live session's run/archived state, and which side
  resolves it, is not decided. The seam is the session id the row already carries.
- **A durable completeness flag.** Whether the fact that earlier records were pruned survives a
  restart is not decided; the seam is a durable meta row, and the read contract already declares
  the flag. Until decided, the register must not claim completeness it cannot prove.

## Testing Strategy

- **Invariant tests first.** The predicate, each count rule, the count invariants, the
  tombstone exclusion and the completeness flag are asserted as invariants over fixture records,
  because they are the promises every surface depends on.
- **Behaviour through the read contract.** Tests call the list read and the register read with
  queries and assert the returned snapshot; they never assert an internal row-building function,
  so the merge can change without rewriting acceptance tests.
- **Fixtures are explicit record sets.** Each scenario states the item states, tiers, severities,
  sessions and workspace snapshots inline, so a failure names the fixture that produced it.
- **Only boundaries are mocked:** storage, the harness's session facts and the clock. Filtering,
  ordering and counting are the behaviour under test.
- **Time and order are controlled.** The clock is injected and fixed; the last-visit watermark
  is passed explicitly; ordering assertions use total orders with explicit tie-breaks rather than
  "some order".
- **Determinism is tested, not assumed.** Running the same read twice over the same fixture must
  produce the same page and the same order; a paging test asserts no repeated item id across
  pages and no cursor on the final page.
- **Count invariants run on every fixture.** Every snapshot a test builds is also checked against
  the invariants, so a new fixture cannot quietly introduce a count that contradicts the
  predicate.

## Out of Scope

- **How a surface arranges, renders, filters or navigates the snapshot** — sections, group
  headers, badges, rows, detail pane, empty states, keyboard and accessibility. Surfaces owns
  them.
- **The re-read trigger policy** — polling, focus, visibility, connection reset, own-write
  invalidation. Surfaces owns freshness behaviour; this spec owns the facts it consumes.
- **Delivery and answering writes** — the reply contract, the delivery tracks, the answer matrix
  and the refusals. Answering & Delivery owns them; this spec publishes reads only.
- **Export** — formats, determinism rules and row selection. Surfaces owns the export; the
  register read is its input.
- **The model-facing list** — its row cap, preview length and wording. Model Contract & Consent
  owns them; this spec owns the read they adapt.
- **Capture's per-session cursors and backfill watermarks** — the same word, a different concept
  owned by Capture; the paging cursor here is a continuation token only.
- **Any cached or materialised snapshot** — the read model is computed per read; caching is a
  durability decision this spec does not make.

## Open Questions

- **Should the counts expose the archived item state as its own number?** The live cap can move
  items out of Needs you without resolving them; the archived status filter is the only read that
  shows them. Answer: Surfaces and the product owner.
- **Should the register period be expressed as a lower bound or as named periods (today, 7 days,
  30 days, archive)?** A surface can map named periods to bounds; whether the read model should
  carry the vocabulary instead is open. Answer: Surfaces.
