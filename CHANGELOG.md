## [Unreleased]

### Prose-candidate remediation — additive per-item detection (2026-11-14)

Implements the approved remediation in
[`../research/prose-audit/IMPLEMENTATION-CONTRACT.md`](../research/prose-audit/IMPLEMENTATION-CONTRACT.md):
the shipped strict gate captured **one** item from a five-decision turn (four
lost, the fifth mis-kinded as a question). Same unreleased `0.1.0-rc.2` build;
**not live until the app restarts** (fold/projection replay 2 → 3 and the
one-time legacy migration). Evidence structure and pending measured values:
[`VERIFY.md`](VERIFY.md) §10.

#### Host — detection

- **Additive extraction.** A trailing-ask **section mode** (the last anchored
  heading among the trailing 80 non-empty lines — `decisions/questions/asks/
  open questions/your call/confirmations/sign-off`) turns each ask-like
  top-level list item into its own candidate, bounded to **5 per turn**
  (`truncated` counts the rest), layered over the shipped strict single-ask
  **fallback** (≥40 chars + marker in the last 300; marker list unchanged —
  except a bare `confirm`/`approve` now needs its own sentence to be a question
  or imperative, removing the measured "confirm guard" false positive at 0
  corpus recall loss).
  Fenced blocks and nested sub-bullets never become items; full-width `？`
  counts as a question mark.
- **The final-message state is raw.** The fold keeps the newline-preserving
  4000-char final-text tail (`tailBoundLines`) instead of a flattened 1200-char
  line, so list structure survives; old checkpoints still parse (newline-less
  text finds no section and falls back).
- **Semantic kinds.** `decision` when alternatives are presented or the section
  is decisions-like; `question` for information requests and go-ahead/permission
  asks (unless alternatives are named); the prose gate never emits `approval` in
  phase 1. The old `?`-in-tail rule is gone.
- **Markdown-clean per-item evidence.** Titles (`"<label> — <first sentence>"`,
  ≤120) and quotes (verbatim item, ≤300) strip bullets/emphasis/backticks/links;
  the body names the item ("Decision 3 of 5 from the turn that ended"); explicit
  labelled alternatives become reply `options` (`controls: ['option','text']`),
  and a yes/no option is never fabricated.
- **Per-item identity.** `prose:t<turn>:<12-hex sha256(markdown-clean quote + label)>`
  with `~2`/`~3` duplicate suffixes: stable across replay/restart/baseline, new
  per turn, no kind or position in the id.
- **Batch-aware bounds.** `maxItemsPerTurn: 5`, `maxOpenProse: 8` per session
  (replacing `cap: 2`); after a batch opens, the oldest rows *outside* that batch
  are superseded (`prose-gate:superseded-by-cap`), so a turn never
  self-supersedes. Text bound 4000; `minChars`/`tailChars`/`quoteChars` stay.
- **Lifecycle fixes.** `proseCandidates: false` gates raises only (closures
  always pass); the structural-turn marker uses `event.data.turn` on `turn/end`;
  a log that ends inside a turn still finalizes that turn's asks.
- **Extraction seam.** One bounded one-shot call per emitted prose item (never a
  closure), keyed to that draft's turn; the prompt's kind rules now state the
  §2.1 taxonomy. Extraction is still **off by default** and was not exercised
  against a live provider.

#### Host — persistence / API

- **`promote` correction patch.** `promote(itemId, expectedVersion, { kind?,
  title?, body?, quote?, options? })` applies in one CAS write: rekeys the
  dedupe key and any exact-key suppressor when `kind` changes, recomputes the
  structural `reply` from `(kind, options)`, appends `promoted` history (+
  `reclassified` when the kind changed), keeps occurrence/version, and resets
  tier/severity/blocking as before.
- **One-time legacy migration** at activation, before the capture mount: open
  legacy prose candidates (`prose:<16 hex>`) retire `detected-closed` with
  `prose-gate:superseded-by-scope-change`; legacy prose suppressors expand to
  both kind families under the session-scoped prefix; promoted structural rows
  are preserved; idempotent, counted and logged, never fails activation.
- **Reconciliation** after each backfill pass closes a candidate that duplicates
  a promoted structural row from the same session+turn **and the same ask
  identity** (normalised title/quote, so a partially confirmed multi-item turn
  keeps its unconfirmed siblings live, `prose-gate:duplicate-of-promoted`).
- **Versions 2 → 3 together**: `OPEN_ITEMS_FOLD_VERSION` and
  `OPEN_ITEMS_PROJECTION_VERSION`; `STORE_SCHEMA_VERSION` deliberately stays 3
  (no new required record field, no domain migration).
- **Tool/nudge copy** restates the §2.1 kind taxonomy and "one item per real
  decision, at most 5 in a turn"; `modelNudge` remains opt-in and default off.

#### Client

- Candidate rows/details render **projected plain text** (no `**`, no leading
  `- `) and suppress the duplicate title/quote block; an **"Inferred <Kind>"**
  badge, a kind picker and an editable title pre-filled with the projection;
  confirming sends `promote(item, { kind, title })`. Options render under "What
  you're deciding" before and after confirmation, and promoted items are
  answerable with option controls.
