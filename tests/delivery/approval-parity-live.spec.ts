/**
 * Live approval/question parity and the track-1 re-read (REVIEW-rc1 P0-04a,
 * P1 track-1 re-read; DESIGN §6.2 track 1).
 *
 * The reply engine must not claim `applied` for a card the browser settled after
 * the ask stopped being live. The bridge re-reads the ask through the shipped
 * projections and the observe-only live-ask carrier; positive `not-live`
 * evidence records a `was-not-applied` delivery and refuses, `live`/`unknown`
 * proceed exactly as before (no behaviour change for authored items).
 *
 * @module tests/delivery/approval-parity-live
 */

import { describe, expect, it } from 'vitest'

import { createCaptureDriver } from '../../src/host/capture'
import { createSessionBridge, type BridgeContext } from '../../src/host/delivery-bridge'
import type { LiveAskCarrier, LiveAskObservation, SessionBridge } from '../../src/host/delivery-contract'
import { createReplyEngine, REPLY_NOTES } from '../../src/host/delivery'
import type { ReplyRequest } from '../../src/shared/protocol'
import type { OpenItemRecord } from '../../src/shared/schema'
import { makeItem } from '../fixtures'
import { createFakeSessions, createFakeStore } from './fakes'

/** One live Agent identity the fake registry returns. */
const AGENT = { session: { id: 'session-1' }, status: 'idle' as const }

/** A derived approval record (the capture fold's row). */
function derivedApproval(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    id: '018f0a3e-7b1c-7c2d-8a9b-0c1d2e3f4a5c',
    kind: 'approval',
    severity: 1,
    dedupeKey: 'derived|approval|session-1|approval:call-1',
    source: { sessionId: 'session-1', callId: 'call-1', approvalId: 'approval-1' },
    detectedBy: ['projection'],
    reply: { controls: ['approve', 'deny'], freeText: false, requiresConfirm: true },
    ...overrides,
  })
}

/** A derived question record. */
function derivedQuestion(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    id: '018f0a3e-7b1c-7c2d-8a9b-0c1d2e3f4a5d',
    kind: 'question',
    severity: 1,
    dedupeKey: 'derived|question|session-1|question:call-9',
    source: { sessionId: 'session-1', callId: 'call-9' },
    detectedBy: ['projection'],
    reply: { controls: ['option', 'text'], options: ['Yes', 'No'], freeText: true, requiresConfirm: true },
    ...overrides,
  })
}

/** A live-ask carrier over a fixed observation map. */
function fakeCarrier(observations: readonly LiveAskObservation[] = []): LiveAskCarrier {
  const map = new Map(observations.map(entry => [`${entry.sessionId}\u0000${entry.callId}`, entry]))
  return {
    get: (sessionId, callId) => map.get(`${sessionId}\u0000${callId}`),
    get observed() {
      return map.size
    },
  }
}

/**
 * Build the Host bridge over fake services.
 * @param options - agent presence, projection values and carrier.
 * @returns the bridge.
 */
function bridge(options: {
  readonly agent?: boolean
  readonly activeQuestions?: readonly unknown[]
  readonly ledgerItems?: Readonly<Record<string, unknown>>
  readonly carrier?: LiveAskCarrier
} = {}): ReturnType<typeof createSessionBridge> {
  const agents = new Map<string, unknown>(options.agent === false ? [] : [['session-1', AGENT]])
  const ledger = { items: options.ledgerItems ?? {}, inheritedEventCount: 0, lastSeq: -1 }
  const services: Record<string, unknown> = {
    agents: { get: (id: string) => agents.get(id) },
    sessionProjections: {
      snapshot: (_session: unknown, keys: readonly string[]) => ({
        values: {
          ...keys.includes('userQuestions') ? { userQuestions: { active: options.activeQuestions ?? [], settled: [] } } : {},
          ...keys.includes('openItems') ? { openItems: ledger } : {},
        },
      }),
    },
    ...options.carrier === undefined ? {} : { [('openItemsLiveAsks')]: options.carrier },
  }
  return createSessionBridge({ get: (name: string) => services[name] } as BridgeContext)
}

