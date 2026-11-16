# Historical capture — backfill, rescan and hydration

**Context(s):** Capture; Durability & Integrity owns the cursor and report records; Surfaces
explains emptiness to the user · **Date:** 2026-11-15

> Intent spec. It states what the capability is for and what it must do; it does not describe files,
> functions or snippets. The design packet and the code own mechanics.

## Definitions

These are the terms this spec relies on; their canonical senses are in
[UBIQUITOUS_LANGUAGE.md](../../../UBIQUITOUS_LANGUAGE.md) §4, refined here where this capability
uses them with extra conditions.

- **Backfill** — the bounded, resumable scan of sessions that predate the plugin: it folds their
  committed logs once so the register is not empty on day one.
- **Rescan** — the periodic, bounded repetition of the backfill over eligible sessions, so an item
  closed outside the live path is still closed.
- **Hydration** — the one-time read of a session's committed log when its first live event arrives,
  so a restart does not lose the closers for items raised before the restart.
- **Cursor** — the per-session record of how far the fold has processed: last scanned `seq`, last
  event time, scan time and fold version.
- **Cursor coverage** — the property that a cursor's `seq`/time are at or beyond every event in the
  session's log. Coverage is the only sound proof that a scan may skip folding.
- **Eligibility window** — the bound on which sessions one pass considers: newest first, up to a
  session count and an activity-age cap.
- **First-contact emission** — the mode in which a session is scanned for the first time (or its
  cursor is unusable, its log was rewritten, or the fold semantics changed): it reports the
  artifacts still open at the end of the log, not the history of everything already resolved.
- **Delta emission** — the mode in which a session with a fresh, covering cursor is re-folded: the
  whole log is folded for a complete ledger, but only transitions caused by events beyond the
  cursor are reported.
- **Replay** — folding a session's log again from its start; required after a fold-version change.
  A replay must produce the same artifacts and ids, create no duplicate items, never reopen an item
  the user resolved and never claim new attention. A re-sighting of a still-live artifact-keyed
  item records an occurrence and bumps that record's version as audit.
- **Fold version / projection version** — the two counters that describe the same fold semantics:
  one gates cursor replay, the other is the projection's state version. They move together.
- **Archived session** — a session hidden by the workspace registry. It is closed history: no scan
  may re-fold it, because a cold baseline over it would resurrect items the user put away.
- **Work slice** — the bounded unit of scanning between event-loop yields, so a pass never blocks a
  session operation.
- **Backfill report** — the durable, counts-only record of the last completed pass: when, what
  armed it, and how many sessions were eligible, folded, skipped, failed and deferred, with draft,
  batch and duration counts.
- **Capture status** — what the host publishes about capture: whether the plugin mounted and
  whether the projection, live drive and backfill attached; the cursor count, the session-catalog
  size, the last backfill report's counts and the last error. Live-ask observation is internal and
  is not part of the published status.
- **Zero-item state** — an empty inbox that is explained: what has been scanned, whether capture
  attached, whether the first backfill has reported.

## Constraints

1. **The scan never blocks a session.** The activation pass is started and never awaited; work is
   sliced between sessions with an event-loop yield; each pass is bounded by the eligibility window.
   A pass already in flight is joined, not restarted, and its single report belongs to the pass that
   started.
2. **Resumable by construction.** A cursor is written only after every draft for that session has
   been accepted by the register. A failed read, a rejected write or an unwritable cursor leaves the
   session un-cursored and retried on the next pass; one session's failure never aborts the pass.
3. **Cursor coverage is the only read-skip proof.** A session is skipped without folding only when
   the cursor provably covers the log it just read (or a proven activity upper bound covers it).
   Prompt time and creation time are never proof that nothing happened: a session can commit tool,
   approval or goal events after its last prompt.
4. **A log shorter than its cursor was rewritten.** The baseline is rebuilt rather than skipped, so
   a reset or replaced log cannot leave old items behind.
5. **Eligibility.** Only root sessions are scanned; archived sessions are excluded; sessions are
   ordered by the roster's activity time when available, otherwise creation time; one pass
   considers at most 200 sessions within a 90-day activity window. Those two numbers are internal
   safety bounds — not deployment settings — and are overridable only by the code that mounts the
   pass. Sessions dropped by the cap are counted as deferred — never silently ignored.
6. **First contact reports the open set; a re-fold reports transitions.** A session with no usable
   cursor reports only the artifacts still open at the end of its log; a fresh cursor reports only
   the transitions its new events cause. A fold-version change, a blank first scan or a rewritten
   log rebuilds.
7. **The fold version and the projection version move together.** Both counters describe the same
   semantics; a lone bump leaves a checkpoint or cursor interpreting new state with old rules. A
   change to what capture derives is therefore one change to both, followed by a replay.
