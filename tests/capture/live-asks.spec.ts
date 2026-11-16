/**
 * Observe-only live asks (REVIEW-rc1 P0-04a, D0 OD-14).
 *
 * Two mechanisms, both observe-only:
 * - the **pending row** comes from the session log (`approval/asked`,
 *   `tool/call`), which is the durable trace of a live ask; it is marked
 *   live-only so a cold-log read never resurrects an ask whose card is gone;
 * - the **waterfall observers** register on `approval/request` /
 *   `user-questions/request`, record the ask identity into an in-memory carrier
 *   and delegate with `next()` exactly once. They never prepend, claim, hold or
 *   change the outcome, and they dispose with the plugin.
 *
 * @module tests/capture/live-asks
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import { createCaptureDriver, registerOpenItemsCapture, type LiveSessionLike } from '../../src/host/capture'
import type { CaptureEvent } from '../../src/host/capture-contract'
import { LIVE_ASKS_SERVICE, type LiveAskCarrier } from '../../src/host/delivery-contract'
import type { OwnedDraft } from '../../src/host/folds/drafts'
import { foldSession } from '../../src/host/projection'
import { InMemoryDetectionCursorStore, runBackfill } from '../../src/host/backfill'
import { FakeCaptureContext, FakeSink, sessionInfo } from './fakes'
import { T0, approvalAsked, approvalDecided, askUserQuestionArgs, toolCall, toolResult, turnStart } from './fixtures'

/** One deterministic clock. */
const NOW = T0 + 5 * 24 * 60 * 60 * 1000

/** The root session live capture folds. */
const SESSION = sessionInfo('session-root')

/** A real `Session`-shaped record (facts in `header`). */
function liveSession(sessionId = 'session-root'): LiveSessionLike {
  return { id: sessionId, inheritedEventCount: 0, header: { id: sessionId, createdAt: T0, cwd: '/work/x' } }
}

/** Dispatch a waterfall on the real Cordis context with a fallback behaviour. */
function dispatchWaterfall(
  ctx: Context,
  name: string,
  request: unknown,
  fallback: () => Promise<unknown>,
): Promise<unknown> {
  const waterfall = (ctx as unknown as {
    waterfall(event: string, request: unknown, next: () => Promise<unknown>): Promise<unknown>
  }).waterfall
  return waterfall.call(ctx, name, request, fallback)
}

describe('pending approval rows', () => {
  it('raises a truthful pending ask carrying the approval identity', async () => {
    const drafts = await createCaptureDriver({ sink: new FakeSink(), source: 'projection', now: () => NOW })
      .driveSession(liveSession(), [approvalAsked(0, 'approval-1', 'bash', 'call-1', 'run the test suite')])
    const pending = drafts.find(draft => draft.closes === undefined)
    expect(pending).toMatchObject({
      artifactId: 'approval:call-1',
      kind: 'approval',
      detectorCode: 'approval/asked:awaiting-decision',
      callId: 'call-1',
      approvalId: 'approval-1',
      blocking: true,
      sessionId: 'session-root',
    })
    expect(pending?.reply?.controls).toEqual(['approve', 'deny'])
    expect(pending?.body).toContain('run the test suite')
    // The row is live-only: capture may raise it, a cold-log read may not.
    expect((pending as OwnedDraft | undefined)?.liveOnly).toBe(true)
  })

  it('closes the pending row when the ask is granted', async () => {
    const driver = createCaptureDriver({ sink: new FakeSink(), source: 'projection', now: () => NOW })
    await driver.driveSession(liveSession(), [approvalAsked(0, 'approval-1', 'bash', 'call-1')])
    const drafts = await driver.driveSession(liveSession(), [approvalDecided(1, 'approval-1', 'allowed-once')])
    const closure = drafts.find(draft => draft.closes !== undefined)
    expect(closure?.closes).toMatchObject({ artifactId: 'approval:call-1', code: 'approval/decided:allowed-once' })
  })

  it('replaces the pending row with the decided-blocked row on a non-grant', async () => {
    const driver = createCaptureDriver({ sink: new FakeSink(), source: 'projection', now: () => NOW })
    await driver.driveSession(liveSession(), [approvalAsked(0, 'approval-1', 'bash', 'call-1')])
    const drafts = await driver.driveSession(liveSession(), [approvalDecided(1, 'approval-1', 'rejected')])
    expect(drafts[0]).toMatchObject({
      artifactId: 'approval:call-1',
      detectorCode: 'approval/decided:rejected',
    })
    expect(drafts[0]?.closes).toBeUndefined()
  })
})

describe('pending question rows', () => {
  it('keeps the tool-call row open until the real result lands', async () => {
    const driver = createCaptureDriver({ sink: new FakeSink(), source: 'projection', now: () => NOW })
    const ask = await driver.driveSession(liveSession(), [
      turnStart(0, 1),
      toolCall(1, 'call-ask', 'ask_user_question', askUserQuestionArgs('Proceed?', ['Yes', 'No'])),
    ])
    expect(ask[0]).toMatchObject({ artifactId: 'question:call-ask', kind: 'question', callId: 'call-ask' })
    const answered = await driver.driveSession(liveSession(), [toolResult(2, 'call-ask', [])])
    expect(answered[0]?.closes).toMatchObject({ artifactId: 'question:call-ask', code: 'tool/result' })
  })
})

