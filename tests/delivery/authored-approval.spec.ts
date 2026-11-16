/**
 * Authored approval delivery: the track-3 fallback for an approval that has no
 * live harness request (DESIGN §6.4, §6.8; OI-08).
 *
 * A mirrored approval is settled through the browser's live card on track 1 —
 * `approval-parity.spec.ts` holds that contract. An approval raised by
 * `open_items` has no card at all, so its decision travels as an ordinary
 * session message ("approve and retry"), never as a retroactive grant, and the
 * engine must never record one without delivering it.
 *
 * @module tests/delivery/authored-approval
 */
import { describe, expect, it } from 'vitest'

import { createReplyEngine, outboundMessage, REPLY_NOTES } from '../../src/host/delivery'
import type { ReplyRequest } from '../../src/shared/protocol'
import { authoredDedupeKey, defaultReply } from '../../src/shared/records'
import type { OpenItemRecord } from '../../src/shared/schema'
import { makeItem } from '../fixtures'
import { createFakeSessions, createFakeStore, type FakeSessionsOptions, type ResolveResult } from './fakes'

const NOW = 5_000
const TITLE = 'Deploy the release?'

/** A session whose turn is still running (track-3 steer). */
const RUNNING: ResolveResult = { ok: true, agent: { name: 'agent-7' }, running: true, turnOpen: true }
/** A live session between turns (track-3 followup). */
const IDLE: ResolveResult = { ok: true, agent: { name: 'agent-7' }, running: false, turnOpen: false }
/** A cold session (only a confirmed send may resume it). */
const COLD: ResolveResult = { ok: false, reason: 'agent-unavailable' }

/**
 * An approval authored by the `open_items` tool: tool-detected, authored dedupe
 * key, and no `approvalId` because no shipped request exists.
 * @param overrides - fields to replace.
 * @returns a valid authored approval record.
 */
function authoredApproval(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    kind: 'approval',
    blocking: true,
    title: TITLE,
    body: 'Sign-off is waiting on the user.',
    reply: defaultReply('approval'),
    source: { sessionId: 'session-1', callId: 'call-9' },
    dedupeKey: authoredDedupeKey({ kind: 'approval', sessionId: 'session-1', title: TITLE }),
    detectedBy: ['tool'],
    ...overrides,
  })
}

/**
 * The capture fold's mirror of a shipped approval request.
 * @returns a valid mirrored approval record.
 */
function mirroredApproval(): OpenItemRecord {
  return makeItem({
    kind: 'approval',
    blocking: true,
    source: { sessionId: 'session-1', callId: 'call-1', approvalId: 'approval-1' },
    dedupeKey: 'derived|approval|session-1|approval:call-1',
    detectedBy: ['projection'],
    reply: { controls: ['approve', 'deny'], freeText: false, requiresConfirm: true },
  })
}

/** Mount the engine over one item and one fake bridge. */
function mount(options: {
  readonly item?: Partial<OpenItemRecord>
  readonly fixture?: OpenItemRecord
  readonly sessions?: FakeSessionsOptions
} = {}): {
  item: OpenItemRecord
  store: ReturnType<typeof createFakeStore>
  sessions: ReturnType<typeof createFakeSessions>
  engine: ReturnType<typeof createReplyEngine>
} {
  const item = options.fixture ?? authoredApproval(options.item ?? {})
  const store = createFakeStore(item)
  const sessions = createFakeSessions(options.sessions ?? {})
  const engine = createReplyEngine({ store, sessions, now: () => NOW })
  return { item, store, sessions, engine }
}

/** The wire request for one decision on the session-message track. */
function decisionRequest(item: OpenItemRecord, patch: Partial<ReplyRequest> = {}): ReplyRequest {
  return {
    itemId: item.id,
    expectedVersion: item.version,
    deliveryId: 'delivery-1',
    payload: { type: 'approval', outcome: 'allow-once' },
    requestedTrack: 'session-message',
    confirmedWake: true,
    ...patch,
  }
}

