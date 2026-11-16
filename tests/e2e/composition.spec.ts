/**
 * M6 end-to-end composition suite.
 *
 * Every other Host suite tests one unit against a contract. This one composes
 * the **real** modules — storage-domain store, service, tool, exact Fetch route,
 * reply engine + session bridge, capture engine + backfill — through the same
 * `apply()` a profile runs, faking only the external services the plugin cannot
 * own. It is the proof that the branches actually integrate.
 *
 * Scenarios: route lifecycle (`hello → list → tool raise → list → reply →
 * delivery → register → acknowledge`), archived-session refusal, dismiss/snooze/
 * reopen, capture/backfill producing derived items, and route robustness (no
 * throw escapes as a non-envelope).
 *
 * @module tests/e2e/composition.spec
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CaptureEvent } from '../../src/host/capture-contract'
import type {
  DeliveryValue,
  HelloValue,
  ListValue,
  RegisterValue,
  ReplyValue,
} from '../../src/shared/protocol'
import type { OpenItemRecord } from '../../src/shared/schema'
import { isAuthoredApproval } from '../../src/shared/item-origin'
import {
  T0,
  approvalAsked,
  approvalDecided,
  askUserQuestionArgs,
  ev,
  goalSnapshot,
  toolCall,
  turnEnd,
  turnStart,
} from '../capture/fixtures'
import {
  composeCore,
  composePlugin,
  fakeAgent,
  type ComposedCore,
  type ComposedPlugin,
  type FakeSessionRow,
} from './harness'

/** Fixed read time for the capture composition (fixtures are T0-based). */
const NOW = T0 + 5 * 24 * 60 * 60 * 1000

const plugins: ComposedPlugin[] = []
const cores: ComposedCore[] = []

afterEach(async () => {
  for (const core of cores.splice(0)) await core.close()
  for (const plugin of plugins.splice(0)) await plugin.close()
})

/**
 * Compose the full plugin and track it for cleanup.
 * @param options - fakes.
 * @returns the composition.
 */
async function plugin(options: Parameters<typeof composePlugin>[0] = {}): Promise<ComposedPlugin> {
  const composed = await composePlugin(options)
  plugins.push(composed)
  return composed
}

/**
 * Compose the core (store+service+capture) and track it for cleanup.
 * @param options - fakes.
 * @returns the composition.
 */
async function core(options: Parameters<typeof composeCore>[0] = {}): Promise<ComposedCore> {
  const composed = await composeCore(options)
  cores.push(composed)
  return composed
}

/** The stored record behind one tool row. */
function stored(composed: ComposedPlugin, id: string): OpenItemRecord {
  const record = composed.ctx.openItems.get(id)
  if (record === undefined) throw new Error(`item ${id} was not stored`)
  return record
}

