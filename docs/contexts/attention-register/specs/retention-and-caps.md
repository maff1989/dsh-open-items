# Retention and caps

**Context(s):** Attention Register; executed through Durability & Integrity's persistence
contract · **Date:** 2026-11-15

> Intent spec. It states what the capability is for and what it must do; it does not describe
> files, functions or snippets. The design packet and the code own mechanics.

## Definitions

The canonical entries are in [UBIQUITOUS_LANGUAGE.md](../../../UBIQUITOUS_LANGUAGE.md). These are
the terms this spec relies on, with the sense it gives them.

- **Retention** — the policy that keeps the register honest over time. It has four parts: the
  acknowledgement window, the active register window, the resolved-record cap, and the live cap.
  Retention never deletes by time or by decay.
- **Retention class** — where a resolved item sits in the register's active memory: `active`
  (full record) or `archived` (the decision kept, the transcript-derived text dropped). It is a
  property of a resolved register entry, not a lifecycle state.
- **Active register window** — the period after resolution during which a resolved item remains
  in the active retention class. Default 365 days.
- **Archived retention class** — the class a resolved entry moves to when the active register
  window elapses: the item's body and quote are dropped, and the title, kind, resolution
  payload, evidence, acknowledgement, session reference and dates are kept. It is still
  reopenable, still searchable under the register's archive period, and still exportable. Always
  qualify it; "archived" alone can mean the item state below.
- **Archived item state** — the lifecycle state a live item enters when the live cap moves it out
  of the active register. The content is intact and nothing was resolved; the item is hidden
  from Needs you, still tracked, and still counted nowhere until it is resolved or reopened. Its
  only read is the item list's archived status filter; the register read excludes it. It is not
  the archived retention class.
- **Acknowledgement window** — the policy bound after which an item in `awaiting` whose
  acknowledgement is still `pending` resolves with acknowledgement `none`. Default 24 hours.
  Measured from the item's last evidence of life.
- **Last evidence of life** — the latest of the item's last update, its resolution time if any,
  and the times of its delivery attempts. The acknowledgement window is measured from it, so a
  retried delivery restarts the wait honestly rather than pretending the first attempt arrived.
- **No acknowledgement observed** — the honest label for acknowledgement `none`. It reports that
  the register saw no evidence the work acted; it does not claim the work failed and it does not
  claim the answer was never delivered.
- **Resolved-record cap** — the cap on the number of stored resolutions. Default 5000. It counts
  every resolved register entry, active and archived; only archived entries can be pruned to
  satisfy it.
- **Live cap** — the cap on live items, the states `open`, `snoozed` and `stale`. Default 500. It
  is enforced whenever a write would add or return an item to a live state — a raise, a re-raise,
  a reopen, or any other transition into a live state; the excess live item is archived — `stale`
  before non-stale, then least urgent severity (3 before 2 before 1), then oldest update — never
  deleted.
- **Prune** — removing the oldest archived retention class entries when the resolved-record cap
  is exceeded. A cap behaviour on archived entries only, never a user action, never decay and
  never a read-time filter.
- **Prune-on-append** — the rule that a write which appends a resolution may itself trigger
  pruning, so a register that keeps resolving cannot grow past its cap between scheduled
  sweeps.
- **Retention sweep** — the periodic, bounded pass in which the register applies the time and
  size policy: it wakes due snoozes, resolves expired acknowledgement windows, moves resolved
  entries to the archived retention class, and prunes archived resolutions over the resolved-record
  cap. It does not enforce the live cap, which is an invariant over every write that adds or
  returns a live item (see Constraints). The plan is a pure function of the stored records, the
  policy and the clock.
- **Completeness flag** — the register's declaration that a cap has pruned earlier resolutions.
  Its wire and UI label is "earlier records pruned". It is published with the list counts and the
  register read; a pruned register is not a whole register and must say so.
- **Delete forever** — the explicit, confirmed user action that removes an item from every read
  and leaves a tombstone. It is not a retention step and not a resolution.
