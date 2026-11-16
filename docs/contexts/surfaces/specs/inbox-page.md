# Inbox page — capability spec

**Context(s):** Surfaces · **Date:** 2026-11-15

> Intent spec. It states what the capability is for and what it must do; it does not describe
> files, functions or snippets. The design packet and the code own mechanics.

## Definitions

Canonical meanings are in [UBIQUITOUS_LANGUAGE.md](../../../UBIQUITOUS_LANGUAGE.md). Every term this
spec relies on:

- **Page** — the Open Items view in the main content area: one page bar, one section strip, one
  shared list region and one detail region at most. The only surface showing items from more than
  one session at once.
- **Section** — one of the four partitions of the one register: Needs you, Candidates, Snoozed,
  Resolved. A section is a filter, not a separate store, and each **section read** carries that
  section's lifecycle states (and, for Candidates, the candidate tier) because one section's window
  cannot tell us another's rows.
- **Needs you** — the published predicate: structural, `open` or `stale`, severity 1 or 2, not a
  tombstone (the record left by Delete forever, excluded from every list and count). The word always
  means this predicate, never "anything open".
- **Candidate** — an inferred item of the candidate tier awaiting confirmation. Never answerable as
  an item; never counted as Needs you until promoted (confirmed as a structural item, with its kind
  and title correctable first).
- **Row / detail pane / selected** — the row is the scan projection of an item; the detail pane is
  the one place owning its context and answer form; *selected* means the detail is showing it.
  Selecting is not navigating; only "Open session" leaves the page.
- **Grouping / workspace lens / facet / Ungrouped** — grouping arranges the list by Session
  (default) or by Workspace (the lens). A facet is a single-select filter over a grouping dimension;
  the workspace facet selects All workspaces, one workspace, or **Ungrouped** — the real, recurring
  bucket for items whose session had no workspace membership when the item was raised.
- **Workspace snapshot** — the workspace id (identity), title (display) and path (display only)
  stored on the item when raised. Ownership is workspace-id membership, never path.
- **Global counts / new since last visit / dot** — global counts are over every stored record and do
  not change with search, narrowing, grouping or paging. *New since last visit* counts items first seen
  at or after the last visit watermark and drives the navigation **dot** and the per-row new mark; it
  is not a filter. The dot means "there is something new", never a number.
- **Page state** — filter, grouping, workspace/session narrowing, search, folds, selection and list
  scroll position; it survives leaving the page and coming back.
- **Snapshot / revision / freshness / refreshing** — a snapshot is one host read carrying global
  counts, session and workspace rows, the requested section's items, a cursor and a monotonic
  **revision** by which a client can tell it holds older data. **Freshness** is the re-read policy:
  own writes, window focus, visibility return, carrier reset, and a slow poll while visible.
  **Refreshing** is a re-read with a snapshot already on screen; the list must not blank.
- **Paging / Load more** — reading further rows through a cursor and appending them; the counts keep
  describing the install while the list describes the loaded pages.
- **Search / session filter / handoff** — search is a local, case-insensitive substring match over
  title, body, session title and workspace title of the loaded section. The session filter narrows
  the list (set by a handoff, shown as a removable chip). A handoff is navigation into the page
  carrying a target section, item and/or session scope, and it must land on a surface that can
  contain its target.
- **Answerable / reply descriptor** — answerable is whether an item can be settled or delivered from
  this surface now; an unanswerable item shows the reason. The reply descriptor states the controls,
  the verbatim options, whether free text is allowed, and the copy note a row must render.
- **Approve & retry** — the only action offered on a mirrored approval whose live request has
  expired: an instruction asking the work to re-issue the action, which produces a new request. It is
  never an approval of the expired request and never a retroactive grant; selecting it requires an
  explicit confirmation, the instruction travels to the session as a message, and the surface claims
  "Sent to session", never "Applied". The action's meaning is owned by
  [approval parity](../../answering/specs/approval-parity.md).
