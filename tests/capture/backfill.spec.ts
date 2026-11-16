/**
 * Backfill behaviour: eligibility filters, fork cut, batching, resumability and
 * failure containment — over the in-memory fakes, no live harness.
 *
 * @module tests/capture/backfill.spec
 */

import { describe, expect, it } from 'vitest'

import type { CaptureSessionInfo, DerivedItemDraft } from '../../src/host/capture-contract'
import type { DetectionCursor } from '../../src/shared/schema'
import {
  InMemoryDetectionCursorStore,
  isRootSession,
  runBackfill,
  type BackfillOptions,
  type DetectionCursorStore,
} from '../../src/host/backfill'
import { OPEN_ITEMS_FOLD_VERSION } from '../../src/host/folds/limits'
import { deriveInheritedEventCount } from '../../src/host/projection'
import { FakeCaptureContext, FakeSink, sessionInfo } from './fakes'
import {
  T0,
  approvalAsked,
  approvalDecided,
  askUserQuestionArgs,
  assistantMessage,
  foreignEvent,
  forkedSessionLog,
  jobRegistered,
  jobSettled,
  todoWrite,
  toolCall,
  turnEnd,
  turnStart,
  userPrompt,
} from './fixtures'

/** One deterministic clock. */
const NOW = T0 + 10 * 24 * 60 * 60 * 1000

/** Run a backfill with deterministic bounds and no real timers. */
async function backfill(
  context: FakeCaptureContext,
  sink: FakeSink,
  overrides: Partial<BackfillOptions> = {},
  cursors: DetectionCursorStore = new InMemoryDetectionCursorStore(),
): Promise<Awaited<ReturnType<typeof runBackfill>>> {
  return runBackfill({
    context,
    sink,
    cursors,
    now: () => NOW,
    yieldTo: async () => undefined,
    ...overrides,
  })
}

/** A session catalog entry that is a root session inside the age window. */
function rootSession(sessionId: string, overrides: Partial<CaptureSessionInfo> = {}): CaptureSessionInfo {
  return sessionInfo(sessionId, { updatedAt: NOW - 1000, ...overrides })
}

describe('root session scope', () => {
  it('accepts ordinary sessions and rejects subagent origin and delegated depth', () => {
    expect(isRootSession(rootSession('a'))).toBe(true)
    expect(isRootSession(rootSession('b', { origin: 'subagent' }))).toBe(false)
    expect(isRootSession(rootSession('c', { delegationDepth: 1 }))).toBe(false)
    expect(isRootSession(rootSession('d', { delegationDepth: 0 }))).toBe(true)
  })

  it('folds only root sessions', async () => {
    const sink = new FakeSink()
    const context = new FakeCaptureContext({
      sessions: [
        rootSession('root'),
        rootSession('child', { origin: 'subagent' }),
        rootSession('delegate', { delegationDepth: 1 }),
      ],
    })
      .withEvents('root', [approvalAsked(0, 'a1', 'bash', 'call-1'), approvalDecided(1, 'a1', 'unavailable')])
      .withEvents('child', [approvalAsked(0, 'a2', 'bash', 'call-2'), approvalDecided(1, 'a2', 'unavailable')])
      .withEvents('delegate', [approvalAsked(0, 'a3', 'bash', 'call-3'), approvalDecided(1, 'a3', 'unavailable')])
    const report = await backfill(context, sink)
    expect(report.sessionsEligible).toBe(1)
    expect(report.sessionsFolded).toBe(1)
    expect(sink.opens.map(draft => draft.sessionId)).toEqual(['root'])
  })
})

