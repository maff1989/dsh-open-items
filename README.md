# dsh-open-items

**The cross-session inbox for decisions waiting on you.** A DeepSeek Harness plugin that keeps a durable register of the decisions, approvals, questions and blockers an agent session leaves open — so you can answer them from one place, days later, without reopening the chat.

<!-- TODO(screenshot): hero shot — the Open items page: the Needs you list with an item's detail pane open.
     Add the file under assets/screenshots/ and uncomment the line below.
![The Open items page](assets/screenshots/open-items-page.png)
-->

> **Status:** `0.1.0-rc.2` — release candidate, pre-1.0 · DeepSeek Harness `>=0.2.2-rc.1 <0.3.0` · Node.js `>=24.9.0` · MIT.
> Local-first: items live under your `DSH_HOME`, never in the Session log, and nothing leaves the machine unless you configure and opt in to model-assisted extraction.

## Why this exists

A long agent session ends with work still waiting on you: a question, an approval, a choice between options, a plan that needs a sign-off. Then the chat scrolls away, the tab closes, and the decision is stranded in a transcript you will not reread.

The transcript is a stream, but decisions are not. This plugin turns session evidence — committed events, the agent's own declarations and the final prose of a turn — into a durable register of attention, and carries your answer back into the work with evidence of what actually happened. It is not a task manager and not a second transcript.

A few principles shape it:

- **Evidence first, guesses behind a gate.** Facts from the session log come first. An inferred prose decision only becomes a *candidate* you confirm or suppress, and nothing inferred counts as "Needs you" until you say it does.
- **The register outlives the chat.** Items are durable and install-wide, not session-scoped: a session may be archived or deleted and the register still answers "what did I decide, and when?".
- **Answers carry evidence.** Applied, sent, recorded and failed are distinct claims with distinct evidence. A reply is never "answered" because it was queued, and an approval is never "granted" because a message said so.
- **The model is a guest.** The agent may declare items and read the inbox through one tool, but capture never depends on a model call, and the only egress path is opt-in and bounded.
- **Never corrupt the harness.** The plugin never writes plugin-defined events to the Session log, keeps its harness contact to public and duck-typed seams, and reports version skew instead of guessing.

## What it does

- **Captures open loops from sessions** — blocked approvals, unanswered questions and plan reviews, interrupted turns, blocked goals, unsettled background jobs, and — inferred and confirm-first — prose decisions from the end of a turn and plans left unfinished.
- **One inbox page** — **Needs you**, **Candidates**, **Snoozed** and **Resolved** sections; grouping by session or workspace; workspace and session filters; local search; cursor paging; an empty state that says what was scanned.
- **Confirms, never guesses** — inferred items wait in **Candidates**. "It's an item" promotes one (correcting the inferred kind or title first, if you like); "Not an item" suppresses it for good.
- **Answer in place** — choose an option, write a reply, allow once or deny. The answer travels on the strongest delivery track this harness supports, with applied / sent / recorded / failed outcomes and Retry.
- **In-session card and per-session panel** — the `open_items` tool row renders a card hydrated from the item record, and the right-panel tab lists this chat's needs-you, waiting and resolved items, handing off to the session where it must.
- **Resolved register and export** — each closure with its outcome, the delivery track and evidence where an answer travelled, and the acknowledgement when the session proved it; deterministic CSV, JSONL and self-contained HTML export of the current filter.
- **Agent-facing tool** — `open_items` raise / list / resolve / dismiss, with subagent roll-up to the root conversation and a deliberately terse, bounded result.
- **Settings** — model nudge (off by default), prose candidates (on), model-assisted extraction (off).

<!-- TODO(screenshot): the in-session card at the tool row and the right-panel Open items tab.
![The in-session card and right-panel tab](assets/screenshots/card-and-panel.png)
-->

## Requirements

- **DeepSeek Harness** `0.2.2-rc.1` with the web GUI — the tested target. The plugin's `engines.dsh` range is `>=0.2.2-rc.1 <0.3.0`, and it composes the published `0.2.2-rc.1` seams.
- **Node.js** `>=24.9.0` and **pnpm** on `PATH` (pnpm 11 is the tested version).
- **One DSH process per `DSH_HOME`**: the store assumes a single owning Host process and does not lock across processes.
- The package is **private and not published to npm** — install it from a checkout.

## Install

`lib/` is gitignored, so a fresh checkout must be built before it can load:

```sh
git clone https://github.com/maff1989/dsh-open-items.git
cd dsh-open-items
pnpm install
pnpm build

dsh plugin --profile web add "$PWD"
```