- **Waiting for a client** — the row state for a live ask that no owner browser currently holds. The
  request is observed only: the row says it is waiting for a client, offers no normal answer control,
  and is not recorded as if it had been settled. The state clears when a client returns. The
  delivery machinery belongs to [inline answering](../../answering/specs/inline-answering.md).
- **Delivery state** — the evidenced state of a reply attempt: sending, settled, queued, delivered,
  acknowledged or failed, with a named failure reason; a row states it only when it exists. The
  immediate outcome of the write may name applied, sent or recorded; a rendering after a reload
  states only what the record proves, and where the record cannot distinguish an applied answer
  from a recorded one it shows the neutral in-flight state, *waiting on the work*.
- **Wake cost** — resuming a cold session spends a turn. It applies to **every** path that would
  resume one — a message sent to the session and the settle of a continued ask — and the page states
  the cost before the click and requires explicit confirmation; a settle never suppresses the wake
  line. Which path applies is the answer matrix's decision
  ([inline answering](../../answering/specs/inline-answering.md)).
- **Zero-item state** — an empty section that is explained: what has been scanned, whether capture
  has reported, whether capture mounted. An unexplained empty list is a defect.
- **Snooze / dismiss** — the two user actions that never reach the work: snooze defers an item until
  a stated instant, dismiss records that the item is not one.
- **In-flight band** — the top region of the Resolved section listing answers that left the user but
  have no terminal acknowledgement yet. The awaiting line links to it.
- **FYI group / awaiting line** — FYI is a collapsed group at the end of Needs you for structural
  severity-3 items: rendered so they are not lost, never counted. The awaiting line at the top of
  Needs you reports answers waiting on the work and links to the in-flight band.
- **Keyboard subset** — the fixed application keys: next/previous row, select, clear, send, snooze,
  dismiss. They never fire while typing, during IME composition, while a menu or dialog is open, or
  after another handler consumed the key.
- **Locale namespace** — the single dictionary this plugin owns: complete dictionaries per supported
  language, counted strings as singular/plural entries, and no concatenated sentences.

## Constraints

- **Global counts, one Needs-you predicate.** The page head states exactly two actionable counts —
  Needs you and Candidates — and hides a zero count rather than rendering it as zero. Every
  Needs-you number (badge, navigation label, group count) comes from the one published predicate;
  the Candidates count is its own count and is never folded into Needs you. Filters, grouping,
  search, session scope and paging never change the counts, and facet and group counts describe what
  they group and sum consistently with their section.
- **Newness and count are separate signals.** The dot is "new since your last visit"; the page title
  badge is the global Needs-you count; a row's mark is "first seen at or after the last visit".
  Opening the page advances the visit marker once and freezes the row marks for that visit.
- **Ordering is deterministic and host-owned.** Item order: severity ascending, then first-seen
  ascending, then item id ascending. Groups: newest activity descending, Ungrouped last. Concatenated
  pages are globally ordered.
- **Each section reads its own population.** Switching sections re-reads; until the new read lands
  the list shows loading, never the previous section's rows or its empty copy.
- **Loading, refreshing and failure are distinct.** No snapshot → skeleton rows inside the page
  frame. Snapshot plus a re-read in flight → the list stays, with a non-visual refreshing
  announcement. Snapshot plus a failed re-read → the last good list stays, labelled with when it was
  read, with a named reason and Retry. No snapshot plus a failed first read → error state with Retry.
- **Every empty state explains itself.** A truly empty section shows section-appropriate copy and,
  where capture diagnostics exist, what has been scanned or that scanning is still running. A
  filtered-empty list names the term and the section and offers to clear the filter.
- **A claim is only made when its evidence exists, and a durable claim is narrower.** Dismiss and
  snooze never reach the work. The immediate result of a reply may say applied, sent or recorded, and
  a failure keeps its named reason and Retry. A rendering after a reload states only what the record
  proves; where the record cannot distinguish an applied answer from a recorded one it shows the
  neutral in-flight state, never "applied" or "sent to session", and *recorded* is never inferred
  from a delivery state. Retrying a **failed** attempt is a new attempt with a new delivery id; the
  same identity is reused only to recover a lost response of the in-flight attempt. Every path that
  would resume a cold session states the cost before the click.