describe('archived sessions', () => {
  it('skips a session the workspace has archived instead of re-folding it', async () => {
    const sink = new FakeSink()
    const context = new FakeCaptureContext({
      sessions: [
        rootSession('live'),
        rootSession('archived', { archived: true }),
      ],
    })
      .withEvents('live', [approvalAsked(0, 'a1', 'bash', 'call-1'), approvalDecided(1, 'a1', 'unavailable')])
      .withEvents('archived', [approvalAsked(0, 'a2', 'bash', 'call-2'), approvalDecided(1, 'a2', 'unavailable')])
    const report = await backfill(context, sink)
    expect(report.sessionsEligible).toBe(1)
    expect(report.sessionsFolded).toBe(1)
    expect(sink.opens.map(draft => draft.sessionId)).toEqual(['live'])
    // The archived log was never even read.
    expect(context.readCounts.get('archived')).toBeUndefined()
  })
})

/** A final assistant message that passes the prose fallback gate. */
const PROSE_QUESTION = 'I reviewed the migration plan and the schema matches the diff. '
  + 'Do you want me to run the full verification ladder now?'

/** A five-item decision section (one per-item prose candidate each). */
const PROSE_SECTION = [
  '## Decisions I need from you',
  '',
  '- **A** — Choose (a) keep the guard or (b) replace it?',
  '- **B** — Ship now or wait for the next release?',
  '- **C** — Keep the current retention window?',
  '- **D** — Update the docs or only the changelog?',
  '- **E** — Open one PR or two?',
].join('\n')

describe('runtime settings', () => {
  it('drops prose raises when proseCandidates is off, keeping the todo aggregate', async () => {
    const sink = new FakeSink()
    const context = new FakeCaptureContext({ sessions: [rootSession('s1')] }).withEvents('s1', [
      turnStart(0, 1),
      assistantMessage(1, 1, PROSE_QUESTION),
      todoWrite(2, [{ content: 'Update the changelog', status: 'pending' }]),
      turnEnd(3, 1),
    ])
    await backfill(context, sink, { settings: () => ({ proseCandidates: false }) })
    expect(sink.opens.map(draft => draft.artifactId)).toEqual(['todo-open'])
  })

  it('emits both candidates when proseCandidates is on', async () => {
    const sink = new FakeSink()
    const context = new FakeCaptureContext({ sessions: [rootSession('s1')] }).withEvents('s1', [
      turnStart(0, 1),
      assistantMessage(1, 1, PROSE_QUESTION),
      todoWrite(2, [{ content: 'Update the changelog', status: 'pending' }]),
      turnEnd(3, 1),
    ])
    await backfill(context, sink, { settings: () => ({ proseCandidates: true }) })
    expect(sink.opens.map(draft => draft.artifactId)).toHaveLength(2)
    expect(sink.opens.some(draft => draft.artifactId.startsWith('prose:'))).toBe(true)
    expect(sink.opens.some(draft => draft.artifactId === 'todo-open')).toBe(true)
  })

  it('still emits a prose closure when proseCandidates is off (only raises are gated)', async () => {
    const cursors = new InMemoryDetectionCursorStore()
    const session = rootSession('s1')
    const log = [
      turnStart(0, 1),
      assistantMessage(1, 1, PROSE_QUESTION),
      turnEnd(2, 1),
    ]
    const raises = new FakeSink()
    await backfill(
      new FakeCaptureContext({ sessions: [session] }).withEvents('s1', log),
      raises,
      { settings: () => ({ proseCandidates: true }) },
      cursors,
    )
    expect(raises.opens.some(draft => draft.artifactId.startsWith('prose:'))).toBe(true)
    const moved = new FakeCaptureContext({ sessions: [{ ...session, updatedAt: NOW - 500 }] })
      .withEvents('s1', [...log, userPrompt(3, 'Yes, run the ladder.')])
    const closes = new FakeSink()
    await backfill(moved, closes, { settings: () => ({ proseCandidates: false }) }, cursors)
    expect(closes.closes.some(draft => draft.closes?.artifactId.startsWith('prose:') === true)).toBe(true)
    expect(closes.opens.filter(draft => draft.artifactId.startsWith('prose:'))).toEqual([])
  })
})