- **Tombstone** — the record left by delete forever: content dropped, identity and dedupe key
  kept, marked deleted, excluded from the inbox, the register, the counts and the exports, and
  exempt from every retention rule. It exists so a deletion stays final and a later scan cannot
  resurrect what the user deleted.
- **Archive never delete** — the rule that both archive meanings keep the record: the item state
  hides, the retention class compacts, and neither removes. The only removals are delete forever
  and the pruned archived resolutions.
- **Decay** — the time-based policy that would move untouched items from `open` to `stale` and
  from `stale` to the archived item state. The state and the rules that honour it are specified;
  the trigger policy is one of the decisions this spec does not make (see Deferred Decisions).

## Constraints

- **The policy values are deployment configuration with these defaults and bounds:** the
  acknowledgement window is 24 hours by default, configurable from 1 to 720 hours; the active
  register window is 365 days by default, configurable from 1 to 3650 days; the resolved-record
  cap is 5000 by default, configurable from 100 to 100 000; the live cap is 500 by default,
  configurable from 10 to 10 000. A day is exactly 24 hours and an hour exactly 60 minutes;
  retention never uses a local calendar, so daylight saving cannot move a boundary.
- **Boundary rule.** A time-based transition happens when *at least* the configured span has
  elapsed since the anchor: an acknowledgement window of 24 hours is satisfied at exactly 24
  hours, and a 365-day active window at exactly 365 days. All times are the register clock's
  instants, stored and compared as numbers, never as formatted dates.
- **The sweep is pure and deterministic.** Given the same records, policy and instant, the plan
  names the same items in the same order: prune candidates are ordered oldest resolution first,
  then item id ascending. Nothing about the plan depends on iteration order. The live cap is not
  part of the sweep plan; its ordering belongs to the writes that add or return a live item (next
  bullet).
- **Resolution writes are durable and version-checked.** A retention transition is a normal
  compare-and-set write: it increments the item's version, appends an audit entry, and never
  overwrites a concurrent user action. A sweep that loses a race re-reads on the next pass
  instead of forcing the write.
- **Retention is not a read-time filter.** A resolved entry older than the active window is a
  stored archived entry, not a row hidden at read time. The same is true of pruning: the rows
  are gone, and the completeness flag says so. A surface must never render a retention outcome
  the register has not stored.
- **Prune only touches the archived retention class.** Active resolutions are never pruned; a
  register whose cap is filled by active entries is allowed to exceed the cap until entries age
  into the archive. Tombstones are not counted toward the cap and can never be pruned.
- **The live cap is an invariant over every write that adds or returns a live item.** Whenever a
  write would create an item in a live state or return an item to a live state — a raise, a
  re-raise, a reopen, or any other transition into a live state — the cap holds after the write:
  the excess live item is archived first, in the order above; no scheduled sweep enforces the cap.
  The archived item state keeps the content and hides the item from attention; the record still
  exists and is still readable. If making room cannot succeed, the write is refused with a named
  limit outcome rather than dropped silently.
- **Nothing is ever deleted by age.** There is no retention step whose effect is to remove an
  item because time passed. Decay, if it is ever decided, may only move items between the live
  states and the archived item state; it may not delete.
- **A tombstone is exempt from every retention rule.** It is not a resolution, does not count
  toward the resolved-record cap, is never archived or pruned, and cannot be re-raised by a
  later scan. Deleting a tombstone would destroy the proof that the user deleted the item and
  would let capture resurrect it.
- **The completeness flag is never silent.** Whenever a prune has happened, every affected read
  says so; the flag is not a debug detail.

## Problem

A register that is honest about attention cannot keep everything forever without either losing
the user's trust or losing the user's history. Three pressures collide.