- **A request that is gone offers recovery, not a grant.** When a mirrored approval's live request
  has expired, no Allow control is rendered and "Approve & retry" is the only action. Its
  confirmation states that the work is being asked to re-issue the action, that this is one-off and
  that it applies only to the new attempt; after confirmation the surface claims "Sent to session"
  and no approval outcome is recorded against the expired request. A live ask that no owner browser
  holds renders the "waiting for a client" state instead of an answer control and is observed only;
  neither case is ever presented as a grant or a settle.
- **Deterministic presentation rules.** Relative times come from one injected 60-second clock tick,
  so labels in one pass never disagree; grouping day boundaries are the reader's local midnight;
  absolute timestamps appear locale-formatted in tooltips. Grouping, ordering and counts are pure
  functions of snapshot and page state.
- **One detail at most per layout.** Wide: list plus independently scrolling detail. Medium: one
  selected row expands in place. Narrow: a pushed detail page with a back control. Re-selecting the
  open row closes it; selecting another replaces it.
- **State survives navigation.** The page unmounts when a session opens, so page state lives outside
  the page component and must return unchanged.
- **Keyboard and accessibility.** The subset is next/previous/select/clear/send/snooze/dismiss;
  approvals deliberately have no single-key shortcut. Rows are real buttons; option sets are radio
  groups; async results are announced through a live region; after a cleared item leaves the list
  focus moves to a neighbouring row, never to the body; status is never colour-only; target sizes,
  reduced motion and 200 % zoom are respected.
- **Internationalisation.** All copy is in the one namespace, complete key-for-key per language,
  counts use explicit singular/plural entries, and the host sends structured values, never prose. A
  missing session title renders as an untitled label, never as "deleted".
- **Paging is honest.** Counts and the navigation label describe the whole install; the list
  describes the loaded pages. A further-page failure is reported beside Load more and never replaces
  the list.

## Problem

Work happens in conversations, and a conversation is a bad place to keep a decision: the message
that raised it scrolls away, the session closes, and other sessions are waiting on something else.
From the chat the user cannot tell which sessions need them, whether a decision already left their
hands, or whether a list is empty because nothing waits or because capture has not caught up. The
obvious alternative — a second chat window — duplicates every thread and drifts from it.

What is broken is not "we cannot chat about decisions". It is that attention has no durable, honest,
cross-session place to land: one that says how much is waiting, lets an item be cleared with one
deliberate action without reading a transcript, groups work the way the user thinks about it, and is
explicit about what it does not know.

## Solution

An email-style inbox page in the main content area, where an item — not a thread — is the unit. It
has four sections (Needs you, Candidates, Snoozed, Resolved), opens on Needs you grouped by the
session that raised each item, and offers a workspace lens and workspace facet for project-shaped
thinking. One shared list/detail region serves every section: selecting never navigates, and only
"Open session" leaves the page. Rows state kind, title and provenance; a candidate row shows the
evidence it was inferred from; any row that left the open list states its delivery state. Snooze,
dismiss and the one answer form live where the reader acts, every claim about a reply carries its
evidence, and the page says what it is: counts global, emptiness explained, offline labelled with
the last read time, and filters returnable exactly as left.

## User Stories

1. As a user, I want a cross-session list of what is waiting on me, grouped by the conversation that
   raised it, so that I can triage without opening every chat.
2. As a user, I want the page-title count and the navigation label to state one consistent number,
   so that I can believe it.
3. As a user, I want to group the same list by workspace, so that I can answer "what does this
   project owe me?" without a second page.
4. As a user, I want to answer, snooze or dismiss an item in place, so that clearing attention does
   not require reading a transcript.
