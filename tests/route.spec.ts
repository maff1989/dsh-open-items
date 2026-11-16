/**
 * `/api/open-items`: the exact Fetch route over a fake storage-domain store.
 *
 * The route owns transport only — envelope, payload validation, error mapping
 * and capability advertisement — so these tests drive the real `Request`/
 * `Response` pair a browser produces and assert the envelope rather than any
 * Host internals. The reply engine is faked: the delivery layer is a separate
 * branch, and the route's contract is that it delegates verbatim.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, afterAll } from 'vitest'

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { Context } from '@deepseek-ai/cordis'

import type { DerivedItemDraft } from '../src/host/capture-contract'
import { Config } from '../src/host/config'
import type { ReplyEngine } from '../src/host/delivery-contract'
import { apply } from '../src/host/index'
import { ReplyEngineError } from '../src/host/delivery-contract'
import type { OpenItemsRouteDeps } from '../src/host/route'
import { OPEN_ITEMS_ENDPOINTS, createOpenItemsRoute } from '../src/host/route'
import { OpenItemsService } from '../src/host/service'
import { OpenItemsStore } from '../src/host/store'
import { OPEN_ITEMS_ROUTE_PATH, type RouteReply } from '../src/shared/protocol'
import { MAX_BODY_CHARS, MAX_OPTIONS, MAX_TITLE_CHARS } from '../src/shared/records'
import { createFakeDomain, type FakeDomain } from './fake-domain'
import { makeItem } from './fixtures'

const NOW = 10_000

/** One mounted route over a real store and service on a real Cordis context. */
interface Harness {
  readonly route: ConnectionFetchRoute
  readonly service: OpenItemsService
  readonly store: OpenItemsStore
  readonly domain: FakeDomain
  readonly ctx: Context
}

/**
 * Mount the route.
 * @param extra - optional route dependencies (engine, flags).
 * @returns the harness.
 */
async function mount(extra: Partial<OpenItemsRouteDeps> = {}): Promise<Harness> {
  const domain = createFakeDomain()
  const ctx = new Context()
  ctx.provide('storageDomain', { open: async () => domain })
  const store = await OpenItemsStore.open(ctx, { now: () => NOW })
  const service = new OpenItemsService(ctx, store)
  const route = createOpenItemsRoute({ service, now: () => NOW, ...extra })
  return { route, service, store, domain, ctx }
}

/** One parsed response. */
type Parsed = { status: number; contentType: string | null; body: RouteReply<unknown> }

/**
 * POST one envelope through the real route.
 * @param harness - the mounted route.
 * @param envelope - request envelope (or raw text).
 * @returns the parsed response.
 */