describe('route lifecycle over the real composition', () => {
  it('hello → list → tool raise → reply → delivery evidence → register → acknowledge', async () => {
    const agent = fakeAgent('session-1', 'idle')
    const composed = await plugin({
      agents: new Map([['session-1', agent]]),
      sessions: [{ sessionId: 'session-1', updatedAt: Date.now(), running: false, cwd: '/work/api', title: 'Deploy day' }],
      workspaces: [{ workspaceId: 'w1', title: 'api', path: '/work/api', sessionIds: ['session-1'] }],
    })

    // hello advertises the capabilities the composed delivery layer provides.
    const hello = await composed.ok<HelloValue>('hello')
    expect(hello).toMatchObject({
      protocol: 1,
      domainVersion: 1,
      schemaVersion: 3,
      capabilities: { canSettleClient: true, canHostSettle: false, canDeliver: true, canRegister: true },
      counts: { needsYou: 0, candidates: 0, awaiting: 0 },
      earlierRecordsPruned: false,
    })
    expect(hello.installId).toMatch(/^[0-9a-f-]{36}$/u)

    // Empty inbox.
    const empty = await composed.ok<ListValue>('list')
    expect(empty.snapshot.items).toEqual([])
    expect(empty.snapshot.counts.needsYou).toBe(0)

    // Raise through the registered tool (real tool definition, fake agent).
    const raised = await composed.runTool({
      action: 'raise',
      kind: 'question',
      title: 'Ship on Friday?',
      detail: 'The user has not picked a rollout window.',
    }, 'session-1', 'call-raise-1') as { items: { id: string }[] }
    const itemId = raised.items[0]!.id
    const record = stored(composed, itemId)
    expect(record).toMatchObject({
      kind: 'question',
      state: 'open',
      blocking: true,
      source: {
        sessionId: 'session-1',
        callId: 'call-raise-1',
        workspace: { workspaceId: 'w1', title: 'api', path: '/work/api' },
      },
    })

    // The inbox sees the authored item and its workspace row.
    const listed = await composed.ok<ListValue>('list')
    expect(listed.snapshot.items.map(item => item.id)).toEqual([itemId])
    expect(listed.snapshot.counts.needsYou).toBe(1)
    // The raise path resolves workspace membership for the root session, so an
    // authored item groups under its workspace (DESIGN §5.10) instead of
    // Ungrouped.
    expect(listed.snapshot.workspaces).toEqual([
      expect.objectContaining({ title: 'api', itemCount: 1, sessionCount: 1 }),
    ])
    expect(listed.snapshot.sessions[0]).toMatchObject({ sessionId: 'session-1', counts: { needsYou: 1, awaiting: 0 } })
    const item = listed.snapshot.items[0]!

    // Track 1 (client settle): the browser already answered the live card, so
    // the engine records the decision and the item waits for acknowledgement.
    const settled = await composed.ok<ReplyValue>('reply', {
      itemId,
      expectedVersion: item.version,
      deliveryId: 'delivery-e2e-1',
      payload: { type: 'text', text: 'Friday morning works.' },
      requestedTrack: 'client-settle',
    })
    expect(settled.outcome).toBe('applied')
    expect(settled.delivery).toMatchObject({ deliveryId: 'delivery-e2e-1', track: 'client-settle', state: 'settled' })
    expect(settled.item).toMatchObject({ id: itemId, state: 'awaiting', acknowledgement: { state: 'pending' } })
    expect(composed.appends()).toBe(0)

    // The delivery is readable by id (idempotent recovery after a lost response).
    const delivery = await composed.ok<DeliveryValue>('delivery', { deliveryId: 'delivery-e2e-1' })
    expect(delivery.delivery?.deliveryId).toBe('delivery-e2e-1')
    expect(delivery.item?.id).toBe(itemId)

    // Register shows the in-flight answer (awaiting acknowledgement).
    const inFlight = await composed.ok<RegisterValue>('register')
    expect(inFlight.total).toBe(1)
    expect(inFlight.items[0]).toMatchObject({ id: itemId, state: 'awaiting', acknowledgement: { state: 'pending' } })
    expect((await composed.ok<HelloValue>('hello')).counts).toEqual({ needsYou: 0, candidates: 0, awaiting: 1 })

    // A repeated deliveryId is the same answer: no second delivery.
    const duplicate = await composed.ok<ReplyValue>('reply', {
      itemId,
      expectedVersion: item.version,
      deliveryId: 'delivery-e2e-1',
      payload: { type: 'text', text: 'Friday morning works.' },
      requestedTrack: 'client-settle',
    })
    expect(duplicate.item.deliveries.filter(attempt => attempt.deliveryId === 'delivery-e2e-1')).toHaveLength(1)

    // The session acts on the answer: the register becomes the accountability record.
    await composed.ctx.openItems.acknowledge(itemId, { kind: 'next-turn', seq: 42 })
    const resolvedRegister = await composed.ok<RegisterValue>('register')
    expect(resolvedRegister.items[0]).toMatchObject({
      id: itemId,
      state: 'resolved',
      acknowledgement: { state: 'observed', evidence: { kind: 'next-turn', seq: 42 } },
    })
    expect((await composed.ok<HelloValue>('hello')).counts).toEqual({ needsYou: 0, candidates: 0, awaiting: 0 })

    // Track 3 (session message) on an idle session: only a confirmed wake may
    // start a turn, and the engine sends a follow-up through the bridge.
    const second = await composed.runTool({ action: 'raise', kind: 'decision', title: 'Second decision?' }, 'session-1') as { items: { id: string }[] }
    const secondId = second.items[0]!.id
    const sent = await composed.ok<ReplyValue>('reply', {
      itemId: secondId,
      expectedVersion: stored(composed, secondId).version,
      deliveryId: 'delivery-e2e-2',
      payload: { type: 'text', text: 'Go ahead.' },
      requestedTrack: 'session-message',
      confirmedWake: true,
    })
    expect(sent.outcome).toBe('sent')
    expect(sent.delivery).toMatchObject({ deliveryId: 'delivery-e2e-2', track: 'session-message', state: 'queued' })
    expect(agent.followups).toHaveLength(1)
    // A queued track-3 send is "waiting on the agent", not still in the open
    // queue: the register's in-flight band must show it (DESIGN §6.3/§7.4.2).
    expect(stored(composed, secondId)).toMatchObject({
      state: 'awaiting',
      acknowledgement: { state: 'pending' },
      deliveries: [expect.objectContaining({ deliveryId: 'delivery-e2e-2', state: 'queued' })],
    })
    expect((await composed.ok<HelloValue>('hello')).counts).toEqual({ needsYou: 0, candidates: 0, awaiting: 1 })
    expect(composed.appends()).toBe(0)
  })
})