5. As a user, I want to see a candidate's own words before confirming or refusing it, so that the
   register does not fill with guesses.
6. As a user, I want the page to update when I come back to it, so that I am not looking at a list
   the work has moved past.
7. As a user, I want honest loading, empty, offline and error states, so that I can tell "nothing is
   waiting" from "I cannot see".
8. As a user, I want to return to the page and find my filters, grouping and scroll position as I
   left them, so that triage is not restarted every time I check a chat.
9. As a user whose register is long, I want to load more rows without the page falsely implying it
   has shown everything.

## Acceptance Criteria

Per story, the scenarios that define done, written as behaviour, not code. One scenario = one
action; several assertions about that action are fine, a second action is a second scenario.

### Story 1 — a cross-session list grouped by session

```
Given an install whose register holds
       item A: structural, question, severity 1, open, session "dsh-highlights", raised 2 minutes ago
       item B: structural, decision, severity 2, open, session "dsh-highlights", raised 1 hour ago
       item C: structural, follow-up, severity 3, open, session "Hookshot", raised 1 day ago
      and the navigation dot is showing because 3 items are new since the last visit
When  the user opens Open items from the navigation row
Then  the page shows Needs you selected, grouped by session
      rows are A then B inside the "dsh-highlights" group, and C is collapsed under FYI
      the head states exactly two actionable counts: 2 waiting (Needs you) and no Candidates badge,
      because a zero count is hidden rather than shown as zero
      the navigation dot has cleared and the navigation label carries the same Needs-you count
```

```
Given the page is open on Needs you with 2 waiting, and the register also holds
      item G: structural, blocker, severity 2, snoozed until two hours from now, session "dsh-highlights"
When  the user selects Snoozed
Then  the list is re-read for snoozed states and shows item G with the time it wakes
      the page title's Needs-you badge still shows 2 waiting
```

### Story 2 — one consistent number

```
Given the page is open on Needs you and the count badge shows 2 waiting
When  the user types "pnpm" into the list search field
Then  the list shows only rows whose title, body, session title or workspace title contains "pnpm"
      the page-title Needs-you badge still shows 2 waiting
      the workspace facet's counts describe the searched section — a zero-count workspace stays at
      zero — while the page-title Needs-you badge still shows 2 waiting
```

### Story 3 — the workspace lens

```
Given a register holding
       item D: structural, approval, severity 1, open, workspace "Hookshot" (id w1),
               session "AMD stability review"
       item E: structural, question, severity 2, open, workspace "Hookshot" (id w1),
               session "Vulkan driver audit"
       item F: structural, decision, severity 2, open, no workspace membership, session "legacy scratch"
When  the user changes Group by from Session to Workspace
Then  the list nests workspace groups above session groups above rows
      "Hookshot" appears first and "Ungrouped" last
      the Hookshot header states 2 items and 2 sessions; the Ungrouped header states 1 item
```

```
Given the workspace lens is showing "Hookshot", a workspace "Ledger API" has zero matching items,
      and an item's workspace "Tidepool" has since been removed
When  the user opens the workspace facet
Then  it lists All workspaces first, "Ledger API (0)", the remembered "Tidepool (workspace removed)",
      and Ungrouped last
      the removed workspace appears under its remembered title, never merged into another workspace's
      count
```

### Story 4 — answering in place, honestly

```
Given item J is a continued question in session "Vulkan driver audit", the session is cold, and the
      reply contract routes the answer as a settle that would resume it
When  the user submits the answer "Use the corporate registry" from item J's detail
Then  the page states that answering resumes the session and spends a turn, and requires explicit
      confirmation before anything is sent
      no settle is sent until the reader confirms
```

```
Given item K is a mirrored approval whose live request has expired, and its row offers only
      "Approve & retry" — no Allow control — together with the confirmation saying that the work will
      be asked to re-issue the action, one-off and only for the new attempt
When  the reader confirms the "Approve & retry" instruction
Then  exactly one message asking the work to re-issue the action is sent for item K, carrying no
      approval payload, and no approval outcome is recorded against the expired request
      the row claims "Sent to session", never "Applied"
```

