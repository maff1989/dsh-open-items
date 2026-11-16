/**
 * Durable backfill report callback seam (PLAN-remediation §12.4/§12.5, A part).
 *
 * The capture wiring calls `reportBackfill(report, trigger)` once after every
 * completed `runBackfill` pass: the mount pass reports `'activation'`, the
 * periodic timer reports `'rescan'`, and a manual `backfillNow()` counts as an
 * activation-triggered pass. A joined in-flight pass reports once (the pass has
 * one trigger, not one per waiter). The callback is contained: a throw must
 * neither abort capture activation nor turn a completed pass into a failure.
 *
 * @module tests/capture/backfill-report.spec
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BackfillReport } from '../../src/host/backfill'
import { registerOpenItemsCapture, type BackfillTrigger } from '../../src/host/capture'
import { FakeCaptureContext, FakeSink, sessionInfo } from './fakes'
import { T0, approvalAsked, approvalDecided } from './fixtures'

const NOW = T0 + 5 * 24 * 60 * 60 * 1000

/** One report invocation captured by the test. */
interface RecordedReport {
  readonly report: BackfillReport
  readonly trigger: BackfillTrigger
}

/** A context with one foldable session (a blocked approval). */
function oneSessionContext(): FakeCaptureContext {
  return new FakeCaptureContext({ sessions: [sessionInfo('s1', { updatedAt: NOW })] })
    .withEvents('s1', [approvalAsked(0, 'a1', 'bash', 'call-1'), approvalDecided(1, 'a1', 'unavailable')])
}

describe('reportBackfill', () => {
  const disposers: (() => void)[] = []
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose()
  })

  it('reports the activation pass once, with the settled report', async () => {
    const ctx = new Context()
    const records: RecordedReport[] = []
    const capture = registerOpenItemsCapture(ctx, {
      sink: new FakeSink(),
      context: oneSessionContext(),
      now: () => NOW,
      reportBackfill: (report, trigger) => { records.push({ report, trigger }) },
    })
    disposers.push(() => { void capture.dispose() })
    await vi.waitFor(() => {
      expect(records).toHaveLength(1)
    })
    expect(records[0]?.trigger).toBe('activation')
    expect(records[0]?.report).toMatchObject({
      sessionsEligible: 1,
      sessionsFolded: 1,
      sessionsFailed: 0,
    })
    expect(records[0]?.report.draftsEmitted).toBeGreaterThan(0)
    // A settled pass: no further report from activation alone.
    await capture.dispose()
    expect(records).toHaveLength(1)
  })

  it('reports periodic rescans with the rescan trigger and stops on dispose', async () => {
    const ctx = new Context()
    const records: RecordedReport[] = []
    const capture = registerOpenItemsCapture(ctx, {
      sink: new FakeSink(),
      context: oneSessionContext(),
      now: () => NOW,
      rescanIntervalMs: 20,
      reportBackfill: (report, trigger) => { records.push({ report, trigger }) },
    })
    disposers.push(() => { void capture.dispose() })
    await vi.waitFor(() => {
      expect(records.length).toBeGreaterThanOrEqual(2)
    }, { timeout: 2_000 })
    expect(records[0]?.trigger).toBe('activation')
    expect(records.slice(1).every(record => record.trigger === 'rescan')).toBe(true)
    // Every rescan report describes a real pass (the session is cursor-covered
    // but the log is still read, so it reports as skipped rather than folded).
    const rescan = records.find(record => record.trigger === 'rescan')
    expect(rescan?.report.sessionsSkipped).toBeGreaterThanOrEqual(1)
    await capture.dispose()
    const settled = records.length
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(records.length).toBe(settled)
  })

  it('reports a manual backfillNow pass as activation and returns the same report object', async () => {
    const ctx = new Context()
    const records: RecordedReport[] = []
    const capture = registerOpenItemsCapture(ctx, {
      sink: new FakeSink(),
      context: oneSessionContext(),
      now: () => NOW,
      autoBackfill: false,
      reportBackfill: (report, trigger) => { records.push({ report, trigger }) },
    })
    disposers.push(() => { void capture.dispose() })
    const report = await capture.backfillNow()
    expect(report).toBeDefined()
    expect(records).toHaveLength(1)
    expect(records[0]?.report).toBe(report)
    expect(records[0]?.trigger).toBe('activation')
  })

  it('reports once when two callers join the same in-flight pass', async () => {
    const ctx = new Context()
    const records: RecordedReport[] = []
    const capture = registerOpenItemsCapture(ctx, {
      sink: new FakeSink(),
      context: oneSessionContext(),
      now: () => NOW,
      autoBackfill: false,
      reportBackfill: (report, trigger) => { records.push({ report, trigger }) },
    })
    disposers.push(() => { void capture.dispose() })
    const [first, second] = await Promise.all([capture.backfillNow(), capture.backfillNow()])
    expect(first).toBe(second)
    expect(records).toHaveLength(1)
    expect(records[0]?.report).toBe(first)
  })

  it('contains a throwing callback: the pass still completes and the error is reported', async () => {
    const ctx = new Context()
    const errors: unknown[] = []
    const capture = registerOpenItemsCapture(ctx, {
      sink: new FakeSink(),
      context: oneSessionContext(),
      now: () => NOW,
      autoBackfill: false,
      onError: error => { errors.push(error) },
      reportBackfill: () => { throw new Error('report store unavailable') },
    })
    disposers.push(() => { void capture.dispose() })
    const report = await capture.backfillNow()
    expect(report?.sessionsFolded).toBe(1)
    expect(errors).toHaveLength(1)
  })

  it('changes nothing when the callback is absent', async () => {
    const ctx = new Context()
    const sink = new FakeSink()
    const capture = registerOpenItemsCapture(ctx, {
      sink,
      context: oneSessionContext(),
      now: () => NOW,
    })
    disposers.push(() => { void capture.dispose() })
    await vi.waitFor(() => {
      expect(sink.opens.map(draft => draft.artifactId)).toEqual(['approval:call-1'])
    })
    await capture.dispose()
  })
})