- Page: honest caption ("Detected in the final message of a turn — review before
  confirming"), siblings grouped ("N from this turn"), bulk **"Confirm N as
  item(s)"** with a review dialog listing projected titles and chosen/inferred
  kinds (correctable per row) before writing; ticks are pruned on
  filter/search/session/refresh and never silently dropped.
- Panel gains an "Inferred (N) → review" row routing to the Candidates tab
  (candidates still excluded from Needs-you counts); cards never offer reply
  controls for a candidate; settings/extraction/empty-state copy (en + zh) says
  the check is a heuristic on the final message, **may miss decisions**, and the
  inferred kind **may be wrong but is correctable**.

#### Behaviour/breaking notes for existing candidates

- The first activation after upgrade **retires** the open legacy prose
  candidates; they are replaced by per-item candidates from the 2 → 3 replay.
  This is an audited `detected-closed` transition, not a silent deletion. A
  previously promoted prose item is kept, and a post-replay duplicate candidate
  is auto-closed.
- Legacy prose dismissals keep suppressing the new per-item candidates for that
  session (suppressor migration, safe direction).
- Candidate rows may now arrive **several per turn**; the Candidates tab, panel
  count, bulk bar and card copy reflect the group. Candidates still never count
  as "Needs you", never enter workspace `itemCount`, and never write the session
  log.
- **Measured (this worktree, 2026-11-14 ~18:13 local / 2026-11-15T01:13Z; live
  corpus):** real-corpus acceptance over 166 log files / 152,216 events reports 1
  structural item open at log end (target ≤20 MET) plus **27 open candidates** —
  **19 prose** (`prose-gate:decision-request`, 62 raised, 43 closed) and 8 todo
  (11 raised, 3 closed); raised 85 / closed 57 / closures 90; per-kind open
  decision=13/follow-up=8/question=6/approval=1; 0 fold errors; 0 todo-derived
  needs-you rows. Pre-change strict-gate counts (57 raised / 46 closed / 11 open
  prose) are superseded. Ladder: tsc clean; 85 files / 1274 passed / 3 skipped;
  style 0 findings (1 pre-existing justified); build host 307.2 KiB / client
  286.2 KiB; smoke 0 session-log writes; a11y 0/0/0; package-check 15 payload
  files / 29 peers. Full evidence: [`VERIFY.md`](VERIFY.md) §10.

### Owner re-tag: `v0.1.0-rc.2` now tags `main` (2026-11-14)

Owner decision (via Open Items reply on the 2026-11-14 tag/version item): the
0.2.0 version line is abandoned before any release — the plugin has never left
the 0.1.0 release-candidate series. Consequences, all by owner instruction:

- Package version (`package.json`, `src/client/version.ts` `PLUGIN_VERSION`,
  and `dsh-open-items@` strings in docs) is now **`0.1.0-rc.2`**.
- Tag **`v0.1.0-rc.2`** re-created on `main`; the old rc2-line tag location is
  gone. **`v0.2.0-rc.1` deleted**; milestone tags `design-r7`, `p0-scaffold`,
  `m1-*`, `m2-*`, `m3-contract` deleted; only main's tags remain
  (`v0.1.0-rc.1`, `v0.1.0-rc.2`). The `rc2` branch was deleted earlier the same
  day (its content is in `main` via the `fa08edb` squash).
- Decision D6 ("stay on `rc2` / no new tag") is **superseded** by this owner
  decision; historical D6 texts in PLAN-remediation/GAP-ANALYSIS/this file are
  kept as the record of how it was decided at the time.
- The stale `review/scratch-*/` evidence and the orphan worktree-like branches
  are unaffected; `review/` records the pre-re-tag world as-is.

Evidence still points at the same built bytes (`lib/` rebuilt 2026-11-14
16:06:46, before this re-tag + doc edits); `package-check` must pass with the
new version constant.

### Round-4 completion (2026-11-14)

Implements the deferred round-3 items with the user-approved decisions. Same
`0.1.0-rc.2` on `main`, tag `v0.1.0-rc.2` (2026-11-14 re-tag; D6 superseded); commits after `2c04991`.

#### Added

- **One meaning of Needs you** (OI-05 reused by the panel); awaiting status line
  at the top of Needs you (from `counts.awaiting`, links to Resolved); collapsed
  **FYI group** for severity-3 structural rows (rendered, never counted).
- **Newness markers**: leading row dot = new since last visit (visually-hidden
  label), severity 1 = plain `Urgent` tag; the durable marker advances only on
  page open and is captured per mount.
- **Candidate multi-select (confirm only)**: row checkboxes on the Candidates
  tab, bulk bar, sequential promotion with per-failure reporting; "Not an item"
  stays per-row behind the permanent-suppressor confirmation.
- **Column-aligned page head** (documented OD-17 exception): at ≥880 the tab
  strip sits over the list column behind a continuing divider hairline; search
  and the workspace lens move into a list-column header; Group by stays in the
  bar. List header search keeps the in-field clear.
- **Phone section menu** (<440 page width) and **narrow pushed-detail head**
  (single `Open items` back row; pinned footer + inner scroll in the push).
- **Inline code** for backticked commands in item bodies; filtered-empty copy
  names the term and section.
- **Paging ownership** (D-17): Host comparator is the single inbox order
  (severity asc → firstSeenAt asc → id); register journal order untouched.
- **Paging failure separation** (D-12): `loadMoreError` renders beside Load more
  with Retry and never as a page-level failure.

#### Changed / removed

- The inert **compact page bar is removed** (S-01 deviation recorded in UI.md).
- **21 dead locale keys** removed (en + zh).
- Panel tests/derive updated: candidates and severity-3 items are no longer in
  the panel's Needs-you list or count (page owns those surfaces).
- Panel/card surfaces refined for consistency with the page (visual pass), dead
  CSS classes resolved.

#### Verification

An independent read-only pass over the round-4 tree found one major — FYI rows
were selectable but the selection-cleanup containment did not include them, so
their detail was painted for a frame and then cleared — plus seven minors
(duplicate bulk-checkbox name, stale ticks, paging error during a pending
section read, dangling tabpanel label on pushed/phone, bulk-bar live region,
unstyled class, duplicated client predicate, unexercised cleanup in page
tests). All are fixed in `87782ec`; the same verifier re-ran the six gates and
returned **ship: yes**.

#### Deferred (blocked upstream / owner / pending polish)

Canonical register: [`../PLAN.md`](../PLAN.md) §7.

- **Snoozed wake-time surface** — the wake ships, but no surface shows *when*;
  add "wakes in 2h" to the Snoozed row and name the instant in the toast
  (`snoozedUntil` is stored).
- **Panel filter pills labels-only** — the pills still duplicate the section
  heading/header count.
- **Detail `max-width: 600` never binds** — cleanup only.
- **Medium (640–879) inline-detail footer stays in flow** — S-19 judgement.
- **Phone/narrow pushed detail** — offline harness only until a real-device
  S-19 pass.
- **`DisclosureRow.title` ellipsis** — upstream primitive API ask (string title,
  `flex:none`), documented in UI.md; no CSS hack.
- The server/data-source ordering beyond the inbox comparator (register keeps
  its journal order by design).


### Round-3 UI/UX refinement (2026-11-14)

The refinement pass proposed by [../review/07-ui-ux-round3-review.md](../review/07-ui-ux-round3-review.md)
(two independent audits, a measured render harness and a behaviour audit). Same
version `0.1.0-rc.2` on `main`; the unreleased remediation (re-tagged 2026-11-14; D6 superseded)
below still applies. Commits: `8c00606` (rows), `b068a3f` (head/groups),
`a89abbe` (detail/answers), `726f4a2` (truth/handoffs), `eb31a11` (host wake),
`7c101d2`+`51378f0` (polish), `531e554` (docs), `4ec3e03` (independent
verification fixes + measured after pass), `2afa09e` (register in-flight
selection).

#### Fixed

- **P0 — Snooze never woke.** `state:'snoozed'` could not return: no wake sweep,
  `reopen` rejected snoozed, the reply route required `open`. `OpenItemsStore.wakeDue(now)`
  now wakes due deferrals from the periodic sweep **and** lazily on every read;
  counts move from `snoozed` to `needsYou` in the same read. No schema/protocol
  change (v3 history actions accept a `woken` entry).
- **P0 — group headers collapsed at the 400px column.** The item count was baked
  into the disclosure title (clipped mid-word) and the text `Open session`
  button wrapped to two lines inside 28px. The header is now one 32px line:
  title only, right-aligned count (only when >1) + labelled `updated …` time,
  icon-only `Open session`; the whole row toggles, nested session headers
  offset under workspace headers.
- **Answers were invisible controls.** The `Pill` option fill (`bg-layer-2`)
  equals the page background in the light theme, and its fixed 24px height
  clipped wrapped labels. Options are now a native radio list with a checked
  dot, a quiet `Recommended` tag, and native keyboard semantics; the permanent
  `Not an item` now goes through the shipped `RiskConfirmation`.
- **False empty states on section switches.** The inbox store records the
  requested/completed section key; the page renders a loading state while they
  differ, so the previous section's rows (or its empty copy under a non-zero
  badge) can no longer pose as the new section.
