/**
 * Store semantics over a fake storage domain: CAS, authored/derived dedupe,
 * the v3 lifecycle, capture-sink precedence, caps and corrupt-record handling
 * (PLAN M1 items 1–4, 6).
 */
import { describe, expect, it } from 'vitest'

import type { DerivedItemDraft } from '../src/host/capture-contract'
import {
  ConflictError,
  InvalidArgumentError,
  InvalidTransitionError,
  NotFoundError,
  OpenItemsStore,
  TOMBSTONE_TITLE,
  detectorEvidenceKind,
} from '../src/host/store'
import {
  isBackfillReportRecord,
  isSettingsRecord,
  parseBackfillReportRecord,
  parseMetaRecord,
  parseSettingsRecord,
  proseAskKey,
} from '../src/shared/records'
import type { OpenItemRecord, ReplyPayload } from '../src/shared/schema'
import { createFakeDomain, fakeContext, type FakeDomain } from './fake-domain'
import { makeItem, T0 as FIXTURE_T0 } from './fixtures'

let clockNow = 1_000
/** The clock every store in this file uses. */
function clock(): number {
  return clockNow
}
/** Advance the shared clock. */
function tick(milliseconds = 1): void {
  clockNow += milliseconds
}

/** Build one store over a fresh fake domain. */
async function makeStore(options: { maxLiveItems?: number; domain?: FakeDomain } = {}): Promise<{
  store: OpenItemsStore
  domain: FakeDomain
}> {
  const domain = options.domain ?? createFakeDomain()
  const store = await OpenItemsStore.open(fakeContext(domain), {
    now: clock,
    ...(options.maxLiveItems === undefined ? {} : { maxLiveItems: options.maxLiveItems }),
  })
  return { store, domain }
}

/** One valid authored draft. */
function authored(overrides: Record<string, unknown> = {}): Parameters<OpenItemsStore['create']>[0] {
  return {
    kind: 'decision',
    title: 'Ship the migration before Friday?',
    sessionId: 'session-1',
    ...overrides,
  } as Parameters<OpenItemsStore['create']>[0]
}

/** One derived draft. */
function derived(overrides: Partial<DerivedItemDraft> = {}): DerivedItemDraft {
  return {
    artifactId: 'approval:call_1',
    kind: 'approval',
    tier: 'structural',
    severity: 1,
    title: 'Approve: delete the staging volume?',
    body: 'The agent is blocked on this approval.',
    sessionId: 'session-1',
    detectorCode: 'approval/asked',
    detectedBy: ['projection'],
    blocking: true,
    ...overrides,
  }
}