describe('guards and user actions through the route', () => {
  it('refuses an archived session and drives dismiss/snooze/reopen', async () => {
    const archivedAgent = fakeAgent('session-archived', 'idle')
    const liveAgent = fakeAgent('session-live', 'idle')
    const composed = await plugin({
      agents: new Map([
        ['session-archived', archivedAgent],
        ['session-live', liveAgent],
      ]),
      archived: ['session-archived'],
      sessions: [],
    })

    // Guard 6: a reply into an archived session is refused as a value.
    const archivedRaise = await composed.runTool({
      action: 'raise',
      kind: 'decision',
      title: 'Restore the archived session?',
    }, 'session-archived', 'call-archived') as { items: { id: string }[] }
    const archivedId = archivedRaise.items[0]!.id
    const archivedItem = stored(composed, archivedId)
    expect(await composed.failCode('reply', {
      itemId: archivedId,
      expectedVersion: archivedItem.version,
      deliveryId: 'delivery-archived',
      payload: { type: 'text', text: 'yes' },
      requestedTrack: 'session-message',
      confirmedWake: true,
    })).toBe('session-archived')
    expect(stored(composed, archivedId).state).toBe('open')
    expect(archivedAgent.followups).toHaveLength(0)

    // Dismiss one item.
    const dismissRaise = await composed.runTool({ action: 'raise', kind: 'decision', title: 'Dismiss me?' }, 'session-live') as { items: { id: string }[] }
    const dismissId = dismissRaise.items[0]!.id
    const dismissed = await composed.ok<{ item: OpenItemRecord }>('dismiss', {
      itemId: dismissId,
      expectedVersion: stored(composed, dismissId).version,
      reason: 'not needed any more',
    })
    expect(dismissed.item).toMatchObject({ state: 'resolved', resolution: { kind: 'dismissed' } })

    // Reopen it: the previous resolution moves to the log.
    const reopened = await composed.ok<{ item: OpenItemRecord }>('reopen', {
      itemId: dismissId,
      expectedVersion: dismissed.item.version,
    })
    expect(reopened.item).toMatchObject({ state: 'open', reopenCount: 1, resolutionLog: [{ kind: 'dismissed' }] })

    // Snooze another one until the future.
    const snoozeRaise = await composed.runTool({ action: 'raise', kind: 'follow-up', title: 'Snooze me?' }, 'session-live') as { items: { id: string }[] }
    const snoozeId = snoozeRaise.items[0]!.id
    const snoozed = await composed.ok<{ item: OpenItemRecord }>('snooze', {
      itemId: snoozeId,
      expectedVersion: stored(composed, snoozeId).version,
      until: Date.now() + 60_000,
    })
    expect(snoozed.item).toMatchObject({ state: 'snoozed' })

    // Refusals are values with stable codes: missing id and stale CAS.
    expect(await composed.failCode('dismiss', { itemId: 'missing', expectedVersion: 1 })).toBe('not-found')
    expect(await composed.failCode('snooze', { itemId: snoozeId, expectedVersion: 1, until: Date.now() + 60_000 }))
      .toBe('conflict')
    expect(composed.appends()).toBe(0)
  })
})

