/**
 * The register store: reads (main page + band + archive count), filter changes,
 * paging, reopen and export collection/download — all against injected seams, so
 * no network and no browser.
 */
import { describe, expect, it, vi } from 'vitest'

import { createRegisterStore, type RegisterStoreDeps } from '../../src/client/data/register-store'
import type { InboxQuery, OpenItemRecord } from '../../src/shared/schema'
import type { RegisterValue } from '../../src/shared/protocol'
import { NOW, makeAnswered, makeArchived, makeDetected, makeDismissed, makeInFlight, makeRecent } from './register-fixtures'

/** Records the fake Host serves. */
function hostRecords(): OpenItemRecord[] {
  return [makeAnswered(), makeDismissed(), makeRecent(), makeDetected(), makeInFlight(), makeArchived()]
}

/** Split one status-filtered pool, using the cursor as an offset. */
function pageOf(pool: readonly OpenItemRecord[], query: InboxQuery, pruned: boolean): RegisterValue {
  const offset = query.cursor === undefined ? 0 : Number(query.cursor)
  const limit = query.limit ?? 50
  const page = pool.slice(offset, offset + limit)
  const next = offset + page.length < pool.length ? String(offset + page.length) : undefined
  return {
    items: page,
    total: pool.length,
    earlierRecordsPruned: pruned,
    ...(next === undefined ? {} : { nextCursor: next }),
  }
}

/** A fake register endpoint with Host-like status semantics. */
function fakeRegister(calls: InboxQuery[], options: { pruned?: boolean } = {}) {
  return async (query: InboxQuery): Promise<RegisterValue> => {
    calls.push(query)
    const records = hostRecords()
    const status = query.status
    const pool = records.filter((record) => {
      if (status === 'awaiting') return record.state === 'awaiting'
      if (status === 'archived') return record.state === 'resolved' && record.retention.class === 'archived'
      if (status === 'resolved') return record.state === 'resolved' && record.retention.class === 'active'
      return record.state === 'resolved' || record.state === 'awaiting'
    })
    return pageOf(pool, query, options.pruned ?? false)
  }
}

/** Store with a fake Host and an injected clock. */
function makeStore(overrides: Partial<RegisterStoreDeps> = {}, calls: InboxQuery[] = []): ReturnType<typeof createRegisterStore> {
  return createRegisterStore({
    register: fakeRegister(calls),
    now: () => NOW,
    pluginVersion: '9.9.9-test',
    ...overrides,
  })
}

describe('register store reads', () => {
  it('loads the active register, the in-flight band and the archive count in one refresh', async () => {
    const calls: InboxQuery[] = []
    const store = makeStore({}, calls)
    await store.actions.refresh()

    const state = store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.items.map(item => item.id)).toEqual(['reg-answered', 'reg-dismissed', 'reg-detected', 'reg-recent'])
    expect(state.inFlight.map(item => item.id)).toEqual(['reg-inflight'])
    expect(state.total).toBe(4)
    expect(state.archived).toBe(1)
    expect(state.lastReadAt).toBe(NOW)
    // Three reads: main page, awaiting band, archived count.
    expect(calls.map(call => call.status)).toEqual(['resolved', 'awaiting', 'archived'])
    expect(calls[2]?.limit).toBe(1)
  })

  it('keeps a selection that lives in the in-flight band across a refresh', async () => {
    const calls: InboxQuery[] = []
    const store = makeStore({}, calls)
    await store.actions.refresh()
    // An awaiting handoff selects a record that is only in the band, never in
    // the resolved page; the refresh must not drop it.
    store.actions.select('reg-inflight')
    await store.actions.refresh()
    expect(store.getSnapshot().selectedId).toBe('reg-inflight')
    // A selection that exists nowhere still clears.
    store.actions.select('gone')
    await store.actions.refresh()
    expect(store.getSnapshot().selectedId).toBeNull()
  })

  it('maps a filter change into the query and reloads', async () => {
    const calls: InboxQuery[] = []
    const store = makeStore({}, calls)
    await store.actions.refresh()
    store.actions.setFilters({ period: 'today', source: 'user', kind: 'approval', search: 'registry' })
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))

    const last = calls.at(-1)
    expect(calls.filter(call => call.status === 'resolved').at(-1)).toMatchObject({
      status: 'resolved',
      since: new Date(2026, 10, 13, 0, 0, 0).getTime(),
      sources: ['user'],
      kinds: ['approval'],
      search: 'registry',
    })
    expect(store.getSnapshot().filters).toMatchObject({ period: 'today', source: 'user', kind: 'approval', search: 'registry' })
    expect(last).toBeDefined()
  })

  it('scopes the register to one session for the per-session history filter', async () => {
    const calls: InboxQuery[] = []
    const store = makeStore({}, calls)
    await store.actions.refresh()
    store.actions.setFilters({ sessionId: 'session-1' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.filter(call => call.status === 'resolved').at(-1)?.scope).toEqual({ sessionId: 'session-1' })
  })

  it('keeps the last rows and reports offline when the carrier fails', async () => {
    const calls: InboxQuery[] = []
    const fake = fakeRegister(calls)
    const store = createRegisterStore({
      register: async (query) => {
        // The first refresh needs three reads; from the fourth on, the carrier fails.
        if (calls.length >= 3) throw Object.assign(new Error('offline'), { code: 'transport' })
        return fake(query)
      },
      now: () => NOW,
    })
    await store.actions.refresh()
    await store.actions.refresh()
    const state = store.getSnapshot()
    expect(state.items.length).toBeGreaterThan(0)
    expect(state.offline).toBe(true)
    expect(state.error).toContain('offline')
  })

  it('reports the register endpoint as unavailable when the seam is absent', async () => {
    const store = createRegisterStore({ now: () => NOW })
    await store.actions.refresh()
    expect(store.getSnapshot().status).toBe('error')
    expect(store.getSnapshot().error).toBe('register-unavailable')
    expect(store.getSnapshot().offline).toBe(false)
  })

  it('clears filters back to the initial register view', async () => {
    const store = makeStore()
    store.actions.setFilters({ period: 'archive', search: 'x', sessionId: 's' })
    await new Promise(resolve => setTimeout(resolve, 0))
    store.actions.clearFilters()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.getSnapshot().filters).toEqual({ period: '30d', source: 'all', kind: 'all', outcome: 'all', search: '' })
  })

  it('appends the next page and keeps the order', async () => {
    const records = hostRecords().filter(record => record.state === 'resolved' && record.retention.class === 'active')
    const register = async (query: InboxQuery): Promise<RegisterValue> => {
      if (query.status === 'awaiting') return { items: [makeInFlight()], total: 1, earlierRecordsPruned: false }
      if (query.status === 'archived') return { items: [makeArchived()], total: 1, earlierRecordsPruned: false }
      // Force two pages regardless of the requested page size.
      const offset = query.cursor === undefined ? 0 : Number(query.cursor)
      const size = 2
      const page = records.slice(offset, offset + size)
      const next = offset + page.length < records.length ? String(offset + page.length) : undefined
      return {
        items: page,
        total: records.length,
        earlierRecordsPruned: false,
        ...(next === undefined ? {} : { nextCursor: next }),
      }
    }
    const store = createRegisterStore({ register, now: () => NOW })
    await store.actions.refresh()
    expect(store.getSnapshot().items).toHaveLength(2)
    expect(store.getSnapshot().nextCursor).toBe('2')
    await store.actions.loadMore()
    expect(store.getSnapshot().items).toHaveLength(4)
    expect(store.getSnapshot().nextCursor).toBeUndefined()
    expect(store.getSnapshot().items.map(item => item.id)).toEqual(['reg-answered', 'reg-dismissed', 'reg-detected', 'reg-recent'])
  })
})