- **Handoffs landed on the wrong section.** `openInbox` carries the target tab;
  panel resolved/candidate/waiting rows and the in-session card select the
  section that can contain the item instead of a blank Needs-you detail.
- **Selection and focus dead ends.** Re-selecting the open row closes it (the
  medium inline detail has no visible Back); dismiss/snooze clear the selection
  and move focus to the next row; a selection the section no longer contains is
  cleared.
- An answer-draft duplication: the row no longer owns an option picker or a
  send button, so one item has exactly one answer surface and one draft.

#### Changed

- **Page head** is one `pageHead` wrapper with two 16px bands: title + inline
  count badges (`{n} waiting`, `{n} to confirm`), then labels-only tabs + view
  controls. Search is 240×32 border-box ("Filter list", in-field clear); refresh
  is an outline `sm` button with `aria-busy`/disabled while reading. Grouping is
  a labelled `Menu` (`Group by · Session`, hidden when the workspace lens pins
  one workspace) instead of a second segmented control; the workspace lens is
  the same `Menu` shape with no count in its trigger.
- **Rows** are a uniform 76px two-line card — title + labelled wait, then one
  meta line (kind mark · turn · delivery state) + the variant's one-click
  decision. The inline options, inline primary and duplicated session provenance
  are gone; selected is an accent bar + token fill; ellipsised titles carry a
  tooltip.
- **Detail** is four groups (header / content / answer form / sticky footer) on
  a 4–16px scale with `<p>` margins reset. The footer is a sticky 56px bar with
  the wake line above the buttons; the reply editor has a 72px floor; the
  `3 questions` count and machine `severity N` chip were removed.
- **Spacing/rhythm:** page-bar bottom 16, tabs row 16, columns top 16; the tab
  strip stays labels-only and inside the 400px list column; new 4/8/12/16/24
  scale for the page shell and detail.
- One status region by priority (skew > hard error > offline) instead of two
  stacking banners; the Candidates tab explains its triage contract; a visible
  keyboard hint line ships when the shortcut seam is present; task copy is
  user-facing ("Tasks are completed in the session.").
- Docs: `UI.md` revision-6 addendum and superseded rows; `review/07-ui-ux-round3-review.md`
  marks what shipped, with a re-runnable rendered before/after pass under
  `review/scratch-round3/harness/`.
- Independent verification (fresh context, read-only) re-ran all six gates and
  fixed four truth/state majors it found: handoff selections discarded by the
  section cleanup, one painted frame of the previous section after a tab
  switch, in-row Retry toggling the selection, and an unkeyed detail pane
  leaking drafts between items. Also measured-CSS fixes from the after-render:
  400px tab strip on the list divider, 32px group headers, the 72px editor
  floor, and a non-overlaying detail footer.

