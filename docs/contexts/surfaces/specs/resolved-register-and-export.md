# Resolved register and export — capability spec

**Context(s):** Surfaces · **Date:** 2026-11-15

> Intent spec. It states what the capability is for and what it must do; it does not describe
> files, functions or snippets. The design packet and the code own mechanics.

## Definitions

Canonical meanings are in [UBIQUITOUS_LANGUAGE.md](../../../UBIQUITOUS_LANGUAGE.md). Every term
this spec relies on:

- **Resolved section / register** — the page section that shows the durable record of everything
  that left the open list: what was decided, by whom, how it travelled, and whether the work acted
  on it. It is a read-only journal, not a second inbox.
- **Resolution** — the recorded outcome that ended an item's active life: `answered`, `dismissed`,
  `superseded` or `detected-closed`, with an actor (`user`, `model` or `detector`) and, for a user
  answer, the payload exactly as submitted. A resolution is never a paraphrase.
- **Detector-closed** — a resolution written by a closing rule rather than by a human answer. The
  register names the detector family in words and keeps the raw detector code beside it so an
  unknown detector stays auditable.
- **Source indicator** — the two-channel statement of where a row came from: a glyph **and** a word —
  ✓ by you (answered), ✓ muted (dismissed), ↗ in flight, or ○ automatic (detector-closed, naming
  the detector) — with the resolution's outcome word beside it (allowed once, denied, not an item,
  closed automatically). It is never carried by colour alone.
- **In-flight band** — the register's top region for replies that have left the user with no terminal
  acknowledgement yet: the item is `awaiting`, its delivery is settled/queued/delivered, and the
  register shows it before the day groups. The band reports it as in flight — *waiting on the work* —
  and never upgrades the attempt into "applied" or "sent to session".
- **Acknowledgement** — the answer to "did the work act on it?", not "did the user answer?". It is
  observed (with the evidence that proved it), pending (no evidence yet), none (the **acknowledgement
  window** elapsed) or not applicable (a dismissal, a supersede or a detector closure, which are not
  answers). The acknowledgement window is the policy bound after which a pending acknowledgement
  becomes none. "No acknowledgement observed" is a statement of fact, not a failure claim.
- **Day grouping** — resolutions grouped by the reader's local calendar day, newest day first, with
  a per-day count; the headings read today / yesterday / date. The register groups locally because
  it is read by a person in a place; the exported file groups by UTC day so the file is environment-
  independent. This difference is deliberate and stated in both surfaces.
- **Period / source / kind / outcome filters** — the register's narrowings: today, 7 days, 30 days,
  all time or the archive period; by you or automatic; one kind; and the outcome buckets
  acknowledged, no acknowledgement, dismissed or superseded. **Search** is a local substring match
  over title, decision text and session title. The **session scope** narrows to one session.
- **Archive period / archived retention class / compacted** — the archive period shows resolutions
  old enough that their transcript-derived text (body and quote) was dropped; those rows are
  *compacted*, keep everything else, and remain searchable, reopenable and exportable.
- **Pruned / earlier records pruned** — the resolved-record cap removed the oldest archived rows.
  When that has happened the header and every export say so; the register never presents an
  incomplete snapshot as complete.
- **Header totals** — the register's own one-line statement of what the current filter holds:
  resolved count, in-flight count, archived count, whether records were pruned and, when relevant,
  how many rows were compacted.
- **Reopen** — the user action returning a settled record to `open`; the prior resolution moves into
  the resolution log and the reopen count increments. A permission that was exercised cannot be
  un-exercised, so that record offers a correction instead.
- **Delete forever / tombstone** — the explicit, confirmed removal of a record. The record becomes a
  tombstone: it leaves the list, the register, the counts and every export, is not a resolution,
  cannot be archived or pruned, and cannot be re-raised by capture. The session transcript is
  unaffected.
- **Export** — a deterministic, local rendering of the current register filter as CSV, JSONL or
  self-contained HTML. **Determinism** means: the same records, filter, options, file-layout version
  and export time produce a byte-identical file. The export time is the only clock value in the
  output and is an explicit input to generation; everything else is derived from the records.
- **Export schema version** — the version of the file layout (columns, keys, HTML structure). Adding
  a field bumps it; removing or reordering one is a breaking change and is never silent.
- **Filter label** — the human description of the active filter carried in the register header and
  in every export header, so a file names the selection it represents.

## Constraints

- **Read-only, with exactly two writes.** The register's only writes are Reopen and Delete forever.
  Answering belongs to the inbox sections; the register reports outcomes, it does not produce them.
