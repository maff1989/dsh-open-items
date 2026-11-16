/**
 * `ctx.openItems` on a real Cordis context (the service extension point).
 */
import { describe, expect, it } from 'vitest'

import { Context } from '@deepseek-ai/cordis'

import { OpenItemsService } from '../src/host/service'
import { OpenItemsStore } from '../src/host/store'
import { createFakeDomain, type FakeDomain } from './fake-domain'

/** Open a store over a fake storage-domain facility mounted on a real context. */
async function mount(options: { maxLiveItems?: number } = {}): Promise<{ ctx: Context; service: OpenItemsService; store: OpenItemsStore; domain: FakeDomain }> {
  const domain = createFakeDomain()
  const ctx = new Context()
  ctx.provide('storageDomain', { open: async () => domain })
  const store = await OpenItemsStore.open(ctx, { now: () => 5_000, ...options })
  const service = new OpenItemsService(ctx, store)
  return { ctx, service, store, domain }
}

describe('ctx.openItems', () => {
  it('publishes the service and exposes the v3 read surface', async () => {
    const { ctx, service, store } = await mount()
    expect(ctx.openItems).toBeDefined()
    expect(ctx.openItems.installId).toBe(store.installId)
    expect(ctx.openItems.schemaVersion).toBe(3)
    expect(ctx.openItems.protocolVersion).toBe(1)
    expect(ctx.openItems.counts()).toMatchObject({ needsYou: 0, resolved: 0 })
    expect(ctx.openItems.list().items).toEqual([])
    expect(ctx.openItems.register().total).toBe(0)
  })

  it('creates, answers and acknowledges through the published surface', async () => {
    const { ctx } = await mount()
    const { item, deduped } = await ctx.openItems.create({
      kind: 'question',
      title: 'Which workspace should this run in?',
      sessionId: 'session-7',
      workspace: { workspaceId: 'w1', title: 'api' },
    })
    expect(deduped).toBe(false)
    expect(ctx.openItems.counts().needsYou).toBe(1)
    expect(ctx.openItems.list().items.map(row => row.id)).toEqual([item.id])
    expect(ctx.openItems.list().workspaces[0]).toMatchObject({ workspaceId: 'w1', itemCount: 1 })

    await ctx.openItems.answer(item.id, item.version, { type: 'text', text: 'the default one' })
    expect(ctx.openItems.counts()).toMatchObject({ needsYou: 0, awaiting: 1 })
    expect(ctx.openItems.list({ status: 'awaiting' }).items.map(row => row.id)).toEqual([item.id])
    expect(ctx.openItems.register().items.map(row => row.id)).toEqual([item.id])

    const acknowledged = await ctx.openItems.acknowledge(item.id, { kind: 'turn-continued', seq: 3 })
    expect(acknowledged?.state).toBe('resolved')
    expect(ctx.openItems.register().items[0]?.acknowledgement).toEqual({
      state: 'observed',
      at: 5_000,
      evidence: { kind: 'turn-continued', seq: 3 },
    })
    expect(ctx.openItems.counts().resolved).toBe(1)
    await ctx.openItems.flush()
    await ctx.openItems.close()
  })
})

describe('snooze wake on read', () => {
  it('wakes a due snooze on a fresh list read and moves the counts in the same snapshot', async () => {
    const { service } = await mount()
    const { item } = await service.create({
      kind: 'decision',
      title: 'Pick the rollout window?',
      sessionId: 'session-1',
    })
    // Due at the mounted clock (5_000). The item was snoozed after the boot
    // sweep, so no sweep has run since: this read is what must wake it.
    await service.snooze(item.id, item.version, 5_000)
    const snapshot = service.list({ status: 'all', states: ['open', 'stale', 'snoozed'] })
    expect(snapshot.items.find(row => row.id === item.id)).toMatchObject({ state: 'open' })
    // The snapshot's own counts were computed after the wake: same read, moved.
    expect(snapshot.counts).toMatchObject({ needsYou: 1, snoozed: 0 })

    // The durable record is open at its new version, so the item is answerable
    // again (the reply path requires `open`).
    await service.flush()
    const woken = service.get(item.id)!
    expect(woken).toMatchObject({ state: 'open', version: item.version + 2 })
    expect(woken.history.at(-1)).toMatchObject({ action: 'woken' })
    await service.answer(item.id, woken.version, { type: 'text', text: 'Friday morning' })
    expect(service.counts()).toMatchObject({ needsYou: 0, awaiting: 1, snoozed: 0 })
    await service.close()
  })

  it('leaves a future snooze in the Snoozed band', async () => {
    const { service } = await mount()
    const { item } = await service.create({
      kind: 'question',
      title: 'Ask again next week?',
      sessionId: 'session-2',
    })
    await service.snooze(item.id, item.version, 5_001)
    const snapshot = service.list({ status: 'all', states: ['snoozed'] })
    expect(snapshot.items.map(row => row.id)).toEqual([item.id])
    expect(snapshot.counts).toMatchObject({ needsYou: 0, snoozed: 1 })
    await service.close()
  })
})