An answer can be delivered and then ignored. The session may never run again, or its next turn
may never act on the reply, and without a bounded wait that item stays "waiting" forever, so the
register cannot tell the user what actually happened. At the other end, resolutions accumulate:
a year of decisions with full bodies and quotes is a large, slow, privacy-heavy store, yet the
decisions themselves are exactly what the user wants to read back. And the live list can grow
unboundedly when a scan or an agent over-raises; a cap is necessary, but a cap that deletes is
worse than the problem it solves, and a cap that silently drops is indistinguishable from a bug.
Finally, a user who deletes something must be able to trust that it stays deleted — a scanner
re-adding a deleted item would make the delete action a lie.

## Solution

Retention keeps the register honest instead of trimming it. The acknowledgement window resolves
"waiting on the work" into "no acknowledgement observed" after a bounded wait, preserving the
answer's resolution. After a year, a resolution loses its transcript-derived text but keeps the
decision, the evidence, the acknowledgement and the dates. A hard resolved-record cap prunes
only the oldest archived entries and raises a visible completeness flag. A live cap archives the
least important live items rather than deleting them. Delete forever is the only user deletion
and leaves a tombstone that no scan can undo and no retention rule can touch. And decay — the
time-based aging of untouched items — is deliberately left undecided while the state and every
rule that respects it are specified, so the policy can be added without changing what an item
is.

## User Stories

1. As the user, I want a delivered answer that the work never acted on to be reported as "no
   acknowledgement observed" after a bounded wait, so that I am never left with an item that
   silently waits forever.
2. As the user, I want a year-old resolved decision to keep the decision and lose only the
   transcript excerpt, so that the register stays readable and honest without keeping every
   quotation forever.
3. As the user, I want the register never to delete a decision by time, so that I can trust it as
   a record I can read back.
4. As the user, I want a hard cap to prune only the oldest archived entries and to say that it
   did, so that I know when the register is not whole.
5. As the user, I want the live list bounded by archiving rather than deletion, so that a busy
   period or an over-eager scan can never destroy a real item.
6. As the user, I want delete forever to be final and remembered, so that the same decision
   cannot be raised again behind my back.

## Acceptance Criteria

Every scenario fixes the register clock; the acknowledgement window is 24 hours, the active
register window 365 days, the resolved-record cap 5000 and the live cap 500 unless the scenario
states otherwise.

### Story 1 — The acknowledgement window

```
Given an item answered at 09:00 whose acknowledgement is `pending`
When  the retention sweep runs at 23:00 the same day
Then  the item is still `awaiting`, its acknowledgement is still `pending`, and nothing else about
      the record changed
```

```
Given an item answered at 09:00 whose acknowledgement is `pending`
When  the retention sweep runs at 09:00 the next day
Then  the item is `resolved` with acknowledgement `none` recorded at that instant, and its
      resolution is still the answer the user gave
```

```
Given an item answered at 09:00 and a tool result proving the work acted at 11:00
When  that evidence is recorded against the item
Then  the item is `resolved` with acknowledgement `observed` and the tool-result evidence kind, and
      a retention sweep afterwards changes nothing about it
```

### Story 2 — The active register window

```
Given a resolution stored at 12:00 with a body and a quote
When  the retention sweep runs 364 days later
Then  the entry is still in the active retention class with its body and quote intact
```

```
Given a resolution stored at 12:00 with a body, a quote and an acknowledgement
When  the retention sweep runs 365 days later
Then  the entry is in the archived retention class with archived time recorded, its body cleared and
      its quote dropped, while its title, kind, resolution payload, evidence, acknowledgement and
      dates are kept
```

### Story 3 — The resolved-record cap

```
Given a resolved-record cap of 2, two archived resolutions at 10:00 and 11:00, and no further activity
When  a third resolution is appended at 12:00
Then  the resolution resolved at 10:00 is removed, the register holds exactly 2 resolutions, and the
      completeness flag is raised and remains raised
```

```
Given a resolved-record cap of 2, filled by three active resolutions
When  the retention sweep runs
Then  nothing is pruned, the register is allowed to exceed the cap in active entries, and the
      completeness flag stays false
```

```
Given a resolved-record cap of 1, two archived resolutions at 10:00 and 12:00 and one tombstone at 11:00
When  the retention sweep runs
Then  only the 10:00 resolution is pruned, and the 11:00 tombstone is neither counted toward the cap
      nor pruned
```

