# dsh-open-items — the cross-session inbox for decisions waiting on you

Long agent sessions end with decisions, approvals, questions and blockers still
unanswered, and the chat that raised them scrolls away. **Open Items** keeps a
durable, cross-session record of those loops and surfaces them in one inbox so
you can answer without hunting for the conversation.

This is the out-of-tree DSH plugin: a Host half (durable store, capture engine,
read/reply route, model-facing tool) and a browser half (inbox page, in-session
card, resolved register, per-session panel, export).

**Status:** **rc2 is shipped** — version **`0.1.0-rc.2`**, tag
**`v0.1.0-rc.2`** (2026-11-14), installed in the `web` profile (the `dev`
profile carries rc1). Gates and evidence: [`VERIFY.md`](VERIFY.md) — `tsc`
clean; style audit 0/0/0 with one written justification (19 rules PASS);
**888 tests passed + 3 skipped** across 69 files; host bundle **227.2 KiB**,
client **229.5 KiB** (400 KiB budget); smoke 0 session-log writes;
`a11y --strict` 0 findings; `package-check` 0.1.0-rc.2 (15 payload, 29 peers);
perf **12,802 events/s** (7.6 s projected fold); acceptance **10 raised
structural drafts → 1 item open at log end** (≤20 MET) with 0 fold errors; live
`web` storage domain at **49 session cursors** with live-captured items. **One
manual gate remains: the S-19 rendered visual review is required as
post-release sign-off and is not claimed passed.** The previous baseline was rc1
(`v0.1.0-rc.1`; `v0.1.0-rc.2` re-tagged onto `main` 2026-11-14).

**Unreleased remediation build (2026-11-14, current working tree):** the
founding-goal fix, recorded under [`CHANGELOG.md`](CHANGELOG.md) `[Unreleased]`
and verified in [`VERIFY.md`](VERIFY.md) §10 (prose-audit remediation; §9 is the earlier remediation record). **Version stays `0.1.0-rc.2`; on `main`, tag `v0.1.0-rc.2` (owner re-tag 2026-11-14; D6 superseded).** It adds the **prose candidate gate**,
the **`todo_write` abandonment aggregate**, **candidate promote/suppress**, the
**opt-in model nudge + Settings → Open Items page**, **team-task alerts
disabled** with a one-time audited retirement, capture hardening (restart
hydration, periodic re-scan, archived-session skip, fold/projection versions
2 → 3), a **durable backfill report**, and **opt-in, deployment-configured
model-assisted extraction** (default off; never exercised against a live
provider here). **Prose-audit remediation (2026-11-14, same build):** the gate is
now **additive and per-item** — a trailing-ask **section mode** (≤5 items/turn)
layered over the strict single-ask fallback, semantic `decision|question` kinds
that obey DESIGN §2.1, markdown-clean per-item titles/quotes, per-item ids
`prose:t<turn>:<hash>`, **batch-aware bounds (5/turn, 8 open/session replacing
`cap 2`)**, option-bearing replies, a **`promote` correction patch**
(kind/title/body/quote/options) and a one-time legacy migration
(contract: [`../research/prose-audit/IMPLEMENTATION-CONTRACT.md`](../research/prose-audit/IMPLEMENTATION-CONTRACT.md)).
Final ladder (this worktree, 2026-11-14 ~18:13 local): `tsc` exit 0; `npm run
style` PASS (0 findings; 1 pre-existing justified hand-rolled control); **85
files, 1274 passed, 3 skipped, 0 failed**; `npm run build` OK — host **307.2
KiB** / client **286.2 KiB** (400 KiB budget, contracts OK); `npm run smoke` OK
(0 session-log writes); `npm run a11y -- --strict` 0 high / 0 medium / 0 low (60
browser source files; manual browser pass remains); `npm run package:check` 15
payload files / 29 pinned peers at `0.1.0-rc.2`; hermetic acceptance **14 passed
/ 1 skipped** (real-corpus gated). **Measured acceptance** (real corpus,
2026-11-15T01:13Z; the corpus is live): 166 files / 152,216 events → **1
structural item open at log end** (the blocked approval) + **27 open candidates**
(**19 prose** — `prose-gate:decision-request`, 62 raised, 43 closed; **8 todo** —
`todo/write:unfinished-plan`, 11 raised, 3 closed); raised 85 / closed 57 /
closures 90; per-kind open decision=13/follow-up=8/question=6/approval=1; 0 fold
errors, 0 todo-derived needs-you rows. The **pre-change strict-gate numbers** (18
candidates: 11 prose 57/46, 7 todo; raised 77 / closed 58 / closures 89) are
superseded. **Installing it requires an app restart** (the fold/projection replay
2 → 3, the one-time legacy-prose migration and false-row retirement, and the
loaded `lib/` must be restarted before any of this runs). The S-19 visual
review remains the only outstanding manual sign-off.