describe('capture and backfill composition', () => {
  it('folds fake session logs through the real seams and lands derived items in the inbox', async () => {
    const rootEvents = [
      turnStart(0, 1),
      toolCall(1, 'call-ask', 'ask_user_question', askUserQuestionArgs('Proceed with the migration?', ['Yes', 'No'])),
      turnEnd(2, 1),
      approvalAsked(3, 'approval-1', 'bash', 'call-approval'),
      approvalDecided(4, 'approval-1', 'rejected'),
      goalSnapshot(5, 'block', { id: 'goal-1', revision: 2, objective: 'ship the release', phase: 'blocked' }),
      ev(6, 'todo/write', { todos: [{ content: 'not an item', status: 'pending' }] }),
      ev(7, 'future/plugin-event', { note: 'unknown event types must be ignored' }),
    ]
    const childEvents = [
      approvalAsked(0, 'approval-child', 'bash', 'call-child'),
      approvalDecided(1, 'approval-child', 'rejected'),
    ]
    const composed = await core({
      sessions: [
        { sessionId: 'session-root', updatedAt: NOW, running: false, cwd: '/work/api', title: 'Root session' },
        { sessionId: 'session-child', updatedAt: NOW, running: true, origin: 'subagent', delegationDepth: 1 },
      ],
      sessionEvents: new Map([
        ['session-root', rootEvents],
        ['session-child', childEvents],
      ]),
      workspaces: [{
        workspaceId: 'w1',
        title: 'api',
        path: '/work/api',
        sessionIds: ['session-root', 'session-child'],
      }],
      now: () => NOW,
    })

    const report = await composed.capture.backfillNow()
    expect(report).toBeDefined()
    expect(report!.sessionsFolded).toBeGreaterThanOrEqual(1)
    expect(report!.draftsEmitted).toBeGreaterThanOrEqual(3)
    expect(report!.sessionsFailed).toBe(0)

    const snapshot = composed.service.list({ status: 'open' })
    const kinds = snapshot.items.map(item => item.kind).sort()
    // D3: the abandoned plan adds one aggregate `follow-up` candidate.
    expect(kinds).toEqual(['approval', 'blocker', 'follow-up', 'question'])
    // Root-only: no item belongs to the subagent session.
    expect(snapshot.items.every(item => item.source.sessionId === 'session-root')).toBe(true)
    expect(snapshot.items.some(item => item.source.sessionId === 'session-child')).toBe(false)
    // Team-task alerts are disabled (D5); the unknown event is ignored.
    expect(snapshot.items.some(item => item.kind === 'task')).toBe(false)
    // The abandoned plan is one aggregate candidate, never a needs-you item.
    const plan = snapshot.items.find(item => item.kind === 'follow-up')
    expect(plan?.tier).toBe('candidate')
    expect(plan?.blocking).toBe(false)
    expect(plan?.history.some(entry => entry.detail === 'todo/write:unfinished-plan')).toBe(true)
    // Every other family is structural; the plan is the only candidate here.
    expect(snapshot.items.filter(item => item.tier === 'structural')).toHaveLength(3)
    // The workspace snapshot travelled from the registry (membership, not cwd).
    // `itemCount` counts needs-you items only (candidates are excluded by the
    // `counts.needsYou === Σ workspaces.itemCount` invariant), so it stays 3.
    expect(snapshot.workspaces).toEqual([
      expect.objectContaining({ workspaceId: 'w1', itemCount: 3, sessionCount: 1 }),
    ])
    expect(snapshot.items.every(item => item.source.workspace?.workspaceId === 'w1')).toBe(true)

    // A second pass is resumable: the cursor covers the session, no duplicates.
    const before = composed.service.list({ status: 'open' }).items.map(item => item.id)
    const second = await composed.capture.backfillNow()
    expect(second).toBeDefined()
    expect(second!.sessionsSkipped).toBeGreaterThanOrEqual(1)
    expect(composed.service.list({ status: 'open' }).items.map(item => item.id)).toEqual(before)
  })
})

