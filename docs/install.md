# Installing Open Items into a DSH profile

This guide covers the **rc2** package, version **`0.1.0-rc.2`** (tag
**`v0.1.0-rc.2`**, 2026-11-14), installed in the `web` profile (the `dev`
profile carries rc1) — **plus the unreleased 2026-11-14 founding-goal
remediation build** (version `0.1.0-rc.2` on `main`, tag `v0.1.0-rc.2` — owner
re-tag 2026-11-14, D6 superseded; recorded under CHANGELOG `[Unreleased]`). Gates, numbers and the
live storage-domain check are in [`../VERIFY.md`](../VERIFY.md) (§9 for the
remediation). The previous baseline was rc1 (`v0.1.0-rc.1`; `v0.1.0-rc.2` was
re-tagged onto `main` on 2026-11-14).

Shipped in rc2: durable store, capture folds + bounded backfill (live drive now
root-only, workspace-stamped with a cursor-coverage watermark), the exact Fetch
route, the reply engine, the model-facing `open_items` tool, acknowledgement
and delivery evidence (per-detector), observe-only live asks, the inbox page
(workspace lens, session filter, paging, resolved register), the in-session
card, the per-session right **panel**, honest live-ask settle (track 1 through
the shipped interaction card where reachable; track 2 for continued questions
when the Host mounts `userQuestions`), delete-forever, deterministic export, and
the DSH page/style conformance (theme typography, content cards, Plugins-page
shell, shipped primitives, green static style audit).

**The unreleased remediation build adds:** the strict **prose candidate gate**
(final-turn assistant text; candidates are never "Needs you" until confirmed),
the **`todo_write` abandonment aggregate**, candidate **promote/suppress**
controls, the **opt-in model nudge** and its **Settings → Open Items** page,
**team-task alerts disabled** (the family produces no items), and capture
hardening (restart hydration, periodic re-scan, archived-session skip,
fold/projection version 2). Installing it requires **one app restart**: the
activation replays each session's log once (fold version 2 — this is what
surfaces the historical prose/todo candidates) and runs the one-time
`team/task:alerts-disabled` retirement of the existing false task rows.

**The round-2 addendum (same unreleased build) adds:** a **durable backfill
report** (persisted in the `open_items` storage domain and surfaced as
`hello.capture.lastBackfill`, so the last pass survives restarts) and
**opt-in, deployment-configured model-assisted extraction** — a third Settings
toggle (default **off**) that can only call a model when the deployment also
configures `extractionProvider` + `extractionModel`. With the toggle off or
without that config, **nothing leaves the machine**. Extraction is off by
default and was **not exercised against a live provider** in this work; it is
enabled per deployment with the config keys below, not by this install alone.

> **Sandbox limitation.** The agent sandbox used to build this package cannot
> write `~/.dsh` (the DSH home is read-only for it). The profile install below
> must therefore be run **by you, the user, in your own shell**. The agent can
> build, test, and run the acceptance harness against your corpus read-only; it
> cannot install the plugin for you.

## 0. Prerequisites

```bash
node --version      # >= 24.9.0 (engines)
dsh --version       # 0.2.2-rc.1 (engines.dsh: >=0.2.2-rc.1 <0.3.0)
```

Build the package first (host bundle + client bundle; `pnpm` is fine in a normal
checkout, unlike the read-only sandbox store):

```bash
cd /abs/path/to/dsh-open-items
pnpm install
pnpm run build          # -> lib/index.js, lib/client.js, lib/client.js.map
ls lib/index.js lib/client.js cordis.patch.yml
```

Keep the package directory where you installed from: `dsh plugin add` links the
path (or copies it, depending on pnpm settings), so moving the directory later
can break the profile until you re-add it. The absolute path to remember:

```bash
export OI_PLUGIN_DIR=/abs/path/to/dsh-open-items
```

## 1. Install into the `dev` profile (safe to try first)

The `dev` profile is a scratch profile: it is created on first use and does not
touch your live `web` profile.

```bash
dsh plugin --profile dev add "$OI_PLUGIN_DIR"
```

`dsh plugin` forwards its arguments to pnpm in the profile directory, so a
successful run ends with the usual pnpm "added 1 package" line. If pnpm reports
missing **peer** packages: profiles disable automatic peer installation, and the
peers here are the DSH runtime packages already present in the profile's DSH
installation; do not install them globally — report the exact warning instead of
adding random versions.

