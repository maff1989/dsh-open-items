/**
 * Detection-watermark correctness (REVIEW-rc1 P1 watermark, WP-02).
 *
 * Two failure modes this suite pins:
 *
 * 1. **Creation time is not activity.** The persisted header's `createdAt` used
 *    to be stamped into `cursor.lastEventTime`, so a rooster-less session that
 *    gained events later was skipped forever ("blank/roster-less first pass
 *    hides later activity"). Only a roster-reported `lastActivityAt` may skip a
 *    session without a read; otherwise the read itself proves coverage.
 * 2. **A delta re-fold must not replay scanned history.** Replaying old raises
 *    at the store reopens detector-closed items and bumps version/reopenCount on
 *    every boot; the delta fold emits only transitions caused by events past the
 *    cursor.
 *
 * @module tests/capture/watermark.spec
 */

import { describe, expect, it } from 'vitest'

import type { CaptureEvent, CaptureSessionInfo } from '../../src/host/capture-contract'
import type { DetectionCursor } from '../../src/shared/schema'
import { InMemoryDetectionCursorStore, runBackfill } from '../../src/host/backfill'
import { OPEN_ITEMS_FOLD_VERSION } from '../../src/host/folds/limits'
import { OPEN_ITEMS_PROJECTION_VERSION, foldSession } from '../../src/host/projection'
import { FakeCaptureContext, FakeSink, sessionInfo } from './fakes'
import {
  T0,
  approvalAsked,
  approvalDecided,
  assistantMessage,
  goalSnapshot,
  turnEnd,
  turnStart,
} from './fixtures'

/** One deterministic clock. */
const NOW = T0 + 10 * 24 * 60 * 60 * 1000

/** The two-event log whose blocked approval is the open artifact. */
const BLOCKED_APPROVAL: CaptureEvent[] = [
  approvalAsked(0, 'approval-1', 'bash', 'call-1'),
  approvalDecided(1, 'approval-1', 'unavailable'),
]

/** A five-item decision section: one per-item prose candidate per item. */
const PROSE_SECTION = [
  '## Decisions I need from you',
  '',
  '- **A** — Choose (a) keep the guard or (b) replace it?',
  '- **B** — Ship now or wait for the next release?',
  '- **C** — Keep the current retention window?',
  '- **D** — Update the docs or only the changelog?',
  '- **E** — Open one PR or two?',
].join('\n')

/** The granted retry that closes the blocked item. */
const RETRY_CLOSES: CaptureEvent[] = [
  approvalAsked(2, 'approval-2', 'bash', 'call-1'),
  approvalDecided(3, 'approval-2', 'allowed-once'),
]

/** A roster-less catalog row: header facts only, no real activity time. */
function rosterlessSession(sessionId = 's1', overrides: Partial<CaptureSessionInfo> = {}): CaptureSessionInfo {
  return sessionInfo(sessionId, { updatedAt: T0, lastActivityAt: undefined, ...overrides })
}

/** Run one backfill with deterministic bounds. */
async function backfill(
  context: FakeCaptureContext,
  sink: FakeSink,
  cursors: InMemoryDetectionCursorStore,
): Promise<Awaited<ReturnType<typeof runBackfill>>> {
  return runBackfill({ context, sink, cursors, now: () => NOW, yieldTo: async () => undefined })
}