describe('register store reopen', () => {
  it('reopens through the endpoint with the exact version and reports success', async () => {
    const reopen = vi.fn(async () => ({ item: { ...makeAnswered(), state: 'open' as const } }))
    const store = makeStore({ reopen })
    await store.actions.refresh()
    await store.actions.reopen('reg-answered')
    expect(reopen).toHaveBeenCalledWith('reg-answered', makeAnswered().version)
    const state = store.getSnapshot()
    expect(state.items.map(item => item.id)).not.toContain('reg-answered')
    expect(state.total).toBe(3)
    expect(state.notice).toEqual({ tone: 'ok', code: 'reopened' })
  })

  it('turns a refusal into copy instead of a throw', async () => {
    const reopen = vi.fn(async () => {
      throw Object.assign(new Error('conflict'), { code: 'conflict' })
    })
    const store = makeStore({ reopen })
    await store.actions.refresh()
    await store.actions.reopen('reg-answered')
    const state = store.getSnapshot()
    expect(state.items.map(item => item.id)).toContain('reg-answered')
    expect(state.notice).toEqual({ tone: 'error', code: 'reopen-failed', message: 'conflict' })
    expect(state.busyId).toBeUndefined()
  })

  it('reopening an in-flight answer works too (it becomes open again)', async () => {
    const reopen = vi.fn(async () => ({ item: { ...makeInFlight(), state: 'open' as const } }))
    const store = makeStore({ reopen })
    await store.actions.refresh()
    await store.actions.reopen('reg-inflight')
    expect(reopen).toHaveBeenCalledWith('reg-inflight', makeInFlight().version)
    expect(store.getSnapshot().inFlight).toHaveLength(0)
  })

  it('says the seam is unavailable when no reopen endpoint is injected', async () => {
    const store = makeStore()
    await store.actions.refresh()
    await store.actions.reopen('reg-answered')
    expect(store.getSnapshot().notice).toEqual({
      tone: 'error',
      code: 'unavailable',
      message: 'reopen-unavailable',
    })
  })

  it('ignores an unknown item id', async () => {
    const reopen = vi.fn(async () => ({ item: makeAnswered() }))
    const store = makeStore({ reopen })
    await store.actions.refresh()
    await store.actions.reopen('nope')
    expect(reopen).not.toHaveBeenCalled()
  })
})