describe('open and create', () => {
  it('opens the domain with a stable install identity', async () => {
    const { store } = await makeStore()
    expect(store.domainName).toBe('open_items')
    expect(store.schemaVersion).toBe(3)
    expect(store.installId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(store.countLive()).toBe(0)
    expect(store.counts()).toEqual({ needsYou: 0, candidates: 0, awaiting: 0, snoozed: 0, resolved: 0 })
  })

  it('creates an authored record with v3 defaults and an audit entry', async () => {
    const { store } = await makeStore()
    const { item, deduped } = await store.create(authored({ callId: 'call_7', body: 'rollout window' }))
    expect(deduped).toBe(false)
    expect(item).toMatchObject({
      schemaVersion: 3,
      kind: 'decision',
      state: 'open',
      tier: 'structural',
      severity: 2,
      origin: store.installId,
      version: 1,
      reopenCount: 0,
      retention: { class: 'active' },
      blocking: true,
    })
    expect(item.source).toMatchObject({ sessionId: 'session-1', callId: 'call_7' })
    expect(item.history.map(entry => entry.action)).toEqual(['raised'])
    expect(item.dedupeKey).toContain('|decision|session-1|')
    expect(store.countLive()).toBe(1)
  })

  it('dedupes a re-raise of the same kind/title/session without writing', async () => {
    const { store, domain } = await makeStore()
    const first = await store.create(authored())
    const writesAfterFirst = domain.writes()
    tick()
    const second = await store.create(authored({ title: '  ship the   MIGRATION before friday? ' }))
    expect(second.deduped).toBe(true)
    expect(second.item.id).toBe(first.item.id)
    expect(domain.writes()).toBe(writesAfterFirst)
    expect(store.countLive()).toBe(1)
  })

  it('rejects an empty title at the store boundary', async () => {
    const { store } = await makeStore()
    await expect(store.create(authored({ title: '   ' }))).rejects.toThrow(/title/u)
  })
})

describe('CAS lifecycle', () => {
  it('rejects a stale expectedVersion and leaves the record untouched', async () => {
    const { store } = await makeStore()
    const { item } = await store.create(authored())
    await expect(store.answer(item.id, 99, { type: 'text', text: 'yes' })).rejects.toBeInstanceOf(ConflictError)
    expect(store.get(item.id)).toMatchObject({ state: 'open', version: 1 })
  })

  it('answers into the awaiting state until the session acknowledges', async () => {
    const { store } = await makeStore()
    const { item } = await store.create(authored())
    const payload: ReplyPayload = { type: 'text', text: 'Friday morning' }
    const answered = await store.answer(item.id, 1, payload, { deliveryId: 'delivery-1' })
    expect(answered).toMatchObject({ state: 'awaiting', version: 2 })
    expect(answered.resolution).toMatchObject({ kind: 'answered', actor: 'user', deliveryId: 'delivery-1' })
    expect(answered.acknowledgement).toEqual({ state: 'pending' })
    expect(answered.history.at(-1)).toMatchObject({ action: 'answered', detail: 'Friday morning' })
    expect(store.counts()).toMatchObject({ needsYou: 0, awaiting: 1 })

    const acknowledged = await store.acknowledge(item.id, { kind: 'turn-continued', seq: 42 })
    expect(acknowledged).toMatchObject({ state: 'resolved', version: 3 })
    expect(acknowledged?.acknowledgement).toEqual({ state: 'observed', at: clockNow, evidence: { kind: 'turn-continued', seq: 42 } })
    expect(store.counts().resolved).toBe(1)
  })

  it('dismisses into the register with no acknowledgement expected', async () => {
    const { store } = await makeStore()
    const { item } = await store.create(authored())
    const dismissed = await store.dismiss(item.id, 1, 'superseded by the new plan')
    expect(dismissed).toMatchObject({ state: 'resolved', version: 2 })
    expect(dismissed.resolution).toMatchObject({ kind: 'dismissed', actor: 'user' })
    expect(dismissed.acknowledgement).toEqual({ state: 'none' })
    expect(dismissed.history.at(-1)).toMatchObject({ action: 'dismissed', detail: 'superseded by the new plan' })
  })

  it('reopens a settled item and keeps the previous resolution', async () => {
    const { store } = await makeStore()
    const { item } = await store.create(authored())
    await store.dismiss(item.id, 1, 'not now')
    tick(10)
    const reopened = await store.reopen(item.id, 2)
    expect(reopened).toMatchObject({ state: 'open', reopenCount: 1, version: 3 })
    expect(reopened.resolution).toBeUndefined()
    expect(reopened.acknowledgement).toBeUndefined()
    expect(reopened.resolutionLog).toHaveLength(1)
    expect(reopened.resolutionLog?.[0]?.kind).toBe('dismissed')
    expect(reopened.history.at(-1)).toMatchObject({ action: 'reopened', detail: 'was resolved' })
  })

  it('refuses to reopen an approval the session already exercised', async () => {
    const { store } = await makeStore()
    const { item } = await store.create(authored({ kind: 'approval', title: 'Run the destructive migration?' }))
    await store.answer(item.id, 1, { type: 'approval', outcome: 'allow-once' })
    await store.acknowledge(item.id, { kind: 'tool-result', seq: 9 })
    await expect(store.reopen(item.id)).rejects.toBeInstanceOf(InvalidTransitionError)
  })

  it('snoozes a live item until a timestamp', async () => {
    const { store } = await makeStore()
    const { item } = await store.create(authored())
    const snoozed = await store.snooze(item.id, 1, 9_000)
    expect(snoozed).toMatchObject({ state: 'snoozed', snoozedUntil: 9_000 })
    expect(store.counts()).toMatchObject({ needsYou: 0, snoozed: 1 })
  })

  it('appends deliveries and moves to awaiting when one is delivered', async () => {
    const { store } = await makeStore()
    const { item } = await store.create(authored())
    const sending = await store.recordDelivery(item.id, 1, {
      deliveryId: 'delivery-1',
      at: clockNow,
      track: 'session-message',
      payload: { type: 'text', text: 'yes' },
      state: 'sending',
    })
    expect(sending.state).toBe('open')
    const delivered = await store.recordDelivery(item.id, 2, {
      deliveryId: 'delivery-1',
      at: clockNow + 1,
      track: 'session-message',
      payload: { type: 'text', text: 'yes' },
      state: 'delivered',
    })
    expect(delivered.state).toBe('awaiting')
    expect(delivered.acknowledgement).toEqual({ state: 'pending' })
    expect(delivered.deliveries).toHaveLength(2)
  })

  it('throws NotFoundError for an unknown id', async () => {
    const { store } = await makeStore()
    await expect(store.answer('missing', undefined, { type: 'text', text: 'x' })).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('snooze wake', () => {
  /** Create one authored item and defer it until `until`. */
  async function snoozeOne(store: OpenItemsStore, until: number): Promise<OpenItemRecord> {
    const { item } = await store.create(authored())
    return store.snooze(item.id, item.version, until)
  }

  it('wakes a due snooze on the retention sweep and records it in history', async () => {
    const { store, domain } = await makeStore()
    const record = await snoozeOne(store, clockNow + 500)
    tick(500)
    // The sweep is the path that runs with no browser open.
    await store.sweep()
    const woken = store.get(record.id)
    expect(woken).toMatchObject({ state: 'open', version: record.version + 1 })
    expect(woken?.snoozedUntil).toBeUndefined()
    expect(woken?.history.at(-1)).toMatchObject({ action: 'woken' })
    await store.flush()
    // The durable record carries the same transition, not just the index.
    const durable = domain.tables.get('items')?.get(record.id) as OpenItemRecord | undefined
    expect(durable).toMatchObject({ state: 'open', version: record.version + 1 })
    expect(durable?.snoozedUntil).toBeUndefined()
    expect(durable?.history.at(-1)).toMatchObject({ action: 'woken', detail: expect.stringContaining('snoozed until') })
  })

  it('wakes a due snooze on a snapshot read even when no sweep has run', async () => {
    const { store, domain } = await makeStore()
    const record = await snoozeOne(store, clockNow + 500)
    tick(500)
    // The very first read after the instant is the one that must show it open.
    const snapshot = store.all()
    expect(snapshot.find(entry => entry.id === record.id)).toMatchObject({ state: 'open', version: record.version + 1 })
    await store.flush()
    const durable = domain.tables.get('items')?.get(record.id) as OpenItemRecord | undefined
    expect(durable).toMatchObject({ state: 'open', version: record.version + 1 })
    expect(durable?.history.at(-1)).toMatchObject({ action: 'woken' })
  })

  it('moves the counts from snoozed to needs-you on the read that wakes the item', async () => {
    const { store } = await makeStore()
    const record = await snoozeOne(store, clockNow + 500)
    // Still inside the deferral: the item is in the Snoozed band, not Needs you.
    expect(store.counts()).toMatchObject({ needsYou: 0, snoozed: 1 })
    tick(500)
    // The same read that finds the due instant wakes the record and counts it.
    expect(store.counts()).toMatchObject({ needsYou: 1, snoozed: 0 })
    expect(store.get(record.id)).toMatchObject({ state: 'open' })
  })

  it('leaves a future snooze alone', async () => {
    const { store } = await makeStore()
    const record = await snoozeOne(store, clockNow + 10_000)
    expect(store.all().find(entry => entry.id === record.id)).toMatchObject({ state: 'snoozed' })
    await store.sweep()
    expect(store.get(record.id)).toMatchObject({
      state: 'snoozed',
      snoozedUntil: record.snoozedUntil,
      version: record.version,
    })
    expect(store.counts()).toMatchObject({ needsYou: 0, snoozed: 1 })
    expect(store.get(record.id)?.history.some(entry => entry.action === 'woken')).toBe(false)
  })

  it('wakes once: repeated reads and sweeps do not wake or bump the version again', async () => {
    const { store, domain } = await makeStore()
    const record = await snoozeOne(store, clockNow + 500)
    tick(500)
    store.all()
    await store.flush()
    const wokenVersion = store.get(record.id)?.version
    const writes = domain.writes()
    expect(store.wakeDue()).toBe(0)
    store.all()
    store.counts()
    await store.sweep()
    await store.flush()
    expect(store.get(record.id)?.version).toBe(wokenVersion)
    expect(store.get(record.id)?.history.filter(entry => entry.action === 'woken')).toHaveLength(1)
    expect(domain.writes()).toBe(writes)
  })
})

describe('capture sink', () => {
  it('creates one derived record per artifact and merges re-raises', async () => {
    const { store } = await makeStore()
    expect(await store.upsertDerived([derived()])).toBe(1)
    const first = store.all()[0]!
    expect(first).toMatchObject({
      kind: 'approval',
      state: 'open',
      tier: 'structural',
      severity: 1,
      blocking: true,
      detectedBy: ['projection'],
      dedupeKey: 'derived|approval|session-1|approval:call_1',
    })
    expect(first.source).toMatchObject({ sessionId: 'session-1' })

    tick()
    expect(await store.upsertDerived([derived({ title: 'Approve: delete the staging volume (again)?' })])).toBe(1)
    expect(store.all()).toHaveLength(1)
    const updated = store.get(first.id)!
    expect(updated.title).toBe('Approve: delete the staging volume (again)?')
    expect(updated.version).toBe(2)
    expect(updated.occurrences).toHaveLength(1)
    expect(updated.history.at(-1)?.action).toBe('re-raised')
  })

  it('records distinct occurrences for distinct sightings', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([derived()])
    tick()
    await store.upsertDerived([derived({ seq: 12, sessionTitle: 'Deploy day' })])
    const record = store.all()[0]!
    expect(record.occurrences).toHaveLength(2)
    expect(record.occurrences.at(-1)).toMatchObject({ sessionId: 'session-1', seq: 12 })
    expect(record.source.sessionTitle).toBe('Deploy day')
  })

  it('never reopens a decision the user already settled (authored beats derived)', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([derived()])
    const record = store.all()[0]!
    await store.dismiss(record.id, record.version, 'we decided in the chat')
    tick()
    expect(await store.upsertDerived([derived()])).toBe(1)
    const settled = store.get(record.id)!
    expect(settled.state).toBe('resolved')
    expect(settled.resolution?.kind).toBe('dismissed')
    expect(settled.history.at(-1)?.action).toBe('re-raise-suppressed')
  })

  it('reopens a detector-closed item when the artifact reappears', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([derived()])
    const record = store.all()[0]!
    await store.resolve(record.id, record.version, {
      kind: 'detected-closed',
      at: clockNow,
      actor: 'detector',
      payload: { type: 'detector', code: 'approval/decided' },
    })
    tick()
    await store.upsertDerived([derived()])
    const reopened = store.get(record.id)!
    expect(reopened.state).toBe('open')
    expect(reopened.reopenCount).toBe(1)
    expect(reopened.resolutionLog?.[0]?.kind).toBe('detected-closed')
  })

  it('resolves the target of a draft that closes an artifact', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([derived()])
    tick(5)
    const closed = await store.upsertDerived([derived({
      artifactId: 'approval:call_1',
      closes: { artifactId: 'approval:call_1', kind: 'detected-closed', code: 'approval/decided', at: clockNow },
    })])
    expect(closed).toBe(1)
    const record = store.all()[0]!
    expect(record.state).toBe('resolved')
    expect(record.resolution?.payload).toEqual({ type: 'detector', code: 'approval/decided' })
  })

  it('honours a suppressor before creating a candidate', async () => {
    const { store } = await makeStore()
    await store.putSuppressor({
      dedupePrefix: 'derived|risk|session-1|',
      kindFamily: 'risk',
      createdAt: clockNow,
    })
    const suppressed = await store.upsertDerived([derived({
      kind: 'risk',
      tier: 'candidate',
      artifactId: 'risk:job_4',
      title: 'Could the job be stuck?',
    })])
    expect(suppressed).toBe(0)
    expect(store.all()).toHaveLength(0)
  })
})

describe('caps and corruption', () => {
  it('archives the oldest live item instead of refusing at the live cap', async () => {
    const { store } = await makeStore({ maxLiveItems: 2 })
    const first = await store.create(authored({ title: 'First?' }))
    tick()
    await store.create(authored({ title: 'Second?' }))
    tick()
    const third = await store.create(authored({ title: 'Third?' }))
    expect(third.deduped).toBe(false)
    expect(store.countLive()).toBe(2)
    expect(store.get(first.item.id)?.state).toBe('archived')
  })

  it('never counts resolved records against the live cap', async () => {
    const { store } = await makeStore({ maxLiveItems: 2 })
    const { item } = await store.create(authored({ title: 'Only one?' }))
    await store.dismiss(item.id, 1, 'done')
    expect(store.countLive()).toBe(0)
    await store.create(authored({ title: 'One?' }))
    await store.create(authored({ title: 'Two?' }))
    // Two live items fit the cap exactly; the dismissed record is untouched.
    expect(store.countLive()).toBe(2)
    expect(store.get(item.id)?.state).toBe('resolved')
  })

  it('quarantines a corrupt stored record and keeps the valid ones', async () => {
    const domain = createFakeDomain({
      records: {
        items: [
          JSON.parse(JSON.stringify({
            schemaVersion: 3,
            id: 'valid-item',
            origin: 'install-1',
            kind: 'decision',
            state: 'open',
            tier: 'structural',
            severity: 2,
            title: 'Valid',
            body: '',
            source: { sessionId: 'session-1' },
            blocking: true,
            reply: { controls: ['text'], freeText: true, requiresConfirm: false },
            deliveries: [],
            occurrences: [{ sessionId: 'session-1', seenAt: 1 }],
            dedupeKey: 'authored|decision|session-1|valid',
            detectedBy: ['tool'],
            firstSeenAt: 1,
            lastSeenAt: 1,
            updatedAt: 1,
            version: 1,
            reopenCount: 0,
            retention: { class: 'active' },
            history: [{ at: 1, action: 'raised' }],
          })),
          { schemaVersion: 3, id: 'corrupt-item' },
        ],
      },
    })
    const { store } = await makeStore({ domain })
    expect(store.get('valid-item')).toBeDefined()
    expect(store.get('corrupt-item')).toBeUndefined()
    expect(domain.quarantined).toHaveLength(1)
    expect(domain.quarantined[0]).toMatchObject({ table: 'items', key: 'corrupt-item' })
  })

  it('archives snoozed items too when the cap needs a slot', async () => {
    const { store } = await makeStore({ maxLiveItems: 2 })
    const first = await store.create(authored({ title: 'Snooze me?' }))
    await store.snooze(first.item.id, first.item.version, 9_000)
    await store.create(authored({ title: 'Second?' }))
    await store.create(authored({ title: 'Third?' }))
    expect(store.get(first.item.id)?.state).toBe('archived')
    expect(store.countLive()).toBe(2)
  })
})

describe('delete forever', () => {
  it('writes a tombstone: identity kept, transcript text dropped, counts exclude it', async () => {
    const { store } = await makeStore()
    const { item } = await store.create(authored({ title: 'Delete me?', body: 'sensitive body', quote: 'a quote' }))
    const tombstone = await store.deleteForever(item.id, item.version)

    expect(tombstone).toMatchObject({
      id: item.id,
      state: 'resolved',
      title: TOMBSTONE_TITLE,
      body: '',
      deletedAt: clockNow,
      version: item.version + 1,
      retention: { class: 'archived', archivedAt: clockNow },
      resolution: { kind: 'dismissed', actor: 'user', payload: { type: 'dismiss', reason: 'deleted forever' } },
      acknowledgement: { state: 'none' },
    })
    expect(tombstone.quote).toBeUndefined()
    expect(tombstone.deliveries).toEqual([])
    expect(tombstone.occurrences).toEqual([])
    expect(tombstone.source).toEqual({ sessionId: 'session-1' })
    // Identity and dedupe data stay so a later fold cannot resurrect it.
    expect(tombstone.dedupeKey).toBe(item.dedupeKey)
    expect(tombstone.kind).toBe(item.kind)
    expect(tombstone.history.map(entry => entry.action)).toEqual(['deleted-forever'])
    // The domain keeps the tombstone; every count surface excludes it.
    expect(store.all()).toHaveLength(1)
    expect(store.counts()).toEqual({ needsYou: 0, candidates: 0, awaiting: 0, snoozed: 0, resolved: 0 })
  })

  it('is idempotent for the same CAS token, conflicts on a stale one and never resurrects via a fold', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([derived()])
    const record = store.all()[0]!
    const tombstone = await store.deleteForever(record.id, record.version)

    // Repeat after a lost response: same token → same tombstone, no bump.
    const again = await store.deleteForever(record.id, tombstone.version)
    expect(again).toMatchObject({ deletedAt: tombstone.deletedAt, version: tombstone.version })
    await expect(store.deleteForever(record.id, record.version)).rejects.toBeInstanceOf(ConflictError)
    await expect(store.deleteForever('missing', 1)).rejects.toBeInstanceOf(NotFoundError)

    // The same artifact re-appearing in a later fold must not reopen the item.
    tick()
    expect(await store.upsertDerived([derived()])).toBe(0)
    expect(store.get(record.id)?.deletedAt).toBe(tombstone.deletedAt)
    expect(store.all()).toHaveLength(1)
  })
})

