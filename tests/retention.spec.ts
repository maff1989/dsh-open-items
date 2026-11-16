/**
 * Retention and acknowledgement sweeps (PLAN M1 item 6; DESIGN §7.3, §7.4.4).
 */
import { describe, expect, it } from 'vitest'

import { planRetention } from '../src/host/retention'
import { OpenItemsStore } from '../src/host/store'
import { createFakeDomain, fakeContext } from './fake-domain'
import { makeItem, T0 } from './fixtures'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

let clockNow = T0
/** Shared clock. */
function clock(): number {
  return clockNow
}
/** Advance the shared clock. */
function tick(milliseconds: number): void {
  clockNow += milliseconds
}

/** One store over a fresh fake domain. */
async function makeStore(options: { maxResolvedRecords?: number; activeResolveDays?: number } = {}): Promise<OpenItemsStore> {
  return OpenItemsStore.open(fakeContext(createFakeDomain()), {
    now: clock,
    ...options,
  })
}

/** Create, answer and acknowledge one item so it becomes `resolved`. */
async function resolvedItem(store: OpenItemsStore, title: string) {
  const { item } = await store.create({ kind: 'decision', title, sessionId: 'session-1' })
  await store.answer(item.id, 1, { type: 'text', text: 'done' })
  await store.acknowledge(item.id, { kind: 'turn-continued', seq: 1 })
  return store.get(item.id)!
}

describe('acknowledgement window', () => {
  it('records "none" and resolves an awaiting item after the window', async () => {
    const store = await makeStore()
    const { item } = await store.create({ kind: 'decision', title: 'Ship?', sessionId: 'session-1' })
    await store.answer(item.id, 1, { type: 'text', text: 'yes' })
    expect(store.get(item.id)?.state).toBe('awaiting')

    const report = await store.sweep(clockNow + 23 * HOUR)
    expect(report.unacknowledged).toBe(0)
    expect(store.get(item.id)?.state).toBe('awaiting')

    const swept = await store.sweep(clockNow + 25 * HOUR)
    expect(swept.unacknowledged).toBe(1)
    const record = store.get(item.id)!
    expect(record.state).toBe('resolved')
    expect(record.acknowledgement).toEqual({ state: 'none', at: clockNow + 25 * HOUR })
    expect(record.history.at(-1)?.action).toBe('acknowledgement-none')
  })
})

describe('resolution retention', () => {
  it('archives a resolved item after 365 days, dropping body and quote but keeping the decision', async () => {
    const store = await makeStore()
    const { item } = await store.create({
      kind: 'decision',
      title: 'Ship on Friday?',
      body: 'Customer-facing rollout decision.',
      quote: 'we need to know before the release',
      sessionId: 'session-1',
    })
    await store.answer(item.id, 1, { type: 'text', text: 'Friday morning' })
    await store.acknowledge(item.id, { kind: 'turn-continued', seq: 3 })
    const resolvedAt = store.get(item.id)!.resolvedAt!

    const before = await store.sweep(resolvedAt + 364 * DAY)
    expect(before.archived).toBe(0)
    expect(store.get(item.id)?.retention.class).toBe('active')

    const sweep = await store.sweep(resolvedAt + 366 * DAY)
    expect(sweep.archived).toBe(1)
    const archived = store.get(item.id)!
    expect(archived.retention).toMatchObject({ class: 'archived', archivedAt: resolvedAt + 366 * DAY })
    expect(archived.body).toBe('')
    expect(archived.quote).toBeUndefined()
    expect(archived.title).toBe('Ship on Friday?')
    expect(archived.resolution).toMatchObject({ kind: 'answered' })
  })

  it('prunes the oldest archived resolution on append past the cap and reports it', async () => {
    const store = await makeStore({ maxResolvedRecords: 2, activeResolveDays: 1 })
    const records = []
    for (const title of ['First?', 'Second?']) {
      tick(DAY)
      records.push(await resolvedItem(store, title))
    }
    tick(2 * DAY)
    await store.sweep(clockNow)
    expect(records.every(record => store.get(record.id)?.retention.class === 'archived')).toBe(true)

    tick(DAY)
    const third = await resolvedItem(store, 'Third?')
    expect(store.all()).toHaveLength(2)
    expect(store.get(records[0]!.id)).toBeUndefined()
    expect(store.get(third.id)).toBeDefined()
    expect(store.earlierRecordsPruned).toBe(true)
  })

  it('never prunes active (non-archived) resolutions', () => {
    const records = [
      makeItem({ id: 'a', state: 'resolved', retention: { class: 'active' }, resolution: { kind: 'answered', at: T0, actor: 'user', payload: { type: 'text', text: 'a' } }, resolvedAt: T0 }),
      makeItem({ id: 'b', state: 'resolved', retention: { class: 'active' }, resolution: { kind: 'answered', at: T0, actor: 'user', payload: { type: 'text', text: 'b' } }, resolvedAt: T0 }),
      makeItem({ id: 'c', state: 'resolved', retention: { class: 'active' }, resolution: { kind: 'answered', at: T0, actor: 'user', payload: { type: 'text', text: 'c' } }, resolvedAt: T0 }),
    ]
    const plan = planRetention(records, {
      now: T0,
      activeResolveDays: 365,
      acknowledgementWindowHours: 24,
      maxResolvedRecords: 1,
    })
    expect(plan.prune).toEqual([])
  })
})