#### Deferred (documented, not claimed shipping)

- The column-aligned page head (list controls over the list column) needs a
  documented OD-17 exception; the phone section `Menu` (below ≈390px page);
  narrow pushed-detail head; removing the inert compact bar (S-01);
  per-row new-since-visit markers; host/client paging-order unification;
  candidate triage bulk affordances; the "one meaning of Needs you" surface
  split (awaiting/FYI sections + panel predicate) still awaits a product
  decision.


### Open-items remediation (decisions D1–D6)

> **Gate-contract note (2026-11-14):** the D2 strict-gate rules recorded below
> shipped first and were then superseded by the additive per-item contract
> (newest `[Unreleased]` entry above; DESIGN §4 step 5). This section stays as
> the historical record.

The founding-goal remediation: rc.1 shipped structural-artifact capture only, so
prose decisions and abandoned `todo_write` plans were never captured (measured
**0 of 19 expected-open root sessions**; live store **0 candidates**). This
section records decisions D1–D6 from
[`../PLAN-remediation.md`](../PLAN-remediation.md) and the shipped change.
**Status: shipped in the working tree as an unreleased build** — same version
`0.1.0-rc.2`, `main` tagged `v0.1.0-rc.2`, 2026-11-14 owner decision (D6 superseded). Round 2 adds the durable backfill
report and opt-in, deployment-configured model-assisted extraction. Evidence:
[`VERIFY.md`](VERIFY.md) §9 (round-2 addendum §9.5). It is **not live until the app restarts** (the
linked `web` profile loads `lib/` at boot; activation then replays fold version 2
and runs the one-time team-task retirement).

#### Decisions

- **D1 — prose/decision capture is must-ship core.** The candidate tier is no
  longer a deferred surface.
- **D2 — strict candidate gate.** Only the final assistant text of a turn, with
  a question/decision marker in its last 300 characters, one-click
  confirm/promote, never counted as "Needs you" until confirmed.
- **D3 — `todo_write` abandonment ships as one aggregate candidate per session**
  (phase-3 fold). This overturns the old `todo-derived=0` acceptance invariant:
  the invariant becomes "no todo-derived row reaches Needs you".
- **D4 — the model nudge stays opt-in**, so a conventional **Settings → Open
  Items** page with a toggle and description is required.
- **D5 — team-task item raising is disabled** until the liveness gate is
  redesigned; existing false task rows are retired on the next restart.
- **D6 — stay on the `rc2` branch / `0.1.0-rc.2` semantics**; no version or
  package rename (this is an Unreleased changelog entry, not a new tag).

#### Added

- **Prose candidate detector** (`folds/prose.ts`): a pure `proseGateOf(text)`
  gate over the final assistant text, emitting `tier: 'candidate'` rows with a
  quote, turn, `prose-gate:decision-request` code and one-click confirm;
  candidates are closed by a later user message or the per-session cap, and the
  baseline pass surfaces historical silent decisions.
- **`todo_write` abandonment fold** (`folds/todo.ts`): one aggregate candidate
  per session when the turn ends with pending plan items, closed by a later
  fully-completed plan.
- **Candidate lifecycle API**: `promote` (candidate → structural) and `suppress`
  (resolve + write a suppressor so the same fingerprint cannot re-raise), with
  CAS guards and route endpoints.
- **Settings record and page**: a versioned `settings` record
  (`modelNudge` default **off**, `proseCandidates` default **on**, stored in the
  existing `meta` table so the storage-domain version stays 1) served over the
  existing `settings` endpoint (`{op:'read'}` / `{op:'write', expectedVersion,
  patch}`; a CAS loss is a `conflict` value, invalid payloads `bad-request`),
  and a **Settings → Open Items** page (`settings.section`, id `open-items`,
  order 40) with two `Switch` rows, no Save button, Host truth on conflict, and
  no request until the page mounts.
- **Opt-in model nudge**: when `modelNudge` is on, a short `ctx.systemPrompt`
  section tells the model to declare decisions with `open_items raise` and
  resolve them after the user answers; absent `systemPrompt` degrades silently.
- **Live capture hardening**: hydrate the in-memory ledger from the log on first
  contact (restart truth), bounded periodic rescan
  (`rescanIntervalMinutes`, default 15, 1–1440), archived sessions excluded, and
  `OPEN_ITEMS_FOLD_VERSION` + `OPEN_ITEMS_PROJECTION_VERSION` moved 1 → 2
  together (one cursor replay on the next activation).
- **Truthful empty-state copy (en + zh)**: Candidates is "Nothing to confirm
  right now." with the strict end-of-turn-check explanation; the Needs-you body
  no longer claims prose questions appear there; the "review-only in this build"
  placeholder is gone.
- **Auditable retirement of false task rows**: open
  `team/task:in-progress-orphan` records are resolved `detected-closed` with
  code `team/task:alerts-disabled` once on activation.

#### Fixed (round-3 page review)