describe('detector resolution evidence', () => {
  /** Open one derived artifact, close it with a detector code and read the evidence. */
  async function evidenceFor(code: string): Promise<string | undefined> {
    const { store } = await makeStore()
    await store.upsertDerived([derived()])
    const record = store.all()[0]!
    tick()
    await store.upsertDerived([derived({
      closes: { artifactId: 'approval:call_1', kind: 'detected-closed', code, at: clockNow },
    })])
    return store.get(record.id)?.acknowledgement?.evidence?.kind
  }

  it('records the real evidence kind for every closure detector', async () => {
    expect(await evidenceFor('goal/change:active')).toBe('goal-resumed')
    expect(await evidenceFor('goal/change:clear')).toBe('goal-resumed')
    expect(await evidenceFor('team/task:completed')).toBe('task-completed')
    expect(await evidenceFor('turn/start:superseded')).toBe('turn-continued')
    expect(await evidenceFor('tool/result')).toBe('tool-result')
    expect(await evidenceFor('tool/call:retried')).toBe('call-retried')
    expect(await evidenceFor('approval/decided:allowed-once')).toBe('call-retried')
    expect(await evidenceFor('job/settled')).toBe('tool-result')
  })

  it('falls back to the previous kind for an unknown detector code', async () => {
    expect(await evidenceFor('future/detector')).toBe('tool-result')
    expect(detectorEvidenceKind('future/detector')).toBe('tool-result')
    expect(detectorEvidenceKind('goal/change:blocked')).toBe('goal-resumed')
  })

  it('records observed with the closure time on a detector resolution', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([derived()])
    const record = store.all()[0]!
    tick(5)
    await store.upsertDerived([derived({
      closes: { artifactId: 'approval:call_1', kind: 'detected-closed', code: 'team/task:completed', at: clockNow },
    })])
    const resolved = store.get(record.id)!
    expect(resolved.acknowledgement).toEqual({
      state: 'observed',
      at: clockNow,
      evidence: { kind: 'task-completed' },
    })
    expect(resolved.resolution?.payload).toEqual({ type: 'detector', code: 'team/task:completed' })
  })
})

