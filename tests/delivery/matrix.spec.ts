/**
 * The answer matrix (DESIGN §6.2, §6.8) as a table.
 *
 * `planReply` is pure, so every cell — item kind/tier/blocking × session state ×
 * requested track × confirmation — is asserted without a store or a Session.
 */
import { describe, expect, it } from 'vitest'

import {
  outboundMessage,
  planReply,
  REPLY_NOTES,
  type RecordReason,
  type ReplyMessagePayload,
  type SessionProbe,
} from '../../src/host/delivery'
import type { ReplyTrack } from '../../src/host/delivery-contract'
import type { OpenItemRecord } from '../../src/shared/schema'
import { makeItem } from '../fixtures'

const payload: ReplyMessagePayload = { type: 'text', text: 'ship it on Friday' }

const running: SessionProbe = { live: true, running: true, turnOpen: true }
const idle: SessionProbe = { live: true, running: false, turnOpen: false }
const turnOpenOnly: SessionProbe = { live: true, running: false, turnOpen: true }
const cold: SessionProbe = { live: false }

interface ExpectedSend {
  readonly kind: 'send'
  readonly mode: 'steer' | 'followup'
}
interface ExpectedRecord {
  readonly kind: 'record'
  readonly reason: RecordReason
}
interface ExpectedSettle {
  readonly kind: 'client-settle'
}

interface MatrixCase {
  readonly name: string
  readonly item?: Partial<OpenItemRecord>
  readonly session: SessionProbe
  readonly requestedTrack?: ReplyTrack
  readonly confirmedWake?: boolean
  readonly expected: ExpectedSend | ExpectedRecord | ExpectedSettle
}

const blocking = { blocking: true, tier: 'structural' } as const
const advisory = { blocking: false, tier: 'structural' } as const
const candidate = { blocking: false, tier: 'candidate' } as const

const cases: readonly MatrixCase[] = [
  // Blocking, turn still running: steer joins the live turn (no wake, no turn).
  { name: 'blocking + running → steer', item: blocking, session: running, expected: { kind: 'send', mode: 'steer' } },
  {
    name: 'blocking + running + explicit send → steer',
    item: blocking,
    session: running,
    requestedTrack: 'session-message',
    expected: { kind: 'send', mode: 'steer' },
  },
  {
    name: 'blocking + open turn only → steer',
    item: blocking,
    session: turnOpenOnly,
    expected: { kind: 'send', mode: 'steer' },
  },
  // Blocking, turn ended and Session live: record only, never auto-wake.
  { name: 'blocking + idle → record turn-ended', item: blocking, session: idle, expected: { kind: 'record', reason: 'turn-ended' } },
  {
    name: 'blocking + idle + explicit send without confirmation → record idle-unconfirmed',
    item: blocking,
    session: idle,
    requestedTrack: 'session-message',
    expected: { kind: 'record', reason: 'idle-unconfirmed' },
  },
  {
    name: 'blocking + idle + confirmed send → followup',
    item: blocking,
    session: idle,
    requestedTrack: 'session-message',
    confirmedWake: true,
    expected: { kind: 'send', mode: 'followup' },
  },
  // Blocking, cold Session: only a confirmed send may resume it.
  { name: 'blocking + cold → record not-running', item: blocking, session: cold, expected: { kind: 'record', reason: 'not-running' } },
  {
    name: 'blocking + cold + explicit send without confirmation → record idle-unconfirmed',
    item: blocking,
    session: cold,
    requestedTrack: 'session-message',
    expected: { kind: 'record', reason: 'idle-unconfirmed' },
  },
  {
    name: 'blocking + cold + confirmed send → followup',
    item: blocking,
    session: cold,
    requestedTrack: 'session-message',
    confirmedWake: true,
    expected: { kind: 'send', mode: 'followup' },
  },
  // Non-blocking structural item ("decide later"): record; never interrupt.
  { name: 'advisory + running → record advisory', item: advisory, session: running, expected: { kind: 'record', reason: 'advisory' } },
  { name: 'advisory + idle → record advisory', item: advisory, session: idle, expected: { kind: 'record', reason: 'advisory' } },
  { name: 'advisory + cold → record not-running', item: advisory, session: cold, expected: { kind: 'record', reason: 'not-running' } },
  {
    name: 'advisory + running + explicit send → steer',
    item: advisory,
    session: running,
    requestedTrack: 'session-message',
    expected: { kind: 'send', mode: 'steer' },
  },
  {
    name: 'advisory + idle + confirmed send → followup',
    item: advisory,
    session: idle,
    requestedTrack: 'session-message',
    confirmedWake: true,
    expected: { kind: 'send', mode: 'followup' },
  },
  // Candidate prose: the only channel is a message, so a running turn is steered.
  { name: 'candidate + running → steer', item: candidate, session: running, expected: { kind: 'send', mode: 'steer' } },
  {
    name: 'candidate + idle without confirmation → record candidate-unconfirmed',
    item: candidate,
    session: idle,
    expected: { kind: 'record', reason: 'candidate-unconfirmed' },
  },
  {
    name: 'candidate + cold + confirmed send → followup',
    item: candidate,
    session: cold,
    requestedTrack: 'session-message',
    confirmedWake: true,
    expected: { kind: 'send', mode: 'followup' },
  },
  // Track 2 does not exist in this build: degrade and report the channel used.
  {
    name: 'host-settle + running → degrade to steer',
    item: blocking,
    session: running,
    requestedTrack: 'host-settle',
    expected: { kind: 'send', mode: 'steer' },
  },
  {
    name: 'host-settle + idle → record host-settle-unavailable',
    item: blocking,
    session: idle,
    requestedTrack: 'host-settle',
    expected: { kind: 'record', reason: 'host-settle-unavailable' },
  },
  {
    name: 'host-settle + candidate + cold → record host-settle-unavailable',
    item: candidate,
    session: cold,
    requestedTrack: 'host-settle',
    expected: { kind: 'record', reason: 'host-settle-unavailable' },
  },
  // Track 1: the browser settled the live card; the engine records it.
  {
    name: 'client-settle + running → client-settle',
    item: blocking,
    session: running,
    requestedTrack: 'client-settle',
    expected: { kind: 'client-settle' },
  },
  {
    name: 'client-settle + cold → client-settle',
    item: candidate,
    session: cold,
    requestedTrack: 'client-settle',
    expected: { kind: 'client-settle' },
  },
]

