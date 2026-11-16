/**
 * Host session bridge: rc.1 service feature-detection, the non-waking probe,
 * the confirmed wake, the durable message shape and the flush barrier.
 *
 * The fake context is a Map: no Cordis plugin, no live Agent, no filesystem.
 */
import { describe, expect, it } from 'vitest'

import { Context } from '@deepseek-ai/cordis'

import { createSessionBridge, type BridgeContext } from '../../src/host/delivery-bridge'
import type { OutboundMessage } from '../../src/host/delivery-contract'

/** A message built by the engine. */
const message: OutboundMessage = {
  text: 'Reply from the user via Open Items (item item-1, decision):\nFriday',
  source: { kind: 'open-items', form: 'notice', itemId: 'item-1', deliveryId: 'delivery-1' },
}

/** A context whose services are entries in a map the test can change later. */
function fakeContext(services: Record<string, unknown> = {}): BridgeContext & {
  provide(name: string, value: unknown): void
} {
  const entries = new Map(Object.entries(services))
  return {
    get: (name: string) => entries.get(name),
    provide: (name: string, value: unknown) => {
      entries.set(name, value)
    },
  }
}

/** One fake live Agent that records the messages it receives. */
function fakeAgent(options: { running?: boolean } = {}): {
  readonly received: unknown[]
  readonly agent: Record<string, unknown>
} {
  const received: unknown[] = []
  return {
    received,
    agent: {
      status: options.running === true ? 'running' : 'idle',
      session: { id: 'session-1' },
      steer: (input: unknown) => {
        received.push(input)
      },
      followup: (input: unknown) => {
        received.push(input)
      },
    },
  }
}

/** Read one property off an unknown message without an `unknown` cast. */
function field(target: unknown, name: string): unknown {
  if (typeof target !== 'object' || target === null) return undefined
  return (target as Record<string, unknown>)[name]
}

describe('createSessionBridge: context compatibility', () => {
  it('accepts a real Cordis context', () => {
    const context: BridgeContext = new Context()
    expect(typeof createSessionBridge(context).resolveAgent).toBe('function')
  })

  it('reads services lazily so a later mount is picked up', async () => {
    const context = fakeContext()
    const bridge = createSessionBridge(context)
    await expect(bridge.resolveAgent('session-1')).resolves.toEqual({ ok: false, reason: 'agent-unavailable' })
    const { agent } = fakeAgent()
    context.provide('agents', { get: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: null }) })
    const probe = await bridge.resolveAgent('session-1')
    expect(probe.ok).toBe(true)
  })
})

describe('archived', () => {
  it('is false when the profile has no workspace registry', () => {
    const bridge = createSessionBridge(fakeContext())
    expect(bridge.archived('session-1')).toBe(false)
  })

  it('reads the durable archive set', () => {
    const bridge = createSessionBridge(fakeContext({ workspaceRegistry: { archivedSessionIds: ['session-2'] } }))
    expect(bridge.archived('session-2')).toBe(true)
    expect(bridge.archived('session-1')).toBe(false)
  })

  it('is false for a malformed archive set instead of failing the reply', () => {
    const bridge = createSessionBridge(fakeContext({ workspaceRegistry: {} }))
    expect(bridge.archived('session-1')).toBe(false)
  })
})

describe('resolveAgent (non-waking probe)', () => {
  it('reports agent-unavailable for a cold session', async () => {
    const bridge = createSessionBridge(fakeContext({ agents: { get: () => undefined } }))
    await expect(bridge.resolveAgent('session-1')).resolves.toEqual({ ok: false, reason: 'agent-unavailable' })
  })

  it('reports a live idle agent as not running', async () => {
    const { agent } = fakeAgent()
    const bridge = createSessionBridge(fakeContext({ agents: { get: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: null }) } }))
    const probe = await bridge.resolveAgent('session-1')
    expect(probe).toEqual({ ok: true, agent, running: false, turnOpen: false })
  })

  it('reports a running agent and its open turn', async () => {
    const { agent } = fakeAgent({ running: true })
    const bridge = createSessionBridge(fakeContext({ agents: { get: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: 7 }) } }))
    const probe = await bridge.resolveAgent('session-1')
    expect(probe).toEqual({ ok: true, agent, running: true, turnOpen: true })
  })

  it('detects an open turn on an idle-looking agent through turnBoundaryOf', async () => {
    const { agent } = fakeAgent()
    const bridge = createSessionBridge(fakeContext({ agents: { get: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: 7 }) } }))
    const probe = await bridge.resolveAgent('session-1')
    expect(probe).toEqual({ ok: true, agent, running: false, turnOpen: true })
  })

  it('falls back to status when the boundary projection is absent', async () => {
    const { agent } = fakeAgent({ running: true })
    const bridge = createSessionBridge(fakeContext({ agents: { get: () => agent } }))
    const probe = await bridge.resolveAgent('session-1')
    expect(probe).toEqual({ ok: true, agent, running: true, turnOpen: true })
  })

  it('never resumes', async () => {
    let resumes = 0
    const bridge = createSessionBridge(fakeContext({
      agents: { get: () => undefined },
      sessionController: {
        resolveAgent: async () => {
          resumes += 1
          return { agent: {} }
        },
      },
    }))
    await bridge.resolveAgent('session-1')
    expect(resumes).toBe(0)
  })
})