- **List/detail truth:** the inbox list is no longer filtered by the client's
  `since` new-item watermark (it hid every item older than the previous visit
  while the counts still covered it — the "Needs you (1) / Nothing is waiting on
  you." contradiction); `since` now only feeds `newSinceLastVisit` and the
  register's period filter. The list read carries the active section's `states`,
  so the Snoozed tab lists snoozed rows, Candidates lists candidate-tier rows,
  and switching sections re-reads the Host. The new-item dot clears when the
  page opens.
- **Page bar:** four labels-only `SegmentedTabs` capped to the list-column width
  (counts are `Tag` badges beside the title — needs-you/candidates, zero hidden —
  instead of `(N)` text, which widened every equal track to 452–480px); search is
  an explicit 240px toolbar field; the tabs and the group-by control point at
  rendered `role="tabpanel"` regions; the workspace filter says `All workspaces`
  instead of `Ungrouped (0)`; the Needs-you empty body covers questions; the
  detail placeholder is direction-independent.
- **Candidates:** a refused promote/suppress keeps its reason inline beside the
  row/detail with a Retry (success stays a Toast); a candidate detail offers one
  rejection path (`Not an item`, with Snooze/Dismiss hidden); focus moves to the
  neighbouring row when a candidate leaves; pending writes are announced.
- **Settings:** a `Saving…` status with `aria-busy` while a toggle write is in
  flight, and failure/conflict copy above the settings group.
- **DSH styling:** kind chips use the shipped `Tag`; the redundant chip/Menu
  wrapper CSS is deleted; only the severity-2 `StateDot` colour override
  remains; inline code uses the theme code font.

#### Changed

- `open_items raise` accepts `options`, `severity`, `blocking` and `quote`, and
  `resolve` records `actor: 'model'`; the tool description teaches the
  raise → user answers → resolve loop.
- The team-task family is removed from the fold dispatch (the fold and its unit
  tests stay exported for the future liveness-gate redesign); existing open task
  rows are retired on activation.
- **Acceptance harness accounting fixed**: the reported headline is now **items
  open at log end** (each artifact's closure subtracted) instead of raised
  drafts, and the closure invariant is a **declared per-family
  closing-detector map** (question, plan-review, interrupted,
  approval-pending, approval-blocked, goal, job, team-task-disabled, prose,
  todo) instead of a detector-code regex. Corrected rc.1 evidence: **1 open
  item** (the blocked approval `approval:call_00_04yfbkg4E0xcF44XWPZO1187`), not
  the 10 raised drafts the rc2 record quoted.
- **Docs truth pass**: CORE-GOAL STATUS blocks in the root/plugin README and
  DESIGN §0, corrected Candidates-tab copy in UI.md (the shipped empty state was
  not honest), the measured capture gap recorded in the deferred registers, and
  the VERIFY rc.1 evidence correction.

#### Verification — round-1 stage (2026-11-14, run from `dsh-open-items/`; unreleased build)

`tsc` exit 0; style audit `--strict` 0 high / 0 medium / 0 low (19/19 rules PASS,
1 pre-existing justified finding); full `vitest run` **77 files, 1047 passed, 3
skipped, 0 failed** (+122 over the 925 baseline); build host **259.3 KiB** /
client **245.4 KiB** (400 KiB budget, contracts OK, deterministic); smoke
raise/list/resolve/dismiss with **0 session-log writes**; `a11y --strict` 0
findings (54 browser files); `package-check` OK (15 payload, 29 pinned peers,
`0.1.0-rc.2`); acceptance over **142 files / 129,882 events** → **1 structural
item open at log end** (the blocked approval; target ≤20 MET) + **19 open
candidates** (question=11, follow-up=8, approval=1; prose raised 57/open
11/closures 46; todo raised 10/open 8/closures 2), raised 77 / closed 57 /
closures 88, root-only 0, todo-derived needs-you 0, unclassified 0, fold errors
0. Full record: [`VERIFY.md`](VERIFY.md) §9.

#### Round-2 addendum (goal round 2)

**Added**

- **Durable backfill report.** Every completed backfill pass (activation, periodic
  re-scan, or a manual `backfillNow()`, reported as `trigger: 'activation'`) now
  persists a counts-only `BackfillReportRecord` — `schemaVersion: 1`, `at`,
  `trigger: 'activation' | 'rescan'`, `eligible`, `folded`, `skipped`, `failed`,
  `drafts`, `batches`, `deferred`, `durationMs` — in the `open_items` storage
  domain's existing `meta` table under key `backfill` (`parseMetaRecord`
  dispatches on shape; the domain version stays 1). `hello.capture.lastBackfill`
  is seeded from it at activation and updated after each pass, so the observable
  backfill state **survives restarts**. It reports the last pass's counts (not a
  per-session guarantee); a failed pass writes no report.
- **Opt-in model-assisted extraction.** New `src/host/extraction.ts` and a third
  Settings → Open Items row, **Model-assisted extraction** (`llmExtraction`,
  default **off**). It runs only when the toggle is on **and** the deployment
  configures `extractionProvider` + `extractionModel`; then each **new live
  prose candidate** gets one bounded one-shot call (structural `ctx.llm` seam,
  no dependency import; strict JSON `{keep, kind, title, confidence}`,
  `confidence ≥ 0.6`, `maxTokens: 200`, `temperature: 0`) that may drop the
  candidate or refine its kind/title. Failures/timeouts/malformed JSON/low
  confidence keep the gate's candidate; historical/backfill candidates are never
  extracted; an in-memory UTC-day budget (default 20) bounds volume; no session
  content reaches the plugin log; **no session-log writes**.
- **Extraction config knobs:** `extractionProvider` (`''`), `extractionModel`
  (`''` — both empty ⇒ extraction not installed, **no egress**),
  `extractionDailyBudget` (`20`, 0–500), `extractionTimeoutMs` (`8000`,
  1000–60000), `extractionMaxInputBytes` (`8192`, 1024–65536), documented in
  `cordis.patch.yml`; `rescanIntervalMinutes` is documented there too.
- **Settings record** gains `llmExtraction` (default `false`) in the same
  versioned `settings` record; a stored row that predates the field parses with
  it absent ⇒ `false`.

**Privacy / truth**

