/**
 * M1 acceptance gate over the user's real corpus.
 *
 * Gated by `OI_ACCEPTANCE=1` because it reads `$DSH_HOME` (read-only) and takes
 * seconds to minutes; the normal `vitest run` stays hermetic. Run it through
 * `node scripts/acceptance.mjs` or directly:
 *
 *     OI_ACCEPTANCE=1 ./node_modules/.bin/vitest run tests/acceptance
 *
 * The capture modules live on a different branch until merged; when they are
 * absent this suite records a skipped run in `tests/acceptance/last-run.json`
 * and reports why instead of failing.
 */
import { describe, expect, it } from 'vitest'

import {
  computeInvariants,
  foldCorpus,
  formatReport,
  loadCaptureAdapter,
  loadCorpus,
  writeLastRun,
  type AcceptanceReport,
} from './corpus'

const ENABLED = process.env['OI_ACCEPTANCE'] === '1'
const STRICT = process.env['OI_ACCEPTANCE_STRICT'] === '1'
const MAX_SESSIONS = process.env['OI_ACCEPTANCE_MAX_SESSIONS'] === undefined
  ? undefined
  : Number.parseInt(process.env['OI_ACCEPTANCE_MAX_SESSIONS'], 10)

describe.skipIf(!ENABLED)('real-corpus acceptance (OI_ACCEPTANCE=1)', () => {
  it('folds the real session corpus and reports the M1 numbers', async (testContext) => {
    const probe = await loadCaptureAdapter()
    const corpus = await loadCorpus(MAX_SESSIONS === undefined || Number.isNaN(MAX_SESSIONS)
      ? {}
      : { maxSessions: MAX_SESSIONS })

    if (corpus.files.length === 0) {
      const report = computeInvariants([], corpus.sessions, corpus, {
        available: probe.adapter !== undefined,
        ...(probe.adapter === undefined ? { reason: probe.reason } : { adapter: probe.adapter.name }),
        probes: probe.notes,
        foldedSessions: 0,
        foldErrors: [],
      })
      const skipped: AcceptanceReport = {
        ...report,
        skipped: `no session logs found under ${corpus.sessionsRoot} (set $DSH_HOME or generate sessions first)`,
      }
      await writeLastRun(skipped)
      console.warn(formatReport(skipped))
      testContext.skip()
      return
    }

    if (probe.adapter === undefined) {
      const report = computeInvariants([], corpus.sessions, corpus, {
        available: false,
        reason: probe.reason,
        probes: probe.notes,
        foldedSessions: 0,
        foldErrors: [],
      })
      const skipped: AcceptanceReport = { ...report, skipped: probe.reason ?? 'capture modules absent' }
      await writeLastRun(skipped)
      console.warn(formatReport(skipped))
      testContext.skip()
      return
    }

    const folded = await foldCorpus(probe.adapter, corpus)
    const report = computeInvariants(
      folded.origins,
      corpus.sessions,
      corpus,
      {
        available: true,
        adapter: probe.adapter.name,
        probes: probe.notes,
        foldedSessions: folded.foldedSessions,
        foldErrors: folded.foldErrors,
      },
    )
    await writeLastRun(report)
    console.log(formatReport(report))

    // Non-negotiable invariants (PLAN.md §3, updated for decision D3/D5):
    // - a subagent session never produces an item;
    // - a `todo_write`-derived row never reaches Needs you (it is a candidate by
    //   decision D3; the old "zero todo-derived rows" invariant is overturned);
    // - every raised family declares its closing-detector capability, so the
    //   closure invariant is a declared capability, not a string match;
    // - the folds never throw on real events.
    expect(report.invariants.rootOnlyViolations, 'a subagent session produced an item').toEqual([])
    expect(report.invariants.todoDerivedNeedsYou, 'a todo_write-derived row reached Needs you').toEqual([])
    expect(report.invariants.unclassifiedArtifacts, 'a capture family has no declared closing-detector capability').toEqual([])
    expect(report.capture.foldErrors, 'the folds threw on real events').toEqual([])
    // Accounting is open-at-log-end: the headline can never exceed the raised set.
    expect(report.counts.uniqueArtifacts).toBe(report.counts.structural + report.counts.candidate)
    expect(report.counts.uniqueArtifacts).toBeLessThanOrEqual(report.counts.raisedArtifacts)

    // Acceptance target: informational unless OI_ACCEPTANCE_STRICT=1.
    if (STRICT) {
      expect(report.counts.structural).toBeLessThanOrEqual(report.target.maxStructural)
    } else if (!report.target.met) {
      console.warn(
        `M1 target MISSED (informational): ${report.counts.structural} structural items`
        + ` > ${report.target.maxStructural}; set OI_ACCEPTANCE_STRICT=1 to enforce.`,
      )
    }
  }, 300_000)
})

describe.skipIf(ENABLED)('real-corpus acceptance (gated)', () => {
  it('is skipped without OI_ACCEPTANCE=1', () => {
    expect(ENABLED).toBe(false)
  })
})