describe('live capture and restart behaviour over the real composition', () => {
  it('never derives an item from a subagent session while the root session folds', async () => {
    const composed = await core({
      sessions: [
        { sessionId: 'session-root', updatedAt: NOW, running: false, cwd: '/work/api' },
        { sessionId: 'session-child', updatedAt: NOW, running: true, origin: 'subagent', delegationDepth: 1 },
      ],
      workspaces: [{
        workspaceId: 'w1',
        title: 'api',
        path: '/work/api',
        sessionIds: ['session-root', 'session-child'],
      }],
      now: () => NOW,
    })
    /** Emit committed events exactly as the harness publishes them. */
    const emit = (session: unknown, events: readonly CaptureEvent[]): void => {
      for (const event of events) composed.ctx.emit('session/event', session as never, event as never)
    }
    const child = { id: 'session-child', inheritedEventCount: 0, header: { id: 'session-child', createdAt: NOW, origin: 'subagent', delegationDepth: 1 } }
    const root = { id: 'session-root', inheritedEventCount: 0, header: { id: 'session-root', createdAt: NOW, cwd: '/work/api' } }

    emit(child, [
      approvalAsked(0, 'approval-child', 'bash', 'call-child'),
      approvalDecided(1, 'approval-child', 'unavailable'),
    ])
    emit(root, [
      approvalAsked(0, 'approval-root', 'bash', 'call-root'),
      approvalDecided(1, 'approval-root', 'unavailable'),
    ])

    await vi.waitFor(() => {
      const open = composed.service.list({ status: 'open' }).items
      expect(open.map(item => item.source.sessionId)).toEqual(['session-root'])
    })
    const [item] = composed.service.list({ status: 'open' }).items
    expect(item?.kind).toBe('approval')
    // The live draft carries the workspace snapshot resolved by membership, so a
    // post-install item groups under its workspace instead of Ungrouped.
    expect(item?.source.workspace).toEqual({ workspaceId: 'w1', title: 'api', path: '/work/api' })
  })

  it('a restart re-fold leaves a detector-closed item closed and version-stable', async () => {
    const events = new Map<string, CaptureEvent[]>([
      ['session-root', [
        approvalAsked(0, 'approval-1', 'bash', 'call-1'),
        approvalDecided(1, 'approval-1', 'unavailable'),
      ]],
    ])
    const rows: FakeSessionRow[] = [{ sessionId: 'session-root', updatedAt: NOW, running: false }]
    const first = await core({ sessions: rows, sessionEvents: events, now: () => NOW })

    await first.capture.backfillNow()
    const [raised] = first.service.list({ status: 'open' }).items
    expect(raised?.kind).toBe('approval')
    const itemId = raised!.id

    // The tool is retried and allowed: the detector closes the item.
    events.set('session-root', [
      ...events.get('session-root')!,
      approvalAsked(2, 'approval-2', 'bash', 'call-1'),
      approvalDecided(3, 'approval-2', 'allowed-once'),
      turnStart(4, 2),
      turnEnd(5, 2),
    ])
    rows[0] = { ...rows[0]!, updatedAt: NOW + 1000 }
    const closePass = await first.capture.backfillNow()
    expect(closePass?.sessionsFolded).toBe(1)
    const resolved = first.service.get(itemId)!
    expect(resolved).toMatchObject({ state: 'resolved', resolution: { kind: 'detected-closed' } })
    const settledVersion = resolved.version

    // An unrelated event advances the log. A delta re-fold must not replay the
    // historical raise (that would reopen, then re-close, a settled item).
    events.set('session-root', [...events.get('session-root')!, turnStart(6, 3)])
    rows[0] = { ...rows[0]!, updatedAt: NOW + 2000 }
    await first.capture.backfillNow()
    const afterAdvance = first.service.get(itemId)!
    expect(afterAdvance).toMatchObject({ state: 'resolved', reopenCount: 0, version: settledVersion })

    // A restart: a new store/capture over the same durable domain and cursors.
    const restarted = await core({
      domain: first.domain,
      sessions: rows,
      sessionEvents: events,
      now: () => NOW + 10_000,
    })
    const restartReport = await restarted.capture.backfillNow()
    expect(restartReport?.sessionsFailed).toBe(0)
    expect(restarted.service.get(itemId)).toMatchObject({
      state: 'resolved',
      reopenCount: 0,
      version: settledVersion,
    })
  })
})

