/**
 * Reply engine behaviour: guard order, the three tracks, delivery evidence,
 * idempotency and the honest failure paths (DESIGN §6.3, §6.4, §6.7, §6.8).
 *
 * Every case uses fakes only: no Cordis, no live Session, no filesystem.
 */
import { describe, expect, it } from 'vitest'

import { createReplyEngine, REPLY_NOTES } from '../../src/host/delivery'
import { ReplyEngineError } from '../../src/host/delivery-contract'
import { MAX_BODY_CHARS } from '../../src/shared/records'
import type { OpenItemRecord } from '../../src/shared/schema'
import type { ReplyRequest, ReplyValue } from '../../src/shared/protocol'
import { makeItem, T0 } from '../fixtures'
import {
  createFakeSessions,
  createFakeStore,
  namedError,
  type FakeSessionsOptions,
} from './fakes'

const NOW = 5_000

/** Mount the engine over one fake item and one fake bridge. */
function mount(options: { item?: Partial<OpenItemRecord>; sessions?: FakeSessionsOptions } = {}): {
  item: OpenItemRecord
  store: ReturnType<typeof createFakeStore>
  sessions: ReturnType<typeof createFakeSessions>
  engine: ReturnType<typeof createReplyEngine>
} {
  const item = makeItem(options.item ?? {})
  const store = createFakeStore(item)
  const sessions = createFakeSessions(options.sessions ?? {})
  const engine = createReplyEngine({ store, sessions, now: () => NOW })
  return { item, store, sessions, engine }
}

/** Build one reply request for the item. */
function replyFor(item: OpenItemRecord, patch: Partial<ReplyRequest> = {}): ReplyRequest {
  return {
    itemId: item.id,
    expectedVersion: item.version,
    deliveryId: 'delivery-1',
    payload: { type: 'text', text: 'ship it on Friday' },
    ...patch,
  }
}

/** The recorded delivery with one id, or a failure. */
function deliveryIn(result: ReplyValue): ReplyValue['delivery'] {
  return result.delivery
}

describe('guard order (DESIGN §6.7)', () => {
  it('rejects an unknown item before touching the session', async () => {
    const { item, store, sessions, engine } = mount()
    await expect(engine.reply(replyFor(item, { itemId: 'missing' }), 'req-1'))
      .rejects.toMatchObject({ code: 'not-found' })
    expect(store.writes).toHaveLength(0)
    expect(sessions.archiveChecks).toBe(0)
  })

  it('treats a tombstoned item as gone', async () => {
    const { item, engine } = mount({ item: { deletedAt: T0 } })
    await expect(engine.reply(replyFor(item), 'req-1'))
      .rejects.toMatchObject({ code: 'not-found' })
  })

  it('refuses an item that is no longer open', async () => {
    const { item, engine } = mount({ item: { state: 'snoozed', snoozedUntil: NOW + 60_000 } })
    await expect(engine.reply(replyFor(item), 'req-1'))
      .rejects.toMatchObject({ code: 'conflict' })
  })

  it('loses the CAS cleanly before any session work', async () => {
    const { item, store, sessions, engine } = mount()
    await expect(engine.reply(replyFor(item, { expectedVersion: item.version + 1 }), 'req-1'))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(store.writes).toHaveLength(0)
    expect(sessions.archiveChecks).toBe(0)
    expect(sessions.probes).toBe(0)
  })

  it('refuses an archived session before probing or delivering', async () => {
    const { item, store, sessions, engine } = mount({ sessions: { archived: true } })
    await expect(engine.reply(replyFor(item), 'req-1'))
      .rejects.toMatchObject({ code: 'session-archived' })
    expect(sessions.archiveChecks).toBe(1)
    expect(sessions.probes).toBe(0)
    expect(store.writes).toHaveLength(0)
  })

  it('returns the recorded attempt for a duplicated deliveryId instead of double-sending', async () => {
    const seeded = makeItem({
      deliveries: [{
        deliveryId: 'delivery-1',
        at: T0,
        track: 'session-message',
        payload: { type: 'text', text: 'ship it on Friday' },
        state: 'queued',
      }],
    })
    const { store, sessions, engine } = mount({ item: seeded })
    const result = await engine.reply(replyFor(seeded), 'req-2')
    expect(result.outcome).toBe('sent')
    expect(result.note).toBe(REPLY_NOTES.alreadyRecorded)
    expect(result.delivery.state).toBe('queued')
    expect(store.writes).toHaveLength(0)
    expect(sessions.probes).toBe(0)
    expect(sessions.calls).toHaveLength(0)
  })

  it('maps a settled duplicate to applied', async () => {
    const seeded = makeItem({
      deliveries: [{
        deliveryId: 'delivery-1',
        at: T0,
        track: 'client-settle',
        payload: { type: 'text', text: 'done' },
        state: 'settled',
      }],
    })
    const { engine } = mount({ item: seeded })
    const result = await engine.reply(replyFor(seeded), 'req-2')
    expect(result.outcome).toBe('applied')
  })

  it('refuses to repeat a failed attempt under the same deliveryId', async () => {
    const seeded = makeItem({
      deliveries: [{
        deliveryId: 'delivery-1',
        at: T0,
        track: 'session-message',
        payload: { type: 'text', text: 'ship it' },
        state: 'failed',
        failure: { code: 'unknown-outcome', message: 'the Session did not accept the message' },
      }],
    })
    const { engine } = mount({ item: seeded })
    await expect(engine.reply(replyFor(seeded), 'req-2'))
      .rejects.toMatchObject({ code: 'conflict' })
  })
})