- **Ordering is deterministic.** The in-flight band comes first, then resolutions newest first,
  grouped by the reader's local day, each group headed today / yesterday / a date with a per-day
  count. Within a day, order is resolution time descending, tie-broken by item id ascending, so two
  records with the same timestamp never reorder between reads. In-flight rows order by their last
  update, newest first.
- **Filters govern everything shown and exported.** The list, the header totals and the export all
  come from the same filter combination; a filter change re-reads. Filters are applied twice — in
  the host query and mirrored on the client — so a slow or older host cannot make the list disagree
  with its own header. Clearing filters returns the documented default (30 days, all sources, all
  kinds, all outcomes, no search, no session scope).
- **Period means the register's active window or the archive.** Today starts at the reader's local
  midnight; 7 and 30 days are exact rolling millisecond windows, so a re-render cannot shift a
  boundary. The archive period shows archived retention-class records only and suppresses the
  in-flight band, because nothing in flight is archived.
- **The in-flight band is period-independent** but otherwise honours source, kind, search and session
  scope: an answer waiting on the work is always relevant, even if it left yesterday.
- **A delivery claim is only what the record proves.** The register states a delivery state as the
  evidence records it. It never upgrades a settled attempt into "applied" or "sent to session" when
  the record cannot distinguish those outcomes, and *recorded* is never inferred from a delivery
  state; an answer whose outcome is not evidenced stays the neutral in-flight *waiting on the work*.
  The resolved detail reports the track and state as recorded facts, not as a claim about what the
  work did.
- **The header never oversells.** It states the filter's resolved total, the in-flight count and the
  archived count, says whether earlier records were pruned (or that nothing was pruned), and reports
  how many rows are compacted. Pruning is a cap behaviour on archived rows; a confirmed deletion is
  not a prune and does not set the flag.
- **Reopen is guarded by evidence.** A settled record reopens to `open` with its history preserved.
  An approval whose permission was used cannot be reopened; the row says why and points at
  sending a correction to the session. A compare-and-set loss is reported as a conflict with a
  refresh, never as a silent failure.
- **Delete forever is explicit and final.** It requires an acknowledgement step, writes a tombstone,
  and removes the record from the list, register, totals, session rows and all exports. Repeating the
  same delete with the same version token is idempotent rather than a second deletion or an error.
  Only an explicit authored raise of the same title later creates a new item.
- **Export covers the current filter only.** It can include archived records and transcript excerpts;
  both are options the reader sees before generating the file. In-flight answers are not exportable
  until acknowledged, and the dialog says how many are held back. The file is generated in the
  browser, written locally, and never sent anywhere.
- **Byte-determinism, stated so it can be tested:**
  1. Same records, same filter, same export options (including the export time), same versions ⇒
     byte-identical output, including the file name. The export time is the only clock value and is
     carried explicitly, so two exports of the same rows at different moments differ only in that
     header field; an identical input produces identical bytes.
  2. The only clock value in any output is the export time; every other timestamp is
     derived from the records. Times are ISO-8601 UTC, text is UTF-8, line endings are LF, and
     numbers use a `.` decimal separator.
  3. Records sort by resolution time descending, tie-broken by item id ascending, comparing code
     units rather than locales. Filters are applied before sorting. The HTML groups by UTC day.
  4. The file layout is fixed and versioned: CSV column order and JSONL key order are declared and
     documented; adding a field bumps the export schema version; removing or reordering one is a
     breaking change.
  5. The HTML embeds one frozen stylesheet built from a pinned token snapshot, light values with dark
     applied only by the reader's colour-scheme preference. It never reads the live theme, never
     loads a font, image, script, stylesheet or CDN, and emits no inline event handlers. The DOM
     structure is fixed: one record article per resolution with stable data attributes for item id,
     source and outcome.
  6. Every record-derived string is escaped; URLs are not auto-linked; the page is readable with CSS
     disabled. There is no install identity and no absolute local path; session references carry the
     title and a short id only.
  7. Every file starts with an honest header: export schema version, plugin version, the filter
     description, the record count, whether records were pruned or compacted, and the export time. A
     snapshot never presents itself as complete when it is not.
  8. The file name is deterministic: `open-items-<newest resolution stamp>-<count>-<filter slug>.<ext>`;
     a repeated identical export produces the same name instead of a random suffix.
  9. Determinism is verified, not asserted: golden-file tests generate from a fixture register under
     a fixed timezone and locale, assert a second run is identical, and pin the frozen stylesheet
     token map so a theme edit cannot silently change exported bytes.