describe('live pending approval flow (WP-03)', () => {
  it('pending approval → inbox → allow-once → acknowledgement', async () => {
    const agent = fakeAgent('session-root', 'running')
    const agents = new Map([['session-root', agent]])
    const composed = await plugin({
      agents,
      sessions: [{ sessionId: 'session-root', updatedAt: NOW, running: true, cwd: '/work/api' }],
      workspaces: [{ workspaceId: 'w1', title: 'api', path: '/work/api', sessionIds: ['session-root'] }],
      now: () => NOW,
    })
    const live = { id: 'session-root', inheritedEventCount: 0, header: { id: 'session-root', createdAt: T0, cwd: '/work/api' } }
    /** Emit one committed event as the harness publishes it. */
    const emit = (seq: number, type: string, data: unknown): void => {
      composed.ctx.emit('session/event', live as never, { seq, type, time: T0 + seq * 1000, data } as never)
    }

    // The ask is live in the session log before any decision.
    emit(0, 'approval/asked', { id: 'approval-live', toolName: 'bash', callId: 'call-live', reason: 'run the test suite' })
    await vi.waitFor(() => {
      const open = composed.service.list({ status: 'open' }).items
      expect(open).toHaveLength(1)
    })
    const pending = composed.service.list({ status: 'open' }).items[0]!
    expect(pending).toMatchObject({
      kind: 'approval',
      blocking: true,
      source: { sessionId: 'session-root', callId: 'call-live', approvalId: 'approval-live' },
    })
    expect(pending.reply.controls).toEqual(['approve', 'deny'])
    // The live row groups under its workspace (live stamping).
    expect(pending.source.workspace).toEqual({ workspaceId: 'w1', title: 'api', path: '/work/api' })

    // The browser settles the shipped card and reports it: track 1 records the
    // allowed-once decision without sending a message.
    const settled = await composed.ok<ReplyValue>('reply', {
      itemId: pending.id,
      expectedVersion: pending.version,
      deliveryId: 'delivery-allow-once',
      payload: { type: 'approval', outcome: 'allow-once' },
      requestedTrack: 'client-settle',
    })
    expect(settled.outcome).toBe('applied')
    expect(settled.delivery).toMatchObject({
      deliveryId: 'delivery-allow-once',
      track: 'client-settle',
      state: 'settled',
      payload: { type: 'approval', outcome: 'allow-once' },
    })
    expect(composed.appends()).toBe(0)

    // The harness records the decision; the live fold acknowledges the answer
    // and closes the row from the ask's own evidence.
    emit(1, 'approval/decided', { id: 'approval-live', outcome: 'allowed-once' })
    await vi.waitFor(() => {
      const record = composed.ctx.openItems.get(pending.id)
      expect(record?.state).toBe('resolved')
    })
    const resolved = composed.ctx.openItems.get(pending.id)!
    expect(resolved.resolution).toMatchObject({
      kind: 'answered',
      actor: 'user',
      payload: { type: 'approval', outcome: 'allow-once' },
    })
    expect(resolved.acknowledgement).toMatchObject({
      state: 'observed',
      evidence: { kind: 'call-retried' },
    })
    expect(resolved.deliveries.at(-1)).toMatchObject({ deliveryId: 'delivery-allow-once', state: 'acknowledged' })

    const inFlight = await composed.ok<RegisterValue>('register')
    expect(inFlight.items[0]).toMatchObject({
      id: pending.id,
      state: 'resolved',
      acknowledgement: { state: 'observed' },
    })
    expect(composed.appends()).toBe(0)
  })

  it('refuses a track-1 settle for an ask whose live session is gone, recording was-not-applied', async () => {
    const agent = fakeAgent('session-root', 'running')
    const agents = new Map([['session-root', agent]])
    const composed = await plugin({
      agents,
      sessions: [{ sessionId: 'session-root', updatedAt: NOW, running: true }],
      now: () => NOW,
    })
    const live = { id: 'session-root', inheritedEventCount: 0, header: { id: 'session-root', createdAt: T0 } }
    composed.ctx.emit('session/event', live as never, {
      seq: 0,
      type: 'approval/asked',
      time: T0,
      data: { id: 'approval-gone', toolName: 'bash', callId: 'call-gone' },
    } as never)
    await vi.waitFor(() => {
      expect(composed.service.list({ status: 'open' }).items).toHaveLength(1)
    })
    const pending = composed.service.list({ status: 'open' }).items[0]!
    // The session is gone: the live card cannot still own the ask.
    agents.delete('session-root')
    expect(await composed.failCode('reply', {
      itemId: pending.id,
      expectedVersion: pending.version,
      deliveryId: 'delivery-gone',
      payload: { type: 'approval', outcome: 'allow-once' },
      requestedTrack: 'client-settle',
    })).toBe('conflict')
    const record = composed.ctx.openItems.get(pending.id)!
    expect(record.state).toBe('open')
    expect(record.deliveries[0]).toMatchObject({
      deliveryId: 'delivery-gone',
      state: 'failed',
      failure: { code: 'was-not-applied' },
    })
    expect(composed.appends()).toBe(0)
  })
})