describe('planReply matrix', () => {
  it.each(cases)('$name', row => {
    const plan = planReply({
      item: makeItem(row.item ?? {}),
      payload,
      deliveryId: 'delivery-1',
      requestedTrack: row.requestedTrack,
      confirmedWake: row.confirmedWake,
      session: row.session,
    })
    expect(plan.kind).toBe(row.expected.kind)
    if (row.expected.kind === 'send' && plan.kind === 'send') {
      expect(plan.mode).toBe(row.expected.mode)
      expect(plan.message.source).toEqual({
        kind: 'open-items',
        form: 'notice',
        itemId: makeItem(row.item ?? {}).id,
        deliveryId: 'delivery-1',
      })
      expect(plan.note.trim()).not.toBe('')
    }
    if (row.expected.kind === 'record' && plan.kind === 'record') {
      expect(plan.reason).toBe(row.expected.reason)
      expect(plan.note.trim()).not.toBe('')
    }
  })

  it('names the honest copy for each recorded/sent branch', () => {
    const item = makeItem(blocking)
    const recordNote = (session: SessionProbe, track?: ReplyTrack, wake?: boolean): string => {
      const plan = planReply({
        item,
        payload,
        deliveryId: 'delivery-1',
        ...(track === undefined ? {} : { requestedTrack: track }),
        ...(wake === undefined ? {} : { confirmedWake: wake }),
        session,
      })
      if (plan.kind !== 'record') throw new Error(`expected a record plan, got ${plan.kind}`)
      return plan.note
    }
    expect(recordNote(idle)).toBe(REPLY_NOTES.turnEnded)
    expect(recordNote(cold)).toBe(REPLY_NOTES.notRunning)
    expect(recordNote(idle, 'session-message')).toBe(REPLY_NOTES.idleUnconfirmed)
    expect(recordNote(idle, 'host-settle')).toBe(REPLY_NOTES.hostSettle)
    const steer = planReply({
      item,
      payload,
      deliveryId: 'delivery-1',
      session: running,
    })
    expect(steer.kind === 'send' ? steer.note : '').toBe(REPLY_NOTES.sentSteer)
    const followup = planReply({
      item,
      payload,
      deliveryId: 'delivery-1',
      requestedTrack: 'session-message',
      confirmedWake: true,
      session: cold,
    })
    expect(followup.kind === 'send' ? followup.note : '').toBe(REPLY_NOTES.sentFollowup)
    const downgraded = planReply({
      item,
      payload,
      deliveryId: 'delivery-1',
      requestedTrack: 'host-settle',
      session: running,
    })
    expect(downgraded.kind === 'send' ? downgraded.note : '').toBe(REPLY_NOTES.hostSettleDowngraded)
    const advisoryNote = (planReply({
      item: makeItem(advisory),
      payload,
      deliveryId: 'delivery-1',
      session: running,
    }))
    expect(advisoryNote.kind === 'record' ? advisoryNote.note : '').toBe(REPLY_NOTES.advisory)
  })
})

describe('outboundMessage', () => {
  it('carries the user words verbatim behind one attribution line', () => {
    const item = makeItem({ kind: 'decision' })
    const message = outboundMessage(item, { type: 'text', text: '  option B  ' }, 'delivery-9')
    expect(message.text).toBe(
      `Reply from the user via Open Items (item ${item.id}, decision):\n  option B  `,
    )
    expect(message.source).toEqual({
      kind: 'open-items',
      form: 'notice',
      itemId: item.id,
      deliveryId: 'delivery-9',
    })
  })

  it('renders an option payload as its verbatim choice', () => {
    const item = makeItem({ kind: 'question', options: ['red', 'blue'] })
    const message = outboundMessage(item, { type: 'option', option: 'blue' }, 'delivery-2')
    expect(message.text.endsWith('\nblue')).toBe(true)
  })

  it('never puts the item title or body into the message', () => {
    const item = makeItem({ title: 'Deploy target?', body: 'Pick a region.' })
    const message = outboundMessage(item, payload, 'delivery-3')
    expect(message.text).not.toContain(item.title)
    expect(message.text).not.toContain(item.body)
  })
})