8. **Historical inference is gate-only.** The prose gate runs over historical logs and raises the
   still-open per-item candidates; a historical candidate is never handed to extraction. Live-only
   artifacts (a pending ask) are never raised by any cold read; their closures still pass.
9. **Hydration happens once per session per process.** On the first live event of a session the
   driver has never folded, it reads the committed prefix silently (no drafts) and then folds the
   triggering event normally. Concurrent first events share one read; a failed read is contained and
   leaves an empty ledger, which is the pre-hydration behaviour rather than a lost session.
10. **The rescan is periodic and bounded.** After the activation pass, a bounded repeat re-runs the
    eligibility scan on the deployment-configured interval (`rescanIntervalMinutes`, 1–1440 minutes,
    default 15); it is cleared on teardown, and the wiring that mounts capture can disable it. There
    is no zero-valued setting that disables it. A pass body that throws reports its own failure and
    does not break capture.
11. **The report is counts-only and durable.** One record per completed pass: trigger
    (activation or rescan), time, eligible, folded, skipped, failed, deferred, drafts, batches and
    duration. It carries no session ids, titles or content. A failed pass writes no report. The last
    report survives restart and is seeded into capture status at activation, so a restart never
    claims that nothing ran.
12. **A manual scan is a pass.** Requesting a scan joins the in-flight pass or runs one; its report
    is recorded under the activation trigger, because the report's vocabulary is exactly activation
    and rescan.
13. **Determinism.** The same logs and the same fold version produce the same drafts, in stable
    artifact-id order, with no wall-clock contribution to identity. Report counts are a
    deterministic function of the corpus and the window. A baseline replay re-sights each still-live
    artifact exactly once and bumps its record version as audit; a delta fold over unchanged events
    produces no transitions and therefore no version change.
14. **Read-only.** The scan never writes the session log. Its records — cursors and the report —
    are written through the persistence contract, and its drafts carry the log-fold detection
    source.
15. **Empty is explained.** Capture status is available to the surfaces that render the inbox, so a
    zero-item state can say whether capture attached and what the last pass scanned.

## Problem

The moment the plugin is installed, its live senses start from now. Every session that already
holds a waiting decision is invisible, because the projection has never folded it and the log is
the only record. That produces the worst first impression a register can make: an empty inbox while
the user remembers deciding things a day ago.

The obvious repairs are traps. Reading every log at activation blocks the host on the largest
logs and turns installation into a stall. Skipping a session whose "last updated" time looks old
hides exactly the sessions that committed tool and approval activity after the last user prompt —
the updated time is a lower bound, not proof. Treating an interrupted scan as failed and starting
over duplicates work and risks duplicate items. Re-folding the whole corpus on every restart
rewrites every live row and reopens items the register had already closed. Ignoring sessions closed outside
the live path leaves items open forever. And an empty inbox with no explanation is indistinguishable
from a broken capture — the user cannot tell "nothing is waiting" from "nothing is watching".

## Solution

Three bounded mechanisms and one honest report:

- **Backfill: a resumable, work-sliced sweep.** Activation starts one bounded pass and never waits
  for it. Eligible sessions are root, non-archived and inside the age window, newest first, capped
  per pass; the pass yields between sessions. A cursor is written only after the session's drafts
  were accepted, so an interrupted pass resumes where it stopped. A session whose cursor covers its
  log is skipped; everything else is read and folded.
- **Two emission modes.** First contact reports the artifacts that are still open at the end of the
  log — which is exactly the set the user can act on — rather than replaying every historical
  resolution into the register. A re-fold with a fresh, covering cursor reports only the transitions
  its new events cause, so a delta fold over an unchanged corpus reports nothing; a baseline replay
  instead re-sights each still-live artifact as an occurrence merge.
- **Rescan: the same sweep on a bounded interval.** A session that is not live-observed in this
  process still gets scanned, so a decision closed outside the live path lands. The pass is bounded,
  joinable and disable-able.
- **Hydration: the restart bridge for live sessions.** The live driver only sees events from its
  own attachment, so after a restart a closing detector has no ledger to close. On a session's first
  live event the driver reads its committed prefix silently, then folds the new event — the closure
  that would otherwise be lost lands.
- **Version coupling.** Fold and projection versions move together; a semantic change replays every
  session once on the next activation and is idempotent by construction.
- **The report.** Every completed pass leaves a counts-only record, durable and seeded into capture
  status. It states what a pass scanned, folded, skipped, failed and deferred — never a session id,
  title or content. That is what lets a surface explain an empty inbox instead of leaving silence.