describe('the decision is delivered as a session message', () => {
  it('steers an allow-once decision into a running turn and records queued evidence', async () => {
    const { item, store, sessions, engine } = mount({ sessions: { probe: RUNNING } })
    const result = await engine.reply(decisionRequest(item), 'req-1')

    expect(result.outcome).toBe('sent')
    expect(result.note).toBe(REPLY_NOTES.sentSteer)
    expect(result.delivery.track).toBe('session-message')
    expect(result.delivery.state).toBe('queued')
    expect(result.delivery.payload).toEqual({ type: 'approval', outcome: 'allow-once' })
    // A message is not a settle: no resolution, and the item waits for evidence.
    expect(result.item.state).toBe('awaiting')
    expect(result.item.resolution).toBeUndefined()
    expect(result.item.acknowledgement?.state).toBe('pending')

    expect(sessions.calls.map(call => call.op)).toEqual(['steer', 'flush'])
    const [steer] = sessions.calls
    expect(steer?.message?.text).toBe(
      `Reply from the user via Open Items (item ${item.id}, approval):\nApproved (one-off).`,
    )
    expect(steer?.message?.source).toEqual({
      kind: 'open-items',
      form: 'notice',
      itemId: item.id,
      deliveryId: 'delivery-1',
    })
    expect(store.writes).toHaveLength(1)
    expect(store.writes[0]?.resolution).toBeUndefined()
  })

  it('sends a deny with the note verbatim after the decision sentence', async () => {
    const { item, sessions, engine } = mount({ sessions: { probe: RUNNING } })
    const payload = { type: 'approval', outcome: 'deny', note: 'staging is still down' } as const
    const result = await engine.reply(decisionRequest(item, { payload }), 'req-1')

    expect(result.outcome).toBe('sent')
    expect(result.delivery.payload).toEqual(payload)
    expect(result.item.resolution).toBeUndefined()
    expect(sessions.calls[0]?.message?.text).toBe(
      `Reply from the user via Open Items (item ${item.id}, approval):\nDenied.\nNote: staging is still down`,
    )
  })

  it('follows up a live idle session only after the confirmed wake', async () => {
    const { item, sessions, engine } = mount({ sessions: { probe: IDLE } })
    const result = await engine.reply(decisionRequest(item), 'req-1')

    expect(result.outcome).toBe('sent')
    expect(result.note).toBe(REPLY_NOTES.sentFollowup)
    expect(sessions.resumes).toBe(0)
    expect(sessions.calls.map(call => call.op)).toEqual(['followup', 'flush'])
  })

  it('resumes a cold session for the confirmed send', async () => {
    const { item, sessions, engine } = mount({ sessions: { probe: COLD } })
    const result = await engine.reply(decisionRequest(item), 'req-1')

    expect(result.outcome).toBe('sent')
    expect(result.note).toBe(REPLY_NOTES.sentFollowup)
    expect(sessions.resumes).toBe(1)
    expect(sessions.calls.map(call => call.op)).toEqual(['followup', 'flush'])
    expect(result.delivery.state).toBe('queued')
    expect(result.item.state).toBe('awaiting')
  })

  it('is idempotent for the same deliveryId', async () => {
    const { item, store, sessions, engine } = mount({ sessions: { probe: RUNNING } })
    const first = await engine.reply(decisionRequest(item), 'req-1')
    const second = await engine.reply(decisionRequest(item), 'req-2')

    expect(first.outcome).toBe('sent')
    expect(second.outcome).toBe('sent')
    expect(second.note).toBe(REPLY_NOTES.alreadyRecorded)
    expect(second.delivery.deliveryId).toBe('delivery-1')
    expect(sessions.calls.map(call => call.op)).toEqual(['steer', 'flush'])
    expect(store.writes).toHaveLength(1)
  })
})

describe('a decision is never recorded without being delivered', () => {
  it('refuses an unconfirmed send instead of recording it', async () => {
    const { item, store, sessions, engine } = mount({ sessions: { probe: IDLE } })
    const request = decisionRequest(item, { confirmedWake: undefined })

    await expect(engine.reply(request, 'req-1')).rejects.toMatchObject({
      code: 'bad-request',
      message: expect.stringContaining('Send and resume now'),
    })
    expect(store.writes).toHaveLength(0)
    expect(store.current().state).toBe('open')
    expect(store.current().deliveries).toEqual([])
    expect(sessions.calls).toHaveLength(0)
  })
})

