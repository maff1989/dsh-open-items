/**
 * Route transport: one envelope in, typed reply or typed failure out.
 *
 * The page's global fetch is never used here; each case injects a fake so the
 * contract is checked without a harness.
 */
import { describe, expect, it, vi } from 'vitest'

import { OpenItemsRpcError, createTransport } from '../../src/client/data/transport'

/** Minimal Response stand-in for the fake fetch. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/** A fetch double returning one fixed response and recording calls. */
function fetchOf(response: Response): { fetch: typeof fetch; bodies: string[] } {
  const bodies: string[] = []
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    bodies.push(String(init?.body ?? ''))
    return response
  }
  return { fetch: fetchImpl as typeof fetch, bodies }
}

const HELLO = {
  protocol: 1,
  domainVersion: 1,
  schemaVersion: 3,
  installId: 'install-1',
  capabilities: { canSettleClient: false, canHostSettle: false, canDeliver: false, canRegister: true, hasContextLine: false },
  counts: { needsYou: 3, candidates: 1, awaiting: 0 },
  earlierRecordsPruned: false,
}

describe('createTransport', () => {
  it('posts the endpoint envelope and returns the hello value', async () => {
    const { fetch, bodies } = fetchOf(jsonResponse({ ok: true, value: HELLO }))
    const transport = createTransport(fetch, 'http://localhost/')
    await expect(transport.hello()).resolves.toEqual(HELLO)
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({ endpoint: 'hello' })
  })

  it('posts list queries as the payload', async () => {
    const snapshot = { snapshot: { revision: 2 } }
    const { fetch, bodies } = fetchOf(jsonResponse({ ok: true, value: snapshot }))
    const transport = createTransport(fetch, 'http://localhost/')
    await transport.list({ query: { status: 'open' } })
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({ endpoint: 'list', payload: { query: { status: 'open' } } })
  })

  it('posts the settings read as { op: read } and returns { settings }', async () => {
    const value = { settings: { schemaVersion: 1, version: 0, modelNudge: false, proseCandidates: true } }
    const { fetch, bodies } = fetchOf(jsonResponse({ ok: true, value }))
    const transport = createTransport(fetch, 'http://localhost/')
    await expect(transport.settingsRead()).resolves.toEqual(value)
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({ endpoint: 'settings', payload: { op: 'read' } })
  })

  it('posts a settings write with its expectedVersion and patch', async () => {
    const value = { status: 'written', settings: { schemaVersion: 1, version: 2, modelNudge: true, proseCandidates: true } }
    const { fetch, bodies } = fetchOf(jsonResponse({ ok: true, value }))
    const transport = createTransport(fetch, 'http://localhost/')
    await expect(transport.settingsWrite({ expectedVersion: 1, patch: { modelNudge: true } })).resolves.toEqual(value)
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({
      endpoint: 'settings',
      payload: { op: 'write', expectedVersion: 1, patch: { modelNudge: true } },
    })
  })

  it('returns a conflict as a value, not a thrown failure', async () => {
    const value = { status: 'conflict', settings: { schemaVersion: 1, version: 4, modelNudge: false, proseCandidates: false } }
    const { fetch } = fetchOf(jsonResponse({ ok: true, value }))
    const transport = createTransport(fetch, 'http://localhost/')
    await expect(transport.settingsWrite({ expectedVersion: 1, patch: { modelNudge: true } })).resolves.toEqual(value)
  })

  it('posts promote and suppress with the candidate id and version', async () => {
    const item = { id: 'candidate-1', version: 8 }
    const { fetch, bodies } = fetchOf(jsonResponse({ ok: true, value: { item } }))
    const transport = createTransport(fetch, 'http://localhost/')
    await expect(transport.promote({ itemId: 'candidate-1', expectedVersion: 8 })).resolves.toEqual({ item })
    await expect(transport.suppress({ itemId: 'candidate-1', expectedVersion: 8 })).resolves.toEqual({ item })
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({ endpoint: 'promote', payload: { itemId: 'candidate-1', expectedVersion: 8 } })
    expect(JSON.parse(bodies[1] ?? '{}')).toEqual({ endpoint: 'suppress', payload: { itemId: 'candidate-1', expectedVersion: 8 } })
  })

  it('throws a typed business failure instead of returning it', async () => {
    const { fetch } = fetchOf(jsonResponse({ ok: false, error: { code: 'forbidden', message: 'no access' } }))
    const transport = createTransport(fetch, 'http://localhost/')
    await expect(transport.hello()).rejects.toMatchObject({ code: 'forbidden', message: 'no access' })
  })

  it('maps HTTP status classes to actionable codes', async () => {
    const cases: readonly [number, string][] = [
      [401, 'forbidden'],
      [403, 'forbidden'],
      [404, 'not-found'],
      [400, 'bad-request'],
      [409, 'conflict'],
      [503, 'transport'],
    ]
    for (const [status, code] of cases) {
      const { fetch } = fetchOf(jsonResponse({}, status))
      const transport = createTransport(fetch, 'http://localhost/')
      await expect(transport.hello()).rejects.toMatchObject({ code })
    }
  })

  it('treats a malformed or non-JSON body as a transport fault', async () => {
    const malformed = { ok: true, status: 200, json: async () => ({ nonsense: true }) } as unknown as Response
    await expect(createTransport(fetchOf(malformed).fetch, 'http://localhost/').hello())
      .rejects.toMatchObject({ code: 'transport' })
    const nonJson = { ok: true, status: 200, json: async () => { throw new Error('not json') } } as unknown as Response
    await expect(createTransport(fetchOf(nonJson).fetch, 'http://localhost/').hello())
      .rejects.toMatchObject({ code: 'transport' })
  })

  it('folds a network throw into a transport failure', async () => {
    const offline = async (): Promise<Response> => { throw new TypeError('offline') }
    const transport = createTransport(offline as unknown as typeof fetch, 'http://localhost/')
    await expect(transport.hello()).rejects.toBeInstanceOf(OpenItemsRpcError)
    await expect(transport.hello()).rejects.toMatchObject({ code: 'transport' })
  })

  it('rethrows an abort unchanged', async () => {
    const controller = new AbortController()
    const aborted = async (): Promise<Response> => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    }
    const transport = createTransport(aborted as unknown as typeof fetch, 'http://localhost/')
    await expect(transport.hello(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    vi.restoreAllMocks()
  })
})