Confirm the bundle row was composed (this check does not need a GUI):

```bash
dsh --profile dev --dump-config | grep -A 8 "open-items"
```

Expected: a row with `id: open-items`, `name: dsh-open-items` and the config
keys `storePath`, `maxLiveItems`, `listLimit`, `activeResolveDays`,
`maxResolvedRecords`, `acknowledgementWindowHours`, `rescanIntervalMinutes`
(1–1440, default 15; minutes between bounded periodic re-scans), and the
opt-in extraction keys `extractionProvider` / `extractionModel` (both `''` ⇒
**disabled, no egress**), `extractionDailyBudget` (20; 0–500),
`extractionTimeoutMs` (8000; 1000–60000), `extractionMaxInputBytes` (8192;
1024–65536). If the row is missing, see
[Troubleshooting](#troubleshooting).

Restart the dev profile and watch the boot log:

```bash
dsh --profile dev
```

Expected boot line (from the host half's `apply`; it is logged at **warn** level
because this app surfaces warnings, not info):

```
open items ready at open_items (0 need you, 0 awaiting)
```

`ctx.openItems` is now published, the `open_items` tool is registered, and the
durable store is open at `$DSH_HOME/storages/open_items/`.

## 2. Install into the live `web` profile

Same command, live profile:

```bash
dsh plugin --profile web add "$OI_PLUGIN_DIR"
```

Then **restart the web app** (quit the running `dsh --profile web` process and
start it again, or restart the desktop shell that launches it). A browser
refresh alone is not enough for a new Loader row on the first install; later
client-only rebuilds hot-reload.

What you should see:

| Surface | Expected behaviour |
| --- | --- |
| Boot (host core) | Boot log line above; `open_items` tool callable in any chat; `$DSH_HOME/storages/open_items/` created; sessions still resume normally. |
| Sidebar + inbox page | An **Open items** row opens the inbox: needs-you list, grouping by session/workspace with an Ungrouped bucket, filters/search, and the resolved register (in-flight band, paging, "earlier records pruned"). The nav row carries a **dot** for new items; the count is in the page title (OD-16; the numeric overlay pip is removed in rc2). |
| In-session card | The `open_items` tool row renders the card for raised/listed items, hydrated by item id + version. |
| Per-session panel | The right-side panel lists this chat's needs-you / waiting / resolved-here items; tool-raised rows answer in place, live shipped asks hand off to the chat or the inbox. |
| Reply engine | Answering from the inbox records a client settle or sends a session message (confirmed follow-up for an idle chat); delivery/evidence appears on the item and in the register. rc2 requires an explicit wake confirmation, shows applied/sent/recorded/failed with Retry, and uses the shipped `RiskConfirmation` for approvals. |
| Live-ask settle | Where the shipped interaction card is reachable the inbox settles that exact request and records a `client-settle`; approvals are settle-once and never retroactive. Continued questions use `host-settle` only when `hello.capabilities.canHostSettle` is true; otherwise the reply degrades to a session message with an honest note. rc2 captures the pending ask **observe-only** — no host hold. |

Capability notes: track 1 depends on the shipped client's pending-interaction
carrier (internal to DSH, duck-typed and fail-closed), only one interaction per
session is exposed, and track 2 will rarely fire on the standard preset until
timed `ask_user_question` mode is enabled (DESIGN D8). The client degrades
honestly instead of showing controls that cannot work.

An **authored approval** — an `approval` item raised by the `open_items` tool
with no shipped request behind it — is not a track-1 item: it is decided as a
track-3 session message (`Approved (one-off).` / `Denied.` plus the user's note,
after the shipped `RiskConfirmation` and the warned wake step) and is never
merely recorded. Captured/mirrored approvals keep the live-card-only contract.
Session labels resolve the item snapshot, then the live Session catalogue title,
then the honest `(untitled session)` fallback — a missing title never means the
Session was deleted.

### Checking that the automatic backfill ran

There is no manual "scan" control: the backfill starts on activation and resumes
from durable cursors on every boot. To see what it did, ask the route:

```bash
curl -s -X POST http://127.0.0.1:<port>/api/open-items \
  -H 'content-type: application/json' -H "Cookie: <session cookie>" \
  -d '{"endpoint":"hello"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"]["capture"])'
```

Expect `mounted/projection/live/backfill: true`, `cursors` climbing toward the
number of root sessions, and a `lastBackfill` block with
`eligible/folded/skipped/failed/drafts`. `lastError` names the first capture
failure instead of leaving the inbox empty without an explanation. The same
block is available to the browser client through the typed `hello` call, and the
page's empty state uses it to say what was scanned.

`lastBackfill` is **durable (round 2)**: it is seeded from the `backfill` record
in the store's `meta` table at activation, so a restart shows the last completed
pass instead of "nothing ran", and it is refreshed after activation and every
periodic re-scan. It reports the last pass's counts only (not a per-session
guarantee); a failed pass writes no report; a manual `backfillNow()` is reported
as `trigger: 'activation'`. The persisted record also carries `batches`,
`deferred` and the pass `trigger`.

