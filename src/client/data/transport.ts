/**
 * Typed browser client for the Host's exact Fetch route (`POST /api/open-items`).
 *
 * One envelope in, one envelope out: `{ endpoint, payload }` and
 * `{ ok: true, value }` / `{ ok: false, error }`. Connection owns
 * authentication and the owner-Peer fence, so a same-origin credentialed fetch
 * is the whole transport. Business failures arrive as typed values and are
 * thrown here as `OpenItemsRpcError`; only a broken carrier is `transport`.
 *
 * Protocol source of truth: `src/shared/protocol.ts` (both halves import it).
 *
 * @module dsh-open-items/client/data/transport
 */
import {
  OPEN_ITEMS_ROUTE_PATH,
  PROTOCOL_VERSION,
  type DeliveryRequest,
  type DeliveryValue,
  type DeleteRequest,
  type DeleteValue,
  type DismissRequest,
  type DismissValue,
  type HelloValue,
  type ListRequest,
  type ListValue,
  type OpenItemsErrorCode,
  type PromoteRequest,
  type PromoteValue,
  type RegisterRequest,
  type RegisterValue,
  type ReopenRequest,
  type ReopenValue,
  type ReplyRequest,
  type ReplyValue,
  type RequestEnvelope,
  type RouteReply,
  type SettingsRequest,
  type SettingsValue,
  type SettingsWriteInput,
  type SettingsWriteValue,
  type SnoozeRequest,
  type SnoozeValue,
  type SuppressRequest,
  type SuppressValue,
} from '../../shared/protocol'

/** Failure codes the browser can act on; `transport` is minted locally. */
export type InboxErrorCode = OpenItemsErrorCode | 'transport'

/** One typed route failure (business outcome or carrier fault). */
export class OpenItemsRpcError extends Error {
  constructor(
    readonly code: InboxErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'OpenItemsRpcError'
  }
}

/** The route face the store consumes. */
export interface InboxTransport {
  /** Capability and counts probe; never needs a session. */
  hello(signal?: AbortSignal): Promise<HelloValue>
  /** One inbox page (or register page) from the Host. */
  list(request?: ListRequest, signal?: AbortSignal): Promise<ListValue>
  /** One register page: resolutions only, newest first. */
  register(request?: RegisterRequest, signal?: AbortSignal): Promise<RegisterValue>
  /** One reply attempt through the matrix (settle or deliver). */
  reply(request: ReplyRequest, signal?: AbortSignal): Promise<ReplyValue>
  /** Re-read one delivery after a lost response; idempotent. */
  delivery(request: DeliveryRequest, signal?: AbortSignal): Promise<DeliveryValue>
  /** Hide an item from the open list without answering it. */
  dismiss(request: DismissRequest, signal?: AbortSignal): Promise<DismissValue>
  /** Defer an item. */
  snooze(request: SnoozeRequest, signal?: AbortSignal): Promise<SnoozeValue>
  /** Return a resolved/awaiting/archived item to the open list. */
  reopen(request: ReopenRequest, signal?: AbortSignal): Promise<ReopenValue>
  /** Explicit, confirmed "delete forever": the record becomes a tombstone (OD-06). */
  delete(request: DeleteRequest, signal?: AbortSignal): Promise<DeleteValue>
}

/**
 * Settings face of the same route (PLAN-remediation §2): a whole-record read and
 * a compare-and-set write. The write's lost race is a value (`conflict` with the
 * live record), never an error, so the controller can re-render Host truth.
 */
export interface SettingsTransport {
  /** Read the whole settings record (defaults when nothing was ever written). */
  settingsRead(signal?: AbortSignal): Promise<SettingsValue>
  /** Apply one patch against the version that was read. */
  settingsWrite(input: SettingsWriteInput, signal?: AbortSignal): Promise<SettingsWriteValue>
}

/**
 * Candidate lifecycle face (PLAN-remediation §7): the one-click confirmation and
 * suppression controls of the Candidates tab. Both are CAS writes on the
 * candidate's own version.
 */
export interface CandidateTransport {
  /** Confirm one candidate as a structural item. */
  promote(request: PromoteRequest, signal?: AbortSignal): Promise<PromoteValue>
  /** Dismiss one candidate and remember that it is not an item. */
  suppress(request: SuppressRequest, signal?: AbortSignal): Promise<SuppressValue>
}