/* ------------------------------------------------------------------ *
 * Settings (contract PLAN-remediation §1)
 * ------------------------------------------------------------------ */

describe('settings', () => {
  it('serves the defaults without materialising a meta row', async () => {
    const { store, domain } = await makeStore()
    const writesBefore = domain.writes()
    expect(store.settings()).toEqual({
      schemaVersion: 1,
      version: 0,
      modelNudge: false,
      proseCandidates: true,
      llmExtraction: false,
    })
    // Reading twice still writes nothing: the defaults are not a stored record.
    expect(store.settings().proseCandidates).toBe(true)
    expect(domain.writes()).toBe(writesBefore)
    const meta = [...(domain.tables.get('meta')?.keys() ?? [])]
    expect(meta).toEqual(['install'])
  })

  it('writes with compare-and-set and merges one patch at a time', async () => {
    const { store } = await makeStore()
    const first = await store.setSettings(0, { modelNudge: true })
    expect(first).toEqual({
      status: 'written',
      settings: { schemaVersion: 1, version: 1, modelNudge: true, proseCandidates: true, llmExtraction: false },
    })
    // A fresh read sees the written record, not the defaults.
    expect(store.settings().version).toBe(1)

    const second = await store.setSettings(1, { proseCandidates: false })
    expect(second).toEqual({
      status: 'written',
      settings: { schemaVersion: 1, version: 2, modelNudge: true, proseCandidates: false, llmExtraction: false },
    })
    // The untouched field survives the merge.
    expect(store.settings()).toMatchObject({ modelNudge: true, proseCandidates: false, version: 2 })
  })

  it('returns the live record on a stale CAS token without overwriting it', async () => {
    const { store, domain } = await makeStore()
    await store.setSettings(0, { modelNudge: true })
    const writesBefore = domain.writes()
    const stale = await store.setSettings(0, { proseCandidates: false })
    expect(stale).toEqual({
      status: 'conflict',
      settings: { schemaVersion: 1, version: 1, modelNudge: true, proseCandidates: true, llmExtraction: false },
    })
    expect(domain.writes()).toBe(writesBefore)
    // The optimistic write never landed: the stored record is untouched.
    expect(store.settings()).toMatchObject({ modelNudge: true, proseCandidates: true, version: 1 })

    // A write ahead of the stored version is a conflict too, never a silent bump.
    expect((await store.setSettings(9, { modelNudge: false })).status).toBe('conflict')
    expect(store.settings().version).toBe(1)
  })

  it('rejects a non-integer CAS token at the store boundary', async () => {
    const { store } = await makeStore()
    await expect(store.setSettings(-1, { modelNudge: true })).rejects.toThrow(/expectedVersion/u)
    await expect(store.setSettings(1.5, { modelNudge: true })).rejects.toThrow(/expectedVersion/u)
  })

  it('persists across a reopen of the same domain', async () => {
    const domain = createFakeDomain()
    const first = await makeStore({ domain })
    await first.store.setSettings(0, { modelNudge: true, proseCandidates: false })

    const second = await makeStore({ domain })
    expect(second.store.settings()).toMatchObject({
      version: 1,
      modelNudge: true,
      proseCandidates: false,
      llmExtraction: false,
    })
    // The install identity is preserved by the shared meta table.
    expect(second.store.installId).toBe(first.store.installId)
  })
})

describe('meta table dispatcher (install + settings share one table)', () => {
  it('parses the install row and the settings row through one validator', () => {
    const install = parseMetaRecord({ installId: 'install-9', createdAt: FIXTURE_T0 })
    expect(install).toEqual({ installId: 'install-9', createdAt: FIXTURE_T0 })
    const settings = parseMetaRecord({
      schemaVersion: 1,
      version: 3,
      modelNudge: true,
      proseCandidates: false,
      llmExtraction: true,
    })
    expect(settings).toEqual({
      schemaVersion: 1,
      version: 3,
      modelNudge: true,
      proseCandidates: false,
      llmExtraction: true,
    })
    expect(parseSettingsRecord(JSON.parse(JSON.stringify(settings)))).toEqual(settings)
    // A row written before `llmExtraction` existed still parses; absent = false.
    expect(parseMetaRecord({ schemaVersion: 1, version: 2, modelNudge: false, proseCandidates: true }))
      .toEqual({ schemaVersion: 1, version: 2, modelNudge: false, proseCandidates: true, llmExtraction: false })

    // The backfill report is the third shape in the same table; `trigger` is
    // what tells it apart from a settings row (both carry `schemaVersion: 1`).
    const rawReport = {
      schemaVersion: 1,
      at: 42,
      trigger: 'rescan',
      eligible: 1,
      folded: 1,
      skipped: 0,
      failed: 0,
      drafts: 1,
      batches: 1,
      deferred: 0,
      durationMs: 7,
    }
    const backfill = parseMetaRecord(rawReport)
    expect(backfill).toEqual(rawReport)
    expect(parseBackfillReportRecord(rawReport)).toEqual(rawReport)
    expect(isBackfillReportRecord(backfill)).toBe(true)
    expect(isSettingsRecord(backfill)).toBe(false)
    expect(isSettingsRecord(settings)).toBe(true)
    expect(() => parseMetaRecord({ nothing: true })).toThrow(/meta/u)
    expect(() => parseSettingsRecord({ schemaVersion: 2, version: 0, modelNudge: false, proseCandidates: true }))
      .toThrow(/schema version/u)
  })
})

/* ------------------------------------------------------------------ *
 * Candidate lifecycle (contract PLAN-remediation §7)
 * ------------------------------------------------------------------ */

/** One open candidate draft (the prose gate's shape, simplified). */
function candidate(overrides: Partial<DerivedItemDraft> = {}): DerivedItemDraft {
  return {
    artifactId: 'prose:abc123',
    kind: 'decision',
    tier: 'candidate',
    severity: 2,
    title: 'Ship the parser this week?',
    body: 'This session ended a turn with a decision request.',
    quote: 'Want me to ship the parser this week?',
    sessionId: 'session-1',
    detectorCode: 'prose-gate:decision-request',
    detectedBy: ['regex-gate'],
    blocking: false,
    reply: { requiresConfirm: true },
    ...overrides,
  }
}

