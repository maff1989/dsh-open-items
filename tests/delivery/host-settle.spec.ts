/**
 * Track 2 host settle: the engine asks the bridge to answer a continued timed
 * question, records `settled` only when the service accepted it, and persists an
 * evidenced failure — never a success — for every refusal (DESIGN §6.2, §6.3).
 */
import { describe, expect, it } from 'vitest'

import { createReplyEngine, REPLY_NOTES } from '../../src/host/delivery'
import type { HostSettleResult } from '../../src/host/delivery-contract'
import { defaultReply } from '../../src/shared/records'
import type { OpenItemRecord } from '../../src/shared/schema'
import type { ReplyRequest } from '../../src/shared/protocol'
import { makeItem, T0 } from '../fixtures'
import { createFakeSessions, createFakeStore, type FakeSessionsOptions } from './fakes'

const NOW = 5_000

/** A question item raised by a tool call, so track 2 may settle it. */
function questionItem(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    kind: 'question',
    blocking: true,
    reply: defaultReply('question', ['Yes', 'No']),
    source: { sessionId: 'session-1', callId: 'call-7' as never, turn: 2 },
    ...overrides,
  })
}

/** Mount the engine over one fake item and one fake bridge. */
function mount(options: { item?: Partial<OpenItemRecord>; sessions?: FakeSessionsOptions } = {}): {
  item: OpenItemRecord
  store: ReturnType<typeof createFakeStore>
  sessions: ReturnType<typeof createFakeSessions>
  engine: ReturnType<typeof createReplyEngine>
} {
  const item = questionItem(options.item ?? {})
  const store = createFakeStore(item)
  const sessions = createFakeSessions(options.sessions ?? {})
  const engine = createReplyEngine({ store, sessions, now: () => NOW })
  return { item, store, sessions, engine }
}

/** The wire request for one host settle. */
function hostSettleRequest(item: OpenItemRecord, patch: Partial<ReplyRequest> = {}): ReplyRequest {
  return {
    itemId: item.id,
    expectedVersion: item.version,
    deliveryId: 'delivery-1',
    payload: { type: 'option', option: 'Yes' },
    requestedTrack: 'host-settle',
    confirmedWake: true,
    ...patch,
  }
}

const LIVE = { ok: true as const, agent: { name: 'agent-7' }, running: true, turnOpen: true }
const IDLE = { ok: true as const, agent: { name: 'agent-7' }, running: false, turnOpen: false }

describe('track 2 admission', () => {
  it('settles a continued question through the port and records applied', async () => {
    const { item, store, sessions, engine } = mount({
      sessions: { probe: LIVE, hostSettle: { ok: true } },
    })
    const result = await engine.reply(hostSettleRequest(item), 'req-1')

    expect(result.outcome).toBe('applied')
    expect(result.note).toBe(REPLY_NOTES.hostSettled)
    expect(result.delivery.track).toBe('host-settle')
    expect(result.delivery.state).toBe('settled')
    expect(result.delivery.payload).toEqual({ type: 'option', option: 'Yes' })
    expect(result.item.state).toBe('awaiting')
    expect(result.item.resolution).toMatchObject({
      kind: 'answered',
      actor: 'user',
      deliveryId: 'delivery-1',
      payload: { type: 'option', option: 'Yes' },
    })
    expect(result.item.acknowledgement?.state).toBe('pending')

    expect(sessions.hostSettleCalls).toEqual([{
      sessionId: 'session-1',
      callId: 'call-7',
      payload: { type: 'option', option: 'Yes' },
    }])
    expect(sessions.calls).toHaveLength(0)
    expect(store.writes).toHaveLength(1)
  })

  it('can settle with a free-text answer', async () => {
    const { item, engine } = mount({ sessions: { probe: LIVE, hostSettle: { ok: true } } })
    const result = await engine.reply(hostSettleRequest(item, {
      payload: { type: 'text', text: 'only if the tests pass' },
    }), 'req-1')
    expect(result.outcome).toBe('applied')
    expect(result.delivery.payload).toEqual({ type: 'text', text: 'only if the tests pass' })
  })

  it('degrades to a record when the Host does not advertise track 2', async () => {
    const { item, sessions, engine } = mount({ sessions: { probe: IDLE } })
    const result = await engine.reply(hostSettleRequest(item), 'req-1')
    expect(result.outcome).toBe('recorded')
    expect(result.note).toBe(REPLY_NOTES.hostSettle)
    expect(result.delivery.track).toBe('host-settle')
    expect(sessions.hostSettleCalls).toHaveLength(0)
  })

  it('degrades when the item names no tool call', async () => {
    const { item, sessions, engine } = mount({
      item: { source: { sessionId: 'session-1' } },
      sessions: { probe: IDLE, hostSettle: { ok: true } },
    })
    const result = await engine.reply(hostSettleRequest(item), 'req-1')
    expect(result.outcome).toBe('recorded')
    expect(sessions.hostSettleCalls).toHaveLength(0)
  })

  it('degrades for an item that is not a question', async () => {
    const { item, sessions, engine } = mount({
      item: { kind: 'decision', reply: defaultReply('decision') },
      sessions: { probe: IDLE, hostSettle: { ok: true } },
    })
    const result = await engine.reply(hostSettleRequest(item), 'req-1')
    expect(result.outcome).toBe('recorded')
    expect(sessions.hostSettleCalls).toHaveLength(0)
  })

  it('steers a running turn when track 2 is unavailable', async () => {
    const { item, sessions, engine } = mount({
      item: { kind: 'decision', reply: defaultReply('decision') },
      sessions: { probe: LIVE },
    })
    const result = await engine.reply(hostSettleRequest(item), 'req-1')
    expect(result.outcome).toBe('sent')
    expect(result.note).toBe(REPLY_NOTES.hostSettleDowngraded)
    expect(sessions.calls.map(call => call.op)).toEqual(['steer', 'flush'])
  })

  it('resumes a cold session for a confirmed settle', async () => {
    const { item, sessions, engine } = mount({
      sessions: {
        probe: { ok: false, reason: 'agent-unavailable' },
        resume: LIVE,
        hostSettle: { ok: true },
      },
    })
    const result = await engine.reply(hostSettleRequest(item), 'req-1')
    expect(result.outcome).toBe('applied')
    expect(sessions.resumes).toBe(1)
    expect(sessions.hostSettleCalls).toHaveLength(1)
  })

  it('records instead of resuming a cold session without confirmation', async () => {
    const { item, sessions, engine } = mount({
      sessions: {
        probe: { ok: false, reason: 'agent-unavailable' },
        hostSettle: { ok: true },
      },
    })
    const result = await engine.reply(hostSettleRequest(item, { confirmedWake: false }), 'req-1')
    expect(result.outcome).toBe('recorded')
    expect(sessions.resumes).toBe(0)
    expect(sessions.hostSettleCalls).toHaveLength(0)
  })

  it('fails when a confirmed settle cannot resume the session', async () => {
    const { item, store, engine } = mount({
      sessions: {
        probe: { ok: false, reason: 'agent-unavailable' },
        resume: { ok: false, reason: 'unknown-outcome' },
        hostSettle: { ok: true },
      },
    })
    await expect(engine.reply(hostSettleRequest(item), 'req-1'))
      .rejects.toMatchObject({ code: 'agent-unavailable' })
    expect(store.writes).toHaveLength(0)
  })
})