describe('authored approval flow (tool raise, no live card)', () => {
  it('sends the decision to the session as a message and never as a card settle', async () => {
    const agent = fakeAgent('session-1', 'idle')
    const composed = await plugin({
      agents: new Map([['session-1', agent]]),
      sessions: [{ sessionId: 'session-1', updatedAt: NOW, running: false, cwd: '/work/api' }],
      now: () => NOW,
    })

    // The agent raises the sign-off itself: this is the shape of the rc2 item
    // the user could not answer (kind approval, but no shipped request behind it).
    const raised = await composed.runTool({
      action: 'raise',
      kind: 'approval',
      title: 'Restart the app and sign off the release',
      detail: 'Restart the host so the rebuilt client loads, then confirm the rendered review.',
    }, 'session-1', 'call-raise-approval') as { items: { id: string }[] }
    const itemId = raised.items[0]!.id
    const item = stored(composed, itemId)
    expect(item).toMatchObject({ kind: 'approval', state: 'open', blocking: true })
    expect(item.source.approvalId).toBeUndefined()
    expect(isAuthoredApproval(item)).toBe(true)

    // An authored approval has no live request to settle: a card settle would
    // claim a grant nothing can deliver, so track 1 is refused.
    expect(await composed.failCode('reply', {
      itemId,
      expectedVersion: item.version,
      deliveryId: 'authored-settle',
      payload: { type: 'approval', outcome: 'allow-once' },
      requestedTrack: 'client-settle',
    })).toBe('bad-request')
    // An unconfirmed send against an idle session is refused, not recorded: a
    // decision the agent never received must not resolve the item.
    expect(await composed.failCode('reply', {
      itemId,
      expectedVersion: item.version,
      deliveryId: 'authored-unconfirmed',
      payload: { type: 'approval', outcome: 'allow-once' },
      requestedTrack: 'session-message',
    })).toBe('bad-request')
    expect(stored(composed, itemId)).toMatchObject({ state: 'open', deliveries: [] })
    expect(agent.followups).toHaveLength(0)

    // The explicit, confirmed send is the real path: a durable notice into the
    // session, with the decision payload recorded on the item.
    const sent = await composed.ok<ReplyValue>('reply', {
      itemId,
      expectedVersion: item.version,
      deliveryId: 'authored-send',
      payload: { type: 'approval', outcome: 'allow-once', note: 'restarted; verified at 320/640/880' },
      requestedTrack: 'session-message',
      confirmedWake: true,
    })
    expect(sent.outcome).toBe('sent')
    expect(sent.delivery).toMatchObject({
      deliveryId: 'authored-send',
      track: 'session-message',
      state: 'queued',
      payload: { type: 'approval', outcome: 'allow-once', note: 'restarted; verified at 320/640/880' },
    })
    expect(agent.followups).toHaveLength(1)
    const message = agent.followups[0] as {
      readonly content: readonly { readonly text: string }[]
      readonly source: Record<string, unknown>
    }
    const text = message.content.map(part => part.text).join('\n')
    expect(text).toContain('Approved (one-off).')
    expect(text).toContain('Note: restarted; verified at 320/640/880')
    // The title is never interpolated and the source stays the plugin's own.
    expect(text).not.toContain('Restart the app and sign off the release')
    expect(message.source).toMatchObject({ kind: 'open-items', form: 'notice', itemId, deliveryId: 'authored-send' })
    expect(stored(composed, itemId)).toMatchObject({ state: 'awaiting', acknowledgement: { state: 'pending' } })

    // A repeated deliveryId is the same decision: one message, one record.
    const repeat = await composed.ok<ReplyValue>('reply', {
      itemId,
      expectedVersion: item.version,
      deliveryId: 'authored-send',
      payload: { type: 'approval', outcome: 'allow-once', note: 'restarted; verified at 320/640/880' },
      requestedTrack: 'session-message',
      confirmedWake: true,
    })
    expect(repeat.delivery.deliveryId).toBe('authored-send')
    expect(agent.followups).toHaveLength(1)
    expect(stored(composed, itemId).deliveries).toHaveLength(1)
    expect(composed.appends()).toBe(0)
  })
})

