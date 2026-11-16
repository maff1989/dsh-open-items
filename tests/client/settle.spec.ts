/**
 * The browser's settle controller: track 1 through the shipped pending-interaction
 * carrier, track 2 through the Host, the honest fallback matrix, and the
 * authored-approval split.
 *
 * The carrier is an internal contract of the shipped UI clients, so every case
 * starts from feature detection: a missing carrier, a missing live request, a
 * request that cannot accept a decision, and a refusal from the card itself all
 * produce a typed value the surface can explain — never a click that silently
 * does nothing. An approval's origin decides its track (DESIGN §6.4/§6.8): a
 * mirrored one only ever settles its live card, an authored one is sent to the
 * Session on the message track and is never a retroactive grant.
 */
import { describe, expect, it, vi } from 'vitest'

import { createSettleController, type SettleContext } from '../../src/client/data/settle'
import type { InboxTransport } from '../../src/client/data/transport'
import type { HelloValue, RouteReply } from '../../src/shared/protocol'
import type { ReplyValue } from '../../src/shared/protocol'
import { defaultReply } from '../../src/shared/records'
import type { OpenItemRecord, ReplyPayload } from '../../src/shared/schema'
import { makeItem } from './fixtures'

/** One recorded route call. */
interface ReplyCall {
  readonly endpoint: 'reply'
  readonly payload: unknown
}

/** A transport double: only `reply` is exercised, and it records every call. */
function fakeTransport(answer: (request: unknown) => ReplyValue): {
  readonly calls: ReplyCall[]
  readonly transport: InboxTransport
} {
  const calls: ReplyCall[] = []
  const reply = async (request: unknown): Promise<ReplyValue> => {
    calls.push({ endpoint: 'reply', payload: request })
    return answer(request)
  }
  const unused = async (): Promise<never> => {
    throw new Error('not used')
  }
  const transport = {
    hello: unused,
    list: unused,
    register: unused,
    reply: reply as InboxTransport['reply'],
    delivery: unused,
    dismiss: unused,
    snooze: unused,
    reopen: unused,
  } as unknown as InboxTransport
  return { calls, transport }
}

/** One live pending interaction the fake carrier publishes. */
interface FakeInteraction {
  readonly kind: string
  readonly callId?: string
  readonly answerable?: boolean
  readonly questions?: readonly unknown[]
  readonly answer: (input: unknown) => Promise<void>
}

/** A context whose `uiSession` publishes one interaction for one session. */
function fakeContext(interaction?: FakeInteraction): SettleContext {
  const status = new Map<string, { pendingInteraction?: FakeInteraction }>()
  if (interaction !== undefined) status.set('session-1', { pendingInteraction: interaction })
  return {
    get: (name: string) =>
      name === 'uiSession'
        ? { sessionStatus: { getSnapshot: () => status } }
        : undefined,
  }
}

/** One hello value with the given host capabilities. */
function hello(hostSettle: boolean, clientSettle = true): HelloValue {
  return {
    protocol: 1,
    domainVersion: 1,
    schemaVersion: 3,
    installId: 'install-1',
    capabilities: {
      canSettleClient: clientSettle,
      canHostSettle: hostSettle,
      canDeliver: true,
      canRegister: true,
      hasContextLine: false,
    },
    counts: { needsYou: 1, candidates: 0, awaiting: 0 },
    earlierRecordsPruned: false,
  }
}

/** One reply value the route would return for a recorded settle. */
function appliedValue(item: OpenItemRecord, payload: ReplyPayload): ReplyValue {
  return {
    item: { ...item, state: 'awaiting' },
    delivery: {
      deliveryId: 'd-server',
      at: 2,
      track: 'client-settle',
      payload,
      state: 'settled',
    },
    outcome: 'applied',
  }
}

