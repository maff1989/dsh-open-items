# Performance budgets and measurements

The plugin's read path is an in-memory scan over records the storage domain
already holds: there are no secondary indexes and no cross-record joins
(DESIGN §7.4.4, storage-domain limitations). The design accepts that cost at
the stated caps (5,000 resolutions, ≤500 live items) and the guards below keep
it from silently regressing.

Guards live in `tests/perf/budget.spec.ts` and are **hermetic by default**:

```bash
OI_PERF=1 ./node_modules/.bin/vitest run tests/perf
# or: node scripts/acceptance.mjs is unrelated; perf is a separate env gate
```

Without `OI_PERF=1` the suite is skipped, so normal `vitest run` stays fast and
deterministic.

## Measured on this machine

Environment: this workspace's Linux container, Node v24.22.2, fake in-memory
storage domain (the real backend adds file I/O per write, not per read),
2026-11-14. **Release state:** rc2 `0.1.0-rc.2` re-ran the guard
(`OI_PERF=1`, PASS): **12,802 events/s**, projected **7.6 s** of fold for the
recorded 118-session / 97,704-event corpus. The read-path per-operation table
below is the last recorded per-operation snapshot (rc1); the rc2 guard re-ran
against the same budgets and passed. Full gate record: [`../VERIFY.md`](../VERIFY.md).

### Read path at the resolution cap

Setup: 5,000 resolved records spread over 100 sessions and 10 workspaces; 30
measured iterations after 3 warm-up iterations, two consecutive runs on the same
machine. `service.list({})` builds a full `InboxSnapshot` (filter + counts +
session rows + workspace rows); `list({status:'resolved', limit:50})` is one
resolved page; `register({limit:50})` is one register page.

| Operation | run 1 p50 / p95 / max | run 2 p50 / p95 / max | Budget |
| --- | --- | --- | --- |
| `list({})` snapshot | 1.13 / **1.62** / 2.06 ms | 1.17 / **1.64** / 2.34 ms | < 150 ms p95 |
| `list({status:'resolved', limit:50})` | 1.32 / **1.73** / 2.69 ms | 1.49 / **2.11** / 2.70 ms | < 150 ms p95 |
| `register({limit:50})` | 0.27 / **0.33** / 0.39 ms | 0.27 / **0.32** / 0.40 ms | < 150 ms p95 |

Interpretation: ~100× headroom at the design cap. The budgets are deliberately
generous (150 ms) because the same numbers will be re-measured on user hardware
and because the cost is O(records) per read; a regression past 150 ms means an
accidental per-read sort of the full set or an out-of-cap record explosion, not
a slow machine.

### Fold / backfill throughput

Setup: 118 synthetic root sessions × 414 approval pairs (97,704 committed
events, real rc.1 event payload shapes) folded through the real
`createCaptureDriver`, sink batched at 100.

| Metric | Value |
| --- | --- |
| Events folded | 97,704 |
| Drafts produced | 48,852 |
| Wall time (rc2 guard run) | pass at budget |
| Throughput (rc2 guard run) | **12,802 events/s** |
| Projected recorded corpus (118 sessions / 97,704 events) | **7.6 s of fold CPU** |

Interpretation: the one-time backfill fold for the measured corpus
(118 synthetic root sessions, 97,704 events folded; the recorded real corpus is
103,737 events / 119 logs / 49 root sessions within the 200-session / 90-day
backfill window) is projected at roughly 10–11 seconds of pure fold work
(run-to-run variance on this shared container is ~10%). The real backfill is
bounded by `~/.dsh` log reads and the 200-session / 90-day window
(`DEFAULT_BACKFILL_LIMITS`), and it yields between sessions, so it does not
block a session; this number is the CPU floor, not the wall-clock promise.
It also only runs once per session (cursor-covered), so steady-state cost is
the live fold: one pure function per committed event.

**Per-activation read volume (rc2).** One activation reads at most the bounded
eligible set — **≤200 session logs, 90-day window**, one bounded read per
eligible session — work-sliced with yields so a chat opens normally while it runs.
Cursor coverage, not `SessionSummary.updatedAt`, decides whether a session still
needs folding: `updatedAt` is `max(createdAt, lastPromptAt)`, i.e. prompt time
only, and is a lower bound rather than proof that no later tool activity exists.
On a restart with an unchanged corpus the pass is cursor-covered and performs no
fold writes (no reopen/version churn); the fold-CPU figures above are a cold-sweep
floor, not the steady-state cost.

## How to reproduce

```bash
# read-path + fold guards with the numbers above printed to stdout
OI_PERF=1 ./node_modules/.bin/vitest run tests/perf

# the real-corpus acceptance measurement that supplies the recorded corpus size
node scripts/acceptance.mjs          # writes tests/acceptance/last-run.json
```

## Opt-in extraction (round 2) — not a default path

Model-assisted extraction is **off by default** and absent unless the deployment
configures `extractionProvider` + `extractionModel` **and** the user enables the
Settings toggle, so it is not part of any measured budget above. When enabled it
adds at most one bounded one-shot model call per **new live prose candidate**, with
`extractionMaxInputBytes` 8192, `maxTokens: 200`, `temperature: 0`,
`extractionTimeoutMs` 8000 and an in-memory UTC-day budget (default 20). The
acceptance fold/read numbers are unchanged by it; it was **not exercised against
a live provider** in this work, so there is no measured extraction latency in this
document.

## Notes and limits

- The fake domain keeps records in memory; the real JSON backend's per-record
  writes affect **write** latency (one document per transition), not the read
  scans measured here. Write-path latency is exercised by the store suite, not
  budgeted in M6.
- Perf numbers are machine- and JIT-dependent; the guard asserts the generous
  budget, and this document records a concrete snapshot rather than a promise.
- The guards are not part of the default ladder; a release candidate should run
  `OI_PERF=1` on the target machine once (see `docs/release.md`).