```
Given item E is a question in session "Vulkan driver audit" whose turn is not running,
      the reply contract says a message would resume the session and spend a turn,
      and the page has shown that cost and asked for the explicit wake confirmation
When  the reader confirms "Send & resume now" for the free-text answer "Keep the 5-colour palette"
Then  exactly one message is sent for item E
      the row states "Sent to Vulkan driver audit. It will pick this up and spend a turn", never
      "applied"
```

### Story 5 — candidates are reviewed, not answered

```
Given candidate H: inferred decision, tier candidate, state open, session "Mock query builder",
      quote "E — ship the dual-write path now or defer a week?", inferred at the end of turn 4,
      and no other candidate
When  the user confirms H as "It's an item"
Then  H leaves the Candidates list, the Candidates badge goes from 1 to 0, and H appears in Needs you
      as a structural item with severity 2 and blocking set
      before the confirm, H's row showed the quote and its turn, and offered only the two candidate
      controls — never an answer control
```

### Story 6 — the page updates when I return

```
Given the page is open on Needs you showing item A, and item A was answered from another surface
When  the window regains focus and the page's re-read lands
Then  item A is gone from the list and the Needs-you badge has decremented
      the page did not remove or rewrite the row before the re-read landed
```

### Story 7 — honest loading, empty, offline and error states

```
Given the page is open with a snapshot read 4 minutes ago and item A still listed
When  a re-read fails because the harness is unreachable
Then  the last good list remains readable, labelled with the time it was read, with a named reason
      and a Retry control
      reply controls are disabled with the reason stated, and no row claims to have been updated
```

```
Given capture is mounted, a completed backfill pass has scanned 12 of 20 stored sessions, and the
      register genuinely has no Needs-you items
When  the user opens the page
Then  the empty Needs you section states that nothing is waiting on the user and explains that the
      backfill has scanned 12 of 20 stored sessions so far
      it does not state or imply that the register is broken
```

```
Given a mirrored question whose live request is still open but no owner browser currently holds it
When  the user opens the page and its row renders
Then  the row states that it is waiting for a client and offers no normal answer control
      it does not claim the question was settled, and it records no reply while no client holds it
```

### Story 8 — my place comes back

```
Given the user selected the Snoozed section, narrowed to workspace "Hookshot", scrolled the list,
      and then opened a session from the page
When  the user returns to Open items
Then  the same section, workspace facet and list scroll position are restored
      and no selection is claimed for an item the current section does not contain
```

### Story 9 — paging is bounded and honest

```
Given Needs you holds 120 matching items and the first page of 50 carried a cursor
When  the user activates Load more and the next page of 50 rows succeeds
Then  100 rows are listed with no duplicated item ids and in the same global order the first page
      followed
      the page states that the counts cover every session while the list shows the loaded pages
```

## Design Decisions

- **Four sections over one register, not four lists.** Each section filters the same register and
  reads its own population; the count predicate is the register's, so no surface can contradict
  another, and "the number beside the title" describes the install rather than the current tab.
- **The dot means newness and the page title carries the number.** The dot answers "is there
  anything for me?" and clears on a visit; the count has one readable seat. The watermark advances
  only when the page opens, so an app left open keeps a truthful dot.
- **The workspace lens is the project question, and Ungrouped is first-class.** Session grouping is
  the default because the conversation is the context the user already has; the workspace lens is a
  mode of the same page, so no second route or navigation entry is needed. Ownership by workspace
  id (never path) prevents renames and re-created paths from merging two projects' items. Zero-count
  workspaces stay visible in the facet so "this project is clear" is readable; a removed workspace
  keeps its remembered title.
- **One shared list/detail region and one answer form.** Rows scan; the detail owns the answer being
  composed. This keeps "a row is a projection" true and renders the same item identically at every
  width. Page state lives outside the component because the page unmounts when a session opens.