- **Export is streamed and bounded.** Large selections are assembled from ordered chunks into the
  download rather than flattened into one string; a failure to generate or download is reported as a
  named reason and never as a completed export.
- **Accessibility and locale.** The export dialog is a modal with a focus trap, Escape and a labelled
  title; its result is announced. The register's filters are labelled menus that name their current
  value; status is text, not colour. All copy is locale-owned with complete dictionaries, and times
  are rendered from one injected clock tick.

## Problem

Once an item is answered it leaves the inbox, and the user is left with no durable answer to two
questions that matter more later than at the moment of answering: *what did I decide?* and *did the
work act on it?* Without that record the inbox is a to-do list that forgets, and the classes whose
silent disappearance confused users most — decisions the user made and items that closed on their
own — stay invisible. A journal that claims completeness it does not have, or a "what happened next"
line the product cannot observe, would be worse than no journal: it would turn an accountability
record into decoration.

The register also has to leave the app: users review decisions, share a snapshot with someone who
does not run DSH, or keep an archive. A file that changed between identical exports, carried the
browser's timezone or leaked local paths could not be diffed, trusted or handed over.

## Solution

The Resolved section is a read-only journal of the register. It opens with an in-flight band for
answers waiting on the work, then groups every resolution by the reader's local day, newest first,
with per-day counts. Each row states the source in a glyph **and** a word (✓ by you, ✓ muted,
↗ in flight, ○ automatic), the resolution outcome, the decision, the session it belongs to, and the
acknowledgement in plain words; a detector-closed row names the detector. The header states the
filter's totals and whether anything was pruned or compacted. The row's detail repeats the
decision verbatim, how it travelled and what happened next, and offers the only two writes the
register has: Reopen (guarded)
and Delete forever (confirmed). The whole current filter can be exported to a deterministic, local
CSV, JSONL or self-contained HTML file whose header names the filter, the counts, the completeness
and the versions — a file that is byte-identical when the same records, options and export time are
generated, and that never leaves the machine except by the user handing it over.

## User Stories

1. As a user, I want a durable record of what left the inbox, so that I can look up what I decided
   without scrolling old conversations.
2. As a user, I want the register ordered and grouped like a journal, so that I can find "what
   happened on Tuesday" without reading a timeline.
3. As a user, I want to narrow the register by period, source, kind, outcome and text, so that a
   specific decision is findable.
4. As a user, I want in-flight answers shown before the history and their acknowledgement stated
   honestly, so that I can tell "the work acted on it" from "the work never ran".
5. As a user, I want the header to admit when records were pruned or compacted, so that an
   incomplete register never looks complete.
6. As a user, I want to reopen a settled item or delete a record forever with an explicit
   confirmation, so that a mistake in the register is correctable and a sensitive record is
   removable.
7. As a user, I want to export the current filter to a file I can review, keep or share, so that the
   register is useful outside the app.
8. As a user, I want the same filter to export the same bytes locally and honestly, and a failed
   export reported rather than claimed, so that a file I keep or share contains only what it says.

## Acceptance Criteria

Per story, the scenarios that define done, written as behaviour, not code. One scenario = one
action; several assertions about that action are fine, a second action is a second scenario.

### Story 1 — a durable record of what left the inbox

```
Given the register holds
       an in-flight item: answered 12 seconds ago, no acknowledgement yet, session "dsh-highlights"
       a resolution R1: answered by you at 14:02 today, session "dsh-highlights"
       a resolution R2: detector-closed at 18:40 today, session "Hookshot"
       a resolution R3: dismissed by you yesterday, session "AMD stability review"
When  the user opens the Resolved section
Then  the in-flight band appears first, stating one answer awaiting the session, and does not claim
      it was applied or sent to session
      then Today contains R1 before R2 with a count of 2 decisions, then Yesterday contains R3
      no row offers an answer control; only the register's own actions are available
      R1's source reads as glyph ✓ plus the words "by you"; R2's source reads as glyph ○ plus the
      words "automatic" and the detector family in words, so the state survives colour removal
```

### Story 2 — journal order and day boundaries

```
Given a resolution at 23:58 yesterday local time and another at 00:02 today local time
      both in the same session
When  the user opens the Resolved section with the default 30-day period
Then  the second appears under Today and the first under Yesterday
      ordering inside each day is newest first, with an item-id tie-break for identical timestamps
```