describe('promote', () => {
  it('turns a live candidate into a structural needs-you item', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([candidate()])
    const record = store.all()[0]!
    expect(record).toMatchObject({ tier: 'candidate', blocking: false })
    expect(store.counts()).toMatchObject({ candidates: 1, needsYou: 0 })

    tick()
    const promoted = await store.promote(record.id, record.version)
    expect(promoted).toMatchObject({
      id: record.id,
      tier: 'structural',
      blocking: true,
      severity: 2,
      state: 'open',
      version: record.version + 1,
    })
    expect(promoted.history.at(-1)?.action).toBe('promoted')
    expect(store.counts()).toMatchObject({ candidates: 0, needsYou: 1 })
  })

  it('rejects a stale CAS token and leaves the candidate untouched', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([candidate()])
    const record = store.all()[0]!
    await expect(store.promote(record.id, record.version + 5)).rejects.toBeInstanceOf(ConflictError)
    expect(store.get(record.id)).toMatchObject({ tier: 'candidate', version: record.version })
  })

  it('refuses to promote a structural or settled item', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([derived({ tier: 'structural' })])
    const structural = store.all()[0]!
    await expect(store.promote(structural.id, structural.version)).rejects.toBeInstanceOf(InvalidTransitionError)
    await expect(store.promote('missing', 1)).rejects.toBeInstanceOf(NotFoundError)

    await store.upsertDerived([candidate({ artifactId: 'prose:settled' })])
    const settled = store.all().find(item => item.dedupeKey.endsWith('|prose:settled'))!
    await store.suppress(settled.id, settled.version)
    await expect(store.promote(settled.id, settled.version + 1)).rejects.toBeInstanceOf(InvalidTransitionError)
  })
})

