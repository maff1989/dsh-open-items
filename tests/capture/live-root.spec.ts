/**
 * D5 root-only live capture (REVIEW-rc1 P0-02, WP-02).
 *
 * The live drive subscribes `session/event` for every Session, so the root gate
 * has to live in the driver: a subagent or delegated session owns no user
 * decisions and must never produce an inbox draft. The gate reads the live
 * `Session.header` shape (`origin`, `delegationDepth`), which is where a real
 * Session keeps those facts; the flat/`{ info }` harness shapes keep working.
 *
 * @module tests/capture/live-root.spec
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import type { CaptureEvent } from '../../src/host/capture-contract'
import { createCaptureDriver, registerOpenItemsCapture, type LiveSessionLike } from '../../src/host/capture'
import { normalizeFoldSession } from '../../src/host/folds'
import { FakeCaptureContext, FakeSink, sessionInfo } from './fakes'
import { T0, approvalAsked, approvalDecided, askUserQuestionArgs, teamTask, toolCall, turnEnd, turnStart } from './fixtures'

/** One deterministic clock. */
const NOW = T0 + 5 * 24 * 60 * 60 * 1000

/** A deleted-tool audit pair: the most direct live draft source. */
function approvalPair(callId: string): CaptureEvent[] {
  return [approvalAsked(0, `approval-${callId}`, 'bash', callId), approvalDecided(1, `approval-${callId}`, 'unavailable')]
}

/** A real `Session`-shaped record (facts in `header`), as `session/event` passes it. */
function liveSession(
  header: {
    id?: string
    createdAt?: number
    cwd?: string
    origin?: 'subagent'
    delegationDepth?: number
    parentSession?: string
  },
  inheritedEventCount = 0,
): LiveSessionLike {
  return { id: header.id ?? 'session-live', inheritedEventCount, header }
}

describe('normalizeFoldSession reads the live Session.header shape', () => {
  it('normalises the durable header facts of a live Session', () => {
    const live = liveSession({
      id: 'session-live',
      createdAt: T0,
      cwd: '/work/live',
      origin: 'subagent',
      delegationDepth: 2,
      parentSession: 'session-parent',
    })
    expect(normalizeFoldSession(live)).toEqual({
      sessionId: 'session-live',
      updatedAt: T0,
      archived: false,
      cwd: '/work/live',
      origin: 'subagent',
      delegationDepth: 2,
      createdAt: T0,
      parentSession: 'session-parent',
    })
  })

  it('keeps the flat harness shape and the `{ info }` wrapper working', () => {
    const flat = normalizeFoldSession(sessionInfo('session-flat', {
      updatedAt: 42,
      archived: true,
      origin: 'subagent',
      delegationDepth: 1,
      cwd: '/work/flat',
      title: 'Flat',
    }))
    expect(flat).toMatchObject({
      sessionId: 'session-flat',
      updatedAt: 42,
      archived: true,
      origin: 'subagent',
      delegationDepth: 1,
      cwd: '/work/flat',
      title: 'Flat',
    })

    const wrapped = normalizeFoldSession({
      info: sessionInfo('session-wrapped', { updatedAt: 7 }),
      inheritedEventCount: 3,
    })
    expect(wrapped).toMatchObject({ sessionId: 'session-wrapped', updatedAt: 7, archived: false })
  })

  it('lets explicit metadata win over the header and fills gaps from it', () => {
    const normalised = normalizeFoldSession({
      info: { sessionId: 'session-both', updatedAt: 9 },
      header: { id: 'session-header-id', createdAt: T0, cwd: '/work/header', delegationDepth: 1 },
    })
    expect(normalised).toMatchObject({
      sessionId: 'session-both',
      updatedAt: 9,
      cwd: '/work/header',
      delegationDepth: 1,
      createdAt: T0,
    })
  })

  it('does not treat a parentSession id as a subagent classification', () => {
    // DSH keeps `parentSession` on ordinary forks; `origin` is the classifier.
    const normalised = normalizeFoldSession(liveSession({ parentSession: 'session-parent' }))
    expect(normalised.parentSession).toBe('session-parent')
    expect(normalised.origin).toBeUndefined()
    expect(normalised.delegationDepth).toBeUndefined()
  })
})

