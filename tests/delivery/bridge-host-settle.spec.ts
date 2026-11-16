/**
 * The rc.1 `userQuestions.answer` seam behind the engine's hostSettle port:
 * feature-detection, the projection read that names every question, the answer
 * batch, and every refusal code the engine maps to an honest outcome.
 */
import { describe, expect, it, vi } from 'vitest'

import { createSessionBridge, type BridgeContext } from '../../src/host/delivery-bridge'
import type { HostSettleRequest } from '../../src/host/delivery-contract'

/** One fake live Agent with a Session the projection reader can key on. */
const agent = { session: { id: 'session-1' }, status: 'idle' }

/** The projection view of one continued ask with a single question. */
const CONTINUED = {
  active: [{
    callId: 'call-7',
    state: 'continued',
    questions: [{
      id: 'q1',
      question: 'Ship it?',
      options: [{ label: 'Yes' }, { label: 'No' }],
    }],
  }],
  settled: [],
}

/** A context over a mutable service map. */
function fakeContext(services: Record<string, unknown>): BridgeContext & { provide(name: string, value: unknown): void } {
  const entries = new Map(Object.entries(services))
  return {
    get: (name: string) => entries.get(name),
    provide: (name: string, value: unknown) => {
      entries.set(name, value)
    },
  }
}

/** The answerer fake and its recorded calls. */
function fakeAnswerer(options: { accepted?: boolean; throws?: unknown } = {}): {
  readonly calls: unknown[][]
  readonly service: { answer: (...args: unknown[]) => boolean }
} {
  const calls: unknown[][] = []
  return {
    calls,
    service: {
      answer: (...args: unknown[]) => {
        calls.push(args)
        if (options.throws !== undefined) throw options.throws
        return options.accepted ?? true
      },
    },
  }
}

/** The projection fake returning one `userQuestions` view. */
function fakeProjections(view: unknown): {
  readonly calls: unknown[][]
  readonly service: { snapshot: (...args: unknown[]) => unknown }
} {
  const calls: unknown[][] = []
  return {
    calls,
    service: {
      snapshot: (...args: unknown[]) => {
        calls.push(args)
        return { asOfSeq: 1, values: { userQuestions: view } }
      },
    },
  }
}

/** One host-settle request. */
const request: HostSettleRequest = {
  sessionId: 'session-1',
  callId: 'call-7',
  payload: { type: 'option', option: 'Yes' },
}

/** One thrown service error with a taxonomy code. */
function serviceError(code: string): Error {
  const error = new Error(`user questions: ${code}`)
  Object.assign(error, { code })
  return error
}

describe('capability detection', () => {
  it('is false without the answerer and the projection reader', () => {
    expect(createSessionBridge(fakeContext({})).capabilities()).toEqual({ clientSettle: true, hostSettle: false })
    expect(createSessionBridge(fakeContext({
      userQuestions: { answer: () => true },
    })).capabilities()).toEqual({ clientSettle: true, hostSettle: false })
    expect(createSessionBridge(fakeContext({
      sessionProjections: { snapshot: () => ({}) },
    })).capabilities()).toEqual({ clientSettle: true, hostSettle: false })
  })

  it('is true with both, and read lazily so a later mount is visible', () => {
    const context = fakeContext({})
    const bridge = createSessionBridge(context)
    expect(bridge.capabilities()).toEqual({ clientSettle: true, hostSettle: false })
    context.provide('userQuestions', fakeAnswerer().service)
    context.provide('sessionProjections', fakeProjections(CONTINUED).service)
    expect(bridge.capabilities()).toEqual({ clientSettle: true, hostSettle: true })
  })
})