/** A track-1 reply request for one item. */
function clientSettle(item: OpenItemRecord, payload: ReplyRequest['payload'] = {
  type: 'approval',
  outcome: 'allow-once',
}): ReplyRequest {
  return {
    itemId: item.id,
    expectedVersion: item.version,
    deliveryId: 'delivery-track-1',
    payload,
    requestedTrack: 'client-settle',
  }
}

describe('bridge askLiveness', () => {
  it('reports live for a derived approval the carrier saw as pending', async () => {
    const sessions = bridge({
      carrier: fakeCarrier([{
        kind: 'approval',
        sessionId: 'session-1',
        callId: 'call-1',
        toolName: 'bash',
        observedAt: 1,
        state: 'pending',
      }]),
    })
    expect(await sessions.askLiveness?.(derivedApproval())).toBe('live')
  })

  it('reports not-live for a cancelled or unavailable ask and no live Agent', async () => {
    const cancelled = bridge({
      carrier: fakeCarrier([{
        kind: 'approval',
        sessionId: 'session-1',
        callId: 'call-1',
        observedAt: 1,
        state: 'settled',
        outcome: 'cancelled',
      }]),
    })
    expect(await cancelled.askLiveness?.(derivedApproval())).toBe('not-live')
    const cold = bridge({ agent: false })
    expect(await cold.askLiveness?.(derivedApproval())).toBe('not-live')
  })

  it('does not treat a user decision as evidence against a track-1 settle', async () => {
    const sessions = bridge({
      carrier: fakeCarrier([{
        kind: 'approval',
        sessionId: 'session-1',
        callId: 'call-1',
        observedAt: 1,
        state: 'settled',
        outcome: 'allowed-once',
      }]),
    })
    expect(await sessions.askLiveness?.(derivedApproval())).toBe('unknown')
  })

  it('uses the shipped userQuestions projection for a continued timed question', async () => {
    const continued = bridge({ activeQuestions: [{ callId: 'call-9', state: 'continued', questions: [] }] })
    expect(await continued.askLiveness?.(derivedQuestion())).toBe('not-live')
    const open = bridge({ activeQuestions: [{ callId: 'call-9', state: 'open', questions: [] }] })
    expect(await open.askLiveness?.(derivedQuestion())).toBe('live')
  })

  it('reports live from the capture ledger when the carrier never saw the ask', async () => {
    const sessions = bridge({ ledgerItems: { 'approval:call-1': { artifactId: 'approval:call-1' } } })
    expect(await sessions.askLiveness?.(derivedApproval())).toBe('live')
  })

  it('is unknown for an authored item (no live ask behind it)', async () => {
    const sessions = bridge()
    const authored = makeItem({ kind: 'decision', dedupeKey: 'authored|decision|session-1|Ship?' })
    expect(await sessions.askLiveness?.(authored)).toBe('unknown')
  })
})