describe('settings surface', () => {
  it('reads defaults, writes through CAS and notifies listeners on written records only', async () => {
    const { ctx, service } = await mount()
    const seen: { version: number; modelNudge: boolean }[] = []
    const unsubscribe = service.onSettingsChange(settings => {
      seen.push({ version: settings.version, modelNudge: settings.modelNudge })
    })

    expect(service.settings()).toMatchObject({ version: 0, modelNudge: false, proseCandidates: true })
    const written = await service.setSettings(0, { modelNudge: true })
    expect(written).toEqual({
      status: 'written',
      settings: { schemaVersion: 1, version: 1, modelNudge: true, proseCandidates: true, llmExtraction: false },
    })
    expect(service.settings().modelNudge).toBe(true)
    expect(seen).toEqual([{ version: 1, modelNudge: true }])

    // A conflict is not a change: listeners must not fire.
    const conflict = await service.setSettings(0, { modelNudge: false })
    expect(conflict.status).toBe('conflict')
    expect(seen).toHaveLength(1)

    unsubscribe()
    await service.setSettings(1, { proseCandidates: false })
    expect(seen).toHaveLength(1)
    await service.close()
  })

  it('passes a promote correction patch and the migration/reconciliation hooks through', async () => {
    const { service, store } = await mount()
    await service.upsertDerived([{
      artifactId: 'prose:t2:abcdef123456',
      kind: 'question',
      tier: 'candidate',
      severity: 2,
      title: 'Inferred question?',
      body: 'Question 1 of 1 from the turn that ended.',
      sessionId: 'session-1',
      turn: 2,
      detectorCode: 'prose-gate:decision-request',
      detectedBy: ['regex-gate'],
      blocking: false,
      reply: { requiresConfirm: true },
    }])
    const candidate = store.all()[0]!

    const promoted = await service.promote(candidate.id, candidate.version, {
      kind: 'decision',
      title: 'Corrected decision?',
    })
    expect(promoted).toMatchObject({
      kind: 'decision',
      tier: 'structural',
      title: 'Corrected decision?',
      dedupeKey: 'derived|decision|session-1|prose:t2:abcdef123456',
    })
    // Migration hooks are exposed on the published service and are no-ops on an
    // already-migrated store.
    expect(await service.retireLegacyProseCandidates()).toBe(0)
    expect(await service.migrateLegacyProseSuppressors()).toBe(0)
    expect(await service.reconcileProseCandidates()).toBe(0)

    const prefix = 'derived|question|session-9|'
    await service.putSuppressor({ dedupePrefix: prefix, kindFamily: 'question', createdAt: 5_000 })
    expect(service.getSuppressor(prefix)).toBeDefined()
    expect(await service.deleteSuppressor(prefix)).toBe(true)
    expect(service.getSuppressor(prefix)).toBeUndefined()
    expect(await service.deleteSuppressor(prefix)).toBe(false)
    await service.close()
  })

  it('passes promote/suppress and the team-task retirement through to the store', async () => {
    const { ctx, service } = await mount()
    const { item } = await service.create({
      kind: 'decision',
      title: 'Confirm me?',
      sessionId: 'session-1',
      tier: 'candidate',
    })
    const promoted = await service.promote(item.id, item.version)
    expect(promoted.tier).toBe('structural')
    // Structural items are not promotable again: the typed transition surfaces.
    await expect(service.promote(item.id, promoted.version)).rejects.toThrow(/promote/u)
    expect(await service.retireTeamTaskItems()).toBe(0)
    await service.close()
    expect(ctx.openItems).toBeDefined()
  })
})

describe('durable backfill report surface', () => {
  it('round-trips a pass report through the published service', async () => {
    const { service } = await mount()
    expect(service.backfillReport()).toBeUndefined()
    const report = {
      schemaVersion: 1 as const,
      at: 5_000,
      trigger: 'activation' as const,
      eligible: 3,
      folded: 2,
      skipped: 1,
      failed: 0,
      drafts: 1,
      batches: 2,
      deferred: 0,
      durationMs: 12,
    }
    await service.putBackfillReport(report)
    expect(service.backfillReport()).toEqual(report)
    await service.close()
  })
})

describe('llmExtraction setting surface', () => {
  it('writes the third toggle and reports it as a change', async () => {
    const { service } = await mount()
    const seen: boolean[] = []
    const off = service.onSettingsChange(settings => seen.push(settings.llmExtraction))
    const written = await service.setSettings(0, { llmExtraction: true })
    expect(written).toMatchObject({ status: 'written', settings: { llmExtraction: true } })
    expect(service.settings().llmExtraction).toBe(true)
    expect(seen).toEqual([true])
    off()
    await service.setSettings(1, { llmExtraction: false })
    expect(seen).toEqual([true])
    await service.close()
  })
})
