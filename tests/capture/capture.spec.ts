/**
 * Capture wiring: the pure driver, the live event bridge and the backfill
 * kickoff — including graceful degradation when an optional capability is not
 * composed.
 *
 * @module tests/capture/capture.spec
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CaptureEvent } from '../../src/host/capture-contract'
import { createCaptureDriver, registerOpenItemsCapture } from '../../src/host/capture'
import { initialFoldState } from '../../src/host/folds'
import { createOpenItemsFold } from '../../src/host/folds'
import { OPEN_ITEMS_FOLD_VERSION } from '../../src/host/folds/limits'
import { FakeCaptureContext, FakeSink, sessionInfo } from './fakes'
import {
  T0,
  approvalAsked,
  approvalDecided,
  askUserQuestionArgs,
  teamTask,
  toolCall,
  turnEnd,
  turnStart,
} from './fixtures'

/** One deterministic clock. */
const NOW = T0 + 5 * 24 * 60 * 60 * 1000

const SESSION = sessionInfo('session-root', { title: 'Root', updatedAt: NOW, cwd: '/work/x' })

describe('createCaptureDriver', () => {
  it('folds a whole log and reports drafts', async () => {
    const sink = new FakeSink()
    const driver = createCaptureDriver({ sink, source: 'log-fold', now: () => NOW })
    const events: CaptureEvent[] = [
      turnStart(0, 1),
      toolCall(1, 'call-ask', 'ask_user_question', askUserQuestionArgs('Proceed?', ['Yes', 'No'])),
      turnEnd(2, 1),
    ]
    const drafts = await driver.driveSession(SESSION, events)
    expect(drafts.map(draft => draft.artifactId)).toEqual(['question:call-ask'])
    expect(sink.opens).toHaveLength(1)
    expect(sink.drafts[0]?.sessionId).toBe('session-root')
  })

  it('is incremental: a second call folds only the new events', async () => {
    const driver = createCaptureDriver({ sink: new FakeSink(), now: () => NOW })
    await driver.driveSession(SESSION, [approvalAsked(0, 'a1', 'bash', 'call-1')])
    const drafts = await driver.driveSession(SESSION, [approvalDecided(1, 'a1', 'unavailable')])
    expect(drafts.map(draft => draft.artifactId)).toEqual(['approval:call-1'])
    // Replaying the same events changes nothing.
    const replay = await driver.driveSession(SESSION, [approvalDecided(1, 'a1', 'unavailable')])
    expect(replay.every(draft => draft.closes !== undefined)).toBe(true)
  })

  it('applies the fork cut it is given instead of its own default', async () => {
    const driver = createCaptureDriver({ sink: new FakeSink(), now: () => NOW })
    const drafts = await driver.driveSession(
      { info: { ...SESSION, inheritedEventCount: 2 } },
      [
        approvalAsked(0, 'a-parent', 'bash', 'call-parent'),
        approvalDecided(1, 'a-parent', 'rejected'),
        approvalAsked(2, 'a-child', 'bash', 'call-child'),
        approvalDecided(3, 'a-child', 'rejected'),
      ],
    )
    expect([...new Set(drafts.map(draft => draft.artifactId))]).toEqual(['approval:call-child'])
  })

  it('accepts a live Session-shaped record', async () => {
    const driver = createCaptureDriver({ sink: new FakeSink(), now: () => NOW })
    const live = {
      id: 'session-live',
      inheritedEventCount: 0,
      header: { cwd: '/work/live' },
    }
    const drafts = await driver.driveSession(live, [
      approvalAsked(0, 'a1', 'bash', 'call-1'),
      approvalDecided(1, 'a1', 'cancelled'),
    ])
    expect(drafts[0]?.sessionId).toBe('session-live')
    expect(drafts[0]?.cwd).toBe('/work/live')
  })

  it('does not dispatch the team-task family (decision D5)', async () => {
    const events: CaptureEvent[] = [
      teamTask(0, { id: 'task-1', status: 'in_progress', ownerId: 'child-1' }),
      teamTask(1, { id: 'task-2', status: 'in_progress', ownerId: 'child-2' }),
    ]
    const sink = new FakeSink()
    const driver = createCaptureDriver({
      sink,
      now: () => NOW,
      isSessionRunning: () => false,
    })
    expect(await driver.driveSession(SESSION, events)).toEqual([])
    expect(sink.drafts).toEqual([])
  })

  it('contains a failing sink and still reports the drafts to the caller', async () => {
    const sink = new FakeSink()
    sink.failNext = new Error('store offline')
    const errors: unknown[] = []
    const driver = createCaptureDriver({ sink, now: () => NOW, onError: error => { errors.push(error) } })
    const drafts = await driver.driveSession(SESSION, [
      approvalAsked(0, 'a1', 'bash', 'call-1'),
      approvalDecided(1, 'a1', 'rejected'),
    ])
    // The pending ask plus the blocked outcome: both are reported to the caller.
    expect(drafts).toHaveLength(2)
    expect(errors).toHaveLength(1)
    // No unhandled rejection reached the test runner.
    await driver.flush()
  })

  it('forgets one session on request', async () => {
    const driver = createCaptureDriver({ sink: new FakeSink(), now: () => NOW })
    await driver.driveSession(SESSION, [approvalAsked(0, 'a1', 'bash', 'call-1')])
    driver.forgetSession('session-root')
    const drafts = await driver.driveSession(SESSION, [approvalDecided(1, 'a1', 'rejected')])
    // Without the retained ledger the decided event has no matching asked pair.
    expect(drafts).toEqual([])
  })
})