describe('suppress', () => {
  it('dismisses the candidate, records the reason and writes the exact-key suppressor', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([candidate()])
    const record = store.all()[0]!

    tick()
    const suppressed = await store.suppress(record.id, record.version, 'not a real decision')
    expect(suppressed).toMatchObject({
      state: 'resolved',
      tier: 'candidate',
      version: record.version + 1,
      resolution: { kind: 'dismissed', actor: 'user', payload: { type: 'dismiss', reason: 'not a real decision' } },
      acknowledgement: { state: 'none' },
    })
    expect(suppressed.history.at(-1)?.action).toBe('suppressed')

    const suppressor = store.getSuppressor(record.dedupeKey)
    expect(suppressor).toMatchObject({ dedupePrefix: record.dedupeKey, kindFamily: 'decision' })
    expect(store.counts()).toMatchObject({ candidates: 0, resolved: 1 })
  })

  it('makes the same fingerprint un-re-raisable', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([candidate()])
    const record = store.all()[0]!
    await store.suppress(record.id, record.version)

    // The fold sees the same artifact again: the suppressor stops it dead.
    tick()
    expect(await store.upsertDerived([candidate()])).toBe(0)
    expect(store.get(record.id)).toMatchObject({ state: 'resolved' })
    expect(store.counts()).toMatchObject({ candidates: 0, needsYou: 0 })
  })

  it('defaults the reason and refuses a stale/non-candidate suppress', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([candidate()])
    const record = store.all()[0]!

    await expect(store.suppress(record.id, record.version + 3)).rejects.toBeInstanceOf(ConflictError)
    const suppressed = await store.suppress(record.id, record.version)
    expect(suppressed.resolution).toMatchObject({ payload: { type: 'dismiss', reason: 'candidate suppressed' } })
    await expect(store.suppress(record.id, suppressed.version)).rejects.toBeInstanceOf(InvalidTransitionError)

    await store.upsertDerived([derived({ tier: 'structural' })])
    const structural = store.all().find(item => item.tier === 'structural')!
    await expect(store.suppress(structural.id, structural.version)).rejects.toBeInstanceOf(InvalidTransitionError)
    await expect(store.suppress('missing', 1)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('promote correction patch (contract §2.1)', () => {
  it('applies title/body/quote/options in one CAS write and recomputes the reply', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([candidate({ artifactId: 'prose:t4:abcdef123456', turn: 4 })])
    const record = store.all()[0]!
    expect(record.dedupeKey).toBe('derived|decision|session-1|prose:t4:abcdef123456')
    expect(record.reply.requiresConfirm).toBe(true)
    // The candidate kind is preserved when the patch does not touch it.
    expect(record.kind).toBe('decision')

    tick()
    const promoted = await store.promote(record.id, record.version, {
      title: 'Ship the parser this week',
      body: 'Options: (a) ship now, (b) wait for the audit.',
      quote: 'Want me to ship the parser this week?',
      options: ['(a) ship now', '(b) wait for the audit'],
    })
    expect(promoted).toMatchObject({
      kind: 'decision',
      tier: 'structural',
      blocking: true,
      severity: 2,
      state: 'open',
      version: record.version + 1,
      title: 'Ship the parser this week',
      body: 'Options: (a) ship now, (b) wait for the audit.',
      quote: 'Want me to ship the parser this week?',
      options: ['(a) ship now', '(b) wait for the audit'],
      // Kind did not change: identity and audit trail do not either.
      dedupeKey: record.dedupeKey,
    })
    expect(promoted.occurrences).toEqual(record.occurrences)
    expect(promoted.history.map(entry => entry.action)).toEqual(['raised', 'promoted'])
    // Structural defaults replace the candidate's confirm surface.
    expect(promoted.reply).toEqual({
      controls: ['option', 'text'],
      options: ['(a) ship now', '(b) wait for the audit'],
      freeText: true,
      requiresConfirm: false,
    })
  })

  it('rekeys dedupeKey and appends reclassified when the kind changes', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([candidate({
      kind: 'question',
      artifactId: 'prose:t4:abcdef123456',
      title: 'Want me to ship the parser this week?',
      turn: 4,
    })])
    const record = store.all()[0]!
    expect(record.dedupeKey).toBe('derived|question|session-1|prose:t4:abcdef123456')

    tick()
    const promoted = await store.promote(record.id, record.version, {
      kind: 'decision',
      options: ['(a) ship now', '(b) wait'],
    })
    expect(promoted).toMatchObject({
      kind: 'decision',
      tier: 'structural',
      version: record.version + 1,
      dedupeKey: 'derived|decision|session-1|prose:t4:abcdef123456',
    })
    expect(promoted.history.map(entry => entry.action)).toEqual(['raised', 'promoted', 'reclassified'])
    expect(promoted.history.at(-1)?.detail).toBe('question -> decision')
    expect(promoted.reply).toEqual({
      controls: ['option', 'text'],
      options: ['(a) ship now', '(b) wait'],
      freeText: true,
      requiresConfirm: false,
    })
    // Occurrence evidence (the artifact) survives the identity correction.
    expect(promoted.occurrences).toEqual(record.occurrences)
  })

  it('moves an existing exact-key suppressor to the corrected key', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([candidate({ kind: 'question', artifactId: 'prose:t4:abcdef123456', turn: 4 })])
    const record = store.all()[0]!
    // A suppressor can exist for the artifact before the user corrects the row
    // (e.g. a written-off artifact); it must follow the identity.
    await store.putSuppressor({ dedupePrefix: record.dedupeKey, kindFamily: 'question', createdAt: clockNow })

    const promoted = await store.promote(record.id, record.version, { kind: 'decision' })
    expect(store.getSuppressor(record.dedupeKey)).toBeUndefined()
    expect(store.getSuppressor(promoted.dedupeKey)).toMatchObject({
      dedupePrefix: 'derived|decision|session-1|prose:t4:abcdef123456',
      kindFamily: 'decision',
    })
  })

  it('rejects a stale CAS token without applying the patch or rekeying', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([candidate({ kind: 'question', artifactId: 'prose:t4:abcdef123456', turn: 4 })])
    const record = store.all()[0]!
    await expect(store.promote(record.id, record.version + 4, { kind: 'decision', title: 'Corrected' }))
      .rejects.toBeInstanceOf(ConflictError)
    expect(store.get(record.id)).toMatchObject({
      kind: 'question',
      title: 'Ship the parser this week?',
      tier: 'candidate',
      version: record.version,
      dedupeKey: record.dedupeKey,
    })
  })

  it('rejects an unknown kind at the store boundary', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([candidate({ artifactId: 'prose:t4:abcdef123456', turn: 4 })])
    const record = store.all()[0]!
    await expect(store.promote(record.id, record.version, { kind: 'gossip' as never }))
      .rejects.toBeInstanceOf(InvalidArgumentError)
    expect(store.get(record.id)).toMatchObject({ tier: 'candidate', version: record.version })
  })

  it('never lets a candidate re-raise rewrite or demote a promoted item', async () => {
    const { store } = await makeStore()
    const inferred = candidate({ artifactId: 'prose:t4:abcdef123456', turn: 4 })
    await store.upsertDerived([inferred])
    const record = store.all()[0]!
    tick()
    // Patch kind equals the inferred kind, so the identity does not change: the
    // replay's draft key still hits this row, which is exactly the re-raise path.
    const promoted = await store.promote(record.id, record.version, {
      kind: 'decision',
      title: 'E — Ship the parser this week',
      body: 'Confirmed: ship after the audit.',
      quote: 'Want me to ship the parser this week?',
      options: ['(a) ship now', '(b) wait for the audit'],
    })
    expect(promoted.dedupeKey).toBe(record.dedupeKey)
    expect(promoted.history.map(entry => entry.action)).toEqual(['raised', 'promoted'])

    // The post-bump baseline replay re-emits the same artifact as a candidate
    // draft: it must not demote the row or overwrite the user's corrections.
    tick()
    expect(await store.upsertDerived([{ ...inferred, seq: 7 }])).toBe(1)
    const after = store.get(record.id)!
    expect(after).toMatchObject({
      id: record.id,
      kind: promoted.kind,
      tier: 'structural',
      state: 'open',
      blocking: true,
      severity: 2,
      title: 'E — Ship the parser this week',
      body: 'Confirmed: ship after the audit.',
      quote: 'Want me to ship the parser this week?',
      options: ['(a) ship now', '(b) wait for the audit'],
      dedupeKey: promoted.dedupeKey,
      version: promoted.version + 1,
    })
    expect(after.reply).toEqual(promoted.reply)
    expect(after.history.at(-1)).toMatchObject({
      action: 're-raise-suppressed',
      detail: 'prose-gate:decision-request',
    })
    // The replay is a new sighting, not a new item: evidence still merges.
    expect(after.occurrences).toHaveLength(2)
    expect(store.all()).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ *
 * Legacy prose migration (contract §2.2)
 * ------------------------------------------------------------------ */

describe('proseAskKey (reconciliation ask identity)', () => {
  it('normalises markdown, labels and whitespace to one comparable identity', () => {
    const expected = 'want me to ship the parser this week?'
    for (const text of [
      '- **E** — Want me to ship the parser this week?',
      '**E** — Want me to ship the parser this week?',
      'E — Want me to ship the parser this week?',
      'E: Want me to ship the parser this week?',
      'E. Want me to ship the parser this week?',
      '(E) Want me to ship the parser this week?',
      '(E) — Want me to ship the parser this week?',
      'E) Want me to ship the parser this week?',
      '1) Want me to ship the parser this week?',
      '## Want me to ship the parser this week?',
      '`Want me to ship the parser this week?`',
      '  Want   me to ship the parser this week?  ',
    ]) {
      expect(proseAskKey(text), text).toBe(expected)
    }
  })

  it('keeps distinct asks distinct and blanks blank', () => {
    expect(proseAskKey('E — Ship it now?')).not.toBe(proseAskKey('E — Wait for the audit?'))
    expect(proseAskKey('')).toBe('')
    expect(proseAskKey('   ')).toBe('')
  })
})

/** One live candidate exactly as the pre-split one-artifact gate raised it. */
function legacyProseCandidate(
  id: string,
  overrides: Partial<OpenItemRecord> = {},
): OpenItemRecord {
  const sessionId = overrides.source?.sessionId ?? 'session-1'
  const record = makeItem({
    id,
    kind: 'question',
    state: 'open',
    tier: 'candidate',
    severity: 2,
    title: 'Want me to ship the parser?',
    body: 'Question 1 of 1 from the turn that ended; confirm to turn it into an item.',
    quote: 'Want me to ship the parser?',
    source: { sessionId, turn: 4 },
    blocking: false,
    reply: { controls: ['text'], freeText: true, requiresConfirm: true },
    dedupeKey: `derived|question|${sessionId}|prose:c04dafa9ac3e093d`,
    detectedBy: ['regex-gate'],
    history: [{ at: FIXTURE_T0, action: 'raised', detail: 'prose-gate:decision-request' }],
    ...overrides,
  })
  return record
}

/** One suppressor row as an earlier version of the plugin stored it. */
function suppressorRow(dedupePrefix: string, kindFamily: OpenItemRecord['kind'], createdAt = FIXTURE_T0, expiresAt?: number): unknown {
  return { dedupePrefix, kindFamily, createdAt, ...(expiresAt === undefined ? {} : { expiresAt }) }
}

describe('legacy prose candidate retirement (contract §2.2)', () => {
  it('closes exactly the live pre-split candidates, idempotently, keeping promoted rows', async () => {
    const legacyLive = legacyProseCandidate('legacy-live')
    const legacyStructural = legacyProseCandidate('legacy-promoted', {
      tier: 'structural',
      state: 'open',
      severity: 2,
      blocking: true,
      dedupeKey: 'derived|question|session-1|prose:0123456789abcdef',
      history: [
        { at: FIXTURE_T0, action: 'raised', detail: 'prose-gate:decision-request' },
        { at: FIXTURE_T0 + 1, action: 'promoted' },
      ],
    })
    const perItem = legacyProseCandidate('per-item', {
      dedupeKey: 'derived|question|session-1|prose:t4:abcdef123456',
    })
    const resolvedLegacy = legacyProseCandidate('legacy-resolved', {
      state: 'resolved',
      resolution: { kind: 'detected-closed', at: FIXTURE_T0, actor: 'detector', payload: { type: 'detector', code: 'user/message:superseded' } },
      resolvedAt: FIXTURE_T0,
    })
    const domain = createFakeDomain({
      records: { items: [legacyLive, legacyStructural, perItem, resolvedLegacy] },
    })
    const { store } = await makeStore({ domain })

    tick(10)
    expect(await store.retireLegacyProseCandidates()).toBe(1)
    const retired = store.get('legacy-live')!
    expect(retired).toMatchObject({
      state: 'resolved',
      version: legacyLive.version + 1,
      resolvedAt: clockNow,
      resolution: {
        kind: 'detected-closed',
        actor: 'detector',
        payload: { type: 'detector', code: 'prose-gate:superseded-by-scope-change' },
      },
    })
    // Audit-visible closure: a history entry was appended.
    expect(retired.history.at(-1)).toMatchObject({ action: 'resolved', detail: 'detected-closed' })
    // Promoted rows, per-item rows and settled rows are never touched.
    expect(store.get('legacy-promoted')).toMatchObject({ state: 'open', tier: 'structural', version: legacyStructural.version })
    expect(store.get('per-item')).toMatchObject({ state: 'open', tier: 'candidate', version: perItem.version })
    expect(store.get('legacy-resolved')).toMatchObject({ state: 'resolved' })
    // Idempotent: a second activation closes nothing.
    expect(await store.retireLegacyProseCandidates()).toBe(0)
  })

  it('migrates legacy prose suppressors to both session-scoped family prefixes', async () => {
    const legacyQuestion = 'derived|question|session-1|prose:c04dafa9ac3e093d'
    const legacyDecision = 'derived|decision|session-2|prose:0123456789abcdef'
    const unrelated = 'derived|risk|session-1|job:j1'
    const domain = createFakeDomain({
      records: {
        suppressors: [
          suppressorRow(legacyQuestion, 'question', FIXTURE_T0, FIXTURE_T0 + 500),
          suppressorRow(legacyDecision, 'decision', FIXTURE_T0),
          suppressorRow(unrelated, 'risk'),
        ],
      },
    })
    const { store } = await makeStore({ domain })

    expect(await store.migrateLegacyProseSuppressors()).toBe(2)
    // The legacy exact keys are gone; the session-scoped per-kind prefixes exist.
    expect(store.getSuppressor(legacyQuestion)).toBeUndefined()
    expect(store.getSuppressor(legacyDecision)).toBeUndefined()
    expect(store.getSuppressor('derived|question|session-1|prose:')).toMatchObject({
      dedupePrefix: 'derived|question|session-1|prose:',
      kindFamily: 'question',
      createdAt: FIXTURE_T0,
      expiresAt: FIXTURE_T0 + 500,
    })
    expect(store.getSuppressor('derived|decision|session-1|prose:')).toMatchObject({ kindFamily: 'decision' })
    expect(store.getSuppressor('derived|question|session-2|prose:')).toMatchObject({ kindFamily: 'question' })
    expect(store.getSuppressor('derived|decision|session-2|prose:')).toMatchObject({ kindFamily: 'decision' })
    expect(store.getSuppressor(unrelated)).toMatchObject({ dedupePrefix: unrelated })
    // Idempotent: the legacy rows are the migration's only input.
    expect(await store.migrateLegacyProseSuppressors()).toBe(0)

    // The migrated suppressor still blocks a *per-item* prose candidate (the
    // session-1 rows inherited an expiry, so use the unbounded session-2 one).
    expect(await store.upsertDerived([candidate({
      kind: 'question',
      artifactId: 'prose:t9:fedcba987654',
      sessionId: 'session-2',
      turn: 9,
    })])).toBe(0)
  })

  it('closes a replayed duplicate of a kind-corrected promotion (one row after)', async () => {
    const { store } = await makeStore()
    const artifactId = 'prose:t4:abcdef123456'
    const inferred = candidate({ kind: 'question', artifactId, turn: 4 })
    await store.upsertDerived([inferred])
    const record = store.all()[0]!
    const promoted = await store.promote(record.id, record.version, { kind: 'decision' })

    // The post-bump replay re-emits the same inferred artifact: its kind (and so
    // its key) differs from the rekeyed promoted row, which would be a duplicate.
    tick()
    expect(await store.upsertDerived([inferred])).toBe(1)
    expect(store.all()).toHaveLength(2)

    expect(await store.reconcileProseCandidates()).toBe(1)
    const live = store.all().filter(item => item.state === 'open')
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ id: record.id, kind: 'decision', tier: 'structural' })
    const duplicate = store.all().find(item => item.tier === 'candidate')!
    expect(duplicate).toMatchObject({
      state: 'resolved',
      resolution: {
        kind: 'detected-closed',
        actor: 'detector',
        payload: { type: 'detector', code: 'prose-gate:duplicate-of-promoted' },
      },
    })
    // Idempotent: the duplicate is settled now.
    expect(await store.reconcileProseCandidates()).toBe(0)
  })

  it('leaves the unconfirmed siblings of a promoted multi-item turn live', async () => {
    // The post-bump baseline replay of a turn where only E was confirmed: the
    // replay re-emits all five items as per-item candidates. A–D are *not*
    // duplicates of E and must stay in the Candidates tab.
    const promoted = makeItem({
      id: 'promoted-e',
      kind: 'decision',
      tier: 'structural',
      state: 'open',
      severity: 2,
      blocking: true,
      title: '- **E** — Want me to ship the parser this week?',
      quote: '- **E** — Want me to ship the parser this week?',
      source: { sessionId: 'session-1', turn: 4 },
      dedupeKey: 'derived|decision|session-1|prose:0123456789abcdef',
      detectedBy: ['regex-gate'],
      reply: { controls: ['text'], freeText: true, requiresConfirm: false },
      history: [
        { at: FIXTURE_T0, action: 'raised', detail: 'prose-gate:decision-request' },
        { at: FIXTURE_T0 + 1, action: 'promoted' },
      ],
    })
    const domain = createFakeDomain({ records: { items: [promoted] } })
    const { store } = await makeStore({ domain })
    await store.upsertDerived([
      candidate({ artifactId: 'prose:t4:aaaaaaaaaaaa', turn: 4, title: 'A — Ship it now?', quote: 'A — Ship it now?' }),
      candidate({ artifactId: 'prose:t4:bbbbbbbbbbbb', turn: 4, title: 'B — Wait for the audit?', quote: 'B — Wait for the audit?' }),
      candidate({ artifactId: 'prose:t4:cccccccccccc', turn: 4, title: 'C — Keep both flags?', quote: 'C — Keep both flags?' }),
      candidate({ artifactId: 'prose:t4:dddddddddddd', turn: 4, title: 'D — Update the docs?', quote: 'D — Update the docs?' }),
      candidate({
        artifactId: 'prose:t4:eeeeeeeeeeee',
        turn: 4,
        title: 'E — Want me to ship the parser this week?',
        quote: 'E — Want me to ship the parser this week?',
      }),
    ])
    expect(store.all().filter(item => item.tier === 'candidate' && item.state === 'open')).toHaveLength(5)

    // Only the ask whose normalised identity matches the promoted E is closed.
    expect(await store.reconcileProseCandidates()).toBe(1)
    const liveSiblings = store.all()
      .filter(item => item.tier === 'candidate' && item.state === 'open')
      .map(item => item.title.charAt(0))
      .sort()
    expect(liveSiblings).toEqual(['A', 'B', 'C', 'D'])
    expect(store.all().find(item => item.dedupeKey.endsWith('|prose:t4:eeeeeeeeeeee'))).toMatchObject({
      state: 'resolved',
      resolution: {
        kind: 'detected-closed',
        actor: 'detector',
        payload: { type: 'detector', code: 'prose-gate:duplicate-of-promoted' },
      },
    })
    expect(store.get('promoted-e')).toMatchObject({ tier: 'structural' })
  })

  it('leaves other turns, other families and rows without a turn alone', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([candidate({
      artifactId: 'prose:t4:aaaaaaaaaaaa',
      turn: 4,
      title: 'A — Ship it now?',
      quote: 'A — Ship it now?',
    })])
    const promotedRow = store.all()[0]!
    await store.promote(promotedRow.id, promotedRow.version)

    await store.upsertDerived([
      // Same ask identity, different turn: not a duplicate of this promotion.
      candidate({
        artifactId: 'prose:t5:cccccccccccc',
        turn: 5,
        title: 'A — Ship it now?',
        quote: 'A — Ship it now?',
      }),
      // Same turn, different ask: a sibling, not a duplicate.
      candidate({
        artifactId: 'prose:t4:bbbbbbbbbbbb',
        turn: 4,
        title: 'B — Wait for the audit?',
        quote: 'B — Wait for the audit?',
      }),
      // Same turn, but another detector family.
      derived({ tier: 'candidate', artifactId: 'approval:other', turn: 4 }),
      // No turn recorded: cannot be grouped, never closed speculatively.
      candidate({ artifactId: 'prose:no-turn', title: 'A — Ship it now?', quote: 'A — Ship it now?' }),
    ])
    expect(await store.reconcileProseCandidates()).toBe(0)
    expect(store.all().find(item => item.dedupeKey.endsWith('|prose:t5:cccccccccccc'))?.state).toBe('open')
    expect(store.all().find(item => item.dedupeKey.endsWith('|prose:t4:bbbbbbbbbbbb'))?.state).toBe('open')
    expect(store.all().find(item => item.dedupeKey.endsWith('|approval:other'))?.state).toBe('open')
    expect(store.all().find(item => item.dedupeKey.endsWith('|prose:no-turn'))?.state).toBe('open')
  })

  it('is a no-op when no prose item was ever promoted', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([candidate({ turn: 4 })])
    expect(await store.reconcileProseCandidates()).toBe(0)
    expect(store.all()[0]?.state).toBe('open')
  })
})