/** An approval item with a tool-call identity. */
function approvalItem(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    kind: 'approval',
    reply: defaultReply('approval'),
    source: { sessionId: 'session-1', callId: 'call-9' as never, approvalId: 'approval-1' },
    ...overrides,
  })
}

/** An authored approval: raised through the tool, with no live request behind it. */
function authoredApprovalItem(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    kind: 'approval',
    reply: defaultReply('approval'),
    source: { sessionId: 'session-1' },
    dedupeKey: 'authored|approval|session-1|raise-4',
    detectedBy: ['tool'],
    ...overrides,
  })
}

/** A question item with a tool-call identity. */
function questionItem(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    kind: 'question',
    reply: defaultReply('question', ['Yes', 'No']),
    source: { sessionId: 'session-1', callId: 'call-7' as never },
    ...overrides,
  })
}

/** The live approval card the carrier publishes. */
function liveApproval(options: { answerable?: boolean; answer?: (input: unknown) => Promise<void> } = {}): FakeInteraction {
  return {
    kind: 'approval',
    callId: 'call-9',
    answerable: options.answerable ?? true,
    answer: options.answer ?? (async () => undefined),
  }
}

describe('carrier detection', () => {
  it('reports no carrier when the shipped Session status service is absent', () => {
    const { transport } = fakeTransport(r => appliedValue(approvalItem(), { type: 'approval', outcome: 'allow-once' }))
    const controller = createSettleController({ context: { get: () => undefined }, transport, hello: () => hello(true) })
    expect(controller.capabilities()).toEqual({ clientSettle: false, hostSettle: true, message: true })
    expect(controller.canDecideApproval(approvalItem())).toBe(false)
  })

  it('reports the carrier and host settle independently', () => {
    const { transport } = fakeTransport(r => appliedValue(approvalItem(), { type: 'approval', outcome: 'allow-once' }))
    const controller = createSettleController({
      context: fakeContext(liveApproval()),
      transport,
      hello: () => hello(false),
    })
    expect(controller.capabilities()).toEqual({ clientSettle: true, hostSettle: false, message: true })
  })

  it('keeps every open item answerable and no closed item answerable', () => {
    const { transport } = fakeTransport(r => appliedValue(makeItem(), { type: 'text', text: 'x' }))
    const controller = createSettleController({ context: fakeContext(), transport, hello: () => hello(false) })
    expect(controller.canAnswer(makeItem())).toBe(true)
    expect(controller.canAnswer(makeItem({ state: 'awaiting' }))).toBe(false)
    expect(controller.canAnswer(makeItem({ state: 'resolved' }))).toBe(false)
  })
})

