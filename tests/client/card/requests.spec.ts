/**
 * The card's route request shapes and failure mapping: the parts a reviewer must
 * be able to check without a DOM or a live route.
 */
import { describe, expect, it } from 'vitest'

import { LIMITS } from '../../../src/shared/protocol'
import type { ReplyPayload } from '../../../src/shared/schema'
import { OpenItemsRpcError } from '../../../src/client/data/transport'
import {
  answerTextOf,
  failureOf,
  failureOfDelivery,
  hydrationRequest,
  newDeliveryId,
  outcomeCopyKey,
  recoveryOf,
  replyRequest,
} from '../../../src/client/ui/card/requests'

describe('hydrationRequest', () => {
  it('scopes the read to one Session and asks for every state', () => {
    expect(hydrationRequest('session-1')).toEqual({
      query: { scope: { sessionId: 'session-1' }, status: 'all', limit: LIMITS.listPageMax },
    })
  })
})

describe('replyRequest', () => {
  it('carries the item, its CAS version, the delivery id and the payload', () => {
    const payload: ReplyPayload = { type: 'option', option: 'Corporate' }
    expect(replyRequest({ id: 'item-1', version: 7 }, payload, 'd-abc')).toEqual({
      itemId: 'item-1',
      expectedVersion: 7,
      deliveryId: 'd-abc',
      payload,
      requestedTrack: 'session-message',
    })
  })

  it('keeps a dismiss payload intact', () => {
    const request = replyRequest({ id: 'item-1', version: 1 }, { type: 'dismiss' }, 'd-1')
    expect(request.payload).toEqual({ type: 'dismiss' })
  })
})

describe('newDeliveryId', () => {
  it('mints a non-empty unique id', () => {
    const first = newDeliveryId()
    const second = newDeliveryId()
    expect(first.length).toBeGreaterThan(8)
    expect(first).not.toBe(second)
  })
})

describe('failureOf', () => {
  it('maps each route code to the copy the card switches on', () => {
    expect(failureOf(new OpenItemsRpcError('transport', 'offline'))).toBe('offline')
    expect(failureOf(new OpenItemsRpcError('conflict', 'stale'))).toBe('conflict')
    expect(failureOf(new OpenItemsRpcError('forbidden', 'peer'))).toBe('forbidden')
    expect(failureOf(new OpenItemsRpcError('not-found', 'gone'))).toBe('not-found')
    expect(failureOf(new OpenItemsRpcError('bad-request', 'no'))).toBe('bad-request')
    expect(failureOf(new OpenItemsRpcError('session-archived', 'archived'))).toBe('session-archived')
    expect(failureOf(new OpenItemsRpcError('agent-unavailable', 'asleep'))).toBe('agent-unavailable')
    expect(failureOf(new OpenItemsRpcError('unknown-outcome', 'lost'))).toBe('outcome-unknown')
    expect(failureOf(new OpenItemsRpcError('limit-reached', 'full'))).toBe('limit-reached')
    expect(failureOf(new OpenItemsRpcError('unknown', 'huh'))).toBe('unknown')
  })

  it('treats a non-route throw as unknown', () => {
    expect(failureOf(new Error('boom'))).toBe('unknown')
    expect(failureOf('string')).toBe('unknown')
  })
})

describe('failureOfDelivery', () => {
  it('maps evidenced delivery failures onto card failures', () => {
    expect(failureOfDelivery('session-archived')).toBe('session-archived')
    expect(failureOfDelivery('agent-unavailable')).toBe('agent-unavailable')
    expect(failureOfDelivery('unknown-outcome')).toBe('outcome-unknown')
    expect(failureOfDelivery('was-not-applied')).toBe('bad-request')
    expect(failureOfDelivery('cannot-apply')).toBe('bad-request')
    expect(failureOfDelivery(undefined)).toBe('unknown')
  })
})

describe('recoveryOf', () => {
  it('recognizes a settle, a delivery and a failure', () => {
    const base = {
      deliveryId: 'd-1',
      at: 1,
      track: 'session-message' as const,
      payload: { type: 'option' as const, option: 'Corporate' },
    }
    expect(recoveryOf({ ...base, state: 'settled' })).toEqual({ kind: 'settled', outcome: 'applied' })
    expect(recoveryOf({ ...base, state: 'queued' })).toEqual({ kind: 'settled', outcome: 'sent' })
    expect(recoveryOf({ ...base, state: 'delivered' })).toEqual({ kind: 'settled', outcome: 'sent' })
    expect(recoveryOf({ ...base, state: 'acknowledged' })).toEqual({ kind: 'settled', outcome: 'sent' })
    expect(recoveryOf({
      ...base,
      state: 'failed',
      failure: { code: 'session-archived', message: 'archived' },
    })).toEqual({ kind: 'failed', failure: 'session-archived' })
  })

  it('sends again when nothing landed or the attempt is still sending', () => {
    expect(recoveryOf(undefined)).toBeUndefined()
    expect(recoveryOf({
      deliveryId: 'd-1', at: 1, track: 'session-message', payload: { type: 'dismiss' }, state: 'sending',
    })).toBeUndefined()
  })
})

describe('copy selection', () => {
  it('echos the answer text only when the payload carries one', () => {
    expect(answerTextOf({ type: 'option', option: 'Corporate' })).toBe('Corporate')
    expect(answerTextOf({ type: 'text', text: 'hello' })).toBe('hello')
    expect(answerTextOf({ type: 'text', text: '' })).toBeUndefined()
    expect(answerTextOf({ type: 'dismiss' })).toBeUndefined()
  })

  it('keeps the two send claims distinct', () => {
    expect(outcomeCopyKey('applied')).toBe('card.receipt.applied')
    expect(outcomeCopyKey('sent')).toBe('card.receipt.applied')
    expect(outcomeCopyKey('recorded')).toBe('card.receipt.recorded')
  })
})
