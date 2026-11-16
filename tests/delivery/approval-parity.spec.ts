/**
 * Approval parity (OI-08, DESIGN §6.4): one live request, one settle-once
 * decision, `allowed-once`, never retroactive, never granted by a message.
 *
 * The engine is the durable side of that contract: it accepts an approval
 * payload only on track 1 (the shipped card already decided the one request),
 * persists exactly that decision, and refuses every other route — including a
 * later attempt on the same item, which the CAS/state guard loses.
 */
import { describe, expect, it } from 'vitest'

import { createReplyEngine, REPLY_NOTES } from '../../src/host/delivery'
import type { ReplyRequest } from '../../src/shared/protocol'
import type { OpenItemRecord } from '../../src/shared/schema'
import { defaultReply } from '../../src/shared/records'
import { makeItem } from '../fixtures'
import { createFakeSessions, createFakeStore } from './fakes'

const NOW = 5_000

/** An approval item raised by a tool call. */
function approvalItem(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    kind: 'approval',
    blocking: true,
    reply: defaultReply('approval'),
    source: { sessionId: 'session-1', callId: 'call-9' as never, approvalId: 'approval-1', turn: 3 },
    ...overrides,
  })
}

/** Mount the engine over one approval item and one fake bridge. */
function mount(options: { item?: Partial<OpenItemRecord>; live?: boolean } = {}): {
  item: OpenItemRecord
  store: ReturnType<typeof createFakeStore>
  sessions: ReturnType<typeof createFakeSessions>
  engine: ReturnType<typeof createReplyEngine>
} {
  const item = approvalItem(options.item ?? {})
  const store = createFakeStore(item)
  const sessions = createFakeSessions({
    probe: options.live === false
      ? { ok: false, reason: 'agent-unavailable' }
      : { ok: true, agent: { name: 'agent-7' }, running: true, turnOpen: true },
  })
  const engine = createReplyEngine({ store, sessions, now: () => NOW })
  return { item, store, sessions, engine }
}

/** The wire request for one approval decision. */
function settleRequest(item: OpenItemRecord, patch: Partial<ReplyRequest> = {}): ReplyRequest {
  return {
    itemId: item.id,
    expectedVersion: item.version,
    deliveryId: 'delivery-1',
    payload: { type: 'approval', outcome: 'allow-once' },
    requestedTrack: 'client-settle',
    ...patch,
  }
}

describe('one request, one decision', () => {
  it('records exactly one allowed-once decision and sends nothing', async () => {
    const { item, store, sessions, engine } = mount()
    const result = await engine.reply(settleRequest(item), 'req-1')

    expect(result.outcome).toBe('applied')
    expect(result.delivery.track).toBe('client-settle')
    expect(result.delivery.state).toBe('settled')
    expect(result.delivery.payload).toEqual({ type: 'approval', outcome: 'allow-once' })
    expect(result.item.state).toBe('awaiting')
    expect(result.item.resolution).toMatchObject({
      kind: 'answered',
      actor: 'user',
      deliveryId: 'delivery-1',
      payload: { type: 'approval', outcome: 'allow-once' },
    })
    expect(result.item.acknowledgement?.state).toBe('pending')
    // The card settled the waterfall; the engine must not also message the agent.
    expect(sessions.calls).toHaveLength(0)
    expect(store.writes).toHaveLength(1)
  })

  it('records a deny with the reason the model sees', async () => {
    const { item, engine } = mount()
    const result = await engine.reply(settleRequest(item, {
      payload: { type: 'approval', outcome: 'deny', note: 'too risky while staging is down' },
    }), 'req-1')
    expect(result.outcome).toBe('applied')
    expect(result.delivery.payload).toEqual({
      type: 'approval',
      outcome: 'deny',
      note: 'too risky while staging is down',
    })
  })

  it('is idempotent for the same deliveryId', async () => {
    const { item, store, engine } = mount()
    const first = await engine.reply(settleRequest(item), 'req-1')
    const second = await engine.reply(settleRequest(item), 'req-2')
    expect(first.outcome).toBe('applied')
    expect(second.outcome).toBe('applied')
    expect(second.note).toBe(REPLY_NOTES.alreadyRecorded)
    expect(store.writes).toHaveLength(1)
  })
})

describe('never granted by a message, never retroactive', () => {
  const refusedTracks: ReadonlyArray<[string, ReplyRequest['requestedTrack']]> = [
    ['session-message', 'session-message'],
    ['host-settle', 'host-settle'],
    ['unspecified', undefined],
  ]

  it.each(refusedTracks)('refuses an approval payload on the %s track', async (_name, track) => {
    const { item, store, sessions, engine } = mount()
    await expect(engine.reply(settleRequest(item, {
      ...(track === undefined ? { requestedTrack: undefined } : { requestedTrack: track }),
    }), 'req-1')).rejects.toMatchObject({ code: 'bad-request' })
    expect(store.writes).toHaveLength(0)
    expect(sessions.calls).toHaveLength(0)
  })

  it('loses a second, different decision on the settled item', async () => {
    const { item, store, engine } = mount()
    await engine.reply(settleRequest(item), 'req-1')
    await expect(engine.reply(settleRequest(item, {
      deliveryId: 'delivery-2',
      expectedVersion: item.version + 1,
      payload: { type: 'approval', outcome: 'deny' },
    }), 'req-2')).rejects.toMatchObject({ code: 'conflict' })
    expect(store.current().state).toBe('awaiting')
    expect(store.current().resolution?.payload).toEqual({ type: 'approval', outcome: 'allow-once' })
    expect(store.writes).toHaveLength(1)
  })

  it('refuses a late approval payload after the item moved on', async () => {
    const { item, engine } = mount({ item: { state: 'snoozed', snoozedUntil: NOW + 60_000 } })
    await expect(engine.reply(settleRequest(item), 'req-1'))
      .rejects.toMatchObject({ code: 'conflict' })
  })

  it('refuses a stale expectedVersion before recording anything', async () => {
    const { item, store, engine } = mount()
    await expect(engine.reply(settleRequest(item, { expectedVersion: item.version + 1 }), 'req-1'))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(store.writes).toHaveLength(0)
  })

  it('refuses an archived session even for a settled card', async () => {
    const store = createFakeStore(approvalItem())
    const sessions = createFakeSessions({ archived: true })
    const engine = createReplyEngine({ store, sessions, now: () => NOW })
    await expect(engine.reply(settleRequest(approvalItem()), 'req-1'))
      .rejects.toMatchObject({ code: 'session-archived' })
    expect(store.writes).toHaveLength(0)
  })

  it('keeps the payload bound to the approval vocabulary', async () => {
    const { item, store, engine } = mount()
    await expect(engine.reply(settleRequest(item, {
      payload: { type: 'approval', outcome: 'always' as never },
    }), 'req-1')).rejects.toMatchObject({ code: 'bad-request' })
    expect(store.writes).toHaveLength(0)
  })
})