describe('age and count bounds', () => {
  it('drops sessions outside the 90-day window and keeps the newest under the cap', async () => {
    const old = rootSession('old', { updatedAt: NOW - 100 * 24 * 60 * 60 * 1000 })
    const recentA = rootSession('recent-a', { updatedAt: NOW - 2 * 24 * 60 * 60 * 1000 })
    const recentB = rootSession('recent-b', { updatedAt: NOW - 1 * 24 * 60 * 60 * 1000 })
    const context = new FakeCaptureContext({ sessions: [old, recentA, recentB] })
    const report = await backfill(context, new FakeSink(), { limits: { maxSessions: 1 } })
    expect(report.sessionsEligible).toBe(2)
    expect(report.deferredByLimit).toBe(1)
    expect(report.sessionsFolded).toBe(1)
    // Newest first: recent-b wins the single slot.
    expect(report.sessionsFolded).toBe(1)
  })

  it('reports the eligible total before the cap so the UI can say so', async () => {
    const sessions = [rootSession('s1'), rootSession('s2'), rootSession('s3')]
    const report = await backfill(new FakeCaptureContext({ sessions }), new FakeSink(), {
      limits: { maxSessions: 2 },
    })
    expect(report.sessionsEligible).toBe(3)
    expect(report.deferredByLimit).toBe(1)
  })
})

describe('drafts and workspace enrichment', () => {
  it('folds a session into drafts and stamps the resolved workspace', async () => {
    const sink = new FakeSink()
    const context = new FakeCaptureContext({
      sessions: [rootSession('s1', { title: 'AMD stability review', cwd: '/work/amd' })],
      workspaces: new Map([['s1', { workspaceId: 'ws-1', title: 'Hookshot', path: '/work/amd' }]]),
    }).withEvents('s1', [
      turnStart(0, 1),
      toolCall(1, 'call-ask', 'ask_user_question', askUserQuestionArgs('Proceed?', ['Yes', 'No'])),
      turnEnd(2, 1),
    ])
    const report = await backfill(context, sink)
    expect(report.sessionsFolded).toBe(1)
    const open = sink.open('question:call-ask')
    expect(open?.workspace).toEqual({ workspaceId: 'ws-1', title: 'Hookshot', path: '/work/amd' })
    expect(open?.sessionTitle).toBe('AMD stability review')
    expect(open?.cwd).toBe('/work/amd')
  })

  it('still emits when the workspace resolver fails or has no membership', async () => {
    const sink = new FakeSink()
    const context = new FakeCaptureContext({ sessions: [rootSession('s1')] })
      .withEvents('s1', [goalBlocked(0)])
    const report = await backfill(context, sink)
    expect(report.sessionsFolded).toBe(1)
    expect(sink.opens[0]?.workspace).toBeUndefined()
  })
})

describe('fork prefix', () => {
  it('does not raise items from the inherited prefix of a seeded fork', async () => {
    const sink = new FakeSink()
    const events = forkedSessionLog()
    const context = new FakeCaptureContext({ sessions: [rootSession('fork')] }).withEvents('fork', events)
    const report = await backfill(context, sink)
    expect(deriveInheritedEventCount(events)).toBe(4)
    expect(report.sessionsFolded).toBe(1)
    expect(sink.opens.map(draft => draft.artifactId)).toEqual(['question:call-child-ask'])
  })
})