describe('team-task retirement (decision D5)', () => {
  /** One derived task item exactly as the disabled fold used to raise it. */
  function teamTask(overrides: Partial<DerivedItemDraft> = {}): DerivedItemDraft {
    return {
      artifactId: 'team-task:task_1',
      kind: 'task',
      tier: 'structural',
      severity: 2,
      title: 'Teammate task stalled: Review the PR',
      body: 'A shared task is still in progress while its owning session is not running.',
      sessionId: 'session-1',
      taskId: 'task_1',
      detectorCode: 'team/task:in-progress-orphan',
      detectedBy: ['projection'],
      blocking: false,
      ...overrides,
    }
  }

  it('closes open derived team-task rows with an audit-visible detector code', async () => {
    const { store } = await makeStore()
    await store.upsertDerived([teamTask()])
    const record = store.all()[0]!

    tick()
    expect(await store.retireTeamTaskItems()).toBe(1)
    const retired = store.get(record.id)!
    expect(retired).toMatchObject({
      state: 'resolved',
      version: record.version + 1,
      resolution: {
        kind: 'detected-closed',
        actor: 'detector',
        payload: { type: 'detector', code: 'team/task:alerts-disabled' },
      },
    })
    // The evidence kind is the family's own, so the register says "task completed".
    expect(retired.acknowledgement?.evidence?.kind).toBe('task-completed')
    expect(retired.history.at(-1)).toMatchObject({ action: 'resolved', detail: 'detected-closed' })

    // Idempotent: a second activation finds nothing to retire.
    expect(await store.retireTeamTaskItems()).toBe(0)
  })

  it('leaves authored tasks, other derived families and settled rows untouched', async () => {
    const { store } = await makeStore()
    await store.create({ kind: 'task', title: 'An authored task?', sessionId: 'session-1' })
    await store.upsertDerived([teamTask({ artifactId: 'team-task:task_2', taskId: 'task_2' })])
    await store.upsertDerived([derived({ tier: 'structural' })])
    const task = store.all().find(record => record.dedupeKey.startsWith('derived|task|'))!
    await store.resolve(task.id, task.version, {
      kind: 'detected-closed', at: clockNow, actor: 'detector',
      payload: { type: 'detector', code: 'team/task:completed' },
    })

    expect(await store.retireTeamTaskItems()).toBe(0)
    expect(store.all().find(record => record.kind === 'task' && record.dedupeKey.startsWith('authored|'))?.state).toBe('open')
    expect(store.get(task.id)?.resolution?.payload).toEqual({ type: 'detector', code: 'team/task:completed' })
  })
})