async function post(harness: Harness, envelope: unknown): Promise<Parsed> {
  const body = typeof envelope === 'string' ? envelope : JSON.stringify(envelope)
  const response = await harness.route.fetch(new Request(`http://localhost${OPEN_ITEMS_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }))
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: await response.json() as RouteReply<unknown>,
  }
}

/**
 * Call one endpoint expecting success.
 * @param harness - the mounted route.
 * @param endpoint - endpoint name.
 * @param payload - optional payload.
 * @returns the value.
 */
async function ok<T>(harness: Harness, endpoint: string, payload?: unknown): Promise<T> {
  const parsed = await post(harness, { endpoint, ...(payload === undefined ? {} : { payload }) })
  expect(parsed.body.ok, JSON.stringify(parsed.body)).toBe(true)
  return (parsed.body as { ok: true; value: T }).value
}

/**
 * Call one endpoint expecting a failure code.
 * @param harness - the mounted route.
 * @param endpoint - endpoint name.
 * @param payload - optional payload.
 * @returns the error code.
 */
async function code(harness: Harness, endpoint: string, payload?: unknown): Promise<string> {
  const parsed = await post(harness, { endpoint, ...(payload === undefined ? {} : { payload }) })
  expect(parsed.body.ok, JSON.stringify(parsed.body)).toBe(false)
  return (parsed.body as { ok: false; error: { code: string } }).error.code
}

/**
 * Raise one item through the service (the tool path is covered elsewhere).
 * @param harness - mounted route.
 * @param title - item title.
 * @returns the stored record.
 */
async function raise(harness: Harness, title = 'Ship on Friday?'): Promise<Awaited<ReturnType<OpenItemsService['create']>>['item']> {
  const { item } = await harness.service.create({ title, sessionId: 'session-1' })
  return item
}

describe('envelope', () => {
  it('answers 200 + JSON for every endpoint, never a raw failure', async () => {
    const harness = await mount()
    for (const endpoint of OPEN_ITEMS_ENDPOINTS) {
      const parsed = await post(harness, { endpoint })
      expect(parsed.status).toBe(200)
      expect(parsed.contentType).toContain('application/json')
      expect(typeof parsed.body.ok).toBe('boolean')
    }
  })

  it('maps a non-JSON body, a missing endpoint and an unknown endpoint to bad-request', async () => {
    const harness = await mount()
    expect((await post(harness, 'not json')).body).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await code(harness, 'raise', {})).toBe('bad-request')
    expect(await code(harness, 'unknown-endpoint', {})).toBe('bad-request')

    const array = await post(harness, [])
    expect(array.body).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('never leaks internals when an unexpected error escapes', async () => {
    const warnings: string[] = []
    const harness = await mount({ log: { warn: (message: string) => warnings.push(message) } })
    // A malformed stored record cannot happen through the store API, so force the
    // failure a bug would produce: the view reads a non-array.
    const service = harness.service
    const original = service.list.bind(service)
    service.list = () => {
      throw new Error('internal path /home/secret/db.sqlite exploded')
    }
    try {
      const parsed = await post(harness, { endpoint: 'list' })
      expect(parsed.body).toEqual({ ok: false, error: { code: 'unknown', message: 'the request failed' } })
      expect(JSON.stringify(parsed.body)).not.toContain('secret')
      expect(warnings.join('\n')).toContain('exploded')
    } finally {
      service.list = original
    }
  })
})

describe('hello', () => {
  it('reports protocol, identity, counts and no delivery capability until wired', async () => {
    const harness = await mount()
    await raise(harness)
    const hello = await ok<{
      protocol: number
      domainVersion: number
      schemaVersion: number
      installId: string
      capabilities: Record<string, boolean>
      counts: { needsYou: number; candidates: number; awaiting: number }
      earlierRecordsPruned: boolean
    }>(harness, 'hello')

    expect(hello.protocol).toBe(1)
    expect(hello.domainVersion).toBe(harness.service.domainVersion)
    expect(hello.schemaVersion).toBe(3)
    expect(hello.installId).toBe(harness.service.installId)
    expect(hello.counts).toMatchObject({ needsYou: 1, candidates: 0, awaiting: 0 })
    expect(hello.earlierRecordsPruned).toBe(false)
    expect(hello.capabilities).toEqual({
      canSettleClient: false,
      canHostSettle: false,
      canDeliver: false,
      canRegister: true,
      hasContextLine: false,
    })
    expect(hello).not.toHaveProperty('timedMode')
  })

  it('advertises delivery and the optional flags when the deployment has them', async () => {
    const harness = await mount({
      engine: {
        reply: async () => { throw new Error('unused') },
        capabilities: () => ({ clientSettle: true, hostSettle: true }),
      },
      hasContextLine: true,
      timedMode: true,
    })
    const hello = await ok<{ capabilities: Record<string, boolean>; timedMode?: boolean }>(harness, 'hello')
    expect(hello.capabilities).toMatchObject({ canDeliver: true, canHostSettle: true, canSettleClient: true, hasContextLine: true })
    expect(hello.timedMode).toBe(true)
  })

  it('advertises host settle only when the bridge reports a working port', async () => {
    const harness = await mount({
      engine: {
        reply: async () => { throw new Error('unused') },
        // The M2 degraded build: delivery works, out-of-band settle does not.
        capabilities: () => ({ clientSettle: true, hostSettle: false }),
      },
    })
    const hello = await ok<{ capabilities: Record<string, boolean> }>(harness, 'hello')
    expect(hello.capabilities).toMatchObject({ canDeliver: true, canSettleClient: true, canHostSettle: false })
  })

  it('treats an engine without a capability report as delivery-only', async () => {
    const harness = await mount({ engine: { reply: async () => { throw new Error('unused') } } })
    const hello = await ok<{ capabilities: Record<string, boolean> }>(harness, 'hello')
    expect(hello.capabilities).toMatchObject({ canDeliver: true, canSettleClient: true, canHostSettle: false })
  })

  it('resolves a late-mounted engine per request', async () => {
    let engine: ReplyEngine | undefined
    const harness = await mount({ engine: () => engine })
    expect((await ok<{ capabilities: { canDeliver: boolean } }>(harness, 'hello')).capabilities.canDeliver).toBe(false)
    engine = { reply: async () => { throw new ReplyEngineError('nope', 'agent-unavailable') } }
    expect((await ok<{ capabilities: { canDeliver: boolean } }>(harness, 'hello')).capabilities.canDeliver).toBe(true)
    expect(await code(harness, 'reply', {
      itemId: 'x', expectedVersion: 1, deliveryId: 'd1', payload: { type: 'text', text: 'ok' },
    })).toBe('agent-unavailable')
  })
})

describe('list and register', () => {
  it('lists the inbox snapshot and pages the register', async () => {
    const harness = await mount()
    const item = await raise(harness)

    const list = await ok<{ snapshot: { revision: number; items: { id: string }[]; counts: { needsYou: number } } }>(harness, 'list')
    expect(list.snapshot.items.map(row => row.id)).toEqual([item.id])
    expect(list.snapshot.counts.needsYou).toBe(1)

    const register = await ok<{ items: unknown[]; total: number; earlierRecordsPruned: boolean }>(harness, 'register')
    expect(register.items).toEqual([])
    expect(register.total).toBe(0)
    expect(register.earlierRecordsPruned).toBe(false)
  })

  it('validates the query instead of forwarding garbage to the view', async () => {
    const harness = await mount()
    expect(await code(harness, 'list', { query: { status: 'waiting' } })).toBe('bad-request')
    expect(await code(harness, 'list', { query: { limit: 0 } })).toBe('bad-request')
    expect(await code(harness, 'list', { query: { limit: 'ten' } })).toBe('bad-request')
    expect(await code(harness, 'list', { query: { kinds: ['gossip'] } })).toBe('bad-request')
    expect(await code(harness, 'list', { query: { scope: { sessionId: '' } } })).toBe('bad-request')
    expect(await code(harness, 'register', { query: { sources: ['robot'] } })).toBe('bad-request')

    const clamped = await ok<{ snapshot: { items: unknown[] } }>(harness, 'list', { query: { limit: 9_999 } })
    expect(clamped.snapshot.items).toEqual([])
  })
})

describe('dismiss and snooze', () => {
  it('dismisses with a CAS token and reports stale versions as conflict', async () => {
    const harness = await mount()
    const item = await raise(harness)

    const value = await ok<{ item: { state: string; resolution?: { kind: string } } }>(harness, 'dismiss', {
      itemId: item.id,
      expectedVersion: item.version,
      reason: 'no longer needed',
    })
    expect(value.item.state).toBe('resolved')
    expect(value.item.resolution?.kind).toBe('dismissed')

    expect(await code(harness, 'dismiss', { itemId: item.id, expectedVersion: item.version })).toBe('conflict')
    expect(await code(harness, 'dismiss', { itemId: 'missing', expectedVersion: 1 })).toBe('not-found')
    expect(await code(harness, 'dismiss', { itemId: item.id })).toBe('bad-request')
  })

  it('snoozes into the future only', async () => {
    const harness = await mount()
    const item = await raise(harness)

    const snoozed = await ok<{ item: { state: string; snoozedUntil?: number } }>(harness, 'snooze', {
      itemId: item.id,
      expectedVersion: item.version,
      until: NOW + 60_000,
    })
    expect(snoozed.item.state).toBe('snoozed')
    expect(snoozed.item.snoozedUntil).toBe(NOW + 60_000)

    expect(await code(harness, 'snooze', { itemId: item.id, expectedVersion: 1, until: NOW })).toBe('bad-request')
    expect(await code(harness, 'snooze', { itemId: item.id, expectedVersion: 1, until: NOW + 1 })).toBe('conflict')
  })
})

describe('reopen', () => {
  it('returns a settled item to the open list and keeps the resolution in the log', async () => {
    const harness = await mount()
    const item = await raise(harness)
    const dismissed = await ok<{ item: { version: number } }>(harness, 'dismiss', {
      itemId: item.id,
      expectedVersion: item.version,
    })

    const reopened = await ok<{ item: { state: string; reopenCount: number; version: number; resolution?: unknown } }>(
      harness,
      'reopen',
      { itemId: item.id, expectedVersion: dismissed.item.version },
    )
    expect(reopened.item.state).toBe('open')
    expect(reopened.item.reopenCount).toBe(1)
    expect(reopened.item.resolution).toBeUndefined()
    expect(reopened.item.version).toBeGreaterThan(dismissed.item.version)
    expect(harness.store.get(item.id)?.resolutionLog).toHaveLength(1)
  })

  it('reports a stale version as conflict, an open item as conflict and a missing id as not-found', async () => {
    const harness = await mount()
    const item = await raise(harness)
    // Still open: there is nothing to reopen.
    expect(await code(harness, 'reopen', { itemId: item.id, expectedVersion: item.version })).toBe('conflict')

    const dismissed = await ok<{ item: { version: number } }>(harness, 'dismiss', {
      itemId: item.id,
      expectedVersion: item.version,
    })
    expect(await code(harness, 'reopen', { itemId: item.id, expectedVersion: item.version })).toBe('conflict')
    expect(await code(harness, 'reopen', { itemId: 'missing', expectedVersion: 1 })).toBe('not-found')
    expect(await code(harness, 'reopen', { itemId: item.id })).toBe('bad-request')
    // The fresh CAS token still works after the two refusals.
    expect((await ok<{ item: { state: string } }>(harness, 'reopen', {
      itemId: item.id,
      expectedVersion: dismissed.item.version,
    })).item.state).toBe('open')
  })
})

describe('settings', () => {
  it('reads the defaults without materialising a row', async () => {
    const harness = await mount()
    const writesBefore = harness.domain.writes()
    const read = await ok<{ settings: Record<string, unknown> }>(harness, 'settings', { op: 'read' })
    expect(read).toEqual({
      settings: { schemaVersion: 1, version: 0, modelNudge: false, proseCandidates: true, llmExtraction: false },
    })
    expect(harness.domain.writes()).toBe(writesBefore)
  })

  it('writes with expectedVersion, returns the new record and reports a lost race as a conflict value', async () => {
    const harness = await mount()
    const written = await ok<{ status: string; settings: { version: number; modelNudge: boolean } }>(
      harness,
      'settings',
      { op: 'write', expectedVersion: 0, patch: { modelNudge: true } },
    )
    expect(written).toEqual({
      status: 'written',
      settings: { schemaVersion: 1, version: 1, modelNudge: true, proseCandidates: true, llmExtraction: false },
    })
    const read = await ok<{ settings: { version: number; modelNudge: boolean; proseCandidates: boolean } }>(
      harness,
      'settings',
      { op: 'read' },
    )
    expect(read.settings).toMatchObject({ version: 1, modelNudge: true, proseCandidates: true })

    // A stale token is a value, not an error: the live record comes back.
    const conflict = await ok<{ status: string; settings: { version: number; modelNudge: boolean } }>(
      harness,
      'settings',
      { op: 'write', expectedVersion: 0, patch: { proseCandidates: false } },
    )
    expect(conflict).toEqual({
      status: 'conflict',
      settings: { schemaVersion: 1, version: 1, modelNudge: true, proseCandidates: true, llmExtraction: false },
    })
    expect(harness.store.settings()).toMatchObject({ version: 1, proseCandidates: true })
  })

  it('writes and validates the llmExtraction toggle', async () => {
    const harness = await mount()
    const written = await ok<{ status: string; settings: { llmExtraction: boolean; version: number } }>(
      harness,
      'settings',
      { op: 'write', expectedVersion: 0, patch: { llmExtraction: true } },
    )
    expect(written).toMatchObject({ status: 'written', settings: { llmExtraction: true, version: 1 } })
    const read = await ok<{ settings: { llmExtraction: boolean; proseCandidates: boolean } }>(
      harness,
      'settings',
      { op: 'read' },
    )
    expect(read.settings).toMatchObject({ llmExtraction: true, proseCandidates: true })

    expect(await code(harness, 'settings', { op: 'write', expectedVersion: 1, patch: { llmExtraction: 'yes' } }))
      .toBe('bad-request')
    expect(await code(harness, 'settings', { op: 'write', expectedVersion: 1, patch: { llmExtraction: 1 } }))
      .toBe('bad-request')
    // The invalid writes never landed.
    expect(harness.store.settings().llmExtraction).toBe(true)
  })

  it('rejects invalid or absent fields as bad-request', async () => {
    const harness = await mount()
    expect(await code(harness, 'settings', {})).toBe('bad-request')
    expect(await code(harness, 'settings', { op: 'toggle' })).toBe('bad-request')
    expect(await code(harness, 'settings', { op: 'write' })).toBe('bad-request')
    expect(await code(harness, 'settings', { op: 'write', expectedVersion: -1, patch: {} })).toBe('bad-request')
    expect(await code(harness, 'settings', { op: 'write', expectedVersion: 0 })).toBe('bad-request')
    expect(await code(harness, 'settings', { op: 'write', expectedVersion: 0, patch: { modelNudge: 'yes' } }))
      .toBe('bad-request')
    expect(await code(harness, 'settings', { op: 'write', expectedVersion: 'one', patch: {} })).toBe('bad-request')
  })
})

/* ------------------------------------------------------------------ *
 * Candidate lifecycle endpoints (contract §7)
 * ------------------------------------------------------------------ */

/** One open candidate draft, as the prose gate will emit it. */
function candidateDraft(overrides: Partial<DerivedItemDraft> = {}): DerivedItemDraft {
  return {
    artifactId: 'prose:route1',
    kind: 'decision',
    tier: 'candidate',
    severity: 2,
    title: 'Ship the parser this week?',
    body: 'This session ended a turn with a decision request.',
    sessionId: 'session-1',
    detectorCode: 'prose-gate:decision-request',
    detectedBy: ['regex-gate'],
    blocking: false,
    reply: { requiresConfirm: true },
    ...overrides,
  }
}

/** Open one candidate through the service and return its stored record. */
async function raiseCandidate(
  harness: Harness,
  overrides: Partial<DerivedItemDraft> = {},
): Promise<Awaited<ReturnType<OpenItemsService['create']>>['item']> {
  await harness.service.upsertDerived([candidateDraft(overrides)])
  const id = overrides.artifactId ?? 'prose:route1'
  return harness.store.all().find(record => record.dedupeKey.endsWith(`|${id}`))!
}

describe('promote and suppress', () => {
  it('promotes a candidate through the route and reports CAS/transition errors', async () => {
    const harness = await mount()
    const candidate = await raiseCandidate(harness)
    expect(candidate.tier).toBe('candidate')

    const promoted = await ok<{ item: { tier: string; blocking: boolean; severity: number; version: number } }>(
      harness,
      'promote',
      { itemId: candidate.id, expectedVersion: candidate.version },
    )
    expect(promoted.item).toMatchObject({
      tier: 'structural',
      blocking: true,
      severity: 2,
      version: candidate.version + 1,
    })
    // Candidate-only: a second promote (even with the fresh token) is a conflict.
    expect(await code(harness, 'promote', { itemId: candidate.id, expectedVersion: promoted.item.version }))
      .toBe('conflict')
    expect(await code(harness, 'promote', { itemId: candidate.id, expectedVersion: candidate.version }))
      .toBe('conflict')
    expect(await code(harness, 'promote', { itemId: 'missing', expectedVersion: 1 })).toBe('not-found')
    expect(await code(harness, 'promote', { itemId: candidate.id })).toBe('bad-request')
    expect(await code(harness, 'promote', { itemId: candidate.id, expectedVersion: 0 })).toBe('bad-request')

    const list = await ok<{ snapshot: { counts: { needsYou: number; candidates: number } } }>(harness, 'list')
    expect(list.snapshot.counts).toMatchObject({ needsYou: 1, candidates: 0 })
  })

  it('applies a correction patch through the route and reports reclassified', async () => {
    const harness = await mount()
    const candidate = await raiseCandidate(harness, {
      kind: 'question',
      artifactId: 'prose:t4:abcdef123456',
      title: 'E — want me to ship the parser?',
      quote: '- **E** — want me to ship the parser?',
      turn: 4,
    })
    expect(candidate.kind).toBe('question')

    const promoted = await ok<{
      item: {
        id: string
        kind: string
        tier: string
        title: string
        options?: readonly string[]
        dedupeKey: string
        reply: { controls: readonly string[]; requiresConfirm: boolean }
      }
      reclassified?: boolean
    }>(harness, 'promote', {
      itemId: candidate.id,
      expectedVersion: candidate.version,
      patch: {
        kind: 'decision',
        title: 'Ship the parser this week?',
        options: ['(a) ship now', '(b) wait for the audit'],
      },
    })
    expect(promoted.reclassified).toBe(true)
    expect(promoted.item).toMatchObject({
      id: candidate.id,
      kind: 'decision',
      tier: 'structural',
      title: 'Ship the parser this week?',
      options: ['(a) ship now', '(b) wait for the audit'],
      // The kind is part of the derived identity: it was rekeyed, not duplicated.
      dedupeKey: 'derived|decision|session-1|prose:t4:abcdef123456',
    })
    expect(promoted.item.reply).toMatchObject({
      controls: ['option', 'text'],
      requiresConfirm: false,
    })
    expect(harness.store.all()).toHaveLength(1)
    expect(harness.store.counts()).toMatchObject({ candidates: 0, needsYou: 1 })
  })

  it('omits reclassified when the patch does not change the kind', async () => {
    const harness = await mount()
    const candidate = await raiseCandidate(harness, { artifactId: 'prose:t4:aaaaaaaaaaaa', turn: 4 })
    const promoted = await ok<{ item: { title: string; dedupeKey: string }; reclassified?: boolean }>(
      harness,
      'promote',
      { itemId: candidate.id, expectedVersion: candidate.version, patch: { title: 'A corrected title' } },
    )
    expect(promoted.reclassified).toBeUndefined()
    expect(promoted.item).toMatchObject({ title: 'A corrected title', dedupeKey: candidate.dedupeKey })
  })

  it('validates the promote patch before writing anything', async () => {
    const harness = await mount()
    const candidate = await raiseCandidate(harness, { artifactId: 'prose:t4:bbbbbbbbbbbb', turn: 4 })
    const base = { itemId: candidate.id, expectedVersion: candidate.version }
    const tooManyOptions = Array.from({ length: MAX_OPTIONS + 1 }, (_, index) => `option ${index}`)
    for (const patch of [
      'not-an-object',
      { kind: 'gossip' },
      { title: '' },
      { title: 'x'.repeat(MAX_TITLE_CHARS + 1) },
      { body: 'x'.repeat(MAX_BODY_CHARS + 1) },
      { quote: 'x'.repeat(MAX_BODY_CHARS + 1) },
      { options: tooManyOptions },
      { options: ['ok', 42] },
      { unknownField: true },
    ]) {
      expect(await code(harness, 'promote', { ...base, patch }), JSON.stringify(patch)).toBe('bad-request')
    }
    // Nothing was written: the candidate is still a candidate at its version.
    expect(harness.store.get(candidate.id)).toMatchObject({ tier: 'candidate', version: candidate.version })
    // An empty patch is a legal no-op correction.
    const empty = await ok<{ item: { tier: string; version: number } }>(harness, 'promote', { ...base, patch: {} })
    expect(empty.item).toMatchObject({ tier: 'structural', version: candidate.version + 1 })
  })

  it('rejects a stale token without applying the patch', async () => {
    const harness = await mount()
    const candidate = await raiseCandidate(harness, {
      kind: 'question',
      artifactId: 'prose:t4:cccccccccccc',
      turn: 4,
    })
    expect(await code(harness, 'promote', {
      itemId: candidate.id,
      expectedVersion: candidate.version + 3,
      patch: { kind: 'decision', title: 'Corrected too late' },
    })).toBe('conflict')
    expect(harness.store.get(candidate.id)).toMatchObject({
      kind: 'question',
      title: candidate.title,
      tier: 'candidate',
      version: candidate.version,
      dedupeKey: candidate.dedupeKey,
    })
  })

  it('suppresses a candidate: dismissed resolution plus an exact-key suppressor that blocks re-raise', async () => {
    const harness = await mount()
    const candidate = await raiseCandidate(harness, { artifactId: 'prose:route2' })

    const suppressed = await ok<{
      item: { state: string; resolution: { kind: string; actor: string }; version: number }
    }>(harness, 'suppress', { itemId: candidate.id, expectedVersion: candidate.version, reason: 'not a decision' })
    expect(suppressed.item).toMatchObject({
      state: 'resolved',
      version: candidate.version + 1,
      resolution: { kind: 'dismissed', actor: 'user' },
    })
    expect(harness.store.getSuppressor(candidate.dedupeKey)).toMatchObject({
      dedupePrefix: candidate.dedupeKey,
      kindFamily: candidate.kind,
    })

    // The same artifact folded again cannot re-raise the fingerprint.
    expect(await harness.service.upsertDerived([candidateDraft({ artifactId: 'prose:route2' })])).toBe(0)
    expect(harness.store.get(candidate.id)?.state).toBe('resolved')

    // Candidate-only and CAS-checked, like promote.
    expect(await code(harness, 'suppress', { itemId: candidate.id, expectedVersion: suppressed.item.version }))
      .toBe('conflict')
    expect(await code(harness, 'suppress', { itemId: 'missing', expectedVersion: 1 })).toBe('not-found')
    expect(await code(harness, 'suppress', { itemId: candidate.id })).toBe('bad-request')

    // A structural item cannot be suppressed either.
    const structural = await raise(harness, 'A structural decision?')
    expect(await code(harness, 'suppress', { itemId: structural.id, expectedVersion: structural.version }))
      .toBe('conflict')
  })
})

describe('delivery', () => {
  it('finds one attempt by id and treats absence as a value', async () => {
    const harness = await mount()
    const item = await raise(harness)
    await harness.service.recordDelivery(item.id, item.version, {
      deliveryId: 'delivery-1',
      at: NOW,
      track: 'session-message',
      payload: { type: 'text', text: 'Friday' },
      state: 'queued',
    })

    const found = await ok<{ delivery?: { deliveryId: string; state: string }; item?: { id: string } }>(harness, 'delivery', {
      deliveryId: 'delivery-1',
    })
    expect(found.delivery).toMatchObject({ deliveryId: 'delivery-1', state: 'queued' })
    expect(found.item?.id).toBe(item.id)

    expect(await ok(harness, 'delivery', { deliveryId: 'delivery-404' })).toEqual({})
    expect(await code(harness, 'delivery', {})).toBe('bad-request')
  })
})

describe('reply', () => {
  it('is a typed not-configured until the delivery layer mounts', async () => {
    const harness = await mount()
    const item = await raise(harness)
    const parsed = await post(harness, {
      endpoint: 'reply',
      payload: { itemId: item.id, expectedVersion: item.version, deliveryId: 'd1', payload: { type: 'text', text: 'Friday' } },
    })
    expect(parsed.body).toMatchObject({ ok: false, error: { code: 'not-configured' } })
    expect(await code(harness, 'reply', {})).toBe('bad-request')
  })

  it('delegates a validated request verbatim with a correlation id', async () => {
    const seen: { request: unknown; requestId: string }[] = []
    let ticket = 0
    const harness = await mount({
      newRequestId: () => `req-${ticket += 1}`,
      engine: {
        async reply(request, requestId) {
          seen.push({ request, requestId })
          const item = await harness.service.get(request.itemId)
          return {
            item: item!,
            delivery: {
              deliveryId: request.deliveryId,
              at: NOW,
              track: 'session-message',
              payload: request.payload,
              state: 'queued',
            },
            outcome: 'sent',
          }
        },
      },
    })
    const item = await raise(harness)

    const request = {
      itemId: item.id,
      expectedVersion: item.version,
      deliveryId: 'delivery-9',
      payload: { type: 'approval', outcome: 'allow-once' as const, note: 'this once' },
      requestedTrack: 'session-message' as const,
      confirmedWake: true,
    }
    const value = await ok<{ outcome: string; delivery: { deliveryId: string } }>(harness, 'reply', request)
    expect(value.outcome).toBe('sent')
    expect(value.delivery.deliveryId).toBe('delivery-9')
    expect(seen).toEqual([{ request, requestId: 'req-1' }])
  })

  it('maps engine failures to the wire code and rejects malformed payloads first', async () => {
    const harness = await mount({
      engine: {
        async reply() {
          throw new ReplyEngineError('the item changed', 'conflict')
        },
      },
    })
    const item = await raise(harness)
    const valid = { itemId: item.id, expectedVersion: 1, deliveryId: 'd1', payload: { type: 'text', text: 'x' } }
    expect(await code(harness, 'reply', valid)).toBe('conflict')

    const malformed = [
      { ...valid, itemId: undefined },
      { ...valid, expectedVersion: 'one' },
      { ...valid, expectedVersion: 0 },
      { ...valid, deliveryId: '' },
      { ...valid, payload: { type: 'shrug' } },
      { ...valid, payload: { type: 'text', text: '   ' } },
      { ...valid, payload: { type: 'option' } },
      { ...valid, payload: { type: 'approval', outcome: 'maybe' } },
      { ...valid, requestedTrack: 'teleport' },
    ]
    for (const payload of malformed) expect(await code(harness, 'reply', payload), JSON.stringify(payload)).toBe('bad-request')
  })
})

describe('delete forever', () => {
  it('tombstones a record, removes it from every read surface and is idempotent', async () => {
    const harness = await mount()
    const item = await raise(harness)

    const deleted = await ok<{
      item: { deletedAt?: number; state: string; title: string; body: string; version: number; retention: { class: string } }
    }>(harness, 'delete', { itemId: item.id, expectedVersion: item.version })
    expect(deleted.item).toMatchObject({
      deletedAt: NOW,
      state: 'resolved',
      title: '[deleted]',
      body: '',
      version: item.version + 1,
      retention: { class: 'archived' },
    })
    // The tombstone keeps only identity/dedupe fields; the answer text is gone.
    expect(JSON.stringify(deleted.item)).not.toContain('Ship on Friday?')

    const list = await ok<{ snapshot: { items: { id: string }[]; counts: { needsYou: number; resolved: number } } }>(harness, 'list')
    expect(list.snapshot.items).toEqual([])
    expect(list.snapshot.counts).toMatchObject({ needsYou: 0, resolved: 0 })
    const register = await ok<{ items: unknown[]; total: number }>(harness, 'register')
    expect(register.items).toEqual([])
    expect(register.total).toBe(0)
    // A confirmed deletion is not a cap prune.
    expect((await ok<{ earlierRecordsPruned: boolean }>(harness, 'hello')).earlierRecordsPruned).toBe(false)

    // A lost response retried with the tombstone version returns it unchanged.
    const again = await ok<{ item: { version: number; deletedAt?: number } }>(harness, 'delete', {
      itemId: item.id,
      expectedVersion: deleted.item.version,
    })
    expect(again.item).toMatchObject({ deletedAt: NOW, version: deleted.item.version })

    expect(await code(harness, 'delete', { itemId: item.id, expectedVersion: item.version })).toBe('conflict')
    expect(await code(harness, 'delete', { itemId: 'missing', expectedVersion: 1 })).toBe('not-found')
    expect(await code(harness, 'delete', { itemId: item.id })).toBe('bad-request')
    expect(await code(harness, 'delete', { itemId: item.id, expectedVersion: 0 })).toBe('bad-request')
    expect(await code(harness, 'delete', { itemId: item.id, expectedVersion: 'two' })).toBe('bad-request')
  })

  it('removes a resolved register entry without setting the cap-prune flag', async () => {
    const harness = await mount()
    const item = await raise(harness)
    const dismissed = await ok<{ item: { version: number } }>(harness, 'dismiss', {
      itemId: item.id,
      expectedVersion: item.version,
    })
    const register = await ok<{ items: unknown[]; total: number; earlierRecordsPruned: boolean }>(harness, 'register', {
      query: { status: 'all' },
    })
    expect(register.total).toBe(1)

    await ok<{ item: { version: number } }>(harness, 'delete', {
      itemId: item.id,
      expectedVersion: dismissed.item.version,
    })
    const after = await ok<{ items: unknown[]; total: number; earlierRecordsPruned: boolean }>(harness, 'register', {
      query: { status: 'all' },
    })
    expect(after.items).toEqual([])
    expect(after.total).toBe(0)
    // A confirmed delete is not a cap prune: the honesty flag stays false.
    expect(after.earlierRecordsPruned).toBe(false)
    expect((await ok<{ earlierRecordsPruned: boolean }>(harness, 'hello')).earlierRecordsPruned).toBe(false)
  })

  it('refuses a stale version before writing anything', async () => {
    const harness = await mount()
    const item = await raise(harness)
    await harness.service.snooze(item.id, item.version, NOW + 60_000)
    expect(await code(harness, 'delete', { itemId: item.id, expectedVersion: item.version })).toBe('conflict')
    // Validation and the CAS run before any write: the item is untouched.
    expect(await code(harness, 'delete', { itemId: item.id, expectedVersion: 0 })).toBe('bad-request')
    expect(harness.store.get(item.id)?.deletedAt).toBeUndefined()
    const live = await ok<{ snapshot: { items: { id: string; state: string }[] } }>(harness, 'list', { query: { status: 'all' } })
    expect(live.snapshot.items).toMatchObject([{ id: item.id, state: 'snoozed' }])
  })
})

describe('session-scoped query and counts', () => {
  it('filters list and register by session id and keeps paging working', async () => {
    const harness = await mount()
    const first = await raise(harness, 'First in session one?')
    await harness.service.create({ title: 'Second in session one?', sessionId: 'session-1' })
    await harness.service.create({ title: 'Only in session two?', sessionId: 'session-2' })

    const scoped = await ok<{ snapshot: { items: { id: string }[] } }>(harness, 'list', {
      query: { scope: { sessionId: 'session-1' } },
    })
    expect(scoped.snapshot.items.map(row => row.id)).toContain(first.id)
    expect(scoped.snapshot.items).toHaveLength(2)

    // Paging is applied after the session filter, so the cursor cannot leak
    // another session's rows.
    const pageOne = await ok<{ snapshot: { items: { id: string }[]; nextCursor?: string } }>(harness, 'list', {
      query: { scope: { sessionId: 'session-1' }, limit: 1 },
    })
    expect(pageOne.snapshot.items).toHaveLength(1)
    expect(pageOne.snapshot.nextCursor).toBeDefined()
    const pageTwo = await ok<{ snapshot: { items: { id: string }[] } }>(harness, 'list', {
      query: { scope: { sessionId: 'session-1' }, limit: 1, cursor: pageOne.snapshot.nextCursor },
    })
    expect(pageTwo.snapshot.items).toHaveLength(1)
    expect(pageTwo.snapshot.items[0]?.id).not.toBe(pageOne.snapshot.items[0]?.id)

    const register = await ok<{ items: unknown[]; total: number }>(harness, 'register', {
      query: { scope: { sessionId: 'session-2' } },
    })
    expect(register.total).toBe(0)
  })

  it('uses the OI-05 needs-you predicate for the nav counts in hello and the snapshot', async () => {
    const harness = await mount()
    await harness.service.create({ title: 'Structural severity 2?', sessionId: 's1', severity: 2 })
    await harness.service.create({
      title: 'Candidate?',
      sessionId: 's1',
      tier: 'candidate',
      severity: 2,
    })
    await harness.service.create({ title: 'FYI?', sessionId: 's1', severity: 3 })
    const answered = await harness.service.create({ title: 'Answered?', sessionId: 's1' })
    await harness.service.answer(answered.item.id, answered.item.version, { type: 'text', text: 'done' })

    const hello = await ok<{ counts: { needsYou: number; candidates: number; awaiting: number } }>(harness, 'hello')
    expect(hello.counts).toMatchObject({ needsYou: 1, candidates: 1, awaiting: 1 })
    const list = await ok<{ snapshot: { counts: { needsYou: number; candidates: number }; workspaces: { itemCount: number }[] } }>(
      harness,
      'list',
    )
    expect(list.snapshot.counts).toMatchObject({ needsYou: 1, candidates: 1 })
    expect(list.snapshot.workspaces.reduce((total, row) => total + row.itemCount, 0)).toBe(1)
  })
})

/* ------------------------------------------------------------------ *
 * Plugin wiring (index.ts)
 * ------------------------------------------------------------------ */

describe('plugin wiring', () => {
  const temporaryDirectories: string[] = []

  afterAll(async () => {
    for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true })
  })

  /** One registered system-prompt section (the structural nudge seam). */
  interface RecordedSection {
    readonly name: string
    readonly order: number
    readonly text: string
  }

  /**
   * Mount the whole plugin over fake `storageDomain`, `tools`, an optional
   * `connection` carrier and an optional recording `systemPrompt` service.
   * @param withConnection - whether the profile mounts the web carrier.
   * @param engine - optional delivery engine published under its service name.
   * @param options - `systemPrompt: false` simulates a profile without the service.
   * @returns the context, routes and the system-prompt sections observed.
   */
  async function applyPlugin(
    withConnection: boolean,
    engine?: ReplyEngine,
    options: { readonly systemPrompt?: boolean; readonly domain?: FakeDomain } = {},
  ): Promise<{
    ctx: Context
    routes: ConnectionFetchRoute[]
    dir: string
    sections: RecordedSection[]
    sectionDisposals: RecordedSection[]
  }> {
    const root = await mkdtemp(join(tmpdir(), 'open-items-wiring-'))
    temporaryDirectories.push(root)
    const domain = options.domain ?? createFakeDomain()
    const ctx = new Context()
    ctx.provide('storageDomain', { open: async () => domain })
    ctx.provide('tools', { register: () => () => undefined })
    const routes: ConnectionFetchRoute[] = []
    const sections: RecordedSection[] = []
    const sectionDisposals: RecordedSection[] = []
    if (options.systemPrompt !== false) {
      ctx.provide('systemPrompt', {
        section: (section: RecordedSection) => {
          sections.push(section)
          return () => {
            sectionDisposals.push(section)
          }
        },
      })
    }
    if (withConnection) {
      ctx.provide('connection', {
        fetch: {
          register: (route: ConnectionFetchRoute) => {
            routes.push(route)
            return async () => undefined
          },
        },
      })
    }
    if (engine !== undefined) ctx.provide('openItemsReply', engine)

    const validate = Config as unknown as (input: unknown) => Record<string, unknown>
    await apply(ctx, validate({
      storePath: join(root, 'legacy.json'),
      maxLiveItems: 500,
      listLimit: 20,
      activeResolveDays: 365,
      maxResolvedRecords: 5000,
      acknowledgementWindowHours: 24,
    }) as never)
    return { ctx, routes, dir: root, sections, sectionDisposals }
  }

  it('mounts the exact route when the web carrier is present', async () => {
    const { ctx, routes } = await applyPlugin(true)
    expect(routes).toHaveLength(1)
    const route = routes[0]!
    expect(route.path).toBe('/api/open-items')
    expect(route.methods).toEqual(['POST'])
    expect(route.requestBody).toBe('buffered')

    const response = await route.fetch(new Request('http://localhost/api/open-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'hello' }),
    }))
    const body = await response.json() as RouteReply<{ installId: string; capabilities: { canDeliver: boolean } }>
    expect(body.ok).toBe(true)
    if (body.ok) {
      expect(body.value.installId).toBe(ctx.openItems.installId)
      // `apply` now publishes the delivery engine itself, so the route reports a
      // writable reply path in every web composition (PLAN M1 wiring).
      expect(body.value.capabilities.canDeliver).toBe(true)
    }
  })

  it('activates without a web carrier and mounts nothing', async () => {
    const { ctx, routes } = await applyPlugin(false)
    expect(routes).toEqual([])
    expect(ctx.openItems).toBeDefined()
  })

  it('wires the delivery engine published under its documented service name', async () => {
    const engine: ReplyEngine = {
      async reply(request) {
        const item = ctxRef!.openItems.get(request.itemId)
        return {
          item: item!,
          delivery: { deliveryId: request.deliveryId, at: NOW, track: 'session-message', payload: request.payload, state: 'queued' },
          outcome: 'sent',
        }
      },
    }
    let ctxRef: Context | undefined
    const plugin = await applyPlugin(true, engine)
    ctxRef = plugin.ctx
    const route = plugin.routes[0]!
    const item = await plugin.ctx.openItems.create({ title: 'Engine wired?', sessionId: 'session-1' })

    const call = async (envelope: unknown): Promise<RouteReply<unknown>> => {
      const response = await route.fetch(new Request('http://localhost/api/open-items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      }))
      return await response.json() as RouteReply<unknown>
    }

    const hello = await call({ endpoint: 'hello' })
    expect(hello.ok && hello.value).toMatchObject({ capabilities: { canDeliver: true } })

    const replied = await call({
      endpoint: 'reply',
      payload: { itemId: item.item.id, expectedVersion: 1, deliveryId: 'wired-1', payload: { type: 'text', text: 'yes' } },
    })
    expect(replied.ok).toBe(true)
  })

  it('registers the opt-in model nudge only while settings.modelNudge is true', async () => {
    const plugin = await applyPlugin(true)
    const route = plugin.routes[0]!
    const call = async (envelope: unknown): Promise<RouteReply<unknown>> => {
      const response = await route.fetch(new Request('http://localhost/api/open-items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      }))
      return await response.json() as RouteReply<unknown>
    }

    // Default is opt-in OFF: activation registers no section.
    expect(plugin.sections).toEqual([])

    const on = await call({ endpoint: 'settings', payload: { op: 'write', expectedVersion: 0, patch: { modelNudge: true } } })
    expect(on.ok && on.value).toMatchObject({ status: 'written' })
    expect(plugin.sections).toHaveLength(1)
    expect(plugin.sections[0]).toMatchObject({ name: 'open-items:nudge', order: 60 })
    expect(plugin.sections[0]?.text).toContain('open_items raise')
    expect(plugin.sections[0]?.text).toContain('open_items resolve')
    // Contract §2.3: the nudge carries the same kind taxonomy as the tool.
    expect(plugin.sections[0]?.text).toContain('decision = a choice between named options (pass options)')
    expect(plugin.sections[0]?.text).toContain('question = needs an answer')
    expect(plugin.sections[0]?.text).toContain('approval = permission for an action')
    expect(plugin.sections[0]?.text).toContain('at most 5 in a turn')
    // Contract §1: the text is an English instruction of at most three sentences.
    expect((plugin.sections[0]?.text.match(/[.!?](\s|$)/gu) ?? []).length).toBeLessThanOrEqual(3)

    // A settings change applies immediately: false disposes the section.
    const off = await call({ endpoint: 'settings', payload: { op: 'write', expectedVersion: 1, patch: { modelNudge: false } } })
    expect(off.ok && off.value).toMatchObject({ status: 'written' })
    expect(plugin.sectionDisposals).toHaveLength(1)
    expect(plugin.sectionDisposals[0]?.name).toBe('open-items:nudge')
    // And true again re-registers it.
    await call({ endpoint: 'settings', payload: { op: 'write', expectedVersion: 2, patch: { modelNudge: true } } })
    expect(plugin.sections).toHaveLength(2)

    // Teardown disposes the section with the plugin.
    await plugin.ctx.fiber.dispose()
    expect(plugin.sectionDisposals).toHaveLength(2)
  })

  it('retires false team-task rows raised before alerts were disabled (decision D5)', async () => {
    const orphan = JSON.parse(JSON.stringify(makeItem({
      id: 'team-task-row-1',
      kind: 'task',
      title: 'Teammate task stalled: Review the PR',
      blocking: false,
      dedupeKey: 'derived|task|session-1|team-task:task_1',
      detectedBy: ['projection'],
      history: [{ at: 1, action: 'raised', detail: 'team/task:in-progress-orphan' }],
    })))
    const domain = createFakeDomain({ records: { items: [orphan] } })
    const plugin = await applyPlugin(true, undefined, { domain })

    const retired = plugin.ctx.openItems.get('team-task-row-1')!
    expect(retired).toMatchObject({
      state: 'resolved',
      resolution: {
        kind: 'detected-closed',
        actor: 'detector',
        payload: { type: 'detector', code: 'team/task:alerts-disabled' },
      },
    })
    expect(plugin.ctx.openItems.counts().needsYou).toBe(0)
  })

  it('retires legacy prose candidates and rekeys legacy suppressors before capture mounts', async () => {
    const legacyCandidate = JSON.parse(JSON.stringify(makeItem({
      id: 'legacy-prose-candidate',
      kind: 'question',
      tier: 'candidate',
      severity: 2,
      blocking: false,
      title: 'E — want me to ship the parser?',
      quote: '- **E** — want me to ship the parser?',
      source: { sessionId: 'session-1', turn: 4 },
      dedupeKey: 'derived|question|session-1|prose:c04dafa9ac3e093d',
      detectedBy: ['regex-gate'],
      reply: { controls: ['text'], freeText: true, requiresConfirm: true },
      history: [{ at: 1, action: 'raised', detail: 'prose-gate:decision-request' }],
    })))
    const promotedRow = JSON.parse(JSON.stringify(makeItem({
      id: 'legacy-promoted-row',
      kind: 'decision',
      tier: 'structural',
      severity: 2,
      blocking: true,
      source: { sessionId: 'session-1', turn: 2 },
      dedupeKey: 'derived|decision|session-1|prose:0123456789abcdef',
      detectedBy: ['regex-gate'],
      history: [
        { at: 1, action: 'raised', detail: 'prose-gate:decision-request' },
        { at: 2, action: 'promoted' },
      ],
    })))
    const perItem = JSON.parse(JSON.stringify(makeItem({
      id: 'per-item-row',
      kind: 'question',
      tier: 'candidate',
      severity: 2,
      blocking: false,
      source: { sessionId: 'session-2', turn: 3 },
      dedupeKey: 'derived|question|session-2|prose:t3:abcdef123456',
      detectedBy: ['regex-gate'],
      history: [{ at: 1, action: 'raised', detail: 'prose-gate:decision-request' }],
    })))
    const legacySuppressor = 'derived|question|session-1|prose:c04dafa9ac3e093d'
    const domain = createFakeDomain({
      records: {
        items: [legacyCandidate, promotedRow, perItem],
        suppressors: [{ dedupePrefix: legacySuppressor, kindFamily: 'question', createdAt: 1 }],
      },
    })
    const plugin = await applyPlugin(true, undefined, { domain })

    // Exactly the live legacy candidate is retired, audit-visibly.
    expect(plugin.ctx.openItems.get('legacy-prose-candidate')).toMatchObject({
      state: 'resolved',
      resolution: {
        kind: 'detected-closed',
        actor: 'detector',
        payload: { type: 'detector', code: 'prose-gate:superseded-by-scope-change' },
      },
    })
    // Promoted rows and per-item rows are untouched.
    expect(plugin.ctx.openItems.get('legacy-promoted-row')).toMatchObject({ state: 'open', tier: 'structural' })
    expect(plugin.ctx.openItems.get('per-item-row')).toMatchObject({ state: 'open', tier: 'candidate' })
    // The legacy exact-key suppressor was replaced by both session-scoped kinds.
    expect(plugin.ctx.openItems.getSuppressor(legacySuppressor)).toBeUndefined()
    expect(plugin.ctx.openItems.getSuppressor('derived|question|session-1|prose:')).toMatchObject({
      kindFamily: 'question',
    })
    expect(plugin.ctx.openItems.getSuppressor('derived|decision|session-1|prose:')).toMatchObject({
      kindFamily: 'decision',
    })
    expect(domain.tables.get('suppressors')?.size).toBe(2)

    // Second activation is a no-op: nothing is retired or rewritten again.
    await plugin.ctx.fiber.dispose()
    const again = await applyPlugin(true, undefined, { domain })
    expect(again.ctx.openItems.get('legacy-prose-candidate')?.version).toBe(2)
    expect(again.ctx.openItems.get('legacy-promoted-row')?.version).toBe(1)
    expect(domain.tables.get('suppressors')?.size).toBe(2)
    await again.ctx.fiber.dispose()
  })

  it('seeds hello.capture.lastBackfill from the durable report at activation (survives restarts)', async () => {
    const domain = createFakeDomain()
    const seedCtx = new Context()
    seedCtx.provide('storageDomain', { open: async () => domain })
    const seeded = await OpenItemsStore.open(seedCtx, { now: () => NOW })
    const report = {
      schemaVersion: 1 as const,
      at: NOW - 1_000,
      trigger: 'rescan' as const,
      eligible: 7,
      folded: 6,
      skipped: 1,
      failed: 0,
      drafts: 2,
      batches: 3,
      deferred: 0,
      durationMs: 90,
    }
    await seeded.putBackfillReport(report)
    await seeded.close()

    const plugin = await applyPlugin(true, undefined, { domain })
    expect(plugin.ctx.openItems.backfillReport()).toEqual(report)

    const response = await plugin.routes[0]!.fetch(new Request('http://localhost/api/open-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'hello' }),
    }))
    const body = await response.json() as RouteReply<{
      capture?: { mounted: boolean; lastBackfill?: Record<string, number> }
    }>
    expect(body.ok).toBe(true)
    if (body.ok) {
      // Capture itself is not mounted without sessionQuery in this harness, yet
      // the last pass survives: the record, not process memory, is the source.
      expect(body.value.capture?.mounted).toBe(false)
      expect(body.value.capture?.lastBackfill).toEqual({
        eligible: 7,
        folded: 6,
        skipped: 1,
        failed: 0,
        drafts: 2,
        durationMs: 90,
        at: NOW - 1_000,
      })
    }
  })

  it('honours a persisted modelNudge at activation (settings survive a restart)', async () => {
    const domain = createFakeDomain()
    const seedCtx = new Context()
    seedCtx.provide('storageDomain', { open: async () => domain })
    const seeded = await OpenItemsStore.open(seedCtx, { now: () => NOW })
    expect((await seeded.setSettings(0, { modelNudge: true })).status).toBe('written')
    await seeded.close()

    const plugin = await applyPlugin(true, undefined, { domain })
    expect(plugin.sections).toHaveLength(1)
    expect(plugin.sections[0]?.name).toBe('open-items:nudge')
  })

  it('degrades silently when the profile has no systemPrompt service', async () => {
    const plugin = await applyPlugin(true, undefined, { systemPrompt: false })
    const route = plugin.routes[0]!
    const response = await route.fetch(new Request('http://localhost/api/open-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'settings',
        payload: { op: 'write', expectedVersion: 0, patch: { modelNudge: true } },
      }),
    }))
    const body = await response.json() as RouteReply<unknown>
    expect(body.ok).toBe(true)
    expect(plugin.sections).toEqual([])
  })
})