describe('batching and resumability', () => {
  it('batches drafts into bounded sink calls', async () => {
    const sink = new FakeSink()
    const events = []
    for (let index = 0; index < 7; index += 1) {
      events.push(approvalAsked(index * 2, `a${index}`, 'bash', `call-${index}`))
      events.push(approvalDecided(index * 2 + 1, `a${index}`, 'unavailable'))
    }
    const context = new FakeCaptureContext({ sessions: [rootSession('s1')] }).withEvents('s1', events)
    const report = await backfill(context, sink, { limits: { sinkBatch: 3 } })
    expect(report.draftsEmitted).toBe(7)
    expect(report.batches).toBeGreaterThanOrEqual(3)
    expect(sink.batches.every(batch => batch.drafts.length <= 3)).toBe(true)
  })

  it('skips an unchanged session on the next run using its cursor', async () => {
    const cursors = new InMemoryDetectionCursorStore()
    const context = new FakeCaptureContext({ sessions: [rootSession('s1')] })
      .withEvents('s1', [approvalAsked(0, 'a1', 'bash', 'call-1'), approvalDecided(1, 'a1', 'rejected')])
    const first = await backfill(context, new FakeSink(), {}, cursors)
    expect(first.sessionsFolded).toBe(1)
    const second = await backfill(context, new FakeSink(), {}, cursors)
    expect(second.sessionsSkipped).toBe(1)
    expect(second.sessionsFolded).toBe(0)
  })

  it('re-reads a moved session and folds only the events past its cursor', async () => {
    const cursors = new InMemoryDetectionCursorStore()
    const session = rootSession('s1')
    const context = new FakeCaptureContext({ sessions: [session] })
      .withEvents('s1', [approvalAsked(0, 'a1', 'bash', 'call-1'), approvalDecided(1, 'a1', 'rejected')])
    await backfill(context, new FakeSink(), {}, cursors)
    // A newer roster activity time invalidates the cheap skip; the log read
    // shows the new event, which is folded as a delta past the cursor.
    const moved = new FakeCaptureContext({ sessions: [{ ...session, lastActivityAt: NOW - 500 }] })
      .withEvents('s1', [
        approvalAsked(0, 'a1', 'bash', 'call-1'),
        approvalDecided(1, 'a1', 'rejected'),
        goalBlocked(2),
      ])
    const sink = new FakeSink()
    const report = await backfill(moved, sink, {}, cursors)
    expect(report.sessionsFolded).toBe(1)
    // The old raise at seq 0/1 is not replayed; only the new transition lands.
    expect(sink.opens.map(draft => draft.artifactId)).toEqual(['goal:goal-1'])
  })

  it('re-reads a session whose activity time moved but whose log is unchanged as a no-op', async () => {
    const cursors = new InMemoryDetectionCursorStore()
    const session = rootSession('s1')
    const events = [approvalAsked(0, 'a1', 'bash', 'call-1'), approvalDecided(1, 'a1', 'rejected')]
    const context = new FakeCaptureContext({ sessions: [session] }).withEvents('s1', events)
    await backfill(context, new FakeSink(), {}, cursors)
    const moved = new FakeCaptureContext({ sessions: [{ ...session, lastActivityAt: NOW - 500 }] }).withEvents('s1', events)
    const sink = new FakeSink()
    const report = await backfill(moved, sink, {}, cursors)
    // The cursor already covers every event the log contains: nothing to fold,
    // nothing emitted (a re-fold must not replay history at the store).
    expect(report.sessionsSkipped).toBe(1)
    expect(report.sessionsFolded).toBe(0)
    expect(sink.drafts).toEqual([])
  })

  it('does not write a cursor when the sink write fails, so the session retries', async () => {
    const cursors = new InMemoryDetectionCursorStore()
    const sink = new FakeSink()
    const context = new FakeCaptureContext({ sessions: [rootSession('s1')] })
      .withEvents('s1', [approvalAsked(0, 'a1', 'bash', 'call-1'), approvalDecided(1, 'a1', 'unavailable')])
    sink.failNext = new Error('store offline')
    const report = await backfill(context, sink, {}, cursors)
    expect(report.sessionsFailed).toBe(1)
    expect(report.sessionsFolded).toBe(0)
    expect(await cursors.get('s1')).toBeUndefined()
    // The retry succeeds and writes the cursor.
    const retry = await backfill(context, sink, {}, cursors)
    expect(retry.sessionsFolded).toBe(1)
    expect((await cursors.get('s1'))?.foldVersion).toBe(OPEN_ITEMS_FOLD_VERSION)
  })

  it('contains a failing session read and continues with the others', async () => {
    const sink = new FakeSink()
    const context = new FakeCaptureContext({ sessions: [rootSession('broken'), rootSession('good')] })
      .withEvents('good', [approvalAsked(0, 'a1', 'bash', 'call-1'), approvalDecided(1, 'a1', 'rejected')])
    context.brokenSessions.add('broken')
    const report = await backfill(context, sink)
    expect(report.sessionsFailed).toBe(1)
    expect(report.sessionsFolded).toBe(1)
    expect(sink.opens).toHaveLength(1)
  })

  it('stops between sessions when aborted and keeps what it emitted', async () => {
    const sink = new FakeSink()
    const context = new FakeCaptureContext({ sessions: [rootSession('s1'), rootSession('s2')] })
      .withEvents('s1', [approvalAsked(0, 'a1', 'bash', 'call-1'), approvalDecided(1, 'a1', 'rejected')])
      .withEvents('s2', [approvalAsked(0, 'a2', 'bash', 'call-2'), approvalDecided(1, 'a2', 'rejected')])
    const controller = new AbortController()
    controller.abort()
    const report = await backfill(context, sink, { signal: controller.signal })
    expect(report.sessionsFolded).toBe(0)
    expect(sink.drafts).toEqual([])
  })
})