### Story 4 — The live cap

```
Given a live cap of 3 and three live items: an open decision, a snoozed question and a stale severity-3
      follow-up whose last update is the oldest
When  a fourth item is raised
Then  the stale follow-up moves to the archived item state, all four records still exist, and the
      live count is back to 3
```

```
Given an item moved to the archived item state by the live cap, with its title, body and history intact
When  the item list is read with the archived status filter (the only read that shows it)
Then  the item is present with its content, the register read does not include it, it is not in
      Needs you or in any live count, and nothing about it was deleted
```

### Story 5 — Delete forever, and the tombstone's exemptions

```
Given a resolved decision with a body, a quote, delivery attempts and a resolution history
When  the user confirms delete forever
Then  the record remains as a tombstone with its identity and dedupe key kept and its transcript-derived
      text dropped, and it is absent from the item page, the register read, every count and the exports
```

```
Given a tombstone for the decision titled "Ship the migration before Friday?"
When  a later scan of the same session reports the same artifact again
Then  no item is created, the tombstone is unchanged, and the completeness flag is unaffected
```

```
Given a resolved-record cap of 2, two archived resolutions at 10:00 and 12:00 and one tombstone at 11:00
When  the retention sweep runs
Then  the tombstone is untouched, because it is not a resolution and does not occupy the cap, and no
      resolution is pruned
```

### Story 6 — Quiet items are tracked, not deleted

```
Given a structural severity-2 item in state `stale`
When  a retention sweep runs with every policy at its default
Then  the item is still present and still counted as needs you, because `stale` is a live state that
      attention honours and no retention step deletes by age
```

## Design Decisions

- **The acknowledgement window answers a different question from delivery.** Delivery proves the
  answer reached the session; acknowledgement proves the work acted on it. The window is
  measured from the last evidence of life, so a retried delivery gets its own honest wait, and
  the fallback state is `none` with a plain label rather than a success or a failure claim.
- **Archive has two meanings and both keep the record.** The item state hides a live item the
  cap moved out; the retention class compacts a resolved entry. Neither is a deletion, and the
  vocabulary requires them to be qualified everywhere.
- **The resolved-record cap counts resolutions and prunes only archived ones.** The cap exists so the
  store cannot grow without bound; it is not a retention policy, so it must never shorten the
  active register, and it must prune the least valuable tail — the oldest archived entries — not
  the newest history. The completeness flag is what makes the pruning honest.
- **The live cap is a pressure valve over every write that adds or returns a live item, not a
  triage rule.** Whenever such a write would breach the cap it orders the excess by staleness,
  then severity, then age, and archives; the user's own triage order stays the only ordering the
  list presents. A write that cannot make room is refused with a named limit outcome, because a
  silent drop would be a lie about capture.
- **Nothing is ever deleted by decay.** This is decided even though the decay policy is not: a
  time policy may move an item into a less prominent state, but it may not remove a record. That
  keeps every future decay decision from becoming a deletion decision by accident.
- **The tombstone is the deletion's proof.** It keeps identity and drops content, and it is
  exempt from retention so the two mechanisms cannot fight: no archive step, no prune and no scan
  may resurrect it. It is not a resolution, because a deletion is not an outcome *of the item*;
  it is the end of the register entry's visibility.
- **Retention is applied through the same durable write path as every other transition.** A
  sweep is not a back door around version checks; a plan that loses a race is retried, not
  forced.
- **Decay cannot become a deletion by accident.** The state and the predicates are specified; the
  trigger policy is recorded with the decisions this spec does not make, below. Nothing in the
  retention sweep may invent a trigger before that decision is made.

### Deferred Decisions

- **The decay trigger policy.** The trigger policy — when, by what activity clock and per which
  severity an item becomes `stale` and later the archived item state — is not decided. The seam
  is the live-state vocabulary plus the retention sweep: a future policy is another transition in
  the same sweep, and every predicate and read already handles the states.