describe('request validation', () => {
  const cases: ReadonlyArray<[string, Partial<ReplyRequest> | undefined, string]> = [
    ['approval payload', { payload: { type: 'approval', outcome: 'allow-once' } }, 'bad-request'],
    ['task action payload', { payload: { type: 'task-action', action: 'complete' } }, 'bad-request'],
    ['dismiss payload', { payload: { type: 'dismiss' } }, 'bad-request'],
    ['empty text', { payload: { type: 'text', text: '   ' } }, 'bad-request'],
    ['oversized text', { payload: { type: 'text', text: 'x'.repeat(MAX_BODY_CHARS + 1) } }, 'bad-request'],
    ['empty itemId', { itemId: '' }, 'bad-request'],
    ['empty deliveryId', { deliveryId: '' }, 'bad-request'],
    ['oversized deliveryId', { deliveryId: 'd'.repeat(129) }, 'bad-request'],
    ['negative expectedVersion', { expectedVersion: -1 }, 'bad-request'],
    ['unknown track', { requestedTrack: 'telepathy' as never }, 'bad-request'],
  ]

  it.each(cases)('rejects %s with %s', async (_name, patch) => {
    const { item, store, sessions, engine } = mount()
    await expect(engine.reply(replyFor(item, patch), 'req-1')).rejects.toBeInstanceOf(ReplyEngineError)
    await expect(engine.reply(replyFor(item, patch), 'req-1')).rejects.toMatchObject({ code: 'bad-request' })
    expect(store.writes).toHaveLength(0)
    expect(sessions.archiveChecks).toBe(0)
  })

  it('requires a request id', async () => {
    const { item, engine } = mount()
    await expect(engine.reply(replyFor(item), ' ')).rejects.toMatchObject({ code: 'bad-request' })
  })
})