describe('track-1 guard in the engine', () => {
  /** Extend the fake bridge with one fixed liveness answer. */
  function sessionsWith(liveness: 'live' | 'not-live' | 'unknown' | undefined): SessionBridge & {
    readonly calls: readonly unknown[]
  } {
    const sessions = createFakeSessions({ probe: { ok: true, agent: AGENT, running: false, turnOpen: false } })
    if (liveness !== undefined) {
      sessions.askLiveness = async () => liveness
    }
    return sessions
  }

  /** Mount the engine over one derived item. */
  function mount(item: OpenItemRecord, liveness: 'live' | 'not-live' | 'unknown' | undefined): {
    store: ReturnType<typeof createFakeStore>
    engine: ReturnType<typeof createReplyEngine>
  } {
    const store = createFakeStore(item)
    const engine = createReplyEngine({
      store,
      sessions: sessionsWith(liveness),
      now: () => 5_000,
    })
    return { store, engine }
  }

  it('refuses with a recorded was-not-applied delivery when the ask is no longer live', async () => {
    const item = derivedApproval()
    const { store, engine } = mount(item, 'not-live')
    await expect(engine.reply(clientSettle(item), 'request-1')).rejects.toMatchObject({
      name: 'ReplyEngineError',
      code: 'conflict',
    })
    const record = store.current()
    expect(record.state).toBe('open')
    expect(record.deliveries).toHaveLength(1)
    expect(record.deliveries[0]).toMatchObject({
      deliveryId: 'delivery-track-1',
      track: 'client-settle',
      state: 'failed',
      failure: { code: 'was-not-applied' },
    })
  })

  it('records the allowed-once decision when the ask is still live', async () => {
    const item = derivedApproval()
    const { store, engine } = mount(item, 'live')
    const result = await engine.reply(clientSettle(item), 'request-2')
    expect(result.outcome).toBe('applied')
    const record = store.current()
    expect(record.state).toBe('awaiting')
    expect(record.resolution).toMatchObject({
      kind: 'answered',
      actor: 'user',
      payload: { type: 'approval', outcome: 'allow-once' },
    })
    expect(record.deliveries[0]).toMatchObject({
      track: 'client-settle',
      state: 'settled',
      payload: { type: 'approval', outcome: 'allow-once' },
    })
    expect(record.acknowledgement).toMatchObject({ state: 'pending' })
    void store
  })

  it('proceeds when the profile cannot prove liveness (backwards compatible)', async () => {
    for (const liveness of ['unknown', undefined] as const) {
      const item = derivedApproval()
      const { engine } = mount(item, liveness)
      expect((await engine.reply(clientSettle(item), 'request-3')).outcome).toBe('applied')
    }
  })

  it('records the deny decision with the same track-1 evidence path', async () => {
    const item = derivedApproval()
    const { store, engine } = mount(item, 'live')
    const result = await engine.reply(clientSettle(item, { type: 'approval', outcome: 'deny' }), 'request-4')
    expect(result.outcome).toBe('applied')
    expect(store.writes).toHaveLength(1)
    expect(store.current().resolution).toMatchObject({ payload: { type: 'approval', outcome: 'deny' } })
  })
})

describe('pending approval parity with the capture fold', () => {
  it('turns the folded pending ask into an applied track-1 decision', async () => {
    const drafts = await createCaptureDriver({ sink: undefined, source: 'projection', now: () => 5_000 })
      .driveSession(
        { id: 'session-1', inheritedEventCount: 0, header: { id: 'session-1', createdAt: 1 } },
        [
          { seq: 0, type: 'approval/asked', time: 1_000, data: { id: 'approval-1', toolName: 'bash', callId: 'call-1' } },
        ],
      )
    const draft = drafts.find(entry => entry.closes === undefined)
    expect(draft?.artifactId).toBe('approval:call-1')
    const item = derivedApproval({
      title: draft?.title ?? 'Approval needed',
      body: draft?.body ?? '',
      severity: draft?.severity ?? 1,
    })
    const { engine } = mountEngine(item)
    const result = await engine.reply(clientSettle(item), 'request-parity')
    expect(result.outcome).toBe('applied')
    expect(result.note).toBeUndefined()
    expect(result.item.resolution).toMatchObject({ payload: { type: 'approval', outcome: 'allow-once' } })
  })

  /** Mount a track-1 engine over the item with positive liveness. */
  function mountEngine(item: OpenItemRecord): { engine: ReturnType<typeof createReplyEngine> } {
    const sessions = createFakeSessions({ probe: { ok: true, agent: AGENT, running: false, turnOpen: false } })
    sessions.askLiveness = async () => 'live'
    return {
      engine: createReplyEngine({ store: createFakeStore(item), sessions, now: () => 5_000 }),
    }
  }

  it('records the truthful recorded note only when the engine records instead of settling', async () => {
    // A cold session and no requested track: the matrix records, never claims sent.
    const item = derivedQuestion()
    const sessions = createFakeSessions()
    sessions.askLiveness = async () => 'unknown'
    const engine = createReplyEngine({
      store: createFakeStore(item),
      sessions,
      now: () => 5_000,
    })
    const result = await engine.reply({
      itemId: item.id,
      expectedVersion: item.version,
      deliveryId: 'delivery-recorded',
      payload: { type: 'text', text: 'yes' },
    }, 'request-6')
    expect(result.outcome).toBe('recorded')
    expect(result.note).toBe(REPLY_NOTES.notRunning)
  })
})