/* ------------------------------------------------------------------ *
 * Settings: llmExtraction, the third opt-in (contract §12.1)
 * ------------------------------------------------------------------ */

describe('llmExtraction setting', () => {
  it('defaults off and merges independently of the other toggles', async () => {
    const { store } = await makeStore()
    expect(store.settings().llmExtraction).toBe(false)

    const enabled = await store.setSettings(0, { llmExtraction: true })
    expect(enabled).toEqual({
      status: 'written',
      settings: {
        schemaVersion: 1,
        version: 1,
        modelNudge: false,
        proseCandidates: true,
        llmExtraction: true,
      },
    })
    // A later patch of a different field keeps the new one.
    await store.setSettings(1, { modelNudge: true })
    expect(store.settings()).toMatchObject({ modelNudge: true, llmExtraction: true, version: 2 })
    // Explicit false turns it back off.
    await store.setSettings(2, { llmExtraction: false })
    expect(store.settings().llmExtraction).toBe(false)
  })

  it('reads a stored row written before the field existed as off, and can upgrade it', async () => {
    const domain = createFakeDomain()
    // Exactly what a real domain load does to a pre-round-2 settings row.
    domain.tables.get('meta')!.set('settings', parseMetaRecord({
      schemaVersion: 1,
      version: 4,
      modelNudge: true,
      proseCandidates: false,
    }))
    const { store } = await makeStore({ domain })
    expect(store.settings()).toEqual({
      schemaVersion: 1,
      version: 4,
      modelNudge: true,
      proseCandidates: false,
      llmExtraction: false,
    })
    const upgraded = await store.setSettings(4, { llmExtraction: true })
    expect(upgraded).toMatchObject({ status: 'written', settings: { version: 5, llmExtraction: true } })
  })
})

/* ------------------------------------------------------------------ *
 * Durable backfill report (contract §12.5)
 * ------------------------------------------------------------------ */

describe('durable backfill report', () => {
  /** One valid completed-pass report. */
  function report(overrides: Partial<Parameters<OpenItemsStore['putBackfillReport']>[0]> = {}) {
    return {
      schemaVersion: 1 as const,
      at: 5_000,
      trigger: 'activation' as const,
      eligible: 12,
      folded: 10,
      skipped: 2,
      failed: 0,
      drafts: 3,
      batches: 4,
      deferred: 1,
      durationMs: 250,
      ...overrides,
    }
  }

  it('is absent before the first pass and round-trips by replacement', async () => {
    const { store } = await makeStore()
    expect(store.backfillReport()).toBeUndefined()

    await store.putBackfillReport(report())
    expect(store.backfillReport()).toEqual(report())
    // A rescan pass replaces the record (the report is last-pass state, not a log).
    const rescan = report({ trigger: 'rescan', at: 9_000, eligible: 20, drafts: 5 })
    await store.putBackfillReport(rescan)
    expect(store.backfillReport()).toEqual(rescan)
  })

  it('survives a reopen of the same domain', async () => {
    const domain = createFakeDomain()
    const first = await makeStore({ domain })
    await first.store.putBackfillReport(report())
    const second = await makeStore({ domain })
    expect(second.store.backfillReport()).toEqual(report())
    // Counts only: the durable record carries no session identity or content.
    expect(JSON.stringify(second.store.backfillReport())).not.toMatch(/session-/u)
  })

  it('rejects a malformed report at the store boundary', async () => {
    const { store } = await makeStore()
    await expect(store.putBackfillReport({ ...report(), trigger: 'manual' } as never)).rejects.toThrow(/trigger/u)
    await expect(store.putBackfillReport({ ...report(), eligible: -1 } as never)).rejects.toThrow(/eligible/u)
    expect(store.backfillReport()).toBeUndefined()
  })
})