- **Candidates are review, not answers.** A candidate is confirmed or refused and its kind/title can
  be corrected first; it is never answerable as an item and never counted as Needs you before
  promotion. The quote and the inferred-at turn are part of the row contract, because a guess
  without its words cannot be judged.
- **The page states its own limits.** Counts describe the install, the list describes loaded pages,
  and empty/loading/refreshing/offline/skew each say what they mean, with a retry where a read could
  later succeed.
- **Claims are the reply contract's words.** The page renders the published outcome and failure
  reason; it never invents a friendlier phrase. Approvals keep their required confirmation and are
  never granted by one keystroke or click.
- **The keyboard is a deliberate subset.** Fixed application keys cover movement, opening, clearing
  and submitting; every dangerous decision keeps its confirmation and focused-button path, and the
  rest of the map is a separate decision.

### Deferred Decisions

- **Kind and age filters** — the filter bar already carries search, the workspace facet, grouping
  and the session chip; adding kind/age changes the bar, not the read contract.
- **Additional keyboard bindings and a visible hint row** — the fixed-application-key seam and
  locale-owned labels keep these additive.
- **A live delta or staleness channel** — freshness is pull-based; the snapshot's revision lets a
  future channel change the trigger without changing what the page renders.
- **Per-session doorway surfaces and a workspace context-menu entry** — the page and panel are
  reachable without them; the doorways are a harness-seat decision recorded in
  [../CONTEXT.md](../CONTEXT.md).
- **Row density and other presentation refinements** — the read model already carries what a denser
  row needs.

## Testing Strategy

- **Behavioural tests through the page's own interface and pure derivations.** Order: section
  derivation and the counts invariant; grouping and the workspace facet; the newness watermark;
  loading/empty/offline/skew states; paging; the keyboard subset; candidate confirm/refuse and bulk.
- **A good test** fixes one snapshot and one page state and asserts rows, order, badges and the
  announced copy — one concept per test, through the public interface, never a snapshot of markup or
  class names.
- **Mock only system boundaries:** the host route, the shell's services (slot registration, session
  catalogue, shortcuts) and the UI primitives package. Derivation and stores run for real.
- **Non-determinism control:** injected clock advanced by the 60-second tick, fixed fixture
  timestamps and ids, and the spec's tie-breaks; no test depends on wall time, locale default or
  insertion order.
- **Invariants** are pinned by tests: page badge = the predicate over the snapshot; facet and group
  counts sum to the section they describe; page state is restored. These are where a change could
  silently start lying.
- **Locale parity** is asserted key-for-key per language, and copy tests pin the zero-item, offline
  and claim sentences so a wording change is deliberate.

## Out of Scope

- Item semantics — kinds, tier, severity, lifecycle, resolution, acknowledgement, retention — belong
  to Attention Register and Durability & Integrity.
- The register section and its export:
  [resolved-register-and-export.md](resolved-register-and-export.md).
- The in-session card and panel: [in-session-surfaces.md](in-session-surfaces.md).
- Delivery tracks, the answer matrix and the claims they permit: published by Answering & Delivery;
  the page renders outcomes, it does not decide them.
- The settings section's permission semantics (Model Contract & Consent); the page is not a
  settings surface.
- The DSH shell's navigation, layout, locale and keyboard services, and the harness's own question
  and approval cards.

## Open Questions

- **Should the page head also carry Snoozed and Resolved count badges?** The head states the two
  actionable counts and the register reports its own totals; a third or fourth badge widens
  the head. The product owner decides whether the extra glance is worth it.
- **Should a session group header link to the register filtered to that session?** A per-session
  decision history is designed as a link from the group header; its affordance, wording and whether
  it appears only when the group has resolved items remain open. Product owner, with the register
  spec.
- **At first run, with no last-visit watermark, does the page mark every item as new?** Intended
  answer: no — a missing watermark means "do not claim newness". Recorded because it is the one
  newness case the user cannot verify from a later visit.