describe('createCaptureDriver root gate', () => {
  it('drops every draft from a subagent live session', async () => {
    const sink = new FakeSink()
    const driver = createCaptureDriver({ sink, source: 'projection', now: () => NOW })
    const drafts = await driver.driveSession(
      liveSession({ id: 'session-child', origin: 'subagent', delegationDepth: 1, cwd: '/work/x' }),
      approvalPair('call-child'),
    )
    expect(drafts).toEqual([])
    expect(sink.drafts).toEqual([])
  })

  it('drops a delegated session that carries no origin', async () => {
    const sink = new FakeSink()
    const driver = createCaptureDriver({ sink, source: 'projection', now: () => NOW })
    const drafts = await driver.driveSession(
      liveSession({ id: 'session-delegate', delegationDepth: 2 }),
      approvalPair('call-delegate'),
    )
    expect(drafts).toEqual([])
    expect(sink.drafts).toEqual([])
  })

  it('still folds a root session and stamps the header cwd', async () => {
    const sink = new FakeSink()
    const driver = createCaptureDriver({ sink, source: 'projection', now: () => NOW })
    const drafts = await driver.driveSession(
      liveSession({ id: 'session-root', cwd: '/work/root' }),
      [
        turnStart(0, 1),
        toolCall(1, 'call-ask', 'ask_user_question', askUserQuestionArgs('Ship it?', ['Yes', 'No'])),
        turnEnd(2, 1),
      ],
    )
    expect(drafts.map(draft => draft.artifactId)).toEqual(['question:call-ask'])
    expect(drafts[0]?.sessionId).toBe('session-root')
    expect(drafts[0]?.cwd).toBe('/work/root')
    // An ordinary fork (parentSession) is still a root session.
    const fork = await driver.driveSession(liveSession({ id: 'session-fork', parentSession: 'session-parent' }), [
      approvalAsked(0, 'fork-approval', 'bash', 'call-fork'),
      approvalDecided(1, 'fork-approval', 'cancelled'),
    ])
    expect([...new Set(fork.map(draft => draft.artifactId))]).toEqual(['approval:call-fork'])
  })

  it('does not keep ledger state for a dropped non-root session', async () => {
    const driver = createCaptureDriver({ sink: new FakeSink(), now: () => NOW })
    const child = liveSession({ id: 'session-child', origin: 'subagent', delegationDepth: 1 })
    expect(await driver.driveSession(child, [approvalAsked(0, 'a1', 'bash', 'call-1')])).toEqual([])
    // The same id re-delivered as a root session starts from a fresh ledger and
    // folds the whole log the harness hands it (no stale child state).
    const root = liveSession({ id: 'session-child' })
    const drafts = await driver.driveSession(root, approvalPair('call-1'))
    expect([...new Set(drafts.map(draft => draft.artifactId))]).toEqual(['approval:call-1'])
  })

  it('raises no team-task item on the live root path (decision D5)', async () => {
    const events: CaptureEvent[] = [
      teamTask(0, { id: 'task-1', status: 'in_progress', ownerId: 'child-1' }),
      teamTask(1, { id: 'task-2', status: 'in_progress', ownerId: 'child-2' }),
    ]
    const sink = new FakeSink()
    const driver = createCaptureDriver({
      sink,
      now: () => NOW,
      // Even a roster that says the owner is not running cannot raise it: the
      // family is out of dispatch until the liveness gate is redesigned.
      isSessionRunning: () => false,
    })
    const drafts = await driver.driveSession(liveSession({ id: 'session-root' }), events)
    expect(drafts).toEqual([])
    expect(sink.drafts).toEqual([])
  })
})

describe('registerOpenItemsCapture live wiring', () => {
  const disposers: (() => void)[] = []
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose()
  })

  it('folds committed root events and drops committed subagent events', async () => {
    const ctx = new Context()
    const sink = new FakeSink()
    const capture = registerOpenItemsCapture(ctx, {
      sink,
      context: new FakeCaptureContext({ sessions: [] }),
      now: () => NOW,
      autoBackfill: false,
    })
    disposers.push(() => { void capture.dispose() })

    ctx.emit('session/event', liveSession({ id: 'session-child', origin: 'subagent', delegationDepth: 1 }) as never, {
      seq: 0,
      type: 'approval/asked',
      time: T0,
      data: { id: 'approval-child', toolName: 'bash', callId: 'call-child' },
    } as never)
    ctx.emit('session/event', liveSession({ id: 'session-child', origin: 'subagent', delegationDepth: 1 }) as never, {
      seq: 1,
      type: 'approval/decided',
      time: T0 + 1000,
      data: { id: 'approval-child', outcome: 'unavailable' },
    } as never)
    ctx.emit('session/event', liveSession({ id: 'session-root', cwd: '/work/root' }) as never, {
      seq: 0,
      type: 'approval/asked',
      time: T0,
      data: { id: 'approval-root', toolName: 'bash', callId: 'call-root' },
    } as never)
    ctx.emit('session/event', liveSession({ id: 'session-root', cwd: '/work/root' }) as never, {
      seq: 1,
      type: 'approval/decided',
      time: T0 + 1000,
      data: { id: 'approval-root', outcome: 'unavailable' },
    } as never)

    await capture.dispose()
    expect([...new Set(sink.opens.map(draft => draft.artifactId))]).toEqual(['approval:call-root'])
    expect(sink.opens.every(draft => draft.sessionId === 'session-root')).toBe(true)
  })
})