/** Everything the browser half needs from the one route. */
export interface ClientTransport extends InboxTransport, SettingsTransport, CandidateTransport {}

/** Route path resolved against the document base so a mounted app still works. */
function routeUrl(base: string | undefined): URL {
  const documentBase = (globalThis as { document?: Document }).document?.baseURI
  const resolvedBase = base ?? documentBase ?? 'http://localhost/'
  return new URL(OPEN_ITEMS_ROUTE_PATH.replace(/^\//u, ''), resolvedBase)
}

/** Map an HTTP status class to the code the UI can act on. */
function statusCodeOf(status: number): InboxErrorCode {
  if (status === 401 || status === 403) return 'forbidden'
  if (status === 404) return 'not-found'
  if (status === 400 || status === 422) return 'bad-request'
  if (status === 409) return 'conflict'
  return 'transport'
}

/** Narrow an unknown value to a reply envelope; malformed bodies are transport faults. */
function parseReply<T>(body: unknown): RouteReply<T> {
  if (typeof body !== 'object' || body === null) {
    throw new OpenItemsRpcError('transport', 'the open-items route answered a malformed envelope')
  }
  const candidate = body as { ok?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown } }
  if (candidate.ok === true) return { ok: true, value: candidate.value as T }
  if (candidate.ok === false) {
    const code = typeof candidate.error?.code === 'string' ? candidate.error.code : 'unknown'
    const message = typeof candidate.error?.message === 'string' ? candidate.error.message : 'open-items request failed'
    return { ok: false, error: { code: code as OpenItemsErrorCode, message } }
  }
  throw new OpenItemsRpcError('transport', 'the open-items route answered an unknown envelope')
}

/**
 * Create the route transport.
 * @param fetchImpl - fetch-compatible function (defaults to the page's global fetch).
 * @param base - optional base URL override for tests and mounted apps.
 * @returns the typed transport.
 */
export function createTransport(
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
  base?: string,
): ClientTransport {
  const call = async <T>(endpoint: RequestEnvelope['endpoint'], payload: unknown, signal?: AbortSignal): Promise<T> => {
    const envelope: RequestEnvelope = payload === undefined ? { endpoint } : { endpoint, payload }
    let response: Response
    try {
      response = await fetchImpl(routeUrl(base), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw new OpenItemsRpcError('transport', error instanceof Error ? error.message : 'network request failed')
    }
    if (!response.ok) {
      const code = statusCodeOf(response.status)
      throw new OpenItemsRpcError(code, `open-items route answered HTTP ${String(response.status)}`)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new OpenItemsRpcError('transport', 'open-items route answered non-JSON content')
    }
    const reply = parseReply<T>(body)
    if (!reply.ok) throw new OpenItemsRpcError(reply.error.code, reply.error.message)
    return reply.value
  }
  return {
    hello: signal => call<HelloValue>('hello', undefined, signal),
    list: (request, signal) => call<ListValue>('list', request ?? {}, signal),
    register: (request, signal) => call<RegisterValue>('register', request ?? {}, signal),
    reply: (request, signal) => call<ReplyValue>('reply', request, signal),
    delivery: (request, signal) => call<DeliveryValue>('delivery', request, signal),
    dismiss: (request, signal) => call<DismissValue>('dismiss', request, signal),
    snooze: (request, signal) => call<SnoozeValue>('snooze', request, signal),
    reopen: (request, signal) => call<ReopenValue>('reopen', request, signal),
    delete: (request, signal) => call<DeleteValue>('delete', request, signal),
    settingsRead: signal => call<SettingsValue>('settings', { op: 'read' } satisfies SettingsRequest, signal),
    settingsWrite: (input, signal) => call<SettingsWriteValue>(
      'settings',
      { op: 'write', expectedVersion: input.expectedVersion, patch: input.patch } satisfies SettingsRequest,
      signal,
    ),
    promote: (request, signal) => call<PromoteValue>('promote', request, signal),
    suppress: (request, signal) => call<SuppressValue>('suppress', request, signal),
  }
}

export { PROTOCOL_VERSION }