### Opt-in model-assisted extraction (round 2; default off)

Extraction is a **deployment** decision plus a **user** toggle; both are needed:

1. **Deployment config** (Loader row from `cordis.patch.yml`): set
   `extractionProvider` to a configured provider route id and `extractionModel`
   to an exact model id. Leave either empty and extraction is impossible — the
   extractor is not installed at all, so **nothing can leave the machine**.
   Optional bounds: `extractionDailyBudget` (default 20 calls per UTC day;
   in-memory, resets at UTC midnight, `0` disables calls without touching the
   toggle), `extractionTimeoutMs` (default 8000 ms end-to-end deadline),
   `extractionMaxInputBytes` (default 8192 bytes of assistant text).
2. **Settings → Open Items → Model-assisted extraction** (default **off**):
   turn it on to permit the path for **new live prose candidates** only.
   Historical/backfill candidates are never extracted. Each candidate gets one
   bounded one-shot call that may drop it or refine its kind/title; any failure,
   timeout, malformed response or confidence < 0.6 keeps the gate's candidate
   unchanged. Changes apply immediately (no restart).

**Privacy/egress:** with the toggle on and provider+model configured, the
bounded final assistant text of a candidate-producing turn is sent to that
model; that is the **only** path where item text leaves the machine. With the
toggle off or no config, nothing is sent. The plugin writes **no session log**
and does not put session content, titles or ids in its own logs. Extraction is
off by default and **not exercised against a live provider** in this work.

**rc2 capture diagnostics:** when the inbox looks empty, read `capture` first and
do not guess:

- `mounted: false` → the capture wiring did not attach (Loader row/config).
- `projection/live: false` → the live fold or drive did not register (services
  missing or an older Host).
- `backfill: false` → the one-time cold-session context was unavailable; the
  live path can still capture from now on.
- `cursors` far below the root-session count → the backfill is still resuming;
  `lastBackfill.failed > 0` or `lastError` set → read it before treating the
  inbox as empty.
- An empty list with capture healthy means exactly that: nothing is waiting.

## 3. Where the data lives

| What | Path |
| --- | --- |
| Durable items, resolutions, cursors, suppressors, install identity | `$DSH_HOME/storages/open_items/` (storage-domain unit `open_items`, one JSON document per record) |
| DSH home | `$DSH_HOME` if set, otherwise `~/.dsh` |
| Legacy P0 store (only read once, then renamed) | `$DSH_HOME/open-items/store.json` → `store.json.migrated` |
| Build output (inside the package) | `lib/index.js`, `lib/client.js` |

Nothing leaves the machine: the store is local, the read route is same-origin
and Connection-authenticated, and the plugin **never writes to the Session log**
(see `docs/session-log-policy.md`).

Inspect the store at any time:

```bash
ls -la  "${DSH_HOME:-$HOME/.dsh}/storages/open_items/"
du -sh  "${DSH_HOME:-$HOME/.dsh}/storages/open_items/"
```

The unit may be empty until the first item is raised; the `meta` install row is
written during activation.

**Backup / reset** (stop DSH first — the store assumes one owning Host process):

```bash
# backup
cp -a "${DSH_HOME:-$HOME/.dsh}/storages/open_items" ~/open-items-backup-$(date +%F)
# reset (keeps the plugin installed, loses items)
mv "${DSH_HOME:-$HOME/.dsh}/storages/open_items" "${DSH_HOME:-$HOME/.dsh}/storages/open_items.old"
# restore
mv "${DSH_HOME:-$HOME/.dsh}/storages/open_items.old" "${DSH_HOME:-$HOME/.dsh}/storages/open_items"
```