describe('track 3: message delivery', () => {
  it('steers into a running turn, flushes, and records queued evidence', async () => {
    const { item, store, sessions, engine } = mount({
      item: { blocking: true },
      sessions: { probe: { ok: true, agent: { name: 'agent-7' }, running: true, turnOpen: true } },
    })
    const result = await engine.reply(replyFor(item), 'req-1')

    expect(result.outcome).toBe('sent')
    expect(result.note).toBe(REPLY_NOTES.sentSteer)
    expect(deliveryIn(result).track).toBe('session-message')
    expect(deliveryIn(result).state).toBe('queued')
    expect(deliveryIn(result).payload).toEqual({ type: 'text', text: 'ship it on Friday' })
    expect(result.item.state).toBe('awaiting')
    expect(result.item.resolution).toBeUndefined()
    expect(result.item.acknowledgement?.state).toBe('pending')

    expect(sessions.calls.map(call => call.op)).toEqual(['steer', 'flush'])
    const [steer] = sessions.calls
    expect(steer?.agent).toEqual({ name: 'agent-7' })
    expect(steer?.message?.source).toEqual({
      kind: 'open-items',
      form: 'notice',
      itemId: item.id,
      deliveryId: 'delivery-1',
    })
    expect(steer?.message?.text).toBe(
      `Reply from the user via Open Items (item ${item.id}, decision):\nship it on Friday`,
    )
    expect(store.writes).toHaveLength(1)
    expect(store.writes[0]?.resolution).toBeUndefined()
  })

  it('records instead of waking when a blocking item ended and no wake was confirmed', async () => {
    const { item, store, sessions, engine } = mount({
      item: { blocking: true },
      sessions: { probe: { ok: true, agent: { name: 'agent-7' }, running: false, turnOpen: false } },
    })
    const result = await engine.reply(replyFor(item), 'req-1')

    expect(result.outcome).toBe('recorded')
    expect(result.note).toBe(REPLY_NOTES.turnEnded)
    expect(deliveryIn(result).track).toBe('host-settle')
    expect(deliveryIn(result).state).toBe('settled')
    expect(result.item.state).toBe('awaiting')
    expect(result.item.resolution).toMatchObject({
      kind: 'answered',
      actor: 'user',
      deliveryId: 'delivery-1',
      payload: { type: 'text', text: 'ship it on Friday' },
    })
    expect(result.item.acknowledgement?.state).toBe('pending')
    expect(sessions.calls).toHaveLength(0)
    expect(store.writes).toHaveLength(1)
  })

  it('wakes a cold session only for a confirmed send', async () => {
    const { item, sessions, engine } = mount({
      item: { blocking: true },
      sessions: { probe: { ok: false, reason: 'agent-unavailable' } },
    })
    const result = await engine.reply(
      replyFor(item, { requestedTrack: 'session-message', confirmedWake: true }),
      'req-1',
    )
    expect(result.outcome).toBe('sent')
    expect(result.note).toBe(REPLY_NOTES.sentFollowup)
    expect(sessions.resumes).toBe(1)
    expect(sessions.calls.map(call => call.op)).toEqual(['followup', 'flush'])
    expect(result.item.state).toBe('awaiting')
  })

  it('does not wake on an unconfirmed explicit send', async () => {
    const { item, sessions, engine } = mount({
      item: { blocking: true },
      sessions: { probe: { ok: false, reason: 'agent-unavailable' } },
    })
    const result = await engine.reply(replyFor(item, { requestedTrack: 'session-message' }), 'req-1')
    expect(result.outcome).toBe('recorded')
    expect(result.note).toBe(REPLY_NOTES.idleUnconfirmed)
    expect(sessions.resumes).toBe(0)
    expect(sessions.calls).toHaveLength(0)
  })

  it('fails with agent-unavailable when the confirmed resume fails', async () => {
    const { item, store, engine } = mount({
      item: { blocking: true },
      sessions: {
        probe: { ok: false, reason: 'agent-unavailable' },
        resume: { ok: false, reason: 'unknown-outcome' },
      },
    })
    await expect(engine.reply(
      replyFor(item, { requestedTrack: 'session-message', confirmedWake: true }),
      'req-1',
    )).rejects.toMatchObject({ code: 'agent-unavailable' })
    expect(store.writes).toHaveLength(0)
  })

  it('fails with agent-unavailable when the Host cannot resume at all', async () => {
    const { item, engine } = mount({
      item: { blocking: true },
      sessions: { probe: { ok: false, reason: 'agent-unavailable' }, withoutResume: true },
    })
    await expect(engine.reply(
      replyFor(item, { requestedTrack: 'session-message', confirmedWake: true }),
      'req-1',
    )).rejects.toMatchObject({ code: 'agent-unavailable' })
  })

  it('never interrupts an advisory item that the agent moved past', async () => {
    const { item, sessions, engine } = mount({
      item: { blocking: false, tier: 'structural' },
      sessions: { probe: { ok: true, agent: { name: 'agent-7' }, running: true, turnOpen: true } },
    })
    const result = await engine.reply(replyFor(item), 'req-1')
    expect(result.outcome).toBe('recorded')
    expect(result.note).toBe(REPLY_NOTES.advisory)
    expect(sessions.calls).toHaveLength(0)
  })

  it('records a candidate it cannot deliver without a confirmed wake', async () => {
    const { item, engine } = mount({
      item: { blocking: false, tier: 'candidate' },
      sessions: { probe: { ok: true, agent: { name: 'agent-7' }, running: false, turnOpen: false } },
    })
    const result = await engine.reply(replyFor(item), 'req-1')
    expect(result.outcome).toBe('recorded')
    expect(result.note).toBe(REPLY_NOTES.candidateUnconfirmed)
  })
})

describe('track 1 and the degraded track 2', () => {
  it('records a client settle as applied without sending anything', async () => {
    const { item, sessions, engine } = mount()
    const result = await engine.reply(replyFor(item, { requestedTrack: 'client-settle' }), 'req-1')
    expect(result.outcome).toBe('applied')
    expect(deliveryIn(result).track).toBe('client-settle')
    expect(deliveryIn(result).state).toBe('settled')
    expect(result.item.resolution?.deliveryId).toBe('delivery-1')
    expect(sessions.calls).toHaveLength(0)
  })

  it('degrades host-settle to a steer and says so', async () => {
    const { item, sessions, engine } = mount({
      item: { blocking: true },
      sessions: { probe: { ok: true, agent: { name: 'agent-7' }, running: true, turnOpen: true } },
    })
    const result = await engine.reply(replyFor(item, { requestedTrack: 'host-settle' }), 'req-1')
    expect(result.outcome).toBe('sent')
    expect(result.note).toBe(REPLY_NOTES.hostSettleDowngraded)
    expect(deliveryIn(result).track).toBe('session-message')
    expect(sessions.calls.map(call => call.op)).toEqual(['steer', 'flush'])
  })

  it('records host-settle when nothing is running instead of waking', async () => {
    const { item, sessions, engine } = mount({
      item: { blocking: true },
      sessions: { probe: { ok: false, reason: 'agent-unavailable' } },
    })
    const result = await engine.reply(replyFor(item, { requestedTrack: 'host-settle' }), 'req-1')
    expect(result.outcome).toBe('recorded')
    expect(result.note).toBe(REPLY_NOTES.hostSettle)
    expect(sessions.resumes).toBe(0)
  })

  it('delivers an approval item as an attributed instruction message', async () => {
    const { item, sessions, engine } = mount({
      item: { kind: 'approval', blocking: true },
      sessions: { probe: { ok: true, agent: { name: 'agent-7' }, running: true, turnOpen: true } },
    })
    const result = await engine.reply(replyFor(item), 'req-1')
    expect(result.outcome).toBe('sent')
    expect(sessions.calls[0]?.op).toBe('steer')
  })
})