describe('creation time is never an activity watermark', () => {
  it('does not stamp a blank roster-less first pass with the creation time', async () => {
    const cursors = new InMemoryDetectionCursorStore()
    const session = rosterlessSession('blank')
    const context = new FakeCaptureContext({ sessions: [session] }).withEvents('blank', [])
    const first = await backfill(context, new FakeSink(), cursors)
    expect(first.sessionsFolded).toBe(1)
    // The cursor records "no committed event scanned", not the header's createdAt.
    expect(await cursors.get('blank')).toMatchObject({ lastScannedSeq: 0, lastEventTime: 0 })

    // The log gains events later; the catalog still reports no real activity
    // time. The cursor must not hide them.
    const sink = new FakeSink()
    const grown = new FakeCaptureContext({ sessions: [session] })
      .withEvents('blank', BLOCKED_APPROVAL)
    const second = await backfill(grown, sink, cursors)
    expect(second.sessionsFolded).toBe(1)
    expect(sink.opens.map(draft => draft.artifactId)).toEqual(['approval:call-1'])
    expect((await cursors.get('blank'))?.lastEventTime).toBe(T0 + 1000)
  })

  it('re-reads a roster-less session whose log gained events', async () => {
    const cursors = new InMemoryDetectionCursorStore()
    const session = rosterlessSession('cold')
    const first = new FakeCaptureContext({ sessions: [session] }).withEvents('cold', BLOCKED_APPROVAL)
    await backfill(first, new FakeSink(), cursors)
    // Same catalog metadata (no roster row → no activity time), longer log.
    const grown = new FakeCaptureContext({ sessions: [session] })
      .withEvents('cold', [...BLOCKED_APPROVAL, ...RETRY_CLOSES])
    const sink = new FakeSink()
    const report = await backfill(grown, sink, cursors)
    expect(report.sessionsFolded).toBe(1)
    expect(grown.readCounts.get('cold')).toBeGreaterThan(0)
    // Only the new closure is emitted; the old raise is not replayed.
    expect(sink.opens).toEqual([])
    expect(sink.closes.map(draft => draft.closes?.artifactId)).toEqual(['approval:call-1'])
    expect(sink.closes[0]?.closes?.code).toBe('approval/decided:allowed-once')
  })
})

describe('cursor coverage is the watermark the installed Host can prove', () => {
  it('reads an unchanged session once and skips the fold by cursor coverage', async () => {
    const cursors = new InMemoryDetectionCursorStore()
    const session = sessionInfo('s1')
    const context = new FakeCaptureContext({ sessions: [session] }).withEvents('s1', BLOCKED_APPROVAL)
    await backfill(context, new FakeSink(), cursors)
    const second = new FakeCaptureContext({ sessions: [session] }).withEvents('s1', BLOCKED_APPROVAL)
    const report = await backfill(second, new FakeSink(), cursors)
    expect(report.sessionsSkipped).toBe(1)
    expect(report.sessionsFolded).toBe(0)
    // The installed roster cannot prove log immutability, so the read happens;
    // what a boot must not do is re-fold and re-emit history.
    expect(second.readCounts.get('s1')).toBe(1)
  })

  it('folds only the events past the cursor when the log grew', async () => {
    const cursors = new InMemoryDetectionCursorStore()
    const context = new FakeCaptureContext({ sessions: [sessionInfo('s1')] }).withEvents('s1', BLOCKED_APPROVAL)
    await backfill(context, new FakeSink(), cursors)
    const grown = new FakeCaptureContext({ sessions: [sessionInfo('s1')] }).withEvents('s1', [
      ...BLOCKED_APPROVAL,
      goalSnapshot(2, 'block', { id: 'goal-1', revision: 2, objective: 'ship it', phase: 'blocked' }),
    ])
    const sink = new FakeSink()
    const report = await backfill(grown, sink, cursors)
    expect(report.sessionsFolded).toBe(1)
    expect(sink.opens.map(draft => draft.artifactId)).toEqual(['goal:goal-1'])
  })

  it('emits nothing when the log is unchanged (no replay of a scanned raise)', async () => {
    const cursors = new InMemoryDetectionCursorStore()
    const context = new FakeCaptureContext({ sessions: [sessionInfo('s1')] }).withEvents('s1', BLOCKED_APPROVAL)
    await backfill(context, new FakeSink(), cursors)
    const same = new FakeCaptureContext({ sessions: [sessionInfo('s1', { updatedAt: NOW })] }).withEvents('s1', BLOCKED_APPROVAL)
    const sink = new FakeSink()
    const report = await backfill(same, sink, cursors)
    expect(report.sessionsSkipped).toBe(1)
    expect(sink.drafts).toEqual([])
  })

  it('does not replay a scanned raise when only an uninteresting event is appended', async () => {
    const cursors = new InMemoryDetectionCursorStore()
    const context = new FakeCaptureContext({ sessions: [sessionInfo('s1')] }).withEvents('s1', BLOCKED_APPROVAL)
    await backfill(context, new FakeSink(), cursors)
    const appended = new FakeCaptureContext({ sessions: [sessionInfo('s1')] })
      .withEvents('s1', [...BLOCKED_APPROVAL, turnStart(2, 2)])
    const sink = new FakeSink()
    const report = await backfill(appended, sink, cursors)
    expect(report.sessionsFolded).toBe(1)
    expect(sink.drafts).toEqual([])
    expect((await cursors.get('s1'))?.lastScannedSeq).toBe(2)
  })
})