describe('register store export', () => {
  it('collects every filtered page and hands the records to the download seam', async () => {
    const downloaded: { records: readonly OpenItemRecord[]; options: unknown }[] = []
    const store = makeStore({
      download: (records, options) => {
        downloaded.push({ records, options })
        return { ok: true, filename: 'open-items-test.html', mimeType: 'text/html', byteLength: 2048, chunkCount: 3 }
      },
    })
    await store.actions.refresh()
    const result = await store.actions.downloadArchive({
      format: 'html',
      includeArchive: false,
      includeExcerpts: true,
      filterLabel: '30 days · All sources',
      generatedAt: NOW,
      pluginVersion: store.pluginVersion,
      schemaVersion: store.schemaVersion,
      earlierRecordsPruned: false,
    })
    expect(result).toEqual({ ok: true, filename: 'open-items-test.html', byteLength: 2048 })
    expect(downloaded).toHaveLength(1)
    // In-flight answers are not exportable fields (no resolvedAt in the generator
    // sense); the settled rows are.
    expect(downloaded[0]?.records.map(record => record.id)).toEqual([
      'reg-answered', 'reg-dismissed', 'reg-detected', 'reg-recent',
    ])
    expect(downloaded[0]?.options).toMatchObject({
      format: 'html',
      generatedAt: NOW,
      pluginVersion: '9.9.9-test',
      schemaVersion: 3,
      earlierRecordsPruned: false,
    })
    expect(store.getSnapshot().notice).toEqual({
      tone: 'ok',
      code: 'exported',
      filename: 'open-items-test.html',
      byteLength: 2048,
    })
    expect(store.getSnapshot().exporting).toBe(false)
  })

  it('collects through paging before exporting (no silent partial file)', async () => {
    const records = hostRecords().filter(record => record.state === 'resolved' && record.retention.class === 'active')
    const register = async (query: InboxQuery): Promise<RegisterValue> => {
      if (query.status === 'awaiting') return { items: [makeInFlight()], total: 1, earlierRecordsPruned: false }
      if (query.status === 'archived') return { items: [], total: 0, earlierRecordsPruned: false }
      const offset = query.cursor === undefined ? 0 : Number(query.cursor)
      const page = records.slice(offset, offset + 2)
      const next = offset + page.length < records.length ? String(offset + page.length) : undefined
      return {
        items: page,
        total: records.length,
        earlierRecordsPruned: false,
        ...(next === undefined ? {} : { nextCursor: next }),
      }
    }
    const downloaded: OpenItemRecord[][] = []
    const store = createRegisterStore({
      register,
      now: () => NOW,
      download: (items) => {
        downloaded.push([...items])
        return { ok: true, filename: 'all.html', mimeType: 'text/html', byteLength: 10, chunkCount: 1 }
      },
    })
    await store.actions.refresh()
    const collected = await store.actions.collectForExport()
    expect(collected.ok).toBe(true)
    if (collected.ok) {
      expect(collected.records.map(record => record.id)).toEqual([
        'reg-answered', 'reg-dismissed', 'reg-detected', 'reg-recent',
      ])
    }
    await store.actions.downloadArchive({
      format: 'jsonl',
      includeArchive: false,
      includeExcerpts: false,
      filterLabel: 'all',
      generatedAt: NOW,
      pluginVersion: 'x',
      schemaVersion: 3,
      earlierRecordsPruned: false,
    })
    expect(downloaded[0]).toHaveLength(4)
  })

  it('reports a download failure and never claims success', async () => {
    const store = makeStore({ download: () => ({ ok: false, error: 'download-unavailable' }) })
    await store.actions.refresh()
    const result = await store.actions.downloadArchive({
      format: 'csv',
      includeArchive: false,
      includeExcerpts: false,
      filterLabel: 'x',
      generatedAt: NOW,
      pluginVersion: 'x',
      schemaVersion: 3,
      earlierRecordsPruned: false,
    })
    expect(result).toEqual({ ok: false, error: 'download-unavailable' })
    expect(store.getSnapshot().notice).toEqual({
      tone: 'error',
      code: 'export-failed',
      message: 'download-unavailable',
    })
  })

  it('reports a register read failure before touching the download seam', async () => {
    const download = vi.fn()
    const store = createRegisterStore({ now: () => NOW, download })
    await store.actions.refresh()
    const result = await store.actions.collectForExport()
    expect(result).toEqual({ ok: false, error: 'register-unavailable' })
    expect(download).not.toHaveBeenCalled()
  })

  it('a full archive read marks the file as pruned when the page bound cuts it off', async () => {
    // The store collects at most maxResolvedRecords / pageSize pages; a fake that
    // always returns a next cursor proves the honest flag.
    const store = createRegisterStore({
      register: async () => ({
        items: [makeAnswered()],
        total: 99,
        earlierRecordsPruned: false,
        nextCursor: 'always',
      }),
      now: () => NOW,
      download: items => ({ ok: true, filename: 'x', mimeType: 'text/html', byteLength: 1, chunkCount: items.length }),
    })
    const collected = await store.actions.collectForExport()
    expect(collected.ok).toBe(true)
    if (collected.ok) {
      expect(collected.summary.earlierRecordsPruned).toBe(true)
      expect(collected.records).toHaveLength(25)
    }
  })
})