### Story 3 — filtering the journal

```
Given the register holds resolutions by the user and by detectors in two kinds and three sessions
When  the user narrows the register to automatic resolutions in the last 7 days
Then  the list, the header's resolved total and the export's record count all describe that same
      filtered set
      "Clear filters" restores the 30-day/all-sources/all-kinds/all-outcomes default
```

```
Given a resolution older than the active window whose transcript-derived text was dropped,
      and a current-period resolution
When  the user selects the Archive period
Then  only the archived retention-class record is listed, and its detail states that the transcript
      excerpt is no longer stored
      the in-flight band is absent, and the header's archived total is non-zero
```

### Story 4 — in-flight and acknowledgement honesty

```
Given a resolution by the user whose acknowledgement is observed from the retried call
When  the user opens its detail
Then  the detail states that it was acknowledged by the retried call, with the evidence named
```

```
Given an answer the user sent whose acknowledgement window elapsed with no evidence
When  the user opens its detail
Then  it states "No acknowledgement observed" with no failure wording, and offers Reopen
```

### Story 5 — the header never oversells

```
Given the resolved-record cap pruned the oldest archived rows for this install
When  the user opens the Resolved section
Then  the header states the resolved, in-flight and archived totals
      and says "earlier records pruned"; when nothing was pruned it says "nothing pruned" instead
```

### Story 6 — reopen and delete forever

```
Given a resolved question that was answered by you and whose permission was never used
When  the user activates Reopen on it
Then  the item returns to Needs you as open, the register removes the row, and a notice confirms
      the reopened item and the previous resolution stay in the register's history
```

```
Given a resolved approval whose permission was used and whose acknowledgement was observed
When  the user looks at that row's Reopen control
Then  Reopen is disabled with the stated reason that a permission already used cannot be
      un-exercised, and the row directs the user to send a correction to the session
```

```
Given a resolved record whose transcript contains sensitive text
When  the user completes the confirmed "Delete forever" action
Then  the record is tombstoned and leaves the register, the totals and every export
      the session transcript is unchanged, and a repeat of the same delete token is idempotent
```

### Story 7 — exporting the current filter

```
Given the register is filtered and the export dialog is open with one in-flight answer in scope
When  the user exports as CSV
Then  the in-flight answer is not in the file, and the dialog states that it is held back until the
      session acknowledges it
      the file's header states whether earlier records were pruned
```

### Story 8 — deterministic, local and honest export

```
Given the register is filtered to the last 30 days, all sources, no search, and an export of that
      filter as HTML with transcript excerpts excluded was generated at a fixed export time
When  the same records, options and export time are generated again
Then  the second file is byte-identical to the first and carries the same deterministic file name
      the header names the filter, the record count, the export schema version, the plugin version,
      the pruned/compacted state and the export time
      no other clock value, timezone, locale, install identity or absolute path appears in either file
```

```
Given the same filtered register and an environment in which the file cannot be downloaded
When  the user exports as JSONL
Then  the dialog reports the failure with a named reason and no success
      no file name or size is claimed, and the register and its filters are unchanged
```

## Design Decisions

- **The register is a journal, not an inbox.** It is read-only except for Reopen and Delete forever;
  answering belongs to the inbox, so the register cannot become a second action surface competing
  for the same item.
- **In-flight first, and acknowledgement as the accountability axis.** An answer that left the user
  but was never acknowledged is the case the user most needs to see, so the band is period-
  independent and always first. "No acknowledgement observed" is stated as a fact; treating it as a
  failure would be a claim the evidence does not support.
- **The source is two-channel.** Glyph plus word (plus the detector code for detector closures)
  makes the record readable without colour, in a screenshot, in print and with a screen reader; it
  also makes an unknown detector auditable instead of silently normalised.
- **Local days for reading, UTC days for files.** A person reads in their own calendar; a file that
  will be diffed and shared must not change with the exporter's timezone. The two groupings are
  deliberately different and both are stated.
- **Filters govern the header and the export, and are mirrored client-side.** The header must be a
  statement about exactly the rows shown, and the export a statement about exactly the filter — so
  the list, totals and file share one selection, and a slow or older host cannot make them disagree.
- **The header admits incompleteness.** Pruning and compaction are stated whenever they apply,
  because a journal that claims completeness it does not have is worse than no journal.
- **Reopen preserves history; the one refusal is a correction.** Reopening restores open with the
  prior resolution kept in the log. A used permission is the one thing the domain cannot
  un-exercise, so that row offers a correction to the session instead of a misleading Reopen.
