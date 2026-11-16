/**
 * Live-driver hydration (PLAN-remediation §8, P1 fix).
 *
 * A driver attached after a Host restart has no ledger, so a post-restart
 * closing detector had nothing to close. On a session's first live event the
 * driver now reads the committed log once, folds the prefix with the live fold
 * (`historical:false`) and seeds its state and `seenSeqs` — **without** emitting
 * the prefix as drafts. These tests pin the seeding, the no-emission rule, the
 * prefix/triggering-event split, failure containment and the wiring seam.
 *
 * @module tests/capture/hydration.spec
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CaptureEvent } from '../../src/host/capture-contract'
import { createCaptureDriver, registerOpenItemsCapture } from '../../src/host/capture'
import { FakeCaptureContext, FakeSink, sessionInfo } from './fakes'
import { T0, approvalAsked, approvalDecided, foreignEvent } from './fixtures'

const NOW = T0 + 5 * 24 * 60 * 60 * 1000

/** A root session record the driver folds. */
const SESSION = sessionInfo('session-root', { updatedAt: NOW })

/** The pre-restart log: a pending approval, never decided. */
const PRE_RESTART_LOG: readonly CaptureEvent[] = [
  approvalAsked(0, 'approval-1', 'bash', 'call-1', 'run the suite'),
]

describe('driver hydration', () => {
  it('seeds the ledger so a post-restart grant closes the pre-restart pending ask', async () => {
    const sink = new FakeSink()
    const reads: string[] = []
    const driver = createCaptureDriver({
      sink,
      source: 'projection',
      now: () => NOW,
      readSession: async (sessionId) => {
        reads.push(sessionId)
        return PRE_RESTART_LOG
      },
    })
    const drafts = await driver.driveSession(SESSION, [approvalDecided(1, 'approval-1', 'allowed-once')])
    expect(reads).toEqual(['session-root'])
    expect(drafts.map(draft => draft.closes?.artifactId)).toEqual(['approval:call-1'])
    expect(drafts[0]?.closes?.code).toBe('approval/decided:allowed-once')
    // The hydration itself raised no draft: only the closure is reported.
    expect(sink.drafts.map(draft => draft.closes?.artifactId)).toEqual(['approval:call-1'])
  })

  it('is the fix for a restart without hydration: the same close is lost', async () => {
    const plain = createCaptureDriver({ sink: new FakeSink(), source: 'projection', now: () => NOW })
    const drafts = await plain.driveSession(SESSION, [approvalDecided(1, 'approval-1', 'allowed-once')])
    expect(drafts).toEqual([])
  })

  it('folds the read prefix without emitting it as drafts', async () => {
    const sink = new FakeSink()
    const driver = createCaptureDriver({
      sink,
      source: 'projection',
      now: () => NOW,
      // A log that would raise a blocked approval if it were emitted.
      readSession: async () => [
        approvalAsked(0, 'approval-1', 'bash', 'call-1', 'run the suite'),
        approvalDecided(1, 'approval-1', 'unavailable'),
      ],
    })
    const drafts = await driver.driveSession(SESSION, [foreignEvent(2)])
    expect(drafts).toEqual([])
    expect(sink.drafts).toEqual([])
    // The state is seeded: a later grant closes the silently-hydrated artifact.
    const close = await driver.driveSession(SESSION, [approvalDecided(3, 'approval-1', 'allowed-once')])
    expect(close.map(draft => draft.closes?.code)).toEqual(['approval/decided:allowed-once'])
  })

  it('folds the triggering event itself instead of losing it to the prefix', async () => {
    const sink = new FakeSink()
    const driver = createCaptureDriver({
      sink,
      source: 'projection',
      now: () => NOW,
      // The log read already contains the event that triggered hydration.
      readSession: async () => PRE_RESTART_LOG,
    })
    const drafts = await driver.driveSession(SESSION, PRE_RESTART_LOG)
    // The ask is raised exactly once, by the normal fold of the live event.
    expect(drafts.map(draft => draft.artifactId)).toEqual(['approval:call-1'])
    expect(drafts[0]?.detectorCode).toBe('approval/asked:awaiting-decision')
    expect(sink.opens.map(draft => draft.artifactId)).toEqual(['approval:call-1'])
  })

  it('does not re-fold a duplicate delivery of the triggering event after hydration', async () => {
    const driver = createCaptureDriver({
      sink: new FakeSink(),
      source: 'projection',
      now: () => NOW,
      readSession: async () => PRE_RESTART_LOG,
    })
    const first = await driver.driveSession(SESSION, PRE_RESTART_LOG)
    expect(first).toHaveLength(1)
    // A duplicate live delivery of the same event is a no-op after hydration.
    const replay = await driver.driveSession(SESSION, PRE_RESTART_LOG)
    expect(replay).toEqual([])
  })

  it('contains a failing log read and still folds the live event', async () => {
    const sink = new FakeSink()
    const errors: unknown[] = []
    const driver = createCaptureDriver({
      sink,
      source: 'projection',
      now: () => NOW,
      onError: error => { errors.push(error) },
      readSession: async () => { throw new Error('log unavailable') },
    })
    const drafts = await driver.driveSession(SESSION, PRE_RESTART_LOG)
    expect(drafts.map(draft => draft.artifactId)).toEqual(['approval:call-1'])
    expect(errors).toHaveLength(1)
  })

  it('reads the log only once per session', async () => {
    const reads: string[] = []
    const driver = createCaptureDriver({
      sink: new FakeSink(),
      source: 'projection',
      now: () => NOW,
      readSession: async (sessionId) => {
        reads.push(sessionId)
        return PRE_RESTART_LOG
      },
    })
    await driver.driveSession(SESSION, [approvalDecided(1, 'approval-1', 'allowed-once')])
    await driver.driveSession(SESSION, [foreignEvent(2)])
    expect(reads).toEqual(['session-root'])
  })

  it('does not hydrate a session the driver already folds', async () => {
    const reads: string[] = []
    const driver = createCaptureDriver({
      sink: new FakeSink(),
      source: 'projection',
      now: () => NOW,
      readSession: async (sessionId) => {
        reads.push(sessionId)
        return []
      },
    })
    await driver.driveSession(SESSION, [foreignEvent(0)])
    // The first call hydrated (empty log), so the second must not read again.
    await driver.driveSession(SESSION, [foreignEvent(1)])
    expect(reads).toEqual(['session-root'])
  })
})

describe('registerOpenItemsCapture hydration wiring', () => {
  const disposers: (() => void)[] = []
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose()
  })

  it('passes the cold-read seam to the live driver', async () => {
    const ctx = new Context()
    const sink = new FakeSink()
    const context = new FakeCaptureContext({ sessions: [] }).withEvents('session-live', PRE_RESTART_LOG)
    const capture = registerOpenItemsCapture(ctx, {
      sink,
      context,
      now: () => NOW,
      autoBackfill: false,
    })
    disposers.push(() => { void capture.dispose() })

    // Restart: the pending ask is already in the log; only the grant arrives live.
    ctx.emit('session/event', { id: 'session-live', inheritedEventCount: 0, header: { id: 'session-live' } } as never, {
      seq: 1,
      type: 'approval/decided',
      time: T0 + 1000,
      data: { id: 'approval-1', outcome: 'allowed-once' },
    } as never)

    await vi.waitFor(() => {
      expect(sink.closes.map(draft => draft.closes?.artifactId)).toEqual(['approval:call-1'])
    })
  })
})