describe('live cap and pure plan', () => {
  it('plans archiving the oldest stale item first, then the lowest severity', () => {
    const records = [
      makeItem({ id: 'fresh-high', severity: 1, updatedAt: T0 + 10 }),
      makeItem({ id: 'stale-low', severity: 3, state: 'stale', updatedAt: T0 + 5 }),
      makeItem({ id: 'stale-high', severity: 1, state: 'stale', updatedAt: T0 + 8 }),
    ]
    const plan = planRetention(records, {
      now: T0,
      activeResolveDays: 365,
      acknowledgementWindowHours: 24,
      maxResolvedRecords: 5000,
      maxLiveItems: 2,
    })
    expect(plan.archiveLive.map(record => record.id)).toEqual(['stale-low'])
  })

  it('archives live items over the cap without deleting them', async () => {
    const store = await OpenItemsStore.open(fakeContext(createFakeDomain()), { now: clock, maxLiveItems: 10 })
    const open = await store.create({ kind: 'decision', title: 'Kept?', sessionId: 's' })
    const second = await store.create({ kind: 'decision', title: 'Other?', sessionId: 's' })
    expect(open.item.state).toBe('open')
    expect(second.item.state).toBe('open')
    await store.sweep(clockNow)
    expect(store.all().every(record => record.state !== 'archived')).toBe(true)
    expect(store.countLive()).toBe(2)
  })
})

describe('tombstones in retention', () => {
  it('keeps a deleted-forever record out of the resolution cap, archive and prune plans', async () => {
    const store = await makeStore({ maxResolvedRecords: 1 })
    const first = await resolvedItem(store, 'First resolution?')
    const second = await resolvedItem(store, 'Second resolution?')
    const tombstone = await store.deleteForever(first.id, store.get(first.id)!.version)

    // The tombstone is not a register row, so it must not occupy the cap: only
    // one live resolution remains, which fits the cap of one.
    const plan = planRetention(store.all(), {
      now: clockNow,
      activeResolveDays: 365,
      acknowledgementWindowHours: 24,
      maxResolvedRecords: 1,
    })
    expect(plan.prune).toEqual([])
    expect(plan.archive).toEqual([])
    expect(store.counts().resolved).toBe(1)
    expect(store.get(second.id)?.state).toBe('resolved')
    expect(store.get(tombstone.id)?.deletedAt).toBe(tombstone.deletedAt)
  })
})
