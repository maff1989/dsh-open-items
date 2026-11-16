import { describe, expect, it } from 'vitest'

import type { InboxTransport } from '../../src/client/data/transport'
import { createInboxStore } from '../../src/client/data/inbox-store'
import { makeItem, makeSnapshot } from './fixtures'

/** A transport that serves two list pages and records the requests. */
function pagedTransport(): InboxTransport & { readonly requests: unknown[] } {
  const requests: unknown[] = []
  const pageOne = makeSnapshot([makeItem({ id: 'a', source: { sessionId: 's1' } })], { nextCursor: 'c1' })
  const pageTwo = makeSnapshot([makeItem({ id: 'a', source: { sessionId: 's1' } }), makeItem({ id: 'b', source: { sessionId: 's2' } })])
  const transport = {
    hello: async () => ({
      protocol: 1, domainVersion: 1, schemaVersion: 3, installId: 'i',
      capabilities: { canSettleClient: true, canHostSettle: false, canDeliver: true, canRegister: true, hasContextLine: false },
      counts: { needsYou: 2, candidates: 0, awaiting: 0 },
      earlierRecordsPruned: false,
    }),
    list: async (request: { query?: { cursor?: string } } = {}) => {
      requests.push(request)
      return { snapshot: request.query?.cursor === 'c1' ? pageTwo : pageOne }
    },
    register: async () => ({ items: [], total: 0, earlierRecordsPruned: false }),
    reply: async () => { throw new Error('unused') },
    delivery: async () => ({}),
    dismiss: async () => { throw new Error('unused') },
    snooze: async () => { throw new Error('unused') },
    reopen: async () => { throw new Error('unused') },
    delete: async () => { throw new Error('unused') },
  } as unknown as InboxTransport & { requests: unknown[] }
  return Object.assign(transport, { requests })
}

describe('inbox paging', () => {
  it('appends the next page without duplicating ids and clears the cursor at the end', async () => {
    const transport = pagedTransport()
    const store = createInboxStore(transport, () => 1_000)
    await store.refresh(true)
    expect(store.getSnapshot().nextCursor).toBe('c1')
    await store.loadMore()
    expect(store.getSnapshot().snapshot?.items.map(item => item.id)).toEqual(['a', 'b'])
    expect(store.getSnapshot().nextCursor).toBeUndefined()
    // The page read reused the original query shape and added the cursor.
    expect(transport.requests.at(-1)).toMatchObject({ query: { cursor: 'c1' } })
    await store.loadMore() // no-op at the end
    expect(transport.requests).toHaveLength(2)
  })

  it('keeps the visible list and reports a paging failure separately from the page read (D-12)', async () => {
    const transport = pagedTransport()
    const store = createInboxStore(transport, () => 1_000)
    await store.refresh(true)
    ;(transport as { list: unknown }).list = async () => { throw new Error('offline page') }
    await store.loadMore()
    const state = store.getSnapshot()
    expect(state.snapshot?.items.map(item => item.id)).toEqual(['a'])
    expect(state.loadingMore).toBe(false)
    // A paging failure must not become the page-level error/offline state.
    expect(state.loadMoreError).toContain('offline page')
    expect(state.error).toBeUndefined()
    expect(state.offline).toBe(false)
    // Retrying clears the paging error once a page lands.
    ;(transport as { list: unknown }).list = async () => ({ snapshot: makeSnapshot([makeItem({ id: 'a' }), makeItem({ id: 'b' })]) })
    await store.loadMore()
    expect(store.getSnapshot().loadMoreError).toBeUndefined()
  })
})