describe('teammate-raised item roll-up (OI-02)', () => {
  it('delivers a subagent-authored approval decision to the root session', async () => {
    const root = fakeAgent('session-root', 'idle')
    const child = fakeAgent('session-child', 'running', root)
    const composed = await plugin({
      agents: new Map([
        ['session-root', root],
        ['session-child', child],
      ]),
      sessions: [
        { sessionId: 'session-root', updatedAt: NOW, running: false },
        { sessionId: 'session-child', updatedAt: NOW, running: true, origin: 'subagent', delegationDepth: 1 },
      ],
      now: () => NOW,
    })

    // A teammate (subagent) asks for the sign-off: the item rolls up to the root
    // conversation and names the asker, exactly as the design requires.
    const raised = await composed.runTool({
      action: 'raise',
      kind: 'approval',
      title: 'Teammate sign-off: release checklist',
      detail: 'The release agent asks the user to confirm the checklist.',
    }, 'session-child', 'call-child-raise') as { items: { id: string }[] }
    const itemId = raised.items[0]!.id
    const item = stored(composed, itemId)
    expect(item).toMatchObject({
      kind: 'approval',
      state: 'open',
      source: { sessionId: 'session-root', raisedBy: { sessionId: 'session-child' } },
    })
    expect(isAuthoredApproval(item)).toBe(true)

    // The decision belongs to the root conversation, not to the teammate that
    // asked: the root session is the one woken, and it receives the notice.
    const sent = await composed.ok<ReplyValue>('reply', {
      itemId,
      expectedVersion: item.version,
      deliveryId: 'child-approval-send',
      payload: { type: 'approval', outcome: 'allow-once' },
      requestedTrack: 'session-message',
      confirmedWake: true,
    })
    expect(sent.outcome).toBe('sent')
    expect(sent.delivery).toMatchObject({ track: 'session-message', state: 'queued' })
    expect(root.followups).toHaveLength(1)
    expect(child.followups).toHaveLength(0)
    expect(stored(composed, itemId)).toMatchObject({
      state: 'awaiting',
      source: { sessionId: 'session-root', raisedBy: { sessionId: 'session-child' } },
    })
    expect(composed.appends()).toBe(0)
  })
})

describe('route robustness', () => {
  it('answers every malformed request as a JSON envelope and never throws', async () => {
    const composed = await plugin({ sessions: [] })

    const endpoints = [
      'hello', 'list', 'register', 'reply', 'delivery', 'dismiss', 'snooze', 'settings', 'reopen', 'promote', 'suppress',
    ] as const
    for (const endpoint of endpoints) {
      const parsed = await composed.post({ endpoint, payload: { garbage: true } })
      expect(parsed.status).toBe(200)
      expect(parsed.contentType).toContain('application/json')
      expect(typeof parsed.body.ok).toBe('boolean')
    }

    expect(await composed.failCode('unknown-endpoint')).toBe('bad-request')
    expect((await composed.post('{not json')).body.ok).toBe(false)
    expect(await composed.failCode('reply', {})).toBe('bad-request')
    expect(await composed.failCode('delivery', {})).toBe('bad-request')
    expect(await composed.failCode('snooze', { itemId: 'x', expectedVersion: 1, until: 0 })).toBe('bad-request')
    expect(await composed.failCode('settings', { patch: { theme: 'dark' } })).toBe('bad-request')
    expect(composed.appends()).toBe(0)
  })
})
