/**
 * The register/reopen endpoints of the typed transport: envelope shape, the
 * query payload the store builds, and typed business failures.
 *
 * These two methods are the only route surface this milestone needs; main's
 * later route branch adds the reply surface beside them.
 */
import { describe, expect, it } from 'vitest'

import { OpenItemsRpcError, createTransport } from '../../src/client/data/transport'
import type { RequestEnvelope } from '../../src/shared/protocol'

/** One recorded request. */
interface Recorded {
  readonly url: string
  readonly body: RequestEnvelope
}

/** A fetch stub that answers one envelope. */
function fetchOf(reply: unknown, recorded: Recorded[], status = 200): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    recorded.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as RequestEnvelope,
    })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply,
    } as unknown as Response
  }) as typeof fetch
}

/** A transport over one reply. */
function transportOf(reply: unknown, status = 200): { transport: ReturnType<typeof createTransport>; requests: Recorded[] } {
  const requests: Recorded[] = []
  return { transport: createTransport(fetchOf(reply, requests, status), 'http://localhost/'), requests }
}

describe('transport.register', () => {
  it('sends the register endpoint with the store query', async () => {
    const { transport, requests } = transportOf({
      ok: true,
      value: { items: [], total: 0, earlierRecordsPruned: false },
    })
    const value = await transport.register({
      query: { status: 'resolved', since: 1_760_000_000_000, sources: ['user'], limit: 50 },
    })
    expect(value.total).toBe(0)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toContain('/api/open-items')
    expect(requests[0]?.body).toEqual({
      endpoint: 'register',
      payload: { query: { status: 'resolved', since: 1_760_000_000_000, sources: ['user'], limit: 50 } },
    })
  })

  it('sends an empty payload when no query is given', async () => {
    const { transport, requests } = transportOf({ ok: true, value: { items: [], total: 0, earlierRecordsPruned: false } })
    await transport.register()
    expect(requests[0]?.body).toEqual({ endpoint: 'register', payload: {} })
  })

  it('surfaces a register read failure as a typed error', async () => {
    const { transport } = transportOf({ ok: false, error: { code: 'forbidden', message: 'no access' } })
    await expect(transport.register()).rejects.toMatchObject({ name: 'OpenItemsRpcError', code: 'forbidden' })
  })
})

describe('transport.reopen', () => {
  it('sends the item id and the exact CAS version', async () => {
    const { transport, requests } = transportOf({
      ok: true,
      value: { item: { id: 'item-1', state: 'open' } },
    })
    await transport.reopen({ itemId: 'item-1', expectedVersion: 7 })
    expect(requests[0]?.body).toEqual({
      endpoint: 'reopen',
      payload: { itemId: 'item-1', expectedVersion: 7 },
    })
  })

  it('maps a conflict (an approval already exercised) to a typed error', async () => {
    const { transport } = transportOf({ ok: false, error: { code: 'conflict', message: 'cannot reopen' } }, 409)
    await expect(transport.reopen({ itemId: 'x', expectedVersion: 1 })).rejects.toBeInstanceOf(OpenItemsRpcError)
    await expect(transport.reopen({ itemId: 'x', expectedVersion: 1 })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('maps an HTTP conflict status to `conflict` even without an envelope', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 409,
      json: async () => ({}),
    })) as unknown as typeof globalThis.fetch
    const transport = createTransport(fetchImpl, 'http://localhost/')
    await expect(transport.reopen({ itemId: 'x', expectedVersion: 1 })).rejects.toMatchObject({ code: 'conflict' })
  })
})
