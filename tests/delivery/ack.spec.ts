/**
 * Delivery and acknowledgement evidence, end to end through the real store
 * service (REVIEW-rc1 P0-03, DESIGN §6.3/§7.4.2).
 *
 * The evidence itself is folded from the session log by the capture engine; this
 * suite drives the real `OpenItemsService` sink with that evidence and asserts
 * the durable transitions. The `24 h` `none` sweep is only the fallback and is
 * asserted as such.
 *
 * @module tests/delivery/ack.spec
 */

import { afterEach, describe, expect, it } from 'vitest'

import { createCaptureDriver } from '../../src/host/capture'
import type { CaptureEvent, CaptureSessionInfo } from '../../src/host/capture-contract'
import { composeCore, type ComposedCore } from '../e2e/harness'
import { T0, askUserQuestionArgs, toolCall, toolResult, turnStart } from '../capture/fixtures'

/** One deterministic clock for the store writes. */
const NOW = T0 + 5 * 24 * 60 * 60 * 1000

/** The session every item in this suite belongs to. */
const SESSION: CaptureSessionInfo = { sessionId: 'session-1', updatedAt: NOW, archived: false }

const cores: ComposedCore[] = []

afterEach(async () => {
  for (const core of cores.splice(0)) await core.close()
})

/** Compose the real store/service and track it for cleanup. */
async function core(): Promise<ComposedCore> {
  const composed = await composeCore({ sessions: [], now: () => NOW })
  cores.push(composed)
  return composed
}

/** An answered (track-3 queued) item: `open → awaiting`, acknowledgement pending. */
async function queuedAnswer(composed: ComposedCore, deliveryId: string): Promise<string> {
  const { item } = await composed.service.create({
    kind: 'decision',
    title: `Ship ${deliveryId}?`,
    sessionId: 'session-1',
  })
  await composed.service.recordAttempt({
    itemId: item.id,
    expectedVersion: item.version,
    delivery: {
      deliveryId,
      at: NOW,
      track: 'session-message',
      payload: { type: 'text', text: 'yes' },
      state: 'queued',
    },
    acknowledgement: { state: 'pending' },
  })
  return item.id
}

describe('delivered evidence', () => {
  it('moves the recorded queued attempt to delivered with log coordinates', async () => {
    const composed = await core()
    const itemId = await queuedAnswer(composed, 'delivery-1')

    const applied = await composed.service.applyEvidence([{
      type: 'delivered',
      sessionId: 'session-1',
      itemId,
      deliveryId: 'delivery-1',
      seq: 7,
      messageId: 'message-7',
      at: NOW + 1000,
    }])
    expect(applied).toBe(1)
    const record = composed.service.get(itemId)!
    expect(record.deliveries.map(delivery => delivery.state)).toEqual(['queued', 'delivered'])
    expect(record.deliveries[1]?.evidence).toMatchObject({ seq: 7, messageId: 'message-7' })
    // The item is already awaiting; the delivered evidence does not resolve it.
    expect(record.state).toBe('awaiting')
  })

  it('is idempotent: a replayed message does not append a second transition', async () => {
    const composed = await core()
    const itemId = await queuedAnswer(composed, 'delivery-2')
    const evidence = {
      type: 'delivered' as const,
      sessionId: 'session-1',
      itemId,
      deliveryId: 'delivery-2',
      seq: 9,
      at: NOW + 1000,
    }
    expect(await composed.service.applyEvidence([evidence])).toBe(1)
    expect(await composed.service.applyEvidence([evidence])).toBe(0)
    expect(composed.service.get(itemId)!.deliveries).toHaveLength(2)
  })

  it('ignores a message whose delivery record was never written', async () => {
    const composed = await core()
    const itemId = await queuedAnswer(composed, 'delivery-3')
    expect(await composed.service.applyEvidence([{
      type: 'delivered',
      sessionId: 'session-1',
      itemId,
      deliveryId: 'some-other-delivery',
      seq: 4,
      at: NOW,
    }])).toBe(0)
    expect(composed.service.get(itemId)!.deliveries).toHaveLength(1)
  })
})