describe('acceptance-harness fold entry points', () => {
  it('exposes createOpenItemsFold() with an initial-state factory and a contract fold', () => {
    const definition = createOpenItemsFold()
    expect(definition.foldVersion).toBe(OPEN_ITEMS_FOLD_VERSION)
    expect(typeof definition.fold).toBe('function')
    const initial = definition.initial(3)
    expect((initial as { inheritedEventCount?: number }).inheritedEventCount).toBe(3)
    const event: CaptureEvent = { seq: 5, type: 'approval/asked', time: T0, data: { id: 'a1', toolName: 'bash', callId: 'call-1' } }
    const step = definition.fold(initial, event, { info: { ...SESSION, inheritedEventCount: 3 } } as never)
    expect(step.result.throughSeq).toBe(5)
    // `approval/asked` raises the live pending ask (the fold default is the live
    // drive; cold-log reads suppress live-only raises).
    expect(step.result.drafts.map(draft => draft.artifactId)).toEqual(['approval:call-1'])
  })

  it('exposes initialFoldState', () => {
    expect((initialFoldState(2) as { inheritedEventCount?: number }).inheritedEventCount).toBe(2)
    expect((initialFoldState() as { inheritedEventCount?: number }).inheritedEventCount).toBe(0)
  })
})

describe('registerOpenItemsCapture', () => {
  const disposers: (() => void)[] = []
  afterEach(async () => {
    for (const dispose of disposers.splice(0)) dispose()
  })

  /** A real Cordis context with the optional services the wiring probes. */
  function makeContext(services: { sessionProjections?: unknown; sessionController?: unknown } = {}): Context {
    const ctx = new Context()
    if (services.sessionProjections !== undefined) ctx.provide('sessionProjections', services.sessionProjections)
    if (services.sessionController !== undefined) ctx.provide('sessionController', services.sessionController)
    return ctx
  }

  /** A registry double recording what was registered. */
  function fakeRegistry(): { register: (definition: unknown) => undefined; registered: unknown[] } {
    const registered: unknown[] = []
    return {
      registered,
      register(definition: unknown) {
        registered.push(definition)
        return undefined
      },
    }
  }

  it('registers the projection and wires the live event drive', async () => {
    const registry = fakeRegistry()
    const ctx = makeContext({ sessionProjections: registry })
    const sink = new FakeSink()
    const context = new FakeCaptureContext({ sessions: [] })
    const capture = registerOpenItemsCapture(ctx, {
      sink,
      context,
      now: () => NOW,
      autoBackfill: false,
    })
    disposers.push(() => { void capture.dispose() })
    expect(capture.projection).toBe(true)
    expect(capture.live).toBe(true)
    expect(registry.registered).toHaveLength(1)
    expect((registry.registered[0] as { key?: string }).key).toBe('openItems')
    expect((registry.registered[0] as { wire?: { summary?: boolean } }).wire?.summary).toBe(false)

    // A committed event travels through the live drive into the sink.
    const session = { id: 'session-live', inheritedEventCount: 0, header: { cwd: '/work/x' } }
    ctx.emit('session/event', session as never, {
      seq: 0,
      type: 'tool/call',
      time: T0,
      data: {
        turn: 1,
        step: 1,
        callId: 'call-ask',
        name: 'ask_user_question',
        arguments: JSON.stringify(askUserQuestionArgs('Proceed?', ['Yes', 'No'])),
      },
    } as never)
    await capture.dispose()
    expect(sink.opens.map(draft => draft.artifactId)).toEqual(['question:call-ask'])
  })

  it('degrades to backfill + live when no projection registry is mounted', async () => {
    const ctx = makeContext()
    const sink = new FakeSink()
    const events = new Map([['s1', [approvalAsked(0, 'a1', 'bash', 'call-1'), approvalDecided(1, 'a1', 'rejected')]]])
    const context = new FakeCaptureContext({ sessions: [sessionInfo('s1', { updatedAt: NOW })] })
      .withEvents('s1', events.get('s1') ?? [])
    const capture = registerOpenItemsCapture(ctx, {
      sink,
      context,
      now: () => NOW,
      autoBackfill: false,
    })
    disposers.push(() => { void capture.dispose() })
    expect(capture.projection).toBe(false)
    expect(capture.live).toBe(true)
    const report = await capture.backfillNow()
    expect(report?.sessionsFolded).toBe(1)
    expect(sink.opens.map(draft => draft.artifactId)).toEqual(['approval:call-1'])
  })

  it('joins an in-flight backfill instead of starting a second pass', async () => {
    const ctx = makeContext()
    const sink = new FakeSink()
    const context = new FakeCaptureContext({ sessions: [sessionInfo('s1', { updatedAt: NOW })] })
    const capture = registerOpenItemsCapture(ctx, { sink, context, now: () => NOW, autoBackfill: false })
    disposers.push(() => { void capture.dispose() })
    const [first, second] = await Promise.all([capture.backfillNow(), capture.backfillNow()])
    expect(first).toBe(second)
  })

  it('runs the backfill on activation without awaiting it', async () => {
    const ctx = makeContext()
    const sink = new FakeSink()
    const context = new FakeCaptureContext({ sessions: [sessionInfo('s1', { updatedAt: NOW })] })
      .withEvents('s1', [approvalAsked(0, 'a1', 'bash', 'call-1'), approvalDecided(1, 'a1', 'unavailable')])
    const capture = registerOpenItemsCapture(ctx, { sink, context, now: () => NOW })
    disposers.push(() => { void capture.dispose() })
    await vi.waitFor(() => {
      expect(sink.opens.map(draft => draft.artifactId)).toEqual(['approval:call-1'])
    })
  })

  it('reports a failing backfill context without rejecting activation', async () => {
    const ctx = makeContext()
    const errors: unknown[] = []
    const context = new FakeCaptureContext({ sessions: [sessionInfo('s1', { updatedAt: NOW })] })
    context.brokenSessions.add('s1')
    const capture = registerOpenItemsCapture(ctx, {
      sink: new FakeSink(),
      context,
      now: () => NOW,
      autoBackfill: false,
      onError: error => { errors.push(error) },
    })
    disposers.push(() => { void capture.dispose() })
    const report = await capture.backfillNow()
    expect(report?.sessionsFailed).toBe(1)
    // A read failure is counted in the report, not raised as a wiring error.
    expect(errors).toEqual([])
  })

  it('re-scans periodically after activation and stops on dispose', async () => {
    const ctx = makeContext()
    const sink = new FakeSink()
    const context = new FakeCaptureContext({ sessions: [sessionInfo('s1', { updatedAt: NOW })] })
    const capture = registerOpenItemsCapture(ctx, {
      sink,
      context,
      now: () => NOW,
      autoBackfill: true,
      rescanIntervalMs: 20,
    })
    disposers.push(() => { void capture.dispose() })
    // Activation pass + at least one periodic pass both read the log.
    await vi.waitFor(() => {
      expect(context.readCounts.get('s1') ?? 0).toBeGreaterThanOrEqual(2)
    })
    await capture.dispose()
    const reads = context.readCounts.get('s1') ?? 0
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(context.readCounts.get('s1') ?? 0).toBe(reads)
  })

  it('does not arm the periodic re-scan when rescanIntervalMs is false', async () => {
    const ctx = makeContext()
    const context = new FakeCaptureContext({ sessions: [sessionInfo('s1', { updatedAt: NOW })] })
    const capture = registerOpenItemsCapture(ctx, {
      sink: new FakeSink(),
      context,
      now: () => NOW,
      autoBackfill: false,
      rescanIntervalMs: false,
    })
    disposers.push(() => { void capture.dispose() })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(context.readCounts.get('s1') ?? 0).toBe(0)
  })
})