describe('evidence and honesty', () => {
  it('says the durability barrier failed instead of claiming a clean send', async () => {
    const { item, engine } = mount({
      item: { blocking: true },
      sessions: {
        probe: { ok: true, agent: { name: 'agent-7' }, running: true, turnOpen: true },
        flushThrows: new Error('flush listener failed'),
      },
    })
    const result = await engine.reply(replyFor(item), 'req-1')
    expect(result.outcome).toBe('sent')
    expect(result.delivery.state).toBe('queued')
    expect(result.note).toContain(REPLY_NOTES.durabilityWarning)
  })

  it('persists a failed attempt and leaves the item open when the queue write throws', async () => {
    const { item, store, sessions, engine } = mount({
      item: { blocking: true },
      sessions: {
        probe: { ok: true, agent: { name: 'agent-7' }, running: true, turnOpen: true },
        steerThrows: namedError('Error', 'session append refused'),
      },
    })
    await expect(engine.reply(replyFor(item), 'req-1'))
      .rejects.toMatchObject({ code: 'agent-unavailable' })
    expect(store.writes).toHaveLength(1)
    expect(store.current().state).toBe('open')
    const recorded = store.current().deliveries.at(-1)
    expect(recorded?.state).toBe('failed')
    expect(recorded?.failure?.code).toBe('unknown-outcome')
    expect(sessions.calls.map(call => call.op)).toEqual(['steer'])
  })

  it('maps a store CAS loss to conflict', async () => {
    const { item, store, engine } = mount({
      item: { blocking: true },
      sessions: { probe: { ok: true, agent: { name: 'agent-7' }, running: false, turnOpen: false } },
    })
    store.conflictNextWrite()
    await expect(engine.reply(replyFor(item), 'req-1')).rejects.toMatchObject({ code: 'conflict' })
    expect(store.current().state).toBe('open')
  })

  it('reports a conflict after the message was queued rather than hiding it', async () => {
    const { item, store, sessions, engine } = mount({
      item: { blocking: true },
      sessions: { probe: { ok: true, agent: { name: 'agent-7' }, running: true, turnOpen: true } },
    })
    // The queue write lands, then the durable record loses the CAS.
    sessions.flush = async function flush(this: unknown) {
      store.conflictNextWrite()
    }
    const error = await engine.reply(replyFor(item), 'req-1').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ReplyEngineError)
    expect((error as ReplyEngineError).code).toBe('conflict')
    expect((error as ReplyEngineError).message).toContain('queued')
  })
})

describe('idempotency end to end', () => {
  it('never sends twice for one deliveryId', async () => {
    const { item, sessions, engine } = mount({
      item: { blocking: true },
      sessions: { probe: { ok: true, agent: { name: 'agent-7' }, running: true, turnOpen: true } },
    })
    const first = await engine.reply(replyFor(item), 'req-1')
    const second = await engine.reply(replyFor(item), 'req-2')
    expect(first.outcome).toBe('sent')
    expect(second.outcome).toBe('sent')
    expect(second.note).toBe(REPLY_NOTES.alreadyRecorded)
    expect(sessions.calls.map(call => call.op)).toEqual(['steer', 'flush'])
  })

  it('refuses a second, different delivery once the item left the inbox', async () => {
    const { item, store, engine } = mount({
      item: { blocking: true },
      sessions: { probe: { ok: true, agent: { name: 'agent-7' }, running: true, turnOpen: true } },
    })
    await engine.reply(replyFor(item), 'req-1')
    expect(store.current().state).toBe('awaiting')
    await expect(engine.reply(replyFor(item, { deliveryId: 'delivery-2' }), 'req-2'))
      .rejects.toMatchObject({ code: 'conflict' })
  })
})