describe('baseline versus delta emission', () => {
  it('baseline reports only the still-open set, not the historical resolution', async () => {
    const sink = new FakeSink()
    const context = new FakeCaptureContext({ sessions: [rootSession('s1')] }).withEvents('s1', [
      approvalAsked(0, 'a1', 'bash', 'call-1'),
      approvalDecided(1, 'a1', 'unavailable'),
      jobRegistered(2, 'job-1', 'npm test'),
      turnStart(3, 1),
      approvalAsked(4, 'a2', 'bash', 'call-1'),
      approvalDecided(5, 'a2', 'allowed-once'),
      jobSettled(6, 'job-1', 'npm test'),
      turnEnd(7, 1),
    ])
    await backfill(context, sink)
    expect(sink.drafts).toEqual([])
  })

  it('a re-fold of a moved session reports the closure the store needs', async () => {
    const cursors = new InMemoryDetectionCursorStore()
    const session = rootSession('s1')
    const first = new FakeCaptureContext({ sessions: [session] }).withEvents('s1', [
      approvalAsked(0, 'a1', 'bash', 'call-1'),
      approvalDecided(1, 'a1', 'unavailable'),
    ])
    const baselineSink = new FakeSink()
    await backfill(first, baselineSink, {}, cursors)
    expect(baselineSink.opens.map(draft => draft.artifactId)).toEqual(['approval:call-1'])
    const moved = new FakeCaptureContext({ sessions: [{ ...session, updatedAt: NOW - 500 }] }).withEvents('s1', [
      approvalAsked(0, 'a1', 'bash', 'call-1'),
      approvalDecided(1, 'a1', 'unavailable'),
      approvalAsked(2, 'a2', 'bash', 'call-1'),
      approvalDecided(3, 'a2', 'allowed-once'),
    ])
    const deltaSink = new FakeSink()
    await backfill(moved, deltaSink, {}, cursors)
    expect(deltaSink.closes.map(draft => draft.closes?.artifactId)).toContain('approval:call-1')
    expect(deltaSink.closes[0]?.closes?.code).toBe('approval/decided:allowed-once')
  })

  it('baseline emits every still-open per-item prose artifact of one turn', async () => {
    const sink = new FakeSink()
    const context = new FakeCaptureContext({ sessions: [rootSession('s1')] }).withEvents('s1', [
      turnStart(0, 2),
      assistantMessage(1, 2, PROSE_SECTION),
      turnEnd(2, 2),
    ])
    await backfill(context, sink)
    const prose = sink.opens.filter(draft => draft.artifactId.startsWith('prose:'))
    expect(prose).toHaveLength(5)
    expect(new Set(prose.map(draft => draft.artifactId)).size).toBe(5)
    expect(prose.every(draft => draft.kind === 'decision')).toBe(true)
  })

  it('emits both the open question and the interrupted blocker for one unanswered ask', async () => {
    const sink = new FakeSink()
    const context = new FakeCaptureContext({ sessions: [rootSession('s1')] }).withEvents('s1', [
      turnStart(0, 1),
      toolCall(1, 'call-ask', 'ask_user_question', askUserQuestionArgs('Proceed?', ['Yes', 'No'])),
      turnEnd(2, 1, { kind: 'interrupted' }),
    ])
    await backfill(context, sink)
    expect(sink.opens.map(draft => draft.artifactId)).toEqual(['question:call-ask'])
  })
})