describe('hostSettle', () => {
  it('answers a continued single-question ask with the chosen option', async () => {
    const answerer = fakeAnswerer()
    const projections = fakeProjections(CONTINUED)
    const bridge = createSessionBridge(fakeContext({
      userQuestions: answerer.service,
      sessionProjections: projections.service,
    }))
    const result = await bridge.hostSettle(agent, request)
    expect(result).toEqual({ ok: true })
    expect(projections.calls).toEqual([[agent.session, ['userQuestions']]])
    expect(answerer.calls).toEqual([[
      agent,
      'call-7',
      { answers: [{ id: 'q1', selected: ['Yes'] }] },
    ]])
  })

  it('sends free text as the custom answer', async () => {
    const answerer = fakeAnswerer()
    const bridge = createSessionBridge(fakeContext({
      userQuestions: answerer.service,
      sessionProjections: fakeProjections(CONTINUED).service,
    }))
    await bridge.hostSettle(agent, { ...request, payload: { type: 'text', text: 'only if green' } })
    expect(answerer.calls[0]?.[2]).toEqual({
      answers: [{ id: 'q1', selected: [], custom: 'only if green' }],
    })
  })

  it('refuses an open ask: the live card owns the waterfall', async () => {
    const answerer = fakeAnswerer()
    const bridge = createSessionBridge(fakeContext({
      userQuestions: answerer.service,
      sessionProjections: fakeProjections({
        active: [{ ...CONTINUED.active[0], state: 'open' }],
      }).service,
    }))
    await expect(bridge.hostSettle(agent, request)).resolves.toEqual({ ok: false, reason: 'not-answerable' })
    expect(answerer.calls).toHaveLength(0)
  })

  it('refuses a call id the projection does not list', async () => {
    const answerer = fakeAnswerer()
    const bridge = createSessionBridge(fakeContext({
      userQuestions: answerer.service,
      sessionProjections: fakeProjections(CONTINUED).service,
    }))
    await expect(bridge.hostSettle(agent, { ...request, callId: 'call-other' }))
      .resolves.toEqual({ ok: false, reason: 'not-answerable' })
    expect(answerer.calls).toHaveLength(0)
  })

  it('refuses a multi-question ask instead of guessing answers', async () => {
    const answerer = fakeAnswerer()
    const bridge = createSessionBridge(fakeContext({
      userQuestions: answerer.service,
      sessionProjections: fakeProjections({
        active: [{
          ...CONTINUED.active[0],
          questions: [CONTINUED.active[0]?.questions?.[0], { id: 'q2', question: 'When?' }],
        }],
      }).service,
    }))
    await expect(bridge.hostSettle(agent, request)).resolves.toEqual({ ok: false, reason: 'needs-batch' })
    expect(answerer.calls).toHaveLength(0)
  })

  it('refuses an option the ask never offered', async () => {
    const answerer = fakeAnswerer()
    const bridge = createSessionBridge(fakeContext({
      userQuestions: answerer.service,
      sessionProjections: fakeProjections(CONTINUED).service,
    }))
    await expect(bridge.hostSettle(agent, { ...request, payload: { type: 'option', option: 'Maybe' } }))
      .resolves.toEqual({ ok: false, reason: 'bad-answer' })
    expect(answerer.calls).toHaveLength(0)
  })

  it('reports not-answerable when the service says the ask moved', async () => {
    const bridge = createSessionBridge(fakeContext({
      userQuestions: fakeAnswerer({ accepted: false }).service,
      sessionProjections: fakeProjections(CONTINUED).service,
    }))
    await expect(bridge.hostSettle(agent, request)).resolves.toEqual({ ok: false, reason: 'not-answerable' })
  })

  it('maps the service error taxonomy', async () => {
    const cases: ReadonlyArray<[string, string]> = [
      ['REPLY_QUEUED', 'reply-queued'],
      ['BAD_ANSWER', 'bad-answer'],
      ['SOMETHING_ELSE', 'unknown-outcome'],
    ]
    for (const [code, reason] of cases) {
      const bridge = createSessionBridge(fakeContext({
        userQuestions: fakeAnswerer({ throws: serviceError(code) }).service,
        sessionProjections: fakeProjections(CONTINUED).service,
      }))
      await expect(bridge.hostSettle(agent, request)).resolves.toEqual({ ok: false, reason })
    }
  })

  it('reports unknown-outcome for a throw without a code', async () => {
    const bridge = createSessionBridge(fakeContext({
      userQuestions: fakeAnswerer({ throws: new Error('boom') }).service,
      sessionProjections: fakeProjections(CONTINUED).service,
    }))
    await expect(bridge.hostSettle(agent, request)).resolves.toEqual({ ok: false, reason: 'unknown-outcome' })
  })

  it('refuses when the projection is unavailable or the agent has no session', async () => {
    const answerer = fakeAnswerer()
    const withoutProjection = createSessionBridge(fakeContext({ userQuestions: answerer.service }))
    await expect(withoutProjection.hostSettle(agent, request))
      .resolves.toEqual({ ok: false, reason: 'not-answerable' })
    const withProjection = createSessionBridge(fakeContext({
      userQuestions: answerer.service,
      sessionProjections: fakeProjections(CONTINUED).service,
    }))
    await expect(withProjection.hostSettle({ name: 'not-an-agent' }, request))
      .resolves.toEqual({ ok: false, reason: 'not-answerable' })
    await expect(withProjection.hostSettle(undefined, request))
      .resolves.toEqual({ ok: false, reason: 'not-answerable' })
    expect(answerer.calls).toHaveLength(0)
  })

  it('never calls the answerer with a malformed payload', async () => {
    const answerer = fakeAnswerer()
    const bridge = createSessionBridge(fakeContext({
      userQuestions: answerer.service,
      sessionProjections: fakeProjections(CONTINUED).service,
    }))
    await expect(bridge.hostSettle(agent, { ...request, payload: { type: 'dismiss' } }))
      .resolves.toEqual({ ok: false, reason: 'bad-answer' })
    expect(answerer.calls).toHaveLength(0)
  })
})

describe('interaction with the engine-facing contract', () => {
  it('exposes the same capabilities object the route advertises', () => {
    const bridge = createSessionBridge(fakeContext({
      userQuestions: fakeAnswerer().service,
      sessionProjections: fakeProjections(CONTINUED).service,
    }))
    expect(bridge.capabilities()).toEqual({ clientSettle: true, hostSettle: true })
    expect(typeof bridge.hostSettle).toBe('function')
  })

  it('does not read the projection until a settle is attempted', async () => {
    const snapshot = vi.fn(() => ({ values: { userQuestions: CONTINUED } }))
    const bridge = createSessionBridge(fakeContext({
      userQuestions: fakeAnswerer().service,
      sessionProjections: { snapshot },
    }))
    bridge.capabilities()
    expect(snapshot).not.toHaveBeenCalled()
    await bridge.hostSettle(agent, request)
    expect(snapshot).toHaveBeenCalledTimes(1)
  })
})