## 4. Post-install checklist

Run these in order after the restart. They check the shipped surfaces, not a
milestone.

1. **Bundle row present.**
   `dsh --profile web --dump-config | grep -A 8 "open-items"` shows the row.
2. **Host half activated.**
   Boot log contains the warning-level `open items ready at open_items` line; no
   `open-items` line in the launcher's skipped-bundle warnings.
3. **Store created.**
   `$DSH_HOME/storages/open_items/` exists and contains an install/meta record
   after a first write. A legacy `store.json` (if any) is renamed `.migrated`.
4. **Page.** Click **Open items** in the sidebar. You should see the page (page
   title with the count, tabs, grouping/facet controls, search, refresh), a
   sensible empty state naming how many sessions were scanned, and the nav row
   without a numeric overlay badge. With items present: select a row, check the
   detail pane, and open **Resolved** to see the register/export.
5. **Card.** In a chat, ask: "raise an open item: I need to decide whether to
   deploy today." The agent calls `open_items` with `action: "raise"`; the tool
   row renders the card and the item appears in the inbox/panel. The model-facing
   result stays terse (one sentence + bounded rows).
6. **Panel.** Open the right-panel **Open items** tab for that chat: it lists
   that session's items only, answers tool-raised rows in place, and hands off
   live shipped asks to the chat/inbox.
7. **One answer cycle.** Answer the item from the inbox (or panel/card). Check
   that the row reports an honest outcome (applied/sent/recorded, never a bare
   "answered" for a message), the register shows the delivery, and a failure
   gives a reason and Retry. In rc2 a cold session requires the explicit
   **Send & resume now** confirmation.
8. **Capture diagnostics.** Run the `hello.capture` probe from §2 and confirm
   `mounted/projection/live/backfill: true` with cursors and a `lastBackfill`
   block.
9. **Sessions still restore.** Restart DSH, reopen the chat used above: the
   session must load normally. The plugin never appends custom session events,
   so a resume failure here would be an unrelated harness issue — but check it,
   because it is the one regression this plugin could have caused in an earlier
   design.
10. **No data loss on restart.** After the restart, the inbox/register still
    show the item and its state.
11. **Settings → Open Items (remediation).** Open **Settings**, find the
    **Open items** section: **Model nudge** is **off** and **Prose candidates**
    is **on** by default; flipping either saves immediately with no Save button
    and needs no restart (the nudge takes effect on the next turn). A second
    window changing the setting shows the conflict status line, not a silent
    overwrite. The page makes no settings request until it is opened.
12. **Candidates + todo aggregate (remediation).** After a turn that ends on a
    decision request, the **Candidates** tab shows one row with the quote and
    "Inferred at the end of turn N" (never in **Needs you**); **It's an item**
    promotes it to Needs you, **Not an item** suppresses the fingerprint so it is
    not re-raised. A session that ended with pending `todo_write` items shows one
    "Plan left unfinished (N items)" candidate.
13. **Model-assisted extraction (round 2).** Settings → Open Items shows a third
    row, **Model-assisted extraction**, **off** by default. With no
    `extractionProvider`/`extractionModel` configured it has no effect; with them
    configured, enabling it permits one bounded model call per *new live prose
    candidate* (drop/refine), and the Candidates tab has no new UI state for it.
    Confirm the egress story: toggle off or unconfigured ⇒ nothing is sent.
14. **Durable backfill observability (round 2).** Run the `hello` probe from
    §2 ("Checking that the automatic backfill ran"), note `lastBackfill`,
    restart the app and probe again: the last completed pass (with `at`/counts)
    is still reported, not "nothing ran".
15. **Delete forever (rc2).** Delete a resolved record from its `⋯` menu behind
    the confirmation; it leaves the list/register/counts, an identical retry is
    idempotent, and a later capture fold does not re-raise it. The session
    transcript is unaffected.

## 5. Uninstall

```bash
dsh plugin --profile web remove dsh-open-items
# restart the web app
```