describe('proven activity is an optional Host capability', () => {
  it('skips without a read when the Host proves an activity upper bound', async () => {
    const cursors = new InMemoryDetectionCursorStore()
    // A Host that CAN prove activity reports the newest committed event time.
    const session = sessionInfo('s1', { updatedAt: NOW, lastActivityAt: T0 + 1000 })
    const context = new FakeCaptureContext({ sessions: [session] }).withEvents('s1', BLOCKED_APPROVAL)
    await backfill(context, new FakeSink(), cursors)
    const second = new FakeCaptureContext({ sessions: [session] }).withEvents('s1', BLOCKED_APPROVAL)
    const report = await backfill(second, new FakeSink(), cursors)
    expect(report.sessionsSkipped).toBe(1)
    expect(report.sessionsFolded).toBe(0)
    expect(second.readCounts.get('s1')).toBeUndefined()
  })

  it('ignores an activity time older than the cursor event coverage as a read trigger', async () => {
    const cursors = new InMemoryDetectionCursorStore()
    // The installed roster's `updatedAt` is a lower bound (last user prompt), so
    // it can make the backfill re-read but never skip new tool activity.
    const first = sessionInfo('s1', { updatedAt: NOW - 2000, lastActivityAt: NOW - 2000 })
    const context = new FakeCaptureContext({ sessions: [first] }).withEvents('s1', BLOCKED_APPROVAL)
    await backfill(context, new FakeSink(), cursors)
    const moved = new FakeCaptureContext({ sessions: [sessionInfo('s1', { updatedAt: NOW, lastActivityAt: NOW })] })
      .withEvents('s1', [...BLOCKED_APPROVAL, ...RETRY_CLOSES])
    const sink = new FakeSink()
    const report = await backfill(moved, sink, cursors)
    expect(report.sessionsFolded).toBe(1)
    expect(sink.closes.map(draft => draft.closes?.artifactId)).toEqual(['approval:call-1'])
  })
})

describe('fold and projection version pair', () => {
  it('moves the fold and projection versions together', () => {
    // Two counters over the same semantics: bumping one alone leaves a stale
    // checkpoint or cursor interpreting new state with old rules (G-13).
    expect(OPEN_ITEMS_FOLD_VERSION).toBe(OPEN_ITEMS_PROJECTION_VERSION)
    expect(OPEN_ITEMS_FOLD_VERSION).toBe(3)
  })
})