What must remain true: history never blocks a session, a pass never loses a session it failed to
finish, an unchanged corpus produces no transitions, a restart never loses a closer, a rewritten
log is rebuilt rather than trusted, and the user can tell an empty register from a broken one.

## User Stories

1. As a user installing the plugin, I want the decisions already waiting in my history to appear
   without my having to replay the chats, so the register is useful on the first read.
2. As a user with very long sessions, I want the first scan to happen in the background, so opening
   a session is never blocked by it.
3. As a user, I want an interrupted scan to resume rather than lose sessions or duplicate items.
4. As a user, I want a decision that arrived after the scan to surface on a later pass, so the
   register catches up without a restart.
5. As a user, I want a decision made after a restart to close its item, so a restart does not strand
   open rows.
6. As a user who archived a session, I want its items never resurrected by a scan.
7. As a user, I want an empty inbox to tell me what was scanned, so I know whether nothing is
   waiting or nothing is watching.
8. As a user, I want a semantic upgrade to replay my sessions once without reopening decisions I
   already resolved.
9. As a user, I want a cold scan never to resurrect a pending ask whose card is long gone.
10. As the operator, I want the scan's record to carry counts, not my session content.

## Acceptance Criteria

Fixtures are a session catalog with committed logs, a cursor store, a register sink and an injected
clock. "Open set" means the drafts a pass emits.

### Story 1 — The first sweep

```
Given three eligible historical root sessions whose logs each end with one unresolved structural
  artifact
When  the activation pass runs
Then  the pass reports three eligible and three folded, and raises the three still-open artifacts
  with the log-fold detection source
```

```
Given a session last active longer ago than the age window, an archived session holding an
  unresolved approval, and one eligible session
When  the pass runs
Then  only the eligible session is scanned; the age-excluded and archived sessions produce no
  drafts and are not counted as eligible
```

```
Given 250 eligible root sessions and a per-pass session cap of 200
When  the pass runs
Then  200 sessions are considered, the remaining 50 are counted as deferred in the report, and no
  session is dropped silently
```

### Story 2 — Skip proof and delta emission

```
Given a session whose cursor covers its whole log
When  a second pass runs over an unchanged corpus
Then  the session is counted as skipped, the pass emits no drafts for it, and its cursor and the
  register are unchanged
```

```
Given a session whose last prompt was days ago but whose log gained approval/decided
  {outcome: "allowed-once"} for a blocked call afterwards, and whose cursor does not cover it
When  the pass runs
Then  the session is read and folded, and the approval's blocked item is closed as detected-closed
```

```
Given a session whose cursor covers events through seq 40 and whose log now holds events 41–43, the
  last being a user message that supersedes an open candidate
When  the pass runs
Then  only the transition caused by the later events is emitted; the already-scanned raise is not
  replayed
```

### Story 3 — Versions and replay

```
Given a corpus whose fold version has changed since the stored cursors were written, and a session
  holding one still-open structural item and one item a user already resolved
When  the activation pass replays the session
Then  the still-open item's artifact is re-sighted as an occurrence with its record version bumped
  as audit, the user-resolved item is not reopened, and no duplicate item is created
```

### Story 4 — Hydration after a restart

```
Given the register holds a pending-ask item raised before a restart, the live driver has not yet
  folded that session, and the session's committed prefix contains the ask
When  the ask's closing result becomes the session's first post-restart event
Then  the driver hydrates the ledger from the silent prefix read and produces the closure draft
  for the ask instead of losing it
```

```
Given the prefix read for a session fails
When  the session's first live event arrives
Then  the live event is still folded with an empty ledger, the failure is contained and reported,
  and capture continues for other sessions
```

### Story 5 — Rescan

```
Given the periodic interval elapses
When  the rescan pass runs
Then  the pass records its report with the rescan trigger, and a rescan requested while it is in
  flight joins the running pass rather than starting a second one
```

### Story 6 — The report

```
Given a completed pass over three eligible sessions
When  its report is persisted
Then  the record carries trigger, time, eligible, folded, skipped, failed, deferred, drafts, batches
  and duration — and no session id, title or content
```

```
Given a persisted report and a restart
When  capture status is built at activation
Then  the last backfill report is present in the status before any new pass runs
```

### Story 7 — Failure and containment

```
Given one session whose log read fails and two readable sessions
When  the pass runs
Then  the failing session is counted as failed and left un-cursored, the other two are folded, and
  the pass completes with a report
```

```
Given two sessions and a sink write that fails for one of them
When  the pass runs
Then  the failing session stays un-cursored and is retried on the next pass, the other session is
  folded, and the completed report counts one failed session
```

## Design Decisions

- **A bounded sweep plus a bounded repeat, not an extension of the live stream.** The live drive only
  sees its own attachment; history needs a scan, and a scan must never cost a session its
  responsiveness. (Cross-context decision: capture is a projection, not an after-session pass; see
  [structural capture](structural-capture.md).)