describe('resumeAgent (waking extension)', () => {
  it('reports agent-unavailable without a session controller', async () => {
    const bridge = createSessionBridge(fakeContext({ agents: { get: () => undefined } }))
    await expect(bridge.resumeAgent('session-1')).resolves.toEqual({ ok: false, reason: 'agent-unavailable' })
  })

  it('resumes through the controller and reports the live agent', async () => {
    const { agent } = fakeAgent({ running: false })
    const bridge = createSessionBridge(fakeContext({
      agents: { get: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: null }) },
      sessionController: { resolveAgent: async () => ({ agent }) },
    }))
    const probe = await bridge.resumeAgent('session-1')
    expect(probe).toEqual({ ok: true, agent, running: false, turnOpen: false })
  })

  it('uses the registry entry when the controller returns a stale handle', async () => {
    const live = fakeAgent()
    const stale = { name: 'stale' }
    const bridge = createSessionBridge(fakeContext({
      agents: { get: () => live.agent, turnBoundaryOf: () => ({ openTurnStartSeq: null }) },
      sessionController: { resolveAgent: async () => ({ agent: stale }) },
    }))
    const probe = await bridge.resumeAgent('session-1')
    expect(probe.ok && probe.agent).toBe(live.agent)
  })

  it('maps not-found and subagent ownership to agent-unavailable', async () => {
    for (const code of ['session/not-found', 'session/agent-busy']) {
      const bridge = createSessionBridge(fakeContext({
        agents: { get: () => undefined },
        sessionController: { resolveAgent: async () => ({ error: { code, message: 'no' } }) },
      }))
      await expect(bridge.resumeAgent('session-1')).resolves.toEqual({ ok: false, reason: 'agent-unavailable' })
    }
  })

  it('maps a writer conflict to unknown-outcome', async () => {
    const bridge = createSessionBridge(fakeContext({
      agents: { get: () => undefined },
      sessionController: { resolveAgent: async () => ({ error: { code: 'session/writer-held', message: 'busy' } }) },
    }))
    await expect(bridge.resumeAgent('session-1')).resolves.toEqual({ ok: false, reason: 'unknown-outcome' })
  })

  it('maps a thrown resume to unknown-outcome instead of claiming success', async () => {
    const bridge = createSessionBridge(fakeContext({
      agents: { get: () => undefined },
      sessionController: { resolveAgent: async () => Promise.reject(new Error('boom')) },
    }))
    await expect(bridge.resumeAgent('session-1')).resolves.toEqual({ ok: false, reason: 'unknown-outcome' })
  })
})

describe('message delivery', () => {
  it('steers a durable user message carrying the item source', () => {
    const { received, agent } = fakeAgent({ running: true })
    const bridge = createSessionBridge(fakeContext({ agents: { get: () => agent } }))
    bridge.steer(agent, message)

    const built = received[0]
    expect(field(built, 'role')).toBe('user')
    expect(typeof field(built, 'id')).toBe('string')
    expect(field(built, 'content')).toEqual([{ type: 'text', text: message.text }])
    expect(field(built, 'source')).toEqual({
      kind: 'open-items',
      form: 'notice',
      itemId: 'item-1',
      deliveryId: 'delivery-1',
    })
    expect(Object.isFrozen(built)).toBe(true)
  })

  it('follows up with the same shape', () => {
    const { received, agent } = fakeAgent()
    const bridge = createSessionBridge(fakeContext({ agents: { get: () => agent } }))
    bridge.followup(agent, message)
    expect(received).toHaveLength(1)
    expect(field(received[0], 'role')).toBe('user')
  })

  it('mints a fresh identity per message', () => {
    const { received, agent } = fakeAgent()
    const bridge = createSessionBridge(fakeContext({ agents: { get: () => agent } }))
    bridge.followup(agent, message)
    bridge.followup(agent, message)
    expect(field(received[0], 'id')).not.toBe(field(received[1], 'id'))
  })

  it('uses the injected message factory when the Host supplies one', () => {
    const { received, agent } = fakeAgent()
    const bridge = createSessionBridge(fakeContext({ agents: { get: () => agent } }), {
      createUserMessage: input => ({ ...input, via: 'factory' }),
    })
    bridge.steer(agent, message)
    expect(field(received[0], 'via')).toBe('factory')
  })

  it('throws when the resolved value is not a steerable Agent', () => {
    const bridge = createSessionBridge(fakeContext())
    expect(() => {
      bridge.steer({ not: 'an agent' }, message)
    }).toThrow(/does not accept steering/u)
    expect(() => {
      bridge.followup(undefined, message)
    }).toThrow(/does not accept a follow-up/u)
  })
})

describe('flush', () => {
  it('awaits the session flush barrier with the agent session', async () => {
    const flushed: unknown[] = []
    const { agent } = fakeAgent()
    const bridge = createSessionBridge(fakeContext({
      sessions: {
        flush: async (session: unknown) => {
          flushed.push(session)
          return true
        },
      },
    }))
    await bridge.flush(agent)
    expect(flushed).toEqual([{ id: 'session-1' }])
  })

  it('resolves without a flush service', async () => {
    const { agent } = fakeAgent()
    const bridge = createSessionBridge(fakeContext())
    await expect(bridge.flush(agent)).resolves.toBeUndefined()
  })

  it('propagates a durability barrier failure to the engine', async () => {
    const { agent } = fakeAgent()
    const bridge = createSessionBridge(fakeContext({
      sessions: { flush: async () => Promise.reject(new Error('flush failed')) },
    }))
    await expect(bridge.flush(agent)).rejects.toThrow(/flush failed/u)
  })
})