- With the toggle off, or without `extractionProvider`/`extractionModel`, the
  extractor is not installed and **nothing leaves the machine**. When enabled,
  the only egress is the bounded final assistant text of a new live
  candidate-producing turn to that configured model. It is **off by default and
  was not exercised against a live provider** in this work.

#### Round-2 verification (2026-11-14, run from `dsh-open-items/`; unreleased build)

`tsc` exit 0; style audit `--strict` 0 high / 0 medium / 0 low (19/19 rules PASS,
1 pre-existing justified finding); full `vitest run` **80 files, 1095 passed, 3
skipped, 0 failed** (+48 over round 1's 1047); build host **272.4 KiB** / client
**247.0 KiB** (400 KiB budget, contracts OK, deterministic); smoke
raise/list/resolve/dismiss with **0 session-log writes**; `a11y --strict` 0
findings (54 browser files); `package-check` OK (15 payload, 29 pinned peers,
`0.1.0-rc.2`); acceptance over **142 files / 131,690 events** → **1 structural
item open at log end** (the blocked approval; target ≤20 MET) + **18 open
candidates** (question=11, follow-up=7, approval=1; prose raised 57/open
11/closures 46; todo raised 10/open 7/closures 3), raised 77 / closed 58 /
closures 89, root-only 0, todo-derived=7 (needs-you 0), unclassified 0, fold
errors 0. Extraction is **off by default**, so the fold counts are unchanged by
it; it was **not exercised against a live provider**. Full record:
[`VERIFY.md`](VERIFY.md) §9.5.

### Post-rc2 fix (authored approvals)


The rc2 sign-off item exposed two defects on the same surface: an approval item
raised by the `open_items` tool could never be answered from the inbox, and a
missing Session title was rendered as `(deleted session)`. Both are fixed here;
the store format, protocol versions and route shapes are unchanged, so this is a
drop-in replacement build for the installed profile.

#### Fixed

- **Authored approvals are answerable.** An `approval` item raised through
  `open_items` has no shipped `approval/request` behind it (no `approvalId`, no
  live card), yet the browser only enabled Allow/Deny when a live card owned the
  ask, and the Host refused an approval payload on every track but
  `client-settle`. The documented "Approve & retry" fallback (DESIGN §6.4) had
  never shipped, so the controls were dead forever. Authored approvals now take
  the ordinary track-3 route, per item origin (`shared/item-origin.ts`): the
  decision is delivered to the session as a durable `open-items` notice
  (`Approved (one-off).` / `Denied.` plus the user's verbatim note), recorded as
  a queued `session-message` delivery, and **never** recorded without being sent
  (an unconfirmed idle send is refused with a typed `bad-request`). The right
  panel names the same track and treats the shipped RiskConfirmation as the
  explicit wake consent; the in-session card points approvals at the inbox.
- **Mirrored approvals are unchanged and still safe.** A captured
  `approval/request` mirror (`source.approvalId` present) is decided only through
  the live card: `client-settle`, `allowed-once`/deny, never a message, never
  retroactive. The Host refuses the mismatched origin/track combination before
  any session work, so an authored item cannot claim a card grant and a mirrored
  item cannot be granted by a message.
- **"(deleted session)" was a false claim.** `item.source.sessionTitle` is unset
  for every authored raise (and for untitled Sessions), and the UI rendered that
  absence as `(deleted session)` — even for the live conversation that had just
  raised the item. Session labels now resolve the item snapshot, then the live
  Session catalogue title, then an honest `(untitled session)` fallback, in the
  list row, detail, session/workspace group headings, approval confirmation and
  the register. Nothing claims a Session was deleted from a missing title.
- **Authored raises stamp `source.sessionTitle` when the Host can read it**, so
  new items carry their Session label even after the Session is gone; a missing
  or throwing title reader can never fail a raise.
- The in-session card no longer says an approval is answered at the session's
  own card (false for authored items); it says approvals are answered in Open
  Items, and plan reviews keep their own pointer copy.

#### Verification

`tsc` exit 0; style audit `--strict` 0 high/0 medium/0 low (19 rules PASS, one
written justification); full `vitest run` **70 files, 925 passed, 3 skipped, 0
failed** (baseline 888 + 37 new, including a new `tests/delivery/authored-approval.spec.ts`,
an authored-approval route composition test and a teammate roll-up routing test);
build host **229.2 KiB** / client **231.3 KiB** (400 KiB budget, contracts OK);
smoke raise/list/resolve/dismiss with **0 session-log writes**; `a11y --strict`
0 findings; `package-check` 15 payload files / 29 pinned peers. Evidence:
[`VERIFY.md`](VERIFY.md) §8.

## [0.1.0-rc.2] — 2026-11-14 (rc2)

The conformance-and-truth release: every control reachable and built from the
shipped primitives, the page chrome aligned with the Plugins conventions, and
the docs reconciled to the shipped artifact. Gates and evidence:
[`../ACCEPTANCE-rc2.md`](../ACCEPTANCE-rc2.md), [`VERIFY.md`](VERIFY.md).
Tag `v0.1.0-rc.2` (OD-07); `v0.1.0-rc.2` is never reused.

### Verification

`tsc` exit 0; style audit 0 high / 0 medium / 0 low with one written
justification (19 rules PASS); full `vitest run` **69 files, 888 passed,
3 skipped, 0 failed**; build host **227.2 KiB**, client **229.5 KiB** (400 KiB
budget, contract OK); smoke raise/list/resolve/dismiss with **0 session-log
writes**; `a11y --strict` 0 findings (49 browser files); `package-check`
`0.1.0-rc.2` (15 payload files, 29 pinned peers); perf **12,802 events/s**
(7.6 s projected for the 118-session / 97,704-event corpus); acceptance over
127 files / 115,618 events → **10 raised structural drafts → 1 item open at log
end** (target ≤20 MET; candidates 0, closures 40; the one no-closing-detector
row is the blocked approval `approval:call_00_04yfb…`, user-closable by design —
corrected in the 2026-11-14 truth pass, see Unreleased), 0 fold errors. Live
`web` profile: 49 session cursors and live-captured items. **The S-19 rendered
visual review remains a required post-release manual sign-off and is not claimed
passed here.** Full record: [`VERIFY.md`](VERIFY.md).

### Fixed

- **Live capture correctness:** the live drive now applies the same rules as the
  backfill — root-only (non-root sessions produce no drafts), workspace stamping
  on live items, and a watermark that never infers activity from `createdAt`; a
  delta re-fold no longer reopens items a detector already closed.
- **Acknowledgement evidence:** folding `user/message` with our `deliveryId`
  moves a delivery to `delivered`; closure evidence (tool result, retried call,
  resumed goal, next turn) folds to acknowledgement `observed`; the 24 h `none`
  fallback only applies when no evidence exists.
- **Live asks are actually captured** (observe-only, no host hold): a
  currently-blocked question/approval appears in the inbox while it is in flight.
- **Honest inbox answering:** cold/idle sends require explicit confirmation
  (`confirmedWake` + "Send & resume now"), a `recorded` outcome is never shown as
  sent, approvals go through the shipped `RiskConfirmation` acknowledge step,
  the note reaches the payload, and every failure carries a reason and Retry.
- **Navigation:** `openSession` is injected through `UiWorkspace`; dismiss/snooze/
  undo reach their endpoints; the session filter is applied to the panel's
  "View all"; inbox cursor paging exposes items past the first page; nav is
  dot-only with the count in the page title.
- **Delete forever** (`delete` endpoint) with a tombstone; no dead `deletedAt`.
- **Register:** `sessionRows` no longer mislabels a root session as a subagent;
  detector evidence is recorded per detector instead of a hardcoded
  `tool-result`; approval closure matches a later successful retry.

### Added

- `delete` route endpoint: `{ itemId, expectedVersion }` → `{ item }`
  (tombstone: state resolved, `deletedAt`, title `[deleted]`, empty body,
  archived retention, `version + 1`, idempotent; excluded from
  list/register/counts/session rows/exports and protected against re-raise).
- Inbox paging (cursor + "Load more items"), the global-counts honesty note, a
  session-scoped query filter (`payload.query.scope.sessionId`), and the
  Group-by `SegmentedControl` + Workspace `Menu` + session `Pill` filter set.
- Navigation/data: page-title count (`page.titleCount`, nav stays dot-only),
  dismiss with Toast Undo (reopen) and snooze via `Menu` (no Unsnooze route —
  honest no-undo limitation), `openSession` through `UiWorkspace`, a truthful
  version-skew restart banner, and empty/loading honesty from `hello.capture`.
- DSH style conformance (S-01…S-20): rc.1 theme typography roles with **no
  feature font-weight > 500**, content-card rows R20 on settings-card
  fill/stroke, in-session card R16 on `--dsw-alias-bg-base` with a 0.5px
  hairline, capsule corners paired with `corner-shape: round`, hover under
  `(hover: hover)`, 16px coarse-pointer fields, the Plugins-page shell (inset
  clamp, compact 28→16 page bar driven by either column's scroll, 960px content
  column, 32px rhythm), shipped `DisclosureRow` group headers and History,
  `AnimatedRows` list motion under reduced-motion, `StateDot` severity marks,
  and exactly one `ItemDetail` mount per layout. `scripts/style-audit.mjs`
  (token/weight/radius/material/hover/dead-CSS rules plus visible written
  justifications) is wired into `pnpm run style` / `verify` and passes 0/0.
  The visible `ShortcutKeys` hint row remains deferred (see below).
- The rc2 keyboard subset via `ctx.shortcuts` (`J`/`K`, `Enter`, `Esc`,
  `⌘/Ctrl+Enter`, `S`, `D`) with text-entry/IME/modal guards; the visible
  `ShortcutKeys` hint row is deferred.
- Register: shipped `Menu` filter selectors, export through `Modal` +
  `SegmentedControl` + `Checkbox`, delete-forever through `Menu` →
  `RiskConfirmation`, and focus/visibility/reconnect/after-write freshness.
- Docs truth pass: root README/STATUS, this changelog, DESIGN/UI/PLAN/OPEN-ITEMS
  reconciled to the shipped artifact; [`VERIFY.md`](VERIFY.md) is the rc2
  evidence record (the P0-era record retired); the canonical deferred register
  is [`../PLAN.md`](../PLAN.md) §7.

### Deferred by decision (as of `0.1.0-rc.2`; superseded by `[Unreleased]` above for the remediation)

Candidate tier, team-task actions, aging/decay, per-session caps, register
acknowledgement/outcome + fingerprint filters, panel evidence reveal/
`loadThrough`, page kind/age filters, the rest of the keyboard map, the opt-in
LLM extraction pass, the runtime-context line, the in-session nudge, settings
UI, timed-mode enablement, model access to the register, cross-session duplicate
grouping, the workspace context-menu entry, the session pip/header chip and the
workspace-row badge. See [`../PLAN.md`](../PLAN.md) §7.

## [0.1.0] — 2026-11-14

First M6 release candidate: the cross-session inbox, end to end. Tags
`v0.1.0-rc.1` and (capture hardening) `v0.1.0-rc.2`; installed in the `dev` and
`web` profiles.

### Added

- **Durable store** over the `open_items` storage domain (`layout: 'per-record'`,
  `invalidRecords: 'backup-and-skip'`): items, detection cursors, suppressors and
  the install identity; CAS writes on every lifecycle transition; schema-v3
  records with resolution/resolutionLog/acknowledgement/retention, deliveries,
  `callId`/`version`/`blocking`/`raisedBy`, workspace snapshot and store-internal
  audit history. One-time idempotent migration of the P0 document.
- **`ctx.openItems` service**: `list` snapshot (items, counts, session and
  workspace rows, cursor paging), `register` (resolutions and in-flight answers,
  `earlierRecordsPruned`), `get`, `create`, `answer`, `dismiss`, `reopen`,
  `snooze`, `recordDelivery`, `resolve`, `acknowledge`, capture-sink methods.
- **Capture engine**: projection folds for blocked approvals, unanswered
  questions, plan reviews, interrupted turns, blocked goals, orphaned team tasks
  and unsettled jobs, with bidirectional closure detectors, fork cut and
  root-only backfill; live drive over committed events; resumable bounded
  backfill (200 sessions / 90 days); workspace membership resolution (never a
  `cwd` heuristic).
- **Exact Fetch route** `POST /api/open-items`: `hello`, `list`, `register`,
  `reply`, `delivery`, `dismiss`, `snooze`, `reopen`, `settings` (read-only
  stub), JSON envelope, stable error codes, capability advertisement.
- **Reply engine + session bridge**: client-settle recording, session-message
  delivery (steer a running turn, confirmed follow-up for an idle session), CAS
  and archive guards, delivery states/evidence, idempotent `deliveryId`.
- **Model-facing `open_items` tool**: `raise | list | resolve | dismiss`,
  subagent roll-up to the root conversation, terse bounded render and versioned
  `CardMeta` v1 payload.
- **Inbox page**: needs-you list, grouping by session/workspace, workspace lens
  with Ungrouped, filters and search, resolved register tab, in-flight band.
- **In-session card** at the `open_items` tool row, hydrated by item id/version.
- **Per-session right-panel tab** with needs-you / waiting / resolved-here
  sections and handoff-only live asks.
- **Register export**: deterministic CSV, JSONL and self-contained HTML for the
  current filter.
- **Retention**: 24 h acknowledgement window (`none`), 365 d active → archive
  (body/quote dropped, decision kept), 5000-row cap and 500-live-item cap;
  caps prune/archive with a visible flag rather than deleting silently.
- **Release readiness**: MIT license, package-check script, install/release docs,
  performance budgets, end-to-end composition suite and a static accessibility
  audit.

### Fixed in 0.1.0-rc.2 (capture/backfill on a cold profile)

Three integration defects found on a live web profile (the inbox looked empty and
`$DSH_HOME/storages/open_items` held two cursors and no items):

- **Capture mounted with a load-order race.** Wiring resolved `sessionController`/`sessionQuery`
  with `ctx.get` at apply time; on a cold boot those services can register after our
  Loader row, so capture was silently skipped. It now waits for `sessionQuery` with
  `ctx.inject`, like the Fetch route waits for `connection`.
- **Wrong backfill catalog.** The scan listed sessions through `sessionController.list()`
  (the visible/resident-session view), which shrank the pass to the resident chats.
  The catalog now comes from `sessionQuery.listSessions()` (the persisted-log corpus),
  with the controller used only for liveness/enrichment.
- **One blank session aborted the pass.** An empty log folds to `lastScannedSeq = -1`,
  which the cursor validator rejects, and that throw escaped the per-session guard.
  Cursor writes are now clamped to `>= 0` and a failed cursor write is contained.

Diagnostics: `hello.capture` reports `{mounted, projection, live, backfill, cursors,
catalogSessions, lastError?, lastBackfill}` so an empty inbox is explainable, and
mount/backfill transitions log at `warn` (this app surfaces warnings, not info).

Measured on an isolated web profile over the real corpus: **49 root sessions scanned,
0 failures, 3 open items raised** (blocked approval, interrupted tool call, unsettled
job) — the backfill runs on activation. The raw-file acceptance harness reports 10
structural items (one `noClosureDetector`) because it folds physical logs, while the
runtime reads through `sessionQuery`, which closes interrupted asks during replay;
the split is documented and alignment is deferred (OD-15).

### Security and privacy

- The plugin **never writes to the Session log**: no custom `SessionEventMap`
  events, no `appendPluginRecord` (see `docs/session-log-policy.md`).
- Store data stays local under `$DSH_HOME/storages/open_items/`; the read route
  is same-origin and Connection-authenticated; no telemetry and no network calls.

### Known limitations (tracked, not defects of this release scope)

- No gated LLM extraction (opt-in, off), no plugin-owned runtime-context line,
  no workspace context-menu entry, no session pip/header chip (deferred, V1.1/M5).
- The store assumes one owning Host process (no cross-process locking).
- Track 1 settle depends on the shipped client's pending-interaction carrier
  (internal, duck-typed, fail-closed); only one interaction per Session is
  exposed, and a second simultaneous ask must be answered in the chat.
- Track 2 (`host-settle`) needs `userQuestions` and a continued/timed question;
  on the standard preset most live asks are `open` and are refused honestly.
- rc1's live capture was not root-only (fixed in rc2), live items were not
  workspace-stamped (fixed in rc2), and acknowledgement evidence was never
  recorded at runtime (fixed in rc2).
- Fixed in the same release: a queued track-3 send now moves the item to
  `awaiting` acknowledgement (so the register's in-flight band shows it), and a
  tool-raised item stamps `source.workspace` so it groups under its workspace.
  Both are asserted by `tests/e2e/composition.spec.ts`.