- **Whether a per-session live cap is needed.** The live cap is install-wide. A per-session cap
  would bound a single noisy conversation without touching the rest; the seam is the live-count
  by session plus the same archive transition.
- **Whether the acknowledgement window varies by kind or delivery track.** One policy bound is
  specified; a stricter or looser bound for a kind or a track is not decided. The seam is the
  policy input to the sweep.
- **Whether the completeness flag is durable.** Whether the register keeps saying "earlier
  records were pruned" after a restart is not decided; the seam is a durable meta row, and the
  read contract carries the flag either way.
- **Whether the archived retention class should ever drop the excerpt from export as well as
  from the record.** The record-side rule is decided; the export-side selection belongs to
  Surfaces and is not decided here. The seam is the retention class on every register read.

## Testing Strategy

- **Time-based behaviour is tested with an injected clock.** A scenario advances the clock by
  exact spans and asserts the transition at the boundary and one tick either side; no test
  sleeps or reads the wall clock. This is what makes "exactly 24 hours" and "exactly 365 days"
  testable rather than approximate.
- **The plan is tested as a pure function.** The retention plan is asserted directly over a
  fixture record set for its candidates and their order, before any write; then the write path is
  asserted separately for version bumps, audit entries and race behaviour.
- **Each cap is tested on the paths that enforce it.** The live cap is asserted on every write
  that can add or return a live item — the raising write, the derived re-raise that reopens a
  settled item, and reopening a cap-archived item are all required cases — and no sweep archives
  anything on the live cap's account. The resolved-record cap is tested on both paths — a breach
  on append and the same breach found by a sweep must produce the same prune and the same
  completeness flag.
- **Invariant tests cover the rules that must never bend:** no deletion by age, tombstones
  excluded from counts and prune, prune restricted to the archived class, live-cap archiving
  preserving content, and the boundary condition of every window.
- **Fixtures carry their own policy.** A test that needs a cap of 2 or a window of 1 hour passes
  that policy explicitly, so a default change cannot silently rewrite what a test proves.
- **Only boundaries are mocked:** the storage medium and the clock. The policy itself is the
  behaviour under test.
- **Determinism is asserted.** Running the same sweep twice over the same records and clock
  produces the same report and no second-order changes; a sweep over records with equal
  timestamps breaks ties by item id, not by iteration order.

## Out of Scope

- **The lifecycle definition of the states, resolutions and the resolution log** — the
  [item lifecycle spec](item-lifecycle.md) owns them; this spec owns only the retention
  transitions between two of them.
- **Detection of acknowledgement evidence** — which harness events prove the work acted, and how
  they are observed, belongs to Capture and Answering & Delivery. This spec owns the window and
  what the register records when evidence does or does not arrive.
- **The inventory of delivery attempts and failure codes** — Answering & Delivery owns the
  delivery record; this spec only reads the attempts' times as evidence of life.
- **Presentation of retention outcomes** — the archive period, prune notice, "no acknowledgement
  observed" copy, and row styling belong to Surfaces.
- **Export and its selection rules** — Surfaces owns the export; the retention class it reads is
  published here.
- **Storage mechanics** — how records are compacted, validated or migrated before this policy
  runs. Durability & Integrity owns them; this spec states the invariants they must preserve.
- **Backfill bounds** — the one-time scan's session and age limits are Capture's policy, not
  retention of the register.

## Open Questions

- **Should decay ever archive a `stale` item, or only mark it?** The state exists and attention
  honours it; whether aging should hide an item before the user acts on it is a product
  question. Answer: the product owner with Attention Register.
- **Should the completeness flag survive a restart, and if so, in which record?** The read
  contract already carries the flag; its durability is a durability decision. Answer:
  Durability & Integrity with Attention Register.
- **Should the resolved-record cap count tombstone records at all?** They do not count toward
  the cap because they are not resolutions; a large number of tombstones would therefore grow
  the store without bound. Answer: Durability & Integrity with the product owner.