> **CORE-GOAL STATUS (2026-11-14, remediation).** The plugin's founding goal is
> **decisions that live in agent prose**, not only structured harness artifacts.
> **Historical rc.1 state:** `0.1.0-rc.2` captured structural artifacts only
> (blocked approvals, unanswered questions/plan reviews, interrupted turns,
> blocked goals, team tasks, unsettled jobs); prose decisions and abandoned
> `todo_write` plans were **not captured** — measured **0 of 19 root sessions
> (0%)** with a genuine open loop, **0 candidates** in the live store, and the
> release record's "10 structural items" were **raised drafts, not open items**
> (true cold-open count **1**, the blocked approval).
>
> **The unreleased remediation in this working tree fixes the founding gap**
> (contract: [`../PLAN-remediation.md`](../PLAN-remediation.md), gap register
> [`../GAP-ANALYSIS.md`](../GAP-ANALYSIS.md)): the **prose candidate gate**
> (D1/D2 — **additive** per-item gate since the 2026-11-14 prose-audit
> remediation: trailing-ask section mode + strict fallback, ≤5/turn, 8
> open/session batch-aware, semantic kinds; `tier: 'candidate'`, never "Needs
> you", confirm with optional kind/title correction or suppress), the
> **`todo_write` abandonment
> aggregate** (D3 — one `todo-open` candidate per session, severity 3, closed by
> a later completed plan), **promote/suppress lifecycle** with an exact-key
> suppressor, the **opt-in model nudge + Settings → Open Items page** (D4 —
> nudge default **off**, prose candidates default **on**, CAS, no Save button),
> and **team-task alerts disabled** (D5 — no live/cold task items; existing
> false rows retired once at activation as `team/task:alerts-disabled`).
>
> **Evidence (this worktree, 2026-11-14 ~18:13 local / 2026-11-15T01:13Z; live
> corpus):** 166 files / 152,216 events → **1 structural item open at log end**
> (the blocked approval `approval:call_00_04yfbkg4E0xcF44XWPZO1187`) + **27 open
> candidates** — **19 prose** (`prose-gate:decision-request`, 62 raised, 43
> closed) and **8 todo** (`todo/write:unfinished-plan`, 11 raised, 3 closed);
> raised 85 / closed 57 / closures 90; per-kind open decision=13, follow-up=8,
> question=6, approval=1; 0 fold errors; 0 todo-derived needs-you rows. The
> pre-change strict-gate snapshot (18 candidates: 11 prose 57/46, 7 todo;
> 77/58/89) is superseded; the real-log replay of the incident turn yields 5
> A–E `decision` drafts (distinct per-item ids, clean titles/quotes) and a cold
> baseline emits all 5. The round-2 addendum adds a
> **durable backfill report** (storage-domain `meta` key `backfill`, surfaced as
> `hello.capture.lastBackfill`, surviving restarts and covering activation +
> re-scan) and a third Settings toggle: **Model-assisted extraction** (default
> **off**, deployment-configured — with the toggle off or no
> `extractionProvider`/`extractionModel`, **nothing leaves the machine**; it can
> drop/refine a new live prose candidate only, and was never exercised against a
> live provider here). **Version/branch unchanged (D6); this is an unreleased
> build — an app restart is required** for the fold-version replay, the one-time
> retirement, and the loaded `lib/`.

## What ships

Shipped in the rc1 baseline and carried forward in rc2 (`0.1.0-rc.2`):

- **Durable store** over the `open_items` storage domain
  (`$DSH_HOME/storages/open_items/`, one JSON document per record, CAS writes,
  corrupt records quarantined) with schema-v3 records: resolution register,
  resolution log, acknowledgement, retention class, delivery attempts, audit
  history and the workspace snapshot. The P0 document is migrated once,
  idempotently.
- **Capture engine** — structural items derived from committed Session events:
  blocked approvals, unanswered questions and plan reviews, interrupted turns,
  blocked goals, unsettled jobs, plus the **prose candidate gate** and
  **`todo_write` abandonment aggregate** (unreleased remediation, D1–D3). Every
  raised family declares its closing detector (checked by the acceptance
  harness's per-family closure map); a seeded-fork guard keeps history honest; a
  resumable backfill (200 sessions / 90 days) covers existing history without
  blocking a running chat. Team-task items are **disabled** until the liveness
  gate is redesigned (D5).
- **Inbox page** — needs-you list grouped by session or workspace (with a real
  **Ungrouped** bucket), filters and local search, and the resolved register
  with an in-flight band, cursor paging and "earlier records pruned" honesty.
- **In-session card** at the `open_items` tool row, hydrated by item id and
  version so it never parses model text.
- **Per-session right-panel tab** — this chat's needs-you / waiting / resolved
  items; live shipped asks are handoff-only, tool-raised rows answer in place.
- **Answering** — `POST /api/open-items` (`hello`, `list`, `register`, `reply`,
  `delivery`, `dismiss`, `snooze`, `reopen`, `delete`, `settings`): client-settle
  recording, host-side settle for continued questions, and session-message
  delivery (steer a running turn, confirmed follow-up for an idle one), with
  CAS, archive and idempotency guards. Every outcome is an evidenced
  `deliveries[]` record.
- **Retention** — 24 h acknowledgement window, 365 d active register → archive
  (body/quote dropped, decision kept), 5000-resolution cap and a 500-live-item
  cap; both archive, never delete. Retention runs as a periodic sweep.
- **Register export** — deterministic CSV, JSONL and self-contained HTML for the
  current filter, generated locally.
- **Model-facing `open_items` tool** — `raise | list | resolve | dismiss`, with
  subagent roll-up to the root conversation, terse bounded render and a
  versioned card payload.

Added by **rc2** (`0.1.0-rc.2`, shipped 2026-11-14):

- **Live capture correctness:** root-only enforced on the live drive (rc1 only
  enforced it in the backfill), workspace snapshot on live items via
  `workspace.sessionIds` membership (never `cwd`), and a watermark that never
  infers activity from `createdAt`/`SessionSummary.updatedAt` (prompt time only)
  — eligibility comes from the bounded read window and cursor coverage, not
  "session activity time"; delta re-folds emit only transitions after the cursor,
  so no reopen/version churn on restart.
- **Acknowledgement evidence:** `delivered` is proven by the `user/message`
  carrying our `deliveryId`; `observed`/`none` come from session evidence and
  the 24 h fallback instead of never arriving.
- **Observe-only live asks:** a currently-blocked question/approval appears in
  the inbox, in flight, without holding or parking the request.
- **Honest inbox answering:** shipped `RiskConfirmation` for approvals, the
  shipped `InlineEditor` for drafts, an explicit cold-session **Send & resume
  now** with `confirmedWake`, rendered applied/sent/recorded/failed results with
  Retry, and the app-wide `Toast` for transient feedback. An **authored**
  approval (raised by the tool, with no live request behind it) is decided as a
  track-3 session message (`Approved (one-off).` / `Denied.`) and never recorded
  unsent; a **mirrored** captured approval stays live-card-only.
- **Delete forever:** the `delete` endpoint (`{ itemId, expectedVersion }` →
  `{ item }`) writes a tombstone, removes the record from lists/counts/exports
  and prevents a later fold from re-raising it.
- **DSH-native composition (WP-08 phase 1 shipped):** rc.1 theme typography roles
  (page title 20/28, detail title 16/24 at 500, rows/detail 13/20, meta 12/18,
  chips 11/14; **no feature font-weight > 500**); inbox/register rows are
  content cards R20 on `--dsw-alias-settings-card-fill/-stroke`; in-session card
  R16 on `--dsw-alias-bg-base` with a 0.5px hairline and 4px tool-row margin;
  hover under `(hover: hover)`; 16px coarse-pointer fields. **Phase 2A ships
  the Plugins-page shell** (inset clamp, compact 28→16 page bar, 960px content
  column). **Remaining style pass:** `AnimatedRows`, page `DisclosureRow` group
  headers/History, page `StateDot`, single `ItemDetail` mount, visible
  `ShortcutKeys` hints.
- **Navigation/data (shipped):** `openSession` wired through `UiWorkspace`;
  Group-by `SegmentedControl` + Workspace `Menu` + search + session `Pill`
  (clear-all resets them); dismiss (route write + Toast Undo→reopen) and snooze
  via `Menu` (1h/tomorrow/next week — no Unsnooze route, so no snooze undo);
  inbox cursor paging with "Load more items" and the global-counts honesty note;
  delete-forever via `Menu` → `RiskConfirmation`; export `Modal` +
  `SegmentedControl` + `Checkbox`; nav dot-only with the count in the page title
  (a `Tag` count badge beside the title); keyboard subset `J`/`K`, `Enter`, `Esc`,
  `⌘/Ctrl+Enter`, `S`, `D` through `ctx.shortcuts` with text-entry/IME/modal
  guards; truthful version-skew restart banner; empty state naming scanned
  sessions and "Catching up on earlier sessions…" while the first backfill is
  unreported.
- **Static style gate:** `scripts/style-audit.mjs` (`pnpm run style`, part of
  `pnpm run verify`) enforces tokens-only colours, hover guards, weight ≤500,
  radius/corner-shape pairing, no neutral-border+elevation pairing, and no
  custom replacement of a catalog control. It is green as shipped for rc2
  (`--strict`: 0 high / 0 medium / 0 low, 19 rules PASS, one written
  justification for the DESIGN §6.8 inline warned send).

Added by the **unreleased remediation** (2026-11-14; same `0.1.0-rc.2`
semantics on `main`, tag `v0.1.0-rc.2` (owner decision 2026-11-14; D6 superseded); see [`VERIFY.md`](VERIFY.md) §9):

- **Prose candidate gate (D1/D2; additive per-item since the 2026-11-14
  prose-audit remediation).** A pure end-of-turn detector over the final
  assistant `text` only (reasoning/tool-call parts ignored; the newline-preserving
  4000-char tail is kept). It is **additive**: a trailing-ask **section mode**
  (anchored last heading — `decisions/questions/asks/open questions/your
  call/confirmations/sign-off`) turns every ask-like top-level list item into its
  own candidate (≤5/turn), and every other turn keeps the shipped strict
  single-ask **fallback** (≥40 characters and a marker in the last 300
  characters — a trailing `?`/`？` or a word-bounded phrase from `want me to`,
  `should I`, `shall I`, `would you like`, `do you want me to`, `let me know`,
  `your call`, `which (one|option|approach|of)`, `confirm`, `approve`). Kinds are
  **semantic**, not `?`-driven: `decision` when alternatives are presented,
  `question` for information/go-ahead asks, never `approval` in phase 1 — and
  the inferred kind is a correctable guess. Each item is a `tier: 'candidate'`
  row (`prose-gate:decision-request`, `detectedBy: ['regex-gate']`, severity 2,
  non-blocking) with a markdown-clean title/quote, option controls only for
  explicit labelled alternatives, and a stable per-item id
  `prose:t<turn>:<12-hex hash>`. It never counts as "Needs you"; a later
  `user/message`/`turn/start` closes **all** the turn's items
  (`user/message:superseded`), the **batch-aware** per-session bound of 8 open
  candidates supersedes the oldest rows *outside* the current batch
  (`prose-gate:superseded-by-cap`), and the cold baseline emits every still-open
  per-item row so historical silent decisions surface. The **Prose candidates**
  setting gates raises only. **Honest limits:** this is a heuristic over the
  final message of a turn — it may miss decisions (nested sub-bullets, tables,
  prose-only turns are not parsed as items); inferred kinds may be wrong and are
  correctable at confirmation.
- **`todo_write` abandonment aggregate (D3).** One `todo-open` candidate per
  session, kind `follow-up`, severity 3, title `Plan left unfinished (N items)`,
  body listing up to five pending labels, `detectorCode
  'todo/write:unfinished-plan'`. It closes on a later `todo/write` with nothing
  pending (`todo/write:completed`) and never on a user message. Cold baseline
  emits it; it never reaches Needs you.
- **Candidate lifecycle.** Candidates tab rows + candidate detail render the
  markdown-clean evidence and offer the two confirm controls: **It's an item**
  (`promote` → structural, severity 2, blocking, history `promoted`) — with an
  optional **correction patch** `{ kind?, title?, body?, quote?, options? }`
  applied in the same CAS write (kind/title pickers pre-filled from the
  projection; a kind change rekeys the dedupe key and suppressor and logs
  `reclassified`) — and **Not an item** (`suppress` → dismissed + exact-key
  suppressor so the item cannot re-raise). Both are CAS-guarded; candidates are
  not answerable as normal items, and the footer dismiss does **not** write a
  suppressor (suppress does). Options render under "What you're deciding" before
  and after confirmation.
- **Settings → Open Items page (D4).** A conventional Settings section
  (`settings.section`, id `open-items`, order 40, locale `openItems`) with two
  `Switch` rows: **Model nudge** (default **off**) and **Prose candidates**
  (default **on**). Writes go through the existing `settings` endpoint
  (`{op:'read'}` / `{op:'write', expectedVersion, patch}`) with CAS; a conflict
  shows a status line with Host truth, there is no Save button, and the page
  reads nothing until it mounts. Changes apply immediately and need no restart;
  `connection/reset` refreshes a loaded page.
- **Opt-in model nudge.** While `modelNudge` is on, the Host registers a
  three-sentence `systemPrompt` section (`open-items:nudge`, order 60): when
  ending a turn on a decision/answer, call `open_items raise` (one item per real
  decision, kind `decision`/`question`); after the user answers, call
  `open_items resolve` with the returned id. It is disposed the moment the
  toggle goes off, and a profile without the `systemPrompt` service degrades
  silently. Subagent raises still roll up to the parent conversation. No
  session-log writes.
- **Team-task alerts disabled (D5).** The family leaves the fold dispatch, so no
  live or cold fold raises a task item (the module and its unit tests stay for
  the future liveness-gate redesign). On activation the plugin calls
  `retireTeamTaskItems()` and resolves existing open false rows as
  `detected-closed` with code `team/task:alerts-disabled` (audit visible; runs on
  the next app/plugin restart).
- **Capture hardening.** Live-ledger **hydration** from the committed log on a
  session's first live event (one read per session per process; failures
  contained), a bounded **periodic re-scan** (`rescanIntervalMinutes`, default
  15, 1–1440), archived sessions excluded from backfill, and
  `OPEN_ITEMS_FOLD_VERSION` + `OPEN_ITEMS_PROJECTION_VERSION` moved 1 → 2 → 3
  together (never one alone; one cursor replay per bump on the next activation;
  the 2 → 3 bump runs the one-time legacy-prose migration first; the settings
  record shares the existing `meta` table, so the storage-domain version stays 1
  and `STORE_SCHEMA_VERSION` stays 3).
- **Durable backfill report (round 2).** After every completed pass (activation,
  periodic re-scan, or a manual `backfillNow()`, which counts as `activation`),
  a counts-only `BackfillReportRecord` is persisted in the `open_items` storage
  domain's `meta` table under key `backfill`: `schemaVersion: 1`, `at`,
  `trigger: 'activation' | 'rescan'`, `eligible`, `folded`, `skipped`, `failed`,
  `drafts`, `batches`, `deferred`, `durationMs`. `hello.capture.lastBackfill` is
  seeded from the record at activation and updated after each pass, so the
  observable backfill state **survives restarts** instead of resetting on boot.
  It reports the last pass's counts (not a per-session guarantee), and a failed
  pass produces no report.
- **Opt-in model-assisted extraction (round 2; default OFF).** The Settings page
  gains a third row, **Model-assisted extraction**. It is enabled only when the
  toggle is **on AND the deployment configures `extractionProvider` +
  `extractionModel`**; it then makes one bounded one-shot call per **new live
  prose candidate** (historical/backfill candidates are never extracted) asking
  for strict JSON `{keep, kind, title, confidence}` to drop a false positive or
  refine the item's kind/title. Confidence < 0.6, deadline, provider error,
  malformed JSON or budget exhaustion keep the gate's candidate unchanged
  (fail-closed). One in-memory **UTC-day budget** (default 20 calls) bounds cost;
  no session content is written to the plugin log; **no session-log writes**; and
  the request is sent **only** to the configured model. With the toggle off or a
  missing provider/model, extraction is not installed at all — **nothing leaves
  the machine**. It was **not exercised against a live provider** in this work.
- **Tool/lifecycle truth.** `open_items raise` accepts `options` (string[]),
  `severity` (1|2|3), `blocking` and `quote`; the description teaches the
  resolve-after-answer loop; `resolve` records `actor: 'model'`.
- **Truthful candidate copy (en + zh).** The Candidates empty state is
  "Nothing to confirm right now." and the page caption says the check runs once
  on the final message of a turn — **it may miss decisions, and the inferred kind
  may be wrong but is correctable**. Sibling items from one turn are grouped
  ("N from this turn"), bulk confirmation reviews projected titles/kinds before
  writing, and the panel carries an "Inferred (N) → review" row into the
  Candidates tab. The Needs-you empty state no longer promises prose capture;
  the "review-only in this build" placeholder is gone.

## What it deliberately does not do

- **No Session-log writes.** The plugin never appends custom events (see
  [`docs/session-log-policy.md`](docs/session-log-policy.md)); the durable store
  and the projection are the record.
- **No telemetry; one optional, off-by-default egress path.** Everything is
  local — a reply becomes an ordinary user message in that session's own log.
  The single exception is the **opt-in model-assisted extraction**: only when
  the deployment configures `extractionProvider` + `extractionModel` **and** the
  user turns the Settings toggle on does the plugin send the bounded final
  assistant text of a **new live prose-candidate turn** to that configured
  model, for one confirmation/refinement call. With either precondition missing
  it sends nothing; it never runs over historical/backfill candidates; and it
  was never exercised against a live provider in this work.
- **No cross-process locking.** One owning Host process per store directory.
- **Deferred by decision (V1.1 / M5), not claimed as shipped:** aging/decay,
  the designed general per-session live cap (20; the shipped prose bound is
  8 open/session and 5 raises/turn),
  **team-task actions / the liveness-gate redesign** (the family is disabled
  until then), register acknowledgement/outcome + fingerprint filters, the rest
  of the keyboard map (`1…9`, `O`, `/`, `?`), panel evidence
  reveal/`loadThrough`, page kind/age filters, the runtime-context line, panel
  discovery guide, timed-mode enablement, model access to the register,
  cross-session duplicate grouping, card-density variants, the workspace
  context-menu entry, the session pip/header chip, the workspace-row badge and
  acceptance-harness ↔ runtime logical-read alignment. **Model-assisted
  extraction is no longer deferred:** it shipped in the round-2 addendum as an
  opt-in, deployment-configured feature (default off; no egress without config +
  toggle). The canonical register is [`../PLAN.md`](../PLAN.md) §7.
- **Pending polish after the round-4 completion (canonical table in
  [`../PLAN.md`](../PLAN.md) §7):** the Snoozed wake-time surface ("wakes in 2h"
  on the row, instant in the toast), labels-only panel filter pills, removing
  the non-binding detail `max-width: 600`, the medium inline-detail footer
  decision, a real-device phone/narrow pass in S-19, and the upstream
  `DisclosureRow.title` ellipsis ask. **S-19 rendered visual review remains the
  only outstanding manual gate.**

## Install

Installing is a user step (the build sandbox cannot write `~/.dsh`); the full
guide is [`docs/install.md`](docs/install.md):

```bash
cd /abs/path/to/dsh-open-items
pnpm install && pnpm run build            # lib/index.js + lib/client.js
dsh plugin --profile dev add "$PWD"       # scratch profile first
dsh --profile dev --dump-config | grep -A8 open-items
# restart the app; expected warning-level log: "open items ready at open_items"
dsh plugin --profile web add "$PWD"       # then restart the live web app
```

Uninstalling (`dsh plugin --profile web remove dsh-open-items`) leaves the data
in place; reinstalling reopens it. Backup/reset and the full post-install
checklist (page, card, panel, capture diagnostics) are in
[`docs/install.md`](docs/install.md).

## Development

```bash
./node_modules/.bin/tsc -p tsconfig.json --noEmit   # types
./node_modules/.bin/vitest run                      # unit + client + capture + e2e
node scripts/build.mjs                              # host + client bundles
node scripts/smoke.mjs                              # built host bundle on fake services

# gated, non-hermetic checks
OI_PERF=1 ./node_modules/.bin/vitest run tests/perf # read-path + fold budgets (docs/perf.md)
node scripts/acceptance.mjs                         # real-corpus numbers (docs/install.md §7)

# release readiness
node scripts/package-check.mjs                      # payload/manifest assertions (no npm pack)
node scripts/a11y-audit.mjs                         # static a11y contracts (docs/a11y.md)
node scripts/style-audit.mjs                        # static DSH style rules (part of `verify`)
```

Layout:

```
src/host/      store (storage domain), service, route, reply engine + bridge,
               capture folds/projection/backfill/workspace, retention, tool, wiring
src/shared/    schema v3, records/validation, wire protocol, export format
src/client/    transport, data stores, inbox page, card, register, export,
               settings page (ui/settings), locales
tests/         unit suites per module, e2e composition, perf budgets, acceptance
docs/          install, release, perf, a11y, session-log policy, client foundation
```

## Configuration

The Loader row in `cordis.patch.yml` exposes deployment knobs (Schemastery,
defaults from the shared `LIMITS`):

| key | default | meaning |
| --- | --- | --- |
| `storePath` | `''` | Legacy P0 JSON document imported once (empty = `<DSH_HOME>/open-items/store.json`); the durable store itself is the `open_items` domain |
| `maxLiveItems` | `500` | Cap on live items; a breach archives the oldest, never deletes |
| `listLimit` | `20` | Default page size of the `open_items` list action |
| `activeResolveDays` | `365` | Days a resolution stays in the active register before archiving |
| `maxResolvedRecords` | `5000` | Resolution safety cap; oldest archived rows prune with a visible flag |
| `acknowledgementWindowHours` | `24` | Hours to wait for session acknowledgement before recording `none` |
| `rescanIntervalMinutes` | `15` | Minutes between bounded periodic re-scans of session logs (1–1440; runs after activation) — unreleased remediation |
| `extractionProvider` | `''` | Provider route id for **opt-in model-assisted extraction**; empty disables it entirely — **no egress** (round 2) |
| `extractionModel` | `''` | Exact model id for extraction; empty disables it — no egress (round 2) |
| `extractionDailyBudget` | `20` | Max extraction calls per **UTC day** (0–500; in-memory counter, resets at UTC midnight; `0` disables calls without changing the Settings toggle) |
| `extractionTimeoutMs` | `8000` | End-to-end deadline per extraction call (1000–60000 ms) |
| `extractionMaxInputBytes` | `8192` | Hard cap on the assistant-text bytes sent in one extraction prompt (1024–65536) |

**Opt-in model-assisted extraction needs both halves:** a deployment config with
`extractionProvider` + `extractionModel` **and** the Settings toggle on. With
either missing, the extractor is not installed and **nothing leaves the
machine**. It applies to **new live prose candidates only** (never
historical/backfill ones), one bounded one-shot call per candidate, can drop a
false positive or refine kind/title, and every failure/timeout/low-confidence
keeps the gate's candidate unchanged. It was **not exercised against a live
provider** in this work.

**User preferences** live on **Settings → Open Items** (`settings.section`, id
`open-items`, order 40) and are stored as a versioned `settings` record in the
same `open_items` storage domain (the `meta` table), served over the existing
`settings` endpoint as `{op:'read'}` / `{op:'write', expectedVersion, patch}`:

| setting | default | effect |
| --- | --- | --- |
| `modelNudge` | **off** (opt-in, D4) | While on, a three-sentence `systemPrompt` section (`open-items:nudge`, order 60) tells the model to `raise` at decision-ending turns and `resolve` after the user answers. Registered/disposed immediately on toggle; no restart; a profile without `systemPrompt` degrades silently. |
| `proseCandidates` | **on** (D1/D2) | Gates the end-of-turn prose candidate gate's **raises** (closures always pass). Off stops new candidates; existing candidates stay confirmable/suppressible. |
| `llmExtraction` | **off** (round 2) | *"Only used when this deployment configures an extraction model. When on, it sends the last assistant message of a turn that produced a candidate to that model to confirm or refine the item. Nothing leaves the machine while this is off; with no extraction provider or model configured, this has no effect."* It only **permits** extraction — the deployment must also set `extractionProvider` + `extractionModel`; then new live prose candidates may be dropped/refined. Applies immediately, no restart. |

Writes are CAS with Host truth shown in the controls (a conflict is a status
line, not an overwrite); there is no Save button, and no settings request is made
until the page mounts. Toggle changes need no restart. **The only egress path is
`llmExtraction` + a configured provider/model** (see the extraction paragraph
above and `DESIGN.md` §7.2); with the toggle off or no config, nothing leaves the
machine. **A restart is needed for the unreleased build itself** — the
fold/projection version replay and the one-time team-task false-row retirement
run at activation.

## Documentation

- [`docs/README.md`](docs/README.md) — **domain documentation (intent layer):** the architecture
  and its intent, the context map, the ubiquitous language, one `CONTEXT.md` per bounded context,
  capability specs with acceptance criteria, and ADRs. It states *what the system is for* and is
  written to stay true as the code changes; it deliberately carries no release status (that lives
  in `VERIFY.md`, `CHANGELOG.md` and the design packet at the repository root).
- [`docs/install.md`](docs/install.md) — user-run install/verify/uninstall for the shipped `0.1.0-rc.2`.
- [`docs/release.md`](docs/release.md) — versioning, checklist, handoff, rollback.
- [`docs/perf.md`](docs/perf.md) — measured read-path and fold budgets.
- [`docs/a11y.md`](docs/a11y.md) — static accessibility audit + manual checklist.
- [`docs/session-log-policy.md`](docs/session-log-policy.md) — why no session events.
- [`docs/client-foundation.md`](docs/client-foundation.md) — browser-half contract.
- [`VERIFY.md`](VERIFY.md) — **release evidence record**: rc2 (`0.1.0-rc.2`) plus §9 for the unreleased remediation build.
- [`CHANGELOG.md`](CHANGELOG.md) — shipped surfaces per version, the rc2 entry and the `[Unreleased]` remediation entry.

## License

MIT — see [`LICENSE`](LICENSE).