describe('acknowledgement evidence', () => {
  it('acknowledges an awaiting item from session-scoped next-turn evidence', async () => {
    const composed = await core()
    const itemId = await queuedAnswer(composed, 'delivery-4')
    const applied = await composed.service.applyEvidence([{
      type: 'acknowledged',
      sessionId: 'session-1',
      kind: 'next-turn',
      seq: 11,
      at: NOW + 2000,
    }])
    expect(applied).toBe(1)
    const record = composed.service.get(itemId)!
    expect(record).toMatchObject({
      state: 'resolved',
      acknowledgement: { state: 'observed', evidence: { kind: 'next-turn', seq: 11 } },
    })
    // The delivery timeline ends on the evidenced acknowledgement.
    expect(record.deliveries.at(-1)).toMatchObject({ deliveryId: 'delivery-4', state: 'acknowledged' })
  })

  it('keeps the user answer when the ask\'s own result acknowledges it', async () => {
    const composed = await core()
    const driver = createCaptureDriver({ sink: composed.service, source: 'projection', now: () => NOW })
    const events: CaptureEvent[] = [
      turnStart(0, 1),
      toolCall(1, 'call-ask', 'ask_user_question', askUserQuestionArgs('Proceed?', ['Yes', 'No'])),
    ]
    await driver.driveSession(SESSION, events)
    const item = composed.service.list({ status: 'open' }).items
      .find(entry => entry.source.callId === 'call-ask')
    expect(item).toBeDefined()

    // The browser settled the card (track 1); the engine records the answer.
    await composed.service.recordAttempt({
      itemId: item!.id,
      expectedVersion: item!.version,
      delivery: {
        deliveryId: 'delivery-ask',
        at: NOW,
        track: 'client-settle',
        payload: { type: 'option', option: 'Yes' },
        state: 'settled',
      },
      resolution: {
        kind: 'answered',
        at: NOW,
        actor: 'user',
        payload: { type: 'option', option: 'Yes' },
        deliveryId: 'delivery-ask',
      },
      acknowledgement: { state: 'pending' },
    })

    // The ask's real result lands: evidence is applied before the detector
    // closure, so the item is acknowledged *and* keeps the user's answer.
    await driver.driveSession(SESSION, [toolResult(2, 'call-ask', [])])
    const after = composed.service.get(item!.id)!
    expect(after).toMatchObject({
      state: 'resolved',
      resolution: { kind: 'answered', payload: { type: 'option', option: 'Yes' } },
      acknowledgement: { state: 'observed', evidence: { kind: 'tool-result', seq: 2 } },
    })
  })

  it('resolves a track-3 item with no evidence at the window with a synthesized resolution', async () => {
    const composed = await core()
    const itemId = await queuedAnswer(composed, 'delivery-6')
    // A queued send deliberately has no resolution until the session acts.
    expect(composed.service.get(itemId)?.state).toBe('awaiting')
    expect(composed.service.get(itemId)?.resolution).toBeUndefined()

    await composed.store.sweep(NOW + 25 * 60 * 60 * 1000)
    const record = composed.service.get(itemId)!
    // The honest `none` fallback lands instead of throwing on a resolved record
    // without a resolution: the answer the delivery carried becomes it.
    expect(record).toMatchObject({
      state: 'resolved',
      acknowledgement: { state: 'none' },
      resolution: {
        kind: 'answered',
        actor: 'user',
        payload: { type: 'text', text: 'yes' },
        deliveryId: 'delivery-6',
      },
    })
  })

  it('does not acknowledge an item with no evidence (the 24 h sweep is the fallback)', async () => {
    const composed = await core()
    // A settled (track-1/2) answer: the honest fallback case, still unanswered by
    // any session evidence after the window.
    const { item } = await composed.service.create({ kind: 'decision', title: 'Fallback?', sessionId: 'session-1' })
    await composed.service.recordAttempt({
      itemId: item.id,
      expectedVersion: item.version,
      delivery: {
        deliveryId: 'delivery-5',
        at: NOW,
        track: 'client-settle',
        payload: { type: 'text', text: 'yes' },
        state: 'settled',
      },
      resolution: {
        kind: 'answered',
        at: NOW,
        actor: 'user',
        payload: { type: 'text', text: 'yes' },
        deliveryId: 'delivery-5',
      },
      acknowledgement: { state: 'pending' },
    })
    const itemId = item.id
    expect(composed.service.get(itemId)?.state).toBe('awaiting')
    // Before the window, nothing changes.
    await composed.store.sweep(NOW + 23 * 60 * 60 * 1000)
    expect(composed.service.get(itemId)).toMatchObject({ state: 'awaiting', acknowledgement: { state: 'pending' } })
    // After the window with no evidence the honest fallback fires.
    await composed.store.sweep(NOW + 25 * 60 * 60 * 1000)
    expect(composed.service.get(itemId)).toMatchObject({
      state: 'resolved',
      acknowledgement: { state: 'none' },
    })
  })
})