describe('the item origin decides which track may carry the decision', () => {
  it('refuses an authored approval on the client-settle track', async () => {
    const { item, store, sessions, engine } = mount({ sessions: { probe: RUNNING } })
    await expect(engine.reply(decisionRequest(item, { requestedTrack: 'client-settle' }), 'req-1'))
      .rejects.toMatchObject({ code: 'bad-request', message: expect.stringContaining('session-message') })
    expect(store.writes).toHaveLength(0)
    // The track refusal happens before any session work.
    expect(sessions.archiveChecks).toBe(0)
    expect(sessions.calls).toHaveLength(0)
  })

  it('keeps refusing a mirrored approval on the session-message track', async () => {
    const { item, store, sessions, engine } = mount({ fixture: mirroredApproval() })
    await expect(engine.reply(decisionRequest(item), 'req-1'))
      .rejects.toMatchObject({ code: 'bad-request', message: expect.stringContaining('live approval card') })
    expect(store.writes).toHaveLength(0)
    expect(sessions.calls).toHaveLength(0)
  })

  const refusedTracks: ReadonlyArray<[string, ReplyRequest['requestedTrack']]> = [
    ['host-settle', 'host-settle'],
    ['unspecified', undefined],
  ]

  it.each(refusedTracks)('refuses an authored approval on the %s track', async (_name, track) => {
    const { item, store, sessions, engine } = mount({ sessions: { probe: RUNNING } })
    const request = decisionRequest(item, {
      ...(track === undefined ? { requestedTrack: undefined } : { requestedTrack: track }),
    })
    await expect(engine.reply(request, 'req-1')).rejects.toMatchObject({ code: 'bad-request' })
    expect(store.writes).toHaveLength(0)
    expect(sessions.calls).toHaveLength(0)
  })

  it('still settles a mirrored approval as one recorded card decision', async () => {
    const { item, store, sessions, engine } = mount({ fixture: mirroredApproval() })
    const result = await engine.reply(decisionRequest(item, { requestedTrack: 'client-settle' }), 'req-1')

    expect(result.outcome).toBe('applied')
    expect(result.delivery.track).toBe('client-settle')
    expect(result.delivery.state).toBe('settled')
    expect(result.item.resolution).toMatchObject({
      payload: { type: 'approval', outcome: 'allow-once' },
    })
    expect(sessions.calls).toHaveLength(0)
    expect(store.writes).toHaveLength(1)
  })
})

describe('outbound message phrasing', () => {
  it('states the decision, appends the note verbatim and never interpolates the title', () => {
    const item = authoredApproval()
    const label = `Reply from the user via Open Items (item ${item.id}, approval):`

    expect(outboundMessage(item, { type: 'approval', outcome: 'allow-once' }, 'delivery-1').text)
      .toBe(`${label}\nApproved (one-off).`)
    expect(outboundMessage(item, { type: 'approval', outcome: 'deny' }, 'delivery-1').text)
      .toBe(`${label}\nDenied.`)
    expect(outboundMessage(
      item,
      { type: 'approval', outcome: 'deny', note: 'staging is still down' },
      'delivery-1',
    ).text).toBe(`${label}\nDenied.\nNote: staging is still down`)

    const message = outboundMessage(item, { type: 'approval', outcome: 'allow-once' }, 'delivery-1')
    expect(message.text).not.toContain(item.title)
    expect(message.text).not.toContain(item.body)
    expect(message.source).toEqual({
      kind: 'open-items',
      form: 'notice',
      itemId: item.id,
      deliveryId: 'delivery-1',
    })
  })

  it('keeps the option and text bodies byte-identical', () => {
    const item = authoredApproval()
    expect(outboundMessage(item, { type: 'option', option: '  blue  ' }, 'delivery-2').text)
      .toBe(`Reply from the user via Open Items (item ${item.id}, approval):\n  blue  `)
    expect(outboundMessage(item, { type: 'text', text: '  ship it  ' }, 'delivery-3').text)
      .toBe(`Reply from the user via Open Items (item ${item.id}, approval):\n  ship it  `)
  })
})