describe('track 1: the shipped card', () => {
  it('settles an approval once, then records the decision', async () => {
    const answer = vi.fn(async () => undefined)
    const item = approvalItem()
    const { calls, transport } = fakeTransport(r => {
      const request = r as { payload: ReplyPayload }
      return appliedValue(item, request.payload)
    })
    const controller = createSettleController({
      context: fakeContext(liveApproval({ answer })),
      transport,
      hello: () => hello(false),
      newDeliveryId: () => 'delivery-1',
    })

    expect(controller.canDecideApproval(item)).toBe(true)
    const result = await controller.answer(item, { type: 'approval', outcome: 'allow-once' })

    expect(result.kind).toBe('settled')
    // The card received the exact one-shot vocabulary, not `allow`.
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answer).toHaveBeenCalledWith('allowed-once')
    expect(calls).toHaveLength(1)
    const request = calls[0]?.payload as {
      itemId: string
      expectedVersion: number
      deliveryId: string
      payload: ReplyPayload
      requestedTrack: string
    }
    expect(request).toMatchObject({
      itemId: item.id,
      expectedVersion: item.version,
      deliveryId: 'delivery-1',
      payload: { type: 'approval', outcome: 'allow-once' },
      requestedTrack: 'client-settle',
    })
  })

  it('denies through the card as a rejection', async () => {
    const answer = vi.fn(async () => undefined)
    const item = approvalItem()
    const { transport } = fakeTransport(r => appliedValue(item, (r as { payload: ReplyPayload }).payload))
    const controller = createSettleController({
      context: fakeContext(liveApproval({ answer })),
      transport,
      hello: () => hello(false),
    })
    const result = await controller.answer(item, { type: 'approval', outcome: 'deny' })
    expect(result.kind).toBe('settled')
    expect(answer).toHaveBeenCalledWith('rejected')
  })

  it('refuses an approval the card can no longer decide, and records nothing', async () => {
    const answer = vi.fn(async () => undefined)
    const item = approvalItem()
    const { calls, transport } = fakeTransport(r => appliedValue(item, { type: 'approval', outcome: 'allow-once' }))
    const controller = createSettleController({
      context: fakeContext(liveApproval({ answerable: false, answer })),
      transport,
      hello: () => hello(false),
    })
    expect(controller.canDecideApproval(item)).toBe(false)
    const result = await controller.answer(item, { type: 'approval', outcome: 'allow-once' })
    expect(result).toEqual({ kind: 'unavailable', reason: 'not-answerable' })
    expect(answer).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('never settles an approval without the live card', async () => {
    const item = approvalItem()
    const { calls, transport } = fakeTransport(r => appliedValue(item, { type: 'approval', outcome: 'allow-once' }))
    const controller = createSettleController({ context: fakeContext(), transport, hello: () => hello(true) })
    expect(controller.routeFor(item, { type: 'approval', outcome: 'allow-once' })).toBe('message')
    // The carrier exists (uiSession is mounted) but this session holds no live
    // request, so the honest reason is "no live ask", not "no carrier".
    const result = await controller.answer(item, { type: 'approval', outcome: 'allow-once' })
    expect(result).toEqual({ kind: 'unavailable', reason: 'no-live-ask' })
    expect(calls).toHaveLength(0)
  })

  it('refuses to settle when the Host cannot persist the decision', async () => {
    const answer = vi.fn(async () => undefined)
    const item = approvalItem()
    const { calls, transport } = fakeTransport(r => appliedValue(item, { type: 'approval', outcome: 'allow-once' }))
    const controller = createSettleController({
      context: fakeContext(liveApproval({ answer })),
      transport,
      hello: () => hello(false, false),
    })
    // The card is live but would leave no durable record, so the control stays
    // disabled and the waterfall is never touched.
    expect(controller.canDecideApproval(item)).toBe(false)
    expect(await controller.answer(item, { type: 'approval', outcome: 'allow-once' }))
      .toEqual({ kind: 'unavailable', reason: 'host-cannot-record' })
    expect(answer).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('keeps track 1 disabled until the capability probe answers', async () => {
    const answer = vi.fn(async () => undefined)
    const item = approvalItem()
    const { calls, transport } = fakeTransport(r => appliedValue(item, { type: 'approval', outcome: 'allow-once' }))
    const controller = createSettleController({
      context: fakeContext(liveApproval({ answer })),
      transport,
      hello: () => undefined,
    })
    expect(controller.capabilities().clientSettle).toBe(false)
    expect((await controller.answer(item, { type: 'approval', outcome: 'allow-once' })).kind)
      .toBe('unavailable')
    expect(answer).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('settles a single-question ask with the structured batch', async () => {
    const answer = vi.fn(async () => undefined)
    const item = questionItem()
    const { transport } = fakeTransport(r => appliedValue(item, (r as { payload: ReplyPayload }).payload))
    const controller = createSettleController({
      context: fakeContext({
        kind: 'question',
        callId: 'call-7',
        questions: [{ id: 'q1', question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }],
        answer,
      }),
      transport,
      hello: () => hello(false),
    })
    const result = await controller.answer(item, { type: 'option', option: 'Yes' })
    expect(result.kind).toBe('settled')
    expect(answer).toHaveBeenCalledWith({ answers: [{ id: 'q1', selected: ['Yes'] }] })
  })

  it('refuses a multi-question ask instead of answering one blindly', async () => {
    const answer = vi.fn(async () => undefined)
    const item = questionItem()
    const { calls, transport } = fakeTransport(r => appliedValue(item, (r as { payload: ReplyPayload }).payload))
    const controller = createSettleController({
      context: fakeContext({
        kind: 'question',
        callId: 'call-7',
        questions: [{ id: 'q1' }, { id: 'q2' }],
        answer,
      }),
      transport,
      hello: () => hello(false),
    })
    const result = await controller.answer(item, { type: 'option', option: 'Yes' })
    expect(result).toEqual({ kind: 'unavailable', reason: 'needs-batch' })
    expect(answer).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('does not record a settle the card refused', async () => {
    const item = approvalItem()
    const { calls, transport } = fakeTransport(r => appliedValue(item, { type: 'approval', outcome: 'allow-once' }))
    const controller = createSettleController({
      context: fakeContext(liveApproval({
        answer: async () => {
          throw Object.assign(new Error('the request timed out'), { code: 'ASK_TIMED_OUT' })
        },
      })),
      transport,
      hello: () => hello(false),
    })
    const result = await controller.answer(item, { type: 'approval', outcome: 'allow-once' })
    expect(result.kind).toBe('not-applied')
    expect(calls).toHaveLength(0)
  })

  it('reports an unrecorded settle with the id a retry must reuse', async () => {
    const item = approvalItem()
    const { transport } = fakeTransport(() => {
      throw Object.assign(new Error('the route failed'), { code: 'conflict' })
    })
    const controller = createSettleController({
      context: fakeContext(liveApproval()),
      transport,
      hello: () => hello(false),
      newDeliveryId: () => 'delivery-7',
    })
    const result = await controller.answer(item, { type: 'approval', outcome: 'allow-once' })
    expect(result).toEqual({ kind: 'unrecorded', deliveryId: 'delivery-7', message: 'the route failed' })
  })

  it('does not settle a card for an item whose call does not match', async () => {
    const item = approvalItem({ source: { sessionId: 'session-1', callId: 'call-other' as never } })
    const { calls, transport } = fakeTransport(r => appliedValue(item, { type: 'approval', outcome: 'allow-once' }))
    const controller = createSettleController({
      context: fakeContext(liveApproval()),
      transport,
      hello: () => hello(false),
    })
    expect(controller.routeFor(item, { type: 'approval', outcome: 'allow-once' })).toBe('message')
    expect((await controller.answer(item, { type: 'approval', outcome: 'allow-once' })).kind)
      .toBe('unavailable')
    expect(calls).toHaveLength(0)
  })
})

describe('degrading without a Host record', () => {
  it('falls through a live question card when the Host cannot persist a settle', async () => {
    const answer = vi.fn(async () => undefined)
    const item = questionItem()
    const { calls, transport } = fakeTransport(() => ({
      item,
      delivery: { deliveryId: 'd', at: 2, track: 'session-message', payload: { type: 'option', option: 'Yes' }, state: 'queued' },
      outcome: 'sent',
    }))
    const controller = createSettleController({
      context: fakeContext({
        kind: 'question',
        callId: 'call-7',
        questions: [{ id: 'q1', options: [{ label: 'Yes' }] }],
        answer,
      }),
      transport,
      hello: () => hello(false, false),
    })
    expect(controller.routeFor(item, { type: 'option', option: 'Yes' })).toBe('message')
    const result = await controller.answer(item, { type: 'option', option: 'Yes' })
    expect(result.kind).toBe('sent')
    expect(answer).not.toHaveBeenCalled()
    expect(calls[0]?.payload).toMatchObject({ requestedTrack: 'session-message' })
  })
})

describe('track 2: the Host settles', () => {
  it('asks the Host for a continued question when it advertises the capability', async () => {
    const item = questionItem()
    const { calls, transport } = fakeTransport(r => ({
      item: { ...item, state: 'awaiting' },
      delivery: { deliveryId: 'd', at: 2, track: 'host-settle', payload: { type: 'option', option: 'Yes' }, state: 'settled' },
      outcome: 'applied',
      note: 'Answer applied.',
    }))
    const controller = createSettleController({ context: fakeContext(), transport, hello: () => hello(true) })
    expect(controller.routeFor(item, { type: 'option', option: 'Yes' })).toBe('host-settle')
    const result = await controller.answer(item, { type: 'option', option: 'Yes' })
    expect(result.kind).toBe('host-settled')
    expect(calls[0]?.payload).toMatchObject({
      requestedTrack: 'host-settle',
      confirmedWake: true,
      payload: { type: 'option', option: 'Yes' },
    })
  })

  it('falls back to the delivery matrix when the Host cannot settle', async () => {
    const item = questionItem()
    const { calls, transport } = fakeTransport(r => ({
      item,
      delivery: { deliveryId: 'd', at: 2, track: 'session-message', payload: { type: 'text', text: 'Yes' }, state: 'queued' },
      outcome: 'sent',
    }))
    const controller = createSettleController({ context: fakeContext(), transport, hello: () => hello(false) })
    expect(controller.routeFor(item, { type: 'option', option: 'Yes' })).toBe('message')
    const result = await controller.answer(item, { type: 'option', option: 'Yes' })
    expect(result.kind).toBe('sent')
    expect(calls[0]?.payload).toMatchObject({ requestedTrack: 'session-message' })
  })

  it('surfaces a host refusal as a typed value', async () => {
    const item = questionItem()
    const { transport } = fakeTransport(() => {
      throw Object.assign(new Error('the ask is no longer answerable'), { code: 'conflict' })
    })
    const controller = createSettleController({ context: fakeContext(), transport, hello: () => hello(true) })
    const result = await controller.answer(item, { type: 'option', option: 'Yes' })
    expect(result).toMatchObject({
      kind: 'refused',
      code: 'conflict',
      message: 'the ask is no longer answerable',
    })
    // The attempt keeps the idempotency key a Retry must reuse.
    expect(result).toHaveProperty('deliveryId')
  })
})

describe('route selection', () => {
  it('prefers the live card over every fallback', () => {
    const item = questionItem()
    const { transport } = fakeTransport(r => appliedValue(item, { type: 'text', text: 'x' }))
    const controller = createSettleController({
      context: fakeContext({
        kind: 'question',
        callId: 'call-7',
        questions: [{ id: 'q1', options: [{ label: 'Yes' }] }],
        answer: async () => undefined,
      }),
      transport,
      hello: () => hello(true),
    })
    expect(controller.routeFor(item, { type: 'option', option: 'Yes' })).toBe('client-settle')
  })

  it('routes a text note on an approval item as a message, not a decision', () => {
    const item = approvalItem()
    const { transport } = fakeTransport(r => appliedValue(item, { type: 'text', text: 'retry with a dry run' }))
    const controller = createSettleController({
      context: fakeContext(liveApproval()),
      transport,
      hello: () => hello(false),
    })
    expect(controller.routeFor(item, { type: 'text', text: 'retry with a dry run' })).toBe('message')
  })
})


describe('click plan and wake cost', () => {
  it('settles an approval without a wake confirmation', () => {
    const item = approvalItem()
    const { transport } = fakeTransport(r => appliedValue(item, { type: 'approval', outcome: 'allow-once' }))
    const controller = createSettleController({
      context: fakeContext(liveApproval()),
      transport,
      hello: () => hello(false),
    })
    expect(controller.planFor?.(item, { type: 'approval', outcome: 'allow-once' })).toEqual({
      track: 'client-settle',
      settles: true,
      steers: false,
      requiresWakeConfirmation: false,
    })
  })

  it('warns before a message send while the session is idle', () => {
    const { transport } = fakeTransport(r => appliedValue(questionItem(), { type: 'option', option: 'Yes' }))
    const controller = createSettleController({ context: fakeContext(), transport, hello: () => hello(false) })
    expect(controller.planFor?.(questionItem(), { type: 'option', option: 'Yes' })).toEqual({
      track: 'message',
      settles: false,
      steers: false,
      requiresWakeConfirmation: true,
    })
  })

  it('does not warn when the turn is running, because the answer steers', () => {
    const status = new Map([['session-1', { running: true }]])
    const context: SettleContext = {
      get: name => name === 'uiSession'
        ? { sessionStatus: { getSnapshot: () => status } }
        : undefined,
    }
    const { transport } = fakeTransport(r => appliedValue(questionItem(), { type: 'option', option: 'Yes' }))
    const controller = createSettleController({ context, transport, hello: () => hello(false) })
    expect(controller.planFor?.(questionItem(), { type: 'option', option: 'Yes' })).toEqual({
      track: 'message',
      settles: false,
      steers: true,
      requiresWakeConfirmation: false,
    })
  })

  it('carries the confirmed wake and a reused delivery id on an explicit send', async () => {
    const item = questionItem()
    const { calls, transport } = fakeTransport(() => ({
      item,
      delivery: { deliveryId: 'delivery-9', at: 2, track: 'session-message', payload: { type: 'option', option: 'Yes' }, state: 'queued' },
      outcome: 'sent',
    }))
    const controller = createSettleController({ context: fakeContext(), transport, hello: () => hello(false) })
    const result = await controller.answer(
      item,
      { type: 'option', option: 'Yes' },
      { confirmedWake: true, deliveryId: 'delivery-9' },
    )
    expect(result.kind).toBe('sent')
    expect(result).toHaveProperty('deliveryId', 'delivery-9')
    expect(calls[0]?.payload).toMatchObject({
      requestedTrack: 'session-message',
      confirmedWake: true,
      deliveryId: 'delivery-9',
    })
  })

  it('does not claim a wake for an unconfirmed send', async () => {
    const item = questionItem()
    const { calls, transport } = fakeTransport(() => ({
      item,
      delivery: { deliveryId: 'delivery-3', at: 2, track: 'session-message', payload: { type: 'option', option: 'Yes' }, state: 'settled' },
      outcome: 'recorded',
    }))
    const controller = createSettleController({ context: fakeContext(), transport, hello: () => hello(false) })
    const result = await controller.answer(item, { type: 'option', option: 'Yes' })
    expect(result.kind).toBe('recorded')
    expect(calls[0]?.payload).not.toHaveProperty('confirmedWake')
  })
})

describe('authored approvals: the decision travels as a message', () => {
  it('enables Allow/Deny with no live card at all, while a mirror still needs its card', () => {
    const { transport } = fakeTransport(() => {
      throw new Error('not used')
    })
    const controller = createSettleController({ context: { get: () => undefined }, transport, hello: () => undefined })
    expect(controller.canDecideApproval(authoredApprovalItem())).toBe(true)
    expect(controller.canDecideApproval(approvalItem())).toBe(false)
  })

  it('never routes an authored approval to the live-card track', () => {
    // Even with a reachable carrier and a Host that advertises client settle: an
    // authored sign-off has no request to settle, so claiming track 1 is illegal.
    const { transport } = fakeTransport(() => appliedValue(authoredApprovalItem(), { type: 'approval', outcome: 'allow-once' }))
    const controller = createSettleController({
      context: fakeContext(liveApproval()),
      transport,
      hello: () => hello(false),
    })
    expect(controller.routeFor(authoredApprovalItem(), { type: 'approval', outcome: 'allow-once' })).toBe('message')
  })

  it('warns before sending an authored approval to an idle session', () => {
    const { transport } = fakeTransport(() => appliedValue(authoredApprovalItem(), { type: 'approval', outcome: 'allow-once' }))
    const controller = createSettleController({ context: fakeContext(), transport, hello: () => hello(false) })
    expect(controller.planFor?.(authoredApprovalItem(), { type: 'approval', outcome: 'allow-once' })).toEqual({
      track: 'message',
      settles: false,
      steers: false,
      requiresWakeConfirmation: true,
    })
  })

  it('sends an allow-once decision on the session-message track with the confirmed wake', async () => {
    const item = authoredApprovalItem()
    const { calls, transport } = fakeTransport(r => {
      const request = r as { payload: ReplyPayload }
      return {
        item: { ...item, state: 'awaiting' },
        delivery: { deliveryId: 'd-authored', at: 2, track: 'session-message', payload: request.payload, state: 'queued' },
        outcome: 'sent',
      }
    })
    const controller = createSettleController({
      context: fakeContext(),
      transport,
      hello: () => hello(false),
      newDeliveryId: () => 'delivery-authored',
    })
    const result = await controller.answer(item, { type: 'approval', outcome: 'allow-once' }, { confirmedWake: true })
    expect(result).toMatchObject({ kind: 'sent', deliveryId: 'delivery-authored' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload).toMatchObject({
      itemId: item.id,
      expectedVersion: item.version,
      deliveryId: 'delivery-authored',
      payload: { type: 'approval', outcome: 'allow-once' },
      requestedTrack: 'session-message',
      confirmedWake: true,
    })
  })

  it('sends a denial with its verbatim note on the message track', async () => {
    const item = authoredApprovalItem()
    const { calls, transport } = fakeTransport(r => {
      const request = r as { payload: ReplyPayload }
      return {
        item: { ...item, state: 'awaiting' },
        delivery: { deliveryId: 'd-authored', at: 2, track: 'session-message', payload: request.payload, state: 'queued' },
        outcome: 'sent',
      }
    })
    const controller = createSettleController({ context: fakeContext(), transport, hello: () => hello(false) })
    const result = await controller.answer(
      item,
      { type: 'approval', outcome: 'deny', note: 'run a dry run first' },
      { confirmedWake: true },
    )
    expect(result.kind).toBe('sent')
    expect(calls[0]?.payload).toMatchObject({
      payload: { type: 'approval', outcome: 'deny', note: 'run a dry run first' },
      requestedTrack: 'session-message',
    })
  })

  it('does not claim a wake for an unconfirmed send, and reports the recorded outcome honestly', async () => {
    const item = authoredApprovalItem()
    const { calls, transport } = fakeTransport(() => ({
      item: { ...item, state: 'awaiting' },
      delivery: { deliveryId: 'd', at: 2, track: 'session-message', payload: { type: 'approval', outcome: 'allow-once' }, state: 'queued' },
      outcome: 'recorded',
    }))
    const controller = createSettleController({ context: fakeContext(), transport, hello: () => hello(false) })
    const result = await controller.answer(item, { type: 'approval', outcome: 'allow-once' })
    expect(result.kind).toBe('recorded')
    expect(calls[0]?.payload).not.toHaveProperty('confirmedWake')
  })

  it('surfaces a record-only approval refusal as a typed value a Retry can reuse', async () => {
    const item = authoredApprovalItem()
    const { transport } = fakeTransport(() => {
      throw Object.assign(new Error('an approval decision must be sent, not recorded'), { code: 'bad-request' })
    })
    const controller = createSettleController({
      context: fakeContext(),
      transport,
      hello: () => hello(false),
      newDeliveryId: () => 'delivery-refused',
    })
    const result = await controller.answer(item, { type: 'approval', outcome: 'allow-once' })
    expect(result).toEqual({
      kind: 'refused',
      code: 'bad-request',
      message: 'an approval decision must be sent, not recorded',
      deliveryId: 'delivery-refused',
    })
  })
})