Then **restart the process that serves the GUI** (for example `dsh --profile web`, or the DSH app). The Host half opens its store, route and capture wiring at startup, so a first install needs a process restart rather than a browser refresh. Confirm the bundle row is present:

```sh
dsh --profile web --dump-config | grep -A8 open-items
```

The durable store lives at `$DSH_HOME/storages/open_items/` (with `$DSH_HOME` defaulting to `~/.dsh`) and is created at activation. On startup the plugin scans recent sessions once, so the inbox may fill in over the first few moments.

To remove the plugin, run `dsh plugin --profile web remove dsh-open-items` and restart. Your items are not deleted: they stay under `$DSH_HOME/storages/open_items/` and come back if you reinstall. Back up or reset the store with DSH stopped:

```sh
cp -a "${DSH_HOME:-$HOME/.dsh}/storages/open_items" ~/open-items-backup-$(date +%F)   # backup
mv  "${DSH_HOME:-$HOME/.dsh}/storages/open_items"   "${DSH_HOME:-$HOME/.dsh}/storages/open_items.old"   # reset
```

## Using it

1. **Items appear from work you already did.** The plugin folds committed session events (a bounded startup backfill plus a periodic re-scan), reads declarations the agent makes through `open_items`, and — when enabled — infers candidates from the final message of a turn. An empty inbox explains what it scanned instead of looking broken.
2. **Review.** Open **Open items** in the left navigation. Needs-you items are grouped by session (or workspace), ordered by severity and waiting time; low-priority FYI items sit in their own collapsed group. Candidates wait in their own tab, each with the quoted evidence and an inferred kind.
3. **Confirm what is real.** "It's an item" promotes a candidate to a tracked item — correct the kind or title first if the inference was wrong. "Not an item" suppresses it permanently. Neither action is available to the model.
4. **Answer.** Select an item and use its controls: an option, a sentence, **Allow once** / **Deny** for approvals (both behind a confirmation, because this is a permission decision, not a click). If the session is idle, the plugin asks before sending, because **sending resumes the session and spends a turn**; a running turn is steered instead.
5. **Check what happened.** The row reports applied, sent, recorded ("saved, not sent") or a named failure with Retry. The item moves to **Resolved**, where the register records the delivery track, the evidence and whether the session acknowledged it.
6. **Export when you need a record.** Filter the resolved register by period, source, kind, outcome and search, then export deterministic CSV, JSONL or a self-contained HTML page. The same filter produces the same bytes.

Also in the session: the `open_items` tool row renders the card (it never decides approvals itself), and the right-panel **Open items** tab shows only that session's items.

Settings → **Open items** has three switches, saved immediately with no Save button:

| Setting | Default | What it does |
|---|---|---|
| Model nudge | **off** | Tells the agent, while ending a turn on a decision, to declare it with `open_items` and resolve it after you answer. |
| Prose candidates | **on** | Allows the end-of-turn check that proposes candidates from the agent's final message. |
| Model-assisted extraction | **off** | Only functions when the deployment also configures an extraction provider and model; see [Data and privacy](#data-and-privacy). |

## Agent access

`open_items` is the only synchronous model-facing seam. A tool call can never grant an approval, promote or suppress a candidate, or read a recorded decision.

| Action | What it does |
|---|---|
| `raise` | Declares a decision, question, approval, plan review, blocker, risk, follow-up or task, with optional options, severity, blocking flag and a supporting quote. One item per real decision is the contract's guidance. |
| `list` | Reads the inbox in triage order (severity, then longest waiting), with a status filter; at most five rows and a bounded preview per row. |
| `resolve` | Records the answer the user gave in conversation. It records, it does not deliver anything to the session. |
| `dismiss` | Drops an item that is no longer needed. |

Subagents and teammates may raise items; they roll up to the parent conversation, labelled with the asking session. They cannot resolve or dismiss. A re-raise of a still-live item with the same kind and title in the same conversation returns the existing item instead of creating a duplicate.

Two optional model-adjacent surfaces are **off by default**: the model nudge (a short system-prompt section, registered only while its setting is on) and model-assisted extraction. The tool's returned text is explicitly framed as untrusted display content, not instructions.

## Data and privacy

```text
<DSH_HOME>/storages/open_items/     # the durable register: one JSON document per record,
                                    # plus an install identity and the settings/backfill metadata
<DSH_HOME>/open-items/store.json    # legacy P0 document, imported once and renamed .migrated
```

- **No plugin-defined Session-log events.** The Session log is read-only evidence to this plugin, and the item's own history is its audit trail. When you answer, the answer is delivered as an ordinary user message carrying an attribution notice — written by the harness, not as a custom event type.
- **No telemetry and no sync.** The browser half talks only to the same-origin `/api/open-items` route, and exports are generated locally.
- **One opt-in egress path.** Model-assisted extraction can send the bounded final assistant text of a *new live prose-candidate turn* to the model your deployment configures. It requires both a deployment config (`extractionProvider` **and** `extractionModel`) and the Settings toggle; with either missing, nothing leaves the machine. It never runs over historical candidates, any failure or timeout leaves the candidate unchanged, and it was not exercised against a live provider in this work.
- **Local trust.** Records are unencrypted JSON under your profile: anyone who can read `$DSH_HOME` can read them, and the plugin adds no encryption or access control beyond filesystem permissions and the local owner-peer route fence.
- **The tool can expose item titles across sessions.** `open_items list` is profile-wide: a session that calls it can see stored item titles and bounded previews raised elsewhere. It never returns recorded decision text.
- **Answers are kept by default.** Answers and dismissals stay in the register; after 365 days the active register archives them (body and quote dropped, the decision kept). A 5,000-record safety cap prunes the oldest archived rows with a visible "earlier records pruned" flag, and the 500-live-item cap archives the oldest lower-priority items rather than deleting them. Apart from that cap pruning, only an explicit, confirmed delete removes a record everywhere, as a tombstone.

## Configuration

Deployment knobs live in the plugin's Loader row (`cordis.patch.yml`; validated by the plugin schema). The defaults are the shared limits:

| Key | Default | Meaning |
|---|---|---|
| `storePath` | `''` | Legacy P0 document to import once; empty means `<DSH_HOME>/open-items/store.json`. Not the live store. |
| `maxLiveItems` | `500` | Cap on live items (10–10,000); a breach archives the lowest-priority items, never deletes. |
| `listLimit` | `20` | Default page size of the `open_items` list action (1–200). |
| `activeResolveDays` | `365` | Days a resolution stays in the active register before archiving (1–3,650). |
| `maxResolvedRecords` | `5000` | Resolution safety cap (100–100,000); oldest archived rows prune first, visibly. |
| `acknowledgementWindowHours` | `24` | Hours to wait for session acknowledgement before recording "no acknowledgement observed" (1–720). |
| `rescanIntervalMinutes` | `15` | Minutes between bounded periodic re-scans of session logs (1–1,440); schema default fills it. |
| `extractionProvider` / `extractionModel` | `''` / `''` | Opt-in model-assisted extraction route and model; either empty disables extraction entirely. |
| `extractionDailyBudget` | `20` | Extraction calls per UTC day, per process (0–500; `0` disables calls). |
| `extractionTimeoutMs` | `8000` | End-to-end deadline per extraction call (1,000–60,000 ms). |
| `extractionMaxInputBytes` | `8192` | Byte cap on the assistant text sent in one extraction prompt (1,024–65,536). |

User preferences are the three settings switches described in [Using it](#using-it); they are stored as a versioned record in the same domain and served over the same route.

## Under the hood

- **Two halves, one route.** The Host owns truth and action: the `open_items` storage domain, the capture fold, the model tool, the reply/delivery engine and retention. The browser owns presentation and intent: the page, card, panel, register, settings and the deterministic export, generated locally from shared record types. They talk through one versioned JSON route, `POST /api/open-items`, with capability flags so a surface can degrade instead of guessing.
- **An evidence ladder.** Detection is a pure, replay-safe fold over committed session events: the same log yields the same artifacts, and every family names what closes it. Authored state — raises, answers, dismissals, snoozes, suppressors, settings — is durable and compare-and-set; it is never recomputed from a log. The view merges both into one snapshot, so no surface can contradict the count that sent you there.
- **Capture is bounded and resumable.** A startup backfill covers recent root sessions (200 sessions / 90 days), a periodic re-scan catches closures that happened outside the live process, and a live fold handles each session as it commits. All detection state is checkpointed beside a per-session cursor.
- **Delivery is evidenced, not optimistic.** Three tracks — settle the shipped live card, ask the Host to settle a continued question, or send a session message (steer a running turn, or wake an idle one only with explicit confirmation). Each attempt records its track, state, evidence and failure reason; "unknown" is never reported as success.
- **Three independent versions.** The wire protocol (`1`), the durable domain format (`1`) and the record schema (`3`) version separately and are reported by the identity probe; a skew is surfaced as a truthful restart banner rather than a silently stale list. Migrations are idempotent and never fatal, and corrupt records are quarantined instead of failing the store.
- **TypeScript ESM, React 18 browser half, Cordis services, esbuild bundles.** The host bundle and the client bundle are built locally; the client stays under a 400 KiB contract, and the built host bundle is smoke-tested on fake services inside `pnpm verify`.

## Current limitations

- **Release candidate.** This is `0.1.0-rc.2`, pre-1.0: the version and the durable formats may change, and the package is installed from a checkout rather than npm.
- **Prose capture is a heuristic.** It reads only the agent's final message of a turn (a trailing ask section, or a strict single-ask fallback). It can miss decisions — asks inside nested lists, tables or other structure are not parsed — and its inferred kind can be wrong, which is why it produces candidates you confirm rather than items. It is bounded to a few candidates per turn and a small open set per session.
- **The unfinished-plan aggregate is coarse:** one candidate per session, not per task, and it closes only when the whole plan is completed.
- **Team-task capture is disabled:** no task items are detected from session events until its liveness gate is redesigned (an agent can still declare one explicitly). Several surface entry points are also deferred (workspace context-menu entry, session-header chip, cross-session duplicate grouping, and most of the keyboard map).
- **No aging or decay:** open items are not archived by age, only by the live-item cap. Snooze is one-way (no unsnooze control), and the row does not show its wake time.
- **Approvals are one-shot.** A mirrored approval is decidable only through the shipped live card while it exists; an authored approval is sent to the session as a message and may resume it and spend a turn. Nothing is grantable retroactively.
- **Acknowledgement is only what the log proves.** After the 24-hour window an unproven answer reads "no acknowledgement observed". A recorded (not sent) answer is reported as recorded rather than sent.
- **Live-ask settling is deployment-dependent.** Track 1 depends on the shipped client's pending-interaction carrier (one interaction per session, fail-closed), and track 2 needs a continued timed question. Where a track is unavailable the inbox says so instead of offering a control that cannot work.
- **Pull-only surfaces.** There is no push channel: the inbox re-reads on open, focus, visibility return, connection reset and a 60-second poll while visible; the panel re-reads on its visible edge and after writes; the card hydrates once.
- **One Host process per store.** There is no cross-process locking, so do not share a `DSH_HOME` store between concurrent DSH processes.
- **Delete-forever has a layout gap.** The control is offered on a resolved item, but the wide desktop and narrow layouts currently disable it with a note; only the medium in-row detail wires it — a known gap.
- **Extraction is unverified against a live provider.** The opt-in model-assisted extraction path is wired and bounded but was not exercised against a live provider in this work.

## Development

```sh
pnpm install
pnpm verify   # typecheck + static style audit + tests + host/client build + fake-domain smoke
```

`pnpm verify` is the definition of green. The individual gates are also runnable: `pnpm run typecheck`, `pnpm run test` (Vitest: unit, capture, delivery, client, export and end-to-end composition suites), `pnpm run build`, `pnpm run smoke`, `pnpm run style`, `pnpm run a11y`, `pnpm run package:check`. Two heavier gates are opt-in and non-hermetic: `OI_PERF=1 ./node_modules/.bin/vitest run tests/perf` for performance budgets, and `node scripts/acceptance.mjs` for a real-corpus acceptance pass (it needs `zstdcat` and a readable `$DSH_HOME`, and writes a gitignored report). A fresh checkout must be built before installing, because `lib/` is not committed.

| Path | Contents |
|---|---|
| `src/host/` | Host half: storage domain, capture folds/projection/backfill, route, model tool, reply/delivery engine, retention, extraction, config |
| `src/shared/` | Record schema, wire protocol, validation, export generator |
| `src/client/` | Browser half: transport and stores, inbox page, card, panel, register, settings, export, locales |
| `tests/` | Unit, capture, delivery, client, export, e2e, perf and acceptance suites |
| `scripts/` | Build, smoke, package, style, accessibility and acceptance commands |
| `docs/` | Maintainer design and context documentation (architecture, bounded contexts, specs, ADRs) |

Contributions are welcome: run `pnpm verify` before opening a pull request, add tests for behaviour changes, keep the client bundle inside its budget, and update both locale dictionaries when copy changes. There is no CI workflow yet, so `pnpm verify` is the gate. Release evidence and history live in [`VERIFY.md`](VERIFY.md) and [`CHANGELOG.md`](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE). This is an out-of-tree, third-party plugin, not part of the DeepSeek Harness distribution.