describe('track 2 refusals are evidenced, never success', () => {
  const cases: ReadonlyArray<{
    readonly name: string
    readonly settle: HostSettleResult
    readonly code: string
    readonly failure: string
  }> = [
    { name: 'not answerable', settle: { ok: false, reason: 'not-answerable' }, code: 'conflict', failure: 'cannot-apply' },
    { name: 'multi-question batch', settle: { ok: false, reason: 'needs-batch' }, code: 'conflict', failure: 'cannot-apply' },
    { name: 'reply already queued', settle: { ok: false, reason: 'reply-queued' }, code: 'conflict', failure: 'was-not-applied' },
    { name: 'bad option', settle: { ok: false, reason: 'bad-answer' }, code: 'bad-request', failure: 'cannot-apply' },
    { name: 'agent unavailable', settle: { ok: false, reason: 'agent-unavailable' }, code: 'agent-unavailable', failure: 'agent-unavailable' },
    { name: 'unknown outcome', settle: { ok: false, reason: 'unknown-outcome' }, code: 'unknown-outcome', failure: 'unknown-outcome' },
  ]

  it.each(cases)('$name → $code with a persisted $failure', async row => {
    const { item, store, engine } = mount({
      sessions: { probe: LIVE, hostSettle: row.settle },
    })
    await expect(engine.reply(hostSettleRequest(item), 'req-1'))
      .rejects.toMatchObject({ code: row.code })

    const current = store.current()
    // The item stays answerable; only the attempt is recorded as failed.
    expect(current.state).toBe('open')
    expect(current.resolution).toBeUndefined()
    const recorded = current.deliveries.at(-1)
    expect(recorded?.state).toBe('failed')
    expect(recorded?.track).toBe('host-settle')
    expect(recorded?.failure?.code).toBe(row.failure)
    expect(recorded?.failure?.message.trim()).not.toBe('')
  })

  it('persists unknown-outcome when the port itself throws', async () => {
    const { item, store, engine } = mount({
      sessions: { probe: LIVE, hostSettle: new Error('service exploded') },
    })
    await expect(engine.reply(hostSettleRequest(item), 'req-1'))
      .rejects.toMatchObject({ code: 'unknown-outcome' })
    expect(store.current().deliveries.at(-1)?.failure?.code).toBe('unknown-outcome')
  })

  it('reports the recorded attempt when the same deliveryId repeats', async () => {
    const { item, store, sessions, engine } = mount({
      sessions: { probe: LIVE, hostSettle: { ok: true } },
    })
    const first = await engine.reply(hostSettleRequest(item), 'req-1')
    const second = await engine.reply(hostSettleRequest(item), 'req-2')
    expect(first.outcome).toBe('applied')
    expect(second.outcome).toBe('applied')
    expect(second.note).toBe(REPLY_NOTES.alreadyRecorded)
    expect(sessions.hostSettleCalls).toHaveLength(1)
    expect(store.writes).toHaveLength(1)
  })
})

describe('capability advertisement', () => {
  it('reports client settle always and host settle only with a working port', () => {
    const without = createReplyEngine({
      store: createFakeStore(questionItem()),
      sessions: createFakeSessions(),
      now: () => NOW,
    })
    expect(without.capabilities?.()).toEqual({ clientSettle: true, hostSettle: false })

    const withPort = createReplyEngine({
      store: createFakeStore(questionItem()),
      sessions: createFakeSessions({ hostSettle: { ok: true } }),
      now: () => NOW,
    })
    expect(withPort.capabilities?.()).toEqual({ clientSettle: true, hostSettle: true })
  })

  it('keeps the item version evidence after a refusal', async () => {
    const { item, store, engine } = mount({
      sessions: { probe: LIVE, hostSettle: { ok: false, reason: 'not-answerable' } },
    })
    const before = store.current().version
    await engine.reply(hostSettleRequest(item), 'req-1').catch(() => undefined)
    expect(store.current().version).toBe(before + 1)
    expect(store.current().deliveries.at(-1)?.at).toBe(NOW)
    expect(store.current().updatedAt).toBeGreaterThanOrEqual(T0)
  })
})