- **Cursor coverage is the only skip proof.** The roster's activity time is a lower bound on
  activity, because it is derived from the last prompt; using it as a watermark would hide tool and
  approval events committed after the prompt. The scan reads and lets the cursor decide.
- **First contact reports the open set; re-folds report transitions.** A register has nothing to
  close on first contact, so replaying historical resolutions would create rows for asks nobody is
  waiting on. On later passes, transitions are exactly what a register needs.
- **The scan is root-only and archive-excluding.** Delegated work is not a user decision
  ([ADR 001](../adrs/001-root-sessions-only-with-roll-up.md)); an archived session is closed history
  and a cold baseline over it would resurrect what the user put away.
- **Hydration, not a full rebuild per session.** A live session needs its closers, not its whole
  history replayed; one silent prefix read on first contact restores the ledger at bounded cost.
- **The versions move together.** Two counters describe one semantic change; a lone bump creates a
  stale checkpoint or cursor interpreting new state under old rules.
- **The report is counts-only.** It exists to explain emptiness and to make a partial pass
  accountable after the fact; session content has no place in it, and the last pass is the one that
  describes the present state.

### Deferred Decisions

- **A proven activity timestamp as a read-skip proof.** A Host that can prove an upper bound on the
  newest committed event could skip reads for unchanged sessions cheaply. The seam exists in the
  session metadata contract; until a Host supplies it, every eligible session is read and judged by
  cursor coverage.
- **The rescan schedule policy.** A fixed interval is the design; an adaptive schedule (faster after
  activity, slower when quiet) is not decided. Seam: the interval is a deployment setting
  (1–1440 minutes) and the mounting code can disable the repeat; a different trigger policy could
  replace the fixed interval behind the same seam.
- **Report history.** Only the most recent pass is kept. Whether the register should retain a short
  history of passes (for example to show a pattern of partial passes) is deferred; seam: the record
  lives in the meta table and can gain a bounded history without changing the draft contract.
- **Scanning beyond the activity-age window.** Which older sessions are worth a first look is a
  product judgement; seam: the window is a bound in the mounting code — a safety limit, not a
  deployment setting — so widening it is a limit change, not a new mechanism.

## Testing Strategy

- Pass tests with a fixture catalog and a cursor store over a deterministic clock: assert report
  counts, emitted drafts, cursor writes and which sessions were read. The sink and the log reader
  are the mocks; the fold is real.
- Watermark tests are the heart: a session whose prompt time is stale but whose log grew must be
  read; an unchanged session must be skipped without a fold write; a rewritten-shorter log must
  rebuild.
- Emission-mode tests: first contact emits only the open set; delta emits only post-cursor
  transitions; a version bump replays the open set and never reopens an item the user resolved. A
  baseline replay re-sights each still-live artifact exactly once and bumps its record version as
  audit, while a delta fold over unchanged events leaves every version untouched.
- Hydration tests drive the live driver, not the backfill: a pre-restart raise plus a post-restart
  closing event must close; a failing prefix read must be contained; the prefix must emit no drafts;
  a duplicate first event must not re-fold.
- Report tests assert the exact counts-only field set, the trigger vocabulary, persistence across a
  simulated restart, and that a failed pass produces no report record.
- Determinism: two identical runs over the same fixture produce identical reports and draft order;
  the clock is injected so time appears only in stored timestamps, never in identity.

## Out of Scope

- **Live detection and closing detectors** — [structural capture](structural-capture.md).
- **Inference and candidate lifecycle** — [candidate tier](candidate-tier.md); historical
  candidates are gate-only and never extracted.
- **The record formats, CAS and migration mechanics of cursors and the report** — Durability &
  Integrity's.
- **Rendering capture status or the zero-item explanation** — Surfaces'; this spec defines the facts
  they carry.
- **The live drive's per-event folding path** — the live half of
  [structural capture](structural-capture.md); hydration is specified here because it is a recovery
  seam.
- **A live delta channel from host to browser.** Not a capture concern; the read model is a
  pull-based snapshot owned elsewhere in the map.

## Open Questions

- **Are the default bounds (200 sessions, 90 days) right for a long-lived install?** They are a
  product judgement; answerable by the product owner with measured corpus size and the deferred
  count from real passes.
- **Should the rescan interval be adaptive** to session activity instead of fixed? Answerable by the
  Capture owner with measured out-of-band closure latency.
- **Should a partial pass be reported as partial?** The current report describes the last *completed*
  pass; a pass that failed writes nothing. Whether the status should also carry "last attempt
  failed" is deferred — the seam is the report record and the capture status that mirrors it.