describe('cursor recovery', () => {
  it('replays the baseline after a fold-version bump', async () => {
    const cursors = new InMemoryDetectionCursorStore()
    const stale: DetectionCursor = {
      sessionId: 's1',
      lastScannedSeq: 1,
      lastEventTime: T0 + 1000,
      lastScanAt: NOW - 5000,
      foldVersion: OPEN_ITEMS_FOLD_VERSION - 1,
    }
    await cursors.put(stale)
    const context = new FakeCaptureContext({ sessions: [rosterlessSession('s1')] }).withEvents('s1', BLOCKED_APPROVAL)
    const sink = new FakeSink()
    const report = await backfill(context, sink, cursors)
    expect(report.sessionsFolded).toBe(1)
    expect(sink.opens.map(draft => draft.artifactId)).toEqual(['approval:call-1'])
    expect((await cursors.get('s1'))?.foldVersion).toBe(OPEN_ITEMS_FOLD_VERSION)
  })

  it('replays every per-item prose candidate after a fold-version bump', async () => {
    const cursors = new InMemoryDetectionCursorStore()
    await cursors.put({
      sessionId: 's1',
      lastScannedSeq: 2,
      lastEventTime: T0 + 2000,
      lastScanAt: NOW - 5000,
      foldVersion: OPEN_ITEMS_FOLD_VERSION - 1,
    })
    const context = new FakeCaptureContext({ sessions: [rosterlessSession('s1')] }).withEvents('s1', [
      turnStart(0, 2),
      assistantMessage(1, 2, PROSE_SECTION),
      turnEnd(2, 2),
    ])
    const sink = new FakeSink()
    const report = await backfill(context, sink, cursors)
    expect(report.sessionsFolded).toBe(1)
    const prose = sink.opens.filter(draft => draft.artifactId.startsWith('prose:'))
    expect(prose).toHaveLength(5)
    expect(new Set(prose.map(draft => draft.artifactId)).size).toBe(5)
    expect((await cursors.get('s1'))?.foldVersion).toBe(OPEN_ITEMS_FOLD_VERSION)
    // A further unchanged pass reuses the cursor: no duplicate candidates.
    const again = new FakeSink()
    await backfill(
      new FakeCaptureContext({ sessions: [rosterlessSession('s1')] }).withEvents('s1', [
        turnStart(0, 2),
        assistantMessage(1, 2, PROSE_SECTION),
        turnEnd(2, 2),
      ]),
      again,
      cursors,
    )
    expect(again.opens.filter(draft => draft.artifactId.startsWith('prose:'))).toEqual([])
  })

  it('rebuilds the baseline when the log was rewritten shorter than the cursor', async () => {
    const cursors = new InMemoryDetectionCursorStore()
    await cursors.put({
      sessionId: 's1',
      lastScannedSeq: 40,
      lastEventTime: NOW,
      lastScanAt: NOW,
      foldVersion: OPEN_ITEMS_FOLD_VERSION,
    })
    const context = new FakeCaptureContext({ sessions: [rosterlessSession('s1')] }).withEvents('s1', BLOCKED_APPROVAL)
    const sink = new FakeSink()
    await backfill(context, sink, cursors)
    expect(sink.opens.map(draft => draft.artifactId)).toEqual(['approval:call-1'])
    expect((await cursors.get('s1'))?.lastScannedSeq).toBe(1)
  })
})

describe('foldSession delta resume', () => {
  const SESSION: CaptureSessionInfo = sessionInfo('s1')

  it('emits only transitions caused by events past sinceSeq', () => {
    const folded = foldSession([...BLOCKED_APPROVAL, ...RETRY_CLOSES], {
      session: SESSION,
      source: 'log-fold',
      mode: 'delta',
      sinceSeq: 1,
    })
    // The raise at seq 0/1 is suppressed; the closure at seq 3 is not, even
    // though the closure draft carries the artifact's raising seq.
    expect(folded.drafts.filter(draft => draft.closes === undefined)).toEqual([])
    expect(folded.drafts.map(draft => draft.closes?.artifactId)).toEqual(['approval:call-1'])
    expect(folded.lastScannedSeq).toBe(3)
  })

  it('advances lastScannedSeq past uninteresting events', () => {
    const folded = foldSession([...BLOCKED_APPROVAL, turnStart(2, 2)], {
      session: SESSION,
      source: 'log-fold',
      mode: 'delta',
      sinceSeq: 1,
    })
    expect(folded.drafts).toEqual([])
    expect(folded.lastScannedSeq).toBe(2)
  })

  it('keeps the whole-log delta when no sinceSeq is given', () => {
    const folded = foldSession(BLOCKED_APPROVAL, { session: SESSION, source: 'log-fold', mode: 'delta' })
    expect(folded.drafts.map(draft => draft.artifactId)).toEqual(['approval:call-1'])
  })
})