Uninstalling **leaves the data in place** (`$DSH_HOME/storages/open_items/` and
any `.migrated` legacy file). Reinstalling restores the same items. To delete
the data forever, remove the unit directory manually (see Backup / reset) with
DSH stopped.

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Launcher prints `profile bundle "dsh-open-items" ... skipped: ... declares no dsh.bundle` | installed an older/unbuilt copy, or the path points at the wrong directory | `dsh plugin --profile web remove dsh-open-items`, rebuild (`pnpm run build`), re-add |
| Bundle skipped with an `engines.dsh` / compatibility message | DSH version outside `>=0.2.2-rc.1 <0.3.0` | use the matching DSH rc.1 runtime, or update the plugin's engines with the release owner |
| pnpm reports missing peers during `dsh plugin add` | profiles disable automatic peer installation | do not install peers globally; report the warning — peers are the DSH runtime packages the profile already has |
| `pnpm` fails with `EROFS` / read-only store | global pnpm store is read-only (sandbox) | run `pnpm install` in the plugin directory with a writable store (`--store-dir`), or outside the sandbox |
| Boot log has no `open items ready` line | plugin row not applied (row/tool conflict, patch not composed) | check `--dump-config`, look for the skipped-bundle line, check `$DSH_HOME/logs` |
| GUI does not show the page after installing | app not restarted (new Loader row) | restart DSH; check the boot log and the `hello.capture` probe |
| Inbox empty although sessions had open work | capture did not mount or the backfill did not run | read `hello.capture` per §2; check `lastError`/`lastBackfill.failed`; the empty state also names the scanned count |
| Items missing after upgrading the plugin | store domain version mismatch or legacy file already migrated | keep `$DSH_HOME/storages/open_items/`; the legacy `.migrated` file is only imported once |
| Two DSH processes show different items | store assumes one owning Host process | run one DSH instance per `$DSH_HOME`; do not share the store across processes |
| Model-assisted extraction toggle is on but nothing happens | deployment config is incomplete (`extractionProvider` **and** `extractionModel` must both be set), `ctx.llm` is not mounted, or the UTC-day budget is exhausted | check the Loader row config and the harness `extraction` suites; extraction is off by default and optional — with no provider/model nothing is sent by design |
| `hello.capture.lastBackfill` shows an old pass after restart | **correct by design**: the record is durable; it is replaced after the next activation/re-scan pass | wait for the activation pass or read `lastError` if a pass failed (a failed pass writes no report) |

## 7. Acceptance / diagnostics commands

From the package checkout:

```bash
# one-command acceptance over the real corpus (reads $DSH_HOME read-only)
node scripts/acceptance.mjs
# same, fail when the ≤20 structural target is missed
node scripts/acceptance.mjs --strict
# machine-readable
node scripts/acceptance.mjs --json
```

The report is written to `tests/acceptance/last-run.json`. It folds
`$DSH_HOME/sessions/**/*.jsonl.zstd` and reports items **open at log end**
(raised drafts minus each artifact's closure), the per-kind counts of those open
items, the **declared per-family closing-detector map** (question, plan-review,
interrupted, approval-pending, approval-blocked, goal, job, team-task-disabled,
prose, todo) with the observed raised/open/closure numbers, and the root-only /
no-`todo_write`-needs-you invariants against the PLAN M1 target (≤20 structural
items).

**Known split (OD-15):** the raw-file harness folds physical logs, while the
runtime reads through `sessionQuery`, which closes interrupted asks during
replay. The rc1 artifact reports **10 raised drafts → 1 item open at log end**
(the blocked approval `approval:call_00_04yfb…`, which has no unconditional log
closer because it was never retried), while the live runtime over 49 root
sessions reports 3 open items at its snapshot. Do not read "invariants clean"
into the artifact; the split is documented and aligning the harness to the
logical read is deferred. The release evidence record
([`../../ACCEPTANCE-rc2.md`](../../ACCEPTANCE-rc2.md)) is the authority for rc2
numbers. **Remediation final numbers (unreleased build, round-2 snapshot):** 142
files / 131,690 events → **1 structural item open at log end** (the same blocked
approval) + **18 open candidates** (11 prose, 7 todo; raised 77 / closed 58 /
closures 89), root-only 0, todo-derived needs-you 0, unclassified 0, fold errors
0. Extraction is off by default and cannot change these fold counts. Full record:
[`../VERIFY.md`](../VERIFY.md) §9 (round-2 addendum in §9.5).