/** A blocked goal snapshot matching the real `goal/change` payload. */
function goalBlocked(seq: number): ReturnType<typeof approvalAsked> {
  return {
    seq,
    type: 'goal/change',
    time: T0 + seq * 1000,
    data: {
      kind: 'goal/change',
      version: 1,
      operation: 'block',
      goal: {
        id: 'goal-1',
        revision: 2,
        objective: 'Ship the migration',
        phase: 'blocked',
        maxGoalRounds: 5,
        blockedReason: { code: 'rounds', message: 'cap reached' },
      },
      roundsStarted: 3,
      createdAt: T0,
      updatedAt: T0 + seq * 1000,
    },
  }
}

describe('cursor durability', () => {
  it('folds a session with no committed events without aborting the pass', async () => {
    const sink = new FakeSink()
    const context = new FakeCaptureContext({
      sessions: [rootSession('blank'), rootSession('with-events')],
    })
      .withEvents('blank', [])
      .withEvents('with-events', [approvalAsked(0, 'a1', 'bash', 'call-1'), approvalDecided(1, 'a1', 'unavailable')])
    const cursors = new InMemoryDetectionCursorStore()
    const report = await backfill(context, sink, {}, cursors)
    expect(report.sessionsFailed).toBe(0)
    expect(report.sessionsFolded).toBe(2)
    expect(report.draftsEmitted).toBeGreaterThan(0)
    // An empty log folds to `lastSeq = -1`; the cursor is clamped, not rejected.
    expect(await cursors.get('blank')).toMatchObject({ sessionId: 'blank', lastScannedSeq: 0 })
  })

  it('keeps scanning after one cursor write fails', async () => {
    const sink = new FakeSink()
    const context = new FakeCaptureContext({
      sessions: [rootSession('unwritable'), rootSession('writable')],
    })
      .withEvents('unwritable', [approvalAsked(0, 'a1', 'bash', 'call-1'), approvalDecided(1, 'a1', 'unavailable')])
      .withEvents('writable', [approvalAsked(0, 'a2', 'bash', 'call-2'), approvalDecided(1, 'a2', 'unavailable')])
    const inner = new InMemoryDetectionCursorStore()
    const failing: DetectionCursorStore = {
      get: sessionId => inner.get(sessionId),
      async put(cursor) {
        if (cursor.sessionId === 'unwritable') throw new Error('storage rejected the cursor')
        await inner.put(cursor)
      },
    }
    const report = await backfill(context, sink, {}, failing)
    expect(report.sessionsFailed).toBe(1)
    expect(report.sessionsFolded).toBe(1)
    expect(await inner.get('writable')).toBeDefined()
    expect(await inner.get('unwritable')).toBeUndefined()
  })
})

/** Keep the imported helper list honest for future cases. */
export const FIXTURE_TYPES = {} as {
  foreign: typeof foreignEvent
  cursor: DetectionCursor | undefined
  draft: DerivedItemDraft | undefined
}