- **Delete forever is a tombstone, not a deletion of history.** The record leaves every read surface
  but stays a tombstone that cannot be re-raised, archived or pruned, so deletion is final without
  corrupting the register's invariants.
- **The export is a pure function of records and options.** No clock except the export time, no
  randomness, no locale, no timezone, no network, a fixed and versioned layout and a frozen
  stylesheet — which is what makes byte-determinism testable and a kept file trustworthy.
- **The reader is told what the file will and will not contain.** Format, archive and excerpt options
  are chosen before generation; in-flight answers are excluded and said to be excluded; a pruned or
  compacted register is stated in the file itself.

### Deferred Decisions

- **A host-side acknowledgement/outcome filter** — the register displays acknowledgement per row but
  cannot query by it beyond the rows already loaded. *Seam:* the query vocabulary's structured
  filters; adding one changes the query, not the read model.
- **A dedupe-key lookup ("has this come up before?")** — the record keeps its dedupe key, so a lookup
  can be added without a schema change. *Seam:* the same register index the filters query.
- **Copying the filtered rows as TSV and printing the filtered view** — non-file conveniences over the
  same filtered selection. *Seam:* the export generator's selection is the single source for what the
  filter holds.
- **An evidence reveal and a delivery timeline in the resolved detail** — the record already stores
  the delivery attempts, evidence coordinates and resolution log. *Seam:* presentation over existing
  record fields.
- **A per-format default for transcript excerpts** — whether a format should include body and quote
  by default, or always require the reader to opt in, is a privacy-vs-convenience decision. *Seam:*
  the include-excerpts option and the dialog summary.
- **A per-session sidebar pip or session header chip into the session-filtered register** — recorded
  with the other doorway decisions in [../CONTEXT.md](../CONTEXT.md).

## Testing Strategy

- **Behavioural tests through the register's pure derivations and the generated file bytes.** Order:
  filtering and query mapping; ordering and day grouping; source and acknowledgement presentation;
  in-flight band rules; header totals and prune flag; reopen and delete; then the export formats.
- **A good test** fixes one register fixture and one filter, performs one action, and asserts the
  computed rows, header line and (for export) the exact generated content. Copy is asserted through
  locale keys, not markup snapshots.
- **Determinism is tested, not asserted.** Golden-file tests run the generators from a fixture under
  a pinned timezone and locale, compare against checked-in files, assert a second run over the same
  input is byte-identical, and pin the frozen stylesheet token map so a theme change cannot silently
  move exported bytes.
- **Mock only system boundaries:** the host route, the download environment (Blob/object URL/anchor
  seams) and the clock. Filtering, ordering, grouping and rendering run for real.
- **Non-determinism control:** injected clock for relative labels and the export time; fixed record
  timestamps and ids in fixtures; explicit local-midnight boundaries asserted against a pinned zone,
  never the machine's.
- **Invariants pinned by tests:** filters never disagree with the header or the export; a tombstone
  never appears in a read or a file; an in-flight answer never appears in an export. These are the
  places where the register could start claiming something it cannot prove.
- **Locale parity** is asserted key-for-key per language.

## Out of Scope

- The item lifecycle and resolution semantics — what a resolution is, the acknowledgement window, the
  retention classes — belong to Attention Register and Durability & Integrity; this spec covers how
  the register renders them and what may be claimed.
- The delivery evidence and claim rules — published by Answering & Delivery.
- The page's other sections and their composition: [inbox-page.md](inbox-page.md); the in-session
  surfaces: [in-session-surfaces.md](in-session-surfaces.md).
- Retention mechanics (prune-on-append, archive sweep) and the tombstone's storage rules: Durability
  & Integrity and Attention Register.
- Browser print and clipboard conveniences beyond copying one decision (see Deferred Decisions).

## Open Questions

- **Which default should transcript excerpts have per export format?** A data-minimal default (off
  for CSV and HTML, on for JSONL where the full record is the point) protects shared files; a
  convenience-first default is kinder to a reader who wants their words. The product owner decides
  with the export dialog's option set.
- **Should the exported HTML group by UTC day or by the reader's day with an explicit offset?** UTC
  keeps the file byte-identical across machines; a local day with a stated offset is more readable.
  This needs the export owner's call and a header field if it changes.
- **Should the archive period be visible when nothing has ever been archived?** Showing it always
  teaches the model of the register; hiding it reduces dead options. Needs the product owner with
  the register's deferred decisions.