describe('a cold-log read does not resurrect a live-only ask', () => {
  it('never raises the pending row from a first-contact baseline', () => {
    const folded = foldSession([approvalAsked(0, 'approval-1', 'bash', 'call-1')], {
      session: SESSION,
      source: 'log-fold',
      mode: 'baseline',
    })
    expect(folded.drafts).toEqual([])
  })

  it('reports only the decided row from a historical delta fold', () => {
    const folded = foldSession([
      approvalAsked(0, 'approval-1', 'bash', 'call-1'),
      approvalDecided(1, 'approval-1', 'unavailable'),
    ], { session: SESSION, source: 'log-fold', mode: 'delta', historical: true })
    expect(folded.drafts.map(draft => draft.detectorCode)).toEqual(['approval/decided:unavailable'])
    expect(folded.drafts.every(draft => (draft as OwnedDraft).liveOnly !== true)).toBe(true)
  })

  it('emits no pending row through the backfill either', async () => {
    const sink = new FakeSink()
    const context = new FakeCaptureContext({ sessions: [sessionInfo('session-root', { updatedAt: NOW })] })
      .withEvents('session-root', [approvalAsked(0, 'approval-1', 'bash', 'call-1')])
    const report = await runBackfill({
      context,
      sink,
      cursors: new InMemoryDetectionCursorStore(),
      now: () => NOW,
      yieldTo: async () => undefined,
    })
    expect(report.sessionsFolded).toBe(1)
    expect(sink.drafts).toEqual([])
  })

  it('still closes a stale live row when the decision is folded later', async () => {
    const driver = createCaptureDriver({ sink: new FakeSink(), source: 'projection', now: () => NOW })
    const folded = foldSession([
      approvalAsked(0, 'approval-1', 'bash', 'call-1'),
      approvalDecided(1, 'approval-1', 'allowed-once'),
    ], { session: SESSION, source: 'log-fold', mode: 'delta', historical: true, sinceSeq: 0 })
    // The closing transition for a live-captured pending row is evidence, not a
    // live-only raise, so a restart can still clear it.
    expect(folded.drafts.map(draft => draft.closes?.artifactId)).toEqual(['approval:call-1'])
    void driver
  })
})

describe('observe-only waterfall observers', () => {
  const disposers: (() => void)[] = []
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose()
  })

  /** Register capture on a real context and expose the carrier. */
  function mountCapture(): { ctx: Context; capture: ReturnType<typeof registerOpenItemsCapture>; carrier: LiveAskCarrier } {
    const ctx = new Context()
    const capture = registerOpenItemsCapture(ctx, {
      sink: new FakeSink(),
      context: new FakeCaptureContext({ sessions: [] }),
      now: () => NOW,
      autoBackfill: false,
    })
    disposers.push(() => { void capture.dispose() })
    const carrier = ctx.get(LIVE_ASKS_SERVICE) as LiveAskCarrier | undefined
    if (carrier === undefined) throw new Error('live ask carrier was not provided')
    return { ctx, capture, carrier }
  }

  it('registers both observers without claiming the ask', async () => {
    const { ctx, capture } = mountCapture()
    expect(capture.observeLiveAsks).toBe(true)
    let fallbackCalls = 0
    const outcome = await dispatchWaterfall(ctx, 'approval/request', {
      agent: { session: { id: 'session-root' } },
      toolName: 'bash',
      callId: 'call-1',
    }, () => {
      fallbackCalls += 1
      return Promise.resolve('allowed-once')
    })
    // The observer delegated exactly once and returned the answerer's outcome.
    expect(fallbackCalls).toBe(1)
    expect(outcome).toBe('allowed-once')
  })

  it('records the ask while it is pending and the outcome once it settled', async () => {
    const { ctx, carrier } = mountCapture()
    await dispatchWaterfall(ctx, 'approval/request', {
      agent: { session: { id: 'session-root' } },
      toolName: 'bash',
      callId: 'call-2',
    }, () => {
      expect(carrier.get('session-root', 'call-2')).toMatchObject({
        kind: 'approval',
        state: 'pending',
        toolName: 'bash',
        callId: 'call-2',
      })
      return Promise.resolve('rejected')
    })
    expect(carrier.get('session-root', 'call-2')).toMatchObject({ state: 'settled', outcome: 'rejected' })
    expect(carrier.observed).toBe(1)
  })

  it('observes timed question requests by callId', async () => {
    const { ctx, carrier } = mountCapture()
    const answer = await dispatchWaterfall(ctx, 'user-questions/request', {
      agent: { session: { id: 'session-root' } },
      questions: [{ id: 'q1', question: 'Proceed?' }],
      wait: { callId: 'call-timed' },
    }, () => Promise.resolve({ answers: [] }))
    expect(answer).toEqual({ answers: [] })
    expect(carrier.get('session-root', 'call-timed')).toMatchObject({ kind: 'question', state: 'settled' })
  })

  it('disposes with the plugin', async () => {
    const { ctx, capture, carrier } = mountCapture()
    await capture.dispose()
    let fallbackCalls = 0
    await dispatchWaterfall(ctx, 'approval/request', {
      agent: { session: { id: 'session-root' } },
      toolName: 'bash',
      callId: 'call-after-dispose',
    }, () => {
      fallbackCalls += 1
      return Promise.resolve('unavailable')
    })
    expect(fallbackCalls).toBe(1)
    expect(carrier.get('session-root', 'call-after-dispose')).toBeUndefined()
  })
})

/** The evidence channel the folds expose is asserted in `tests/delivery/ack.spec`. */
export const LIVE_ASK_EVENTS: Readonly<Record<string, CaptureEvent[]>> = {
  asked: [approvalAsked(0, 'approval-1', 'bash', 'call-1')],
}
