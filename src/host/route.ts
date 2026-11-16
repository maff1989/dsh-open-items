/**
 * The exact Fetch route `/api/open-items`: the browser half's only Host call.
 *
 * Transport shape is copied from the proven highlights pattern
 * (`highlight-plugin/dsh-highlights/src/host/route.ts`): Connection owns
 * authentication and the owner-Peer fence — "Only owner Peers reach an exact
 * route; the shared handler answers 403 for every other principal"
 * (`@deepseek-ai/dsh-client-connection/lib/types/rpc.d.ts:119-131`), and the
 * plugin owns the JSON envelope. The generic Connection RPC channel is
 * empirically blocked for an out-of-tree fiber (it calls `owner.webServer`), so
 * an exact route is the supported seam (DESIGN §5.3).
 *
 * Division of labour: this module owns the wire — envelope, payload validation,
 * error mapping, capability advertisement — and never the answer policy. `reply`
 * delegates to the {@link ReplyEngine} supplied by the delivery layer; until that
 * layer mounts, the endpoint answers a typed `not-configured` error and `hello`
 * advertises `canDeliver: false`, so a client degrades instead of guessing.
 *
 * Business outcomes are values: an empty `delivery` read, a `notModified` list
 * and every refusal a caller can act on travel inside `{ ok: true, value }`.
 * Thrown failures become `{ ok: false, error }` with a stable code and a message
 * that never carries internals.
 * @module dsh-open-items/host/route
 */

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'

import type { ReplyEngine } from './delivery-contract'
import { ReplyEngineError } from './delivery-contract'
import type { OpenItemsService } from './service'
import {
  ConflictError,
  InvalidArgumentError,
  InvalidTransitionError,
  LimitError,
  NotFoundError,
  uuidv7,
} from './store'
import {
  ITEM_KINDS,
  MAX_BODY_CHARS,
  MAX_HISTORY_DETAIL_CHARS,
  MAX_OPTIONS,
  MAX_TITLE_CHARS,
  OPEN_ITEM_STATES,
} from '../shared/records'
import type {
  DeliveryRecord,
  InboxQuery,
  ListStatusFilter,
  OpenItemKind,
  OpenItemRecord,
  OpenItemState,
  OpenItemTier,
  ReplyPayload,
} from '../shared/schema'
import {
  LIMITS,
  OPEN_ITEMS_ROUTE_PATH,
  type CaptureStatus,
  type DeleteValue,
  type DeliveryValue,
  type DismissValue,
  type HelloValue,
  type ListValue,
  type OpenItemsEndpoint,
  type OpenItemsErrorCode,
  type RegisterValue,
  type ReopenValue,
  type ReplyRequest,
  type PromotePatch,
  type PromoteValue,
  type ReplyValue,
  type RouteReply,
  type SettingsPatch,
  type SettingsValue,
  type SettingsWriteValue,
  type SnoozeValue,
  type SuppressValue,
} from '../shared/protocol'

/** The slice of the Host `connection` service the route needs. */
export interface ConnectionFetchHost {
  readonly fetch: {
    /** Register one exact route; the disposer removes it. */
    register(route: ConnectionFetchRoute): () => Promise<void> | void
  }
}

/** Every endpoint this route answers, in dispatch order. */
export const OPEN_ITEMS_ENDPOINTS: readonly OpenItemsEndpoint[] = [
  'hello',
  'list',
  'register',
  'reply',
  'delivery',
  'dismiss',
  'snooze',
  'settings',
  'reopen',
  'delete',
  'promote',
  'suppress',
]

/** Status filters `list`/`register` accept (`InboxQuery.status`). */
const STATUS_FILTERS: readonly ListStatusFilter[] = ['open', 'awaiting', 'resolved', 'archived', 'all']

/** Tier filters `InboxQuery.tiers` accepts. */
const TIERS: readonly OpenItemTier[] = ['structural', 'candidate']

/** Source filters `InboxQuery.sources` accepts. */
const SOURCES = ['user', 'detector'] as const

/** Reply payload discriminators (mirrors `ReplyPayload`). */
const REPLY_TYPES = ['option', 'text', 'approval', 'task-action', 'dismiss'] as const

/** Answer tracks the client may request (mirrors `ReplyTrack`). */
const REPLY_TRACKS = ['client-settle', 'host-settle', 'session-message'] as const

/** Approval outcomes a `reply` may carry. */
const APPROVAL_OUTCOMES = ['allow-once', 'deny'] as const

/** Longest string a wire field may carry before it is rejected. */
const MAX_WIRE_STRING = 512

/** Dependencies the route is built with. */
export interface OpenItemsRouteDeps {
  /** The mounted inbox service (reads and every non-reply write). */
  readonly service: OpenItemsService
  /**
   * The delivery-layer engine, or a getter that resolves it at request time.
   *
   * A getter keeps the route independent of plugin load order: the delivery row
   * may activate after this one. Absent (or resolving to undefined) makes `reply`
   * answer `not-configured` and `hello` advertise no delivery capability.
   */
  readonly engine?: ReplyEngine | (() => ReplyEngine | undefined)
  /** Advertise the opt-in runtime-context line in `hello` capabilities. */
  readonly hasContextLine?: boolean
  /** Advertise `ask_user_question` timed mode in `hello` (optional enhancement). */
  readonly timedMode?: boolean
  /** Capture/backfill status for `hello`, resolved per request. */
  readonly capture?: () => CaptureStatus | undefined
  /** Injected clock (tests pin it; snooze validation reads it). */
  readonly now?: () => number
  /** Correlation-id source for one `reply`; tests inject a counter. */
  readonly newRequestId?: () => string
  /** Host logger for the failures the wire deliberately hides from the client. */
  readonly log?: { warn(message: string): void }
}

/**
 * Build the exact Fetch route bound to one mounted service.
 * @param deps - service, optional reply engine and policy flags.
 * @returns the Connection Fetch route definition.
 */
export function createOpenItemsRoute(deps: OpenItemsRouteDeps): ConnectionFetchRoute {
  return {
    path: OPEN_ITEMS_ROUTE_PATH,
    methods: ['POST'],
    // Buffered: Connection applies its configured JSON body cap, so the route
    // never sees an unbounded request body.
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return json(failure('bad-request', 'request body must be JSON'))
      }
      let envelope: { readonly endpoint: OpenItemsEndpoint; readonly payload: unknown }
      try {
        envelope = parseEnvelope(body)
      } catch (error) {
        return json(failureOf(deps, error))
      }
      try {
        return json({ ok: true, value: await dispatch(deps, envelope.endpoint, envelope.payload) })
      } catch (error) {
        return json(failureOf(deps, error))
      }
    },
  }
}

/**
 * Run one validated endpoint.
 * @param deps - route dependencies.
 * @param endpoint - validated endpoint name.
 * @param payload - unvalidated payload.
 * @returns the endpoint's value.
 */
async function dispatch(
  deps: OpenItemsRouteDeps,
  endpoint: OpenItemsEndpoint,
  payload: unknown,
): Promise<unknown> {
  switch (endpoint) {
    case 'hello':
      return hello(deps)
    case 'list':
      return list(deps, payload)
    case 'register':
      return register(deps, payload)
    case 'reply':
      return reply(deps, payload)
    case 'delivery':
      return delivery(deps, payload)
    case 'dismiss':
      return dismiss(deps, payload)
    case 'snooze':
      return snooze(deps, payload)
    case 'reopen':
      return reopen(deps, payload)
    case 'delete':
      return deleteForeverRoute(deps, payload)
    case 'settings':
      return settings(deps, payload)
    case 'promote':
      return promote(deps, payload)
    case 'suppress':
      return suppress(deps, payload)
    default:
      throw new BadRequest('unknown endpoint')
  }
}

/* ------------------------------------------------------------------ *
 * Endpoint implementations
 * ------------------------------------------------------------------ */

/**
 * `hello`: capability and identity probe; works with no session and no engine.
 * @param deps - route dependencies.
 * @returns the capability snapshot the client degrades from.
 */
function hello(deps: OpenItemsRouteDeps): HelloValue {
  const counts = deps.service.counts()
  const engine = engineOf(deps)
  const delivery = engine !== undefined
  // Read per request: the bridge's services may mount after the route. A
  // capability the Host cannot carry out is never advertised (DESIGN §6.2), so
  // a client that trusts `hello` never offers a control that cannot work.
  const capabilities = engine?.capabilities?.()
  const capture = deps.capture?.()
  return {
    protocol: deps.service.protocolVersion,
    domainVersion: deps.service.domainVersion,
    schemaVersion: deps.service.schemaVersion,
    installId: deps.service.installId,
    capabilities: {
      // Track 1: the Host can persist a settle the shipped browser card already
      // performed. The browser separately detects whether the card carrier is
      // present; this flag only says the durable record will be accepted.
      canSettleClient: delivery && (capabilities?.clientSettle ?? true),
      // Track 2: the Host can settle a continued timed question itself.
      canHostSettle: delivery && capabilities?.hostSettle === true,
      canDeliver: delivery,
      canRegister: true,
      hasContextLine: deps.hasContextLine === true,
    },
    counts: {
      needsYou: counts.needsYou,
      candidates: counts.candidates,
      awaiting: counts.awaiting,
    },
    earlierRecordsPruned: counts.earlierRecordsPruned,
    ...(deps.timedMode === undefined ? {} : { timedMode: deps.timedMode }),
    ...(capture === undefined ? {} : { capture }),
  }
}

/**
 * `list`: one inbox snapshot (authored + derived rows, counts, cursor).
 * @param deps - route dependencies.
 * @param payload - `{ query? }`.
 * @returns the snapshot.
 */
function list(deps: OpenItemsRouteDeps, payload: unknown): ListValue {
  const record = optionalRecord(payload)
  const query = parseInboxQuery(record?.['query'])
  return { snapshot: deps.service.list(query) }
}

/**
 * `register`: one page of resolutions, newest first.
 * @param deps - route dependencies.
 * @param payload - `{ query? }`.
 * @returns the register page.
 */
function register(deps: OpenItemsRouteDeps, payload: unknown): RegisterValue {
  const record = optionalRecord(payload)
  const query = parseInboxQuery(record?.['query'])
  return deps.service.register(query)
}

/**
 * `reply`: the single answer write path, delegated to the delivery layer.
 * @param deps - route dependencies.
 * @param payload - `ReplyRequest`.
 * @returns the engine's evidenced outcome.
 */
async function reply(deps: OpenItemsRouteDeps, payload: unknown): Promise<ReplyValue> {
  const request = parseReplyRequest(payload)
  const engine = engineOf(deps)
  if (engine === undefined) {
    throw new NotConfigured('reply delivery is not wired in this deployment; the inbox is read-only')
  }
  const requestId = (deps.newRequestId ?? (() => uuidv7()))()
  return await engine.reply(request, requestId)
}

/**
 * `delivery`: re-read one attempt by id (idempotent recovery after a lost
 * response). Absence is a value, not an error — the client re-reads state.
 * @param deps - route dependencies.
 * @param payload - `{ deliveryId }`.
 * @returns the delivery and its item, when found.
 */
function delivery(deps: OpenItemsRouteDeps, payload: unknown): DeliveryValue {
  const record = requiredRecord(payload, 'payload')
  const deliveryId = requiredString(record['deliveryId'], 'payload.deliveryId', 128)
  const found = findDelivery(deps.service.store.all(), deliveryId)
  return found === undefined ? {} : found
}

/**
 * `dismiss`: drop one item without an answer (`open → resolved`).
 * @param deps - route dependencies.
 * @param payload - `DismissRequest`.
 * @returns the written record.
 */
async function dismiss(deps: OpenItemsRouteDeps, payload: unknown): Promise<DismissValue> {
  const record = requiredRecord(payload, 'payload')
  const itemId = requiredString(record['itemId'], 'payload.itemId', 128)
  const expectedVersion = requiredInteger(record['expectedVersion'], 'payload.expectedVersion')
  const reason = optionalString(record['reason'], 'payload.reason', MAX_HISTORY_DETAIL_CHARS)
  const item = await deps.service.dismiss(itemId, expectedVersion, reason)
  return { item }
}

/**
 * `snooze`: hide one item until a future instant.
 * @param deps - route dependencies.
 * @param payload - `SnoozeRequest`.
 * @returns the written record.
 */
async function snooze(deps: OpenItemsRouteDeps, payload: unknown): Promise<SnoozeValue> {
  const record = requiredRecord(payload, 'payload')
  const itemId = requiredString(record['itemId'], 'payload.itemId', 128)
  const expectedVersion = requiredInteger(record['expectedVersion'], 'payload.expectedVersion')
  const until = requiredInteger(record['until'], 'payload.until')
  const now = (deps.now ?? Date.now)()
  if (until <= now) throw new BadRequest('payload.until must be in the future')
  const item = await deps.service.snooze(itemId, expectedVersion, until)
  return { item }
}

/**
 * `reopen`: return a settled item to the open list (`resolved/awaiting → open`).
 *
 * A re-opened item keeps the previous resolution in its log (the register keeps
 * the record) and bumps `reopenCount`, so the UI can distinguish "never
 * answered" from "answered, then asked again". An approval that was already
 * executed is refused by the store as a conflict: a granted approval cannot be
 * un-granted.
 * @param deps - route dependencies.
 * @param payload - `ReopenRequest`.
 * @returns the written record.
 */
async function reopen(deps: OpenItemsRouteDeps, payload: unknown): Promise<ReopenValue> {
  const record = requiredRecord(payload, 'payload')
  const itemId = requiredString(record['itemId'], 'payload.itemId', 128)
  const expectedVersion = requiredInteger(record['expectedVersion'], 'payload.expectedVersion')
  const item = await deps.service.reopen(itemId, expectedVersion)
  return { item }
}

/**
 * `delete`: the explicit, confirmed "delete forever" (DESIGN §7.4.3).
 *
 * The record becomes a tombstone instead of disappearing from the durable
 * domain: `deletedAt` marks it and the transcript-derived text is dropped, so
 * no read, register page, export or later fold can resurrect it. Repeating the
 * request with the same CAS token returns the tombstone unchanged; a stale
 * token is a `conflict`, a missing id a `not-found` and a malformed payload a
 * `bad-request`.
 * @param deps - route dependencies.
 * @param payload - `DeleteRequest`.
 * @returns the tombstone record.
 */
async function deleteForeverRoute(deps: OpenItemsRouteDeps, payload: unknown): Promise<DeleteValue> {
  const record = requiredRecord(payload, 'payload')
  const itemId = requiredString(record['itemId'], 'payload.itemId', 128)
  const expectedVersion = requiredInteger(record['expectedVersion'], 'payload.expectedVersion')
  if (expectedVersion < 1) throw new BadRequest('payload.expectedVersion must be at least 1')
  const item = await deps.service.deleteForever(itemId, expectedVersion)
  return { item }
}

/**
 * `settings`: read the install's preferences, or compare-and-set a patch.
 *
 * The payload is `{ op: 'read' }` or `{ op: 'write', expectedVersion, patch }`.
 * A lost race is a **value** (`status: 'conflict'` with the live record), not
 * an error: the client re-renders from Host truth instead of retrying blindly.
 * Settings changes are applied to the Host immediately (the service notifies the
 * wiring that registers the model nudge).
 * @param deps - route dependencies.
 * @param payload - `SettingsRequest`.
 * @returns the live record (read) or the write outcome.
 */
async function settings(deps: OpenItemsRouteDeps, payload: unknown): Promise<SettingsValue | SettingsWriteValue> {
  const record = requiredRecord(payload, 'payload')
  const op = record['op']
  if (op === 'read') return { settings: deps.service.settings() }
  if (op !== 'write') throw new BadRequest("payload.op must be 'read' or 'write'")
  const expectedVersion = requiredInteger(record['expectedVersion'], 'payload.expectedVersion')
  if (expectedVersion < 0) throw new BadRequest('payload.expectedVersion must not be negative')
  const patch = parseSettingsPatch(record['patch'], 'payload.patch')
  return await deps.service.setSettings(expectedVersion, patch)
}

/**
 * Validate one settings patch: known booleans type-checked, unknown keys ignored
 * (protocol version skew), an absent patch rejected.
 * @param value - candidate patch.
 * @param path - diagnostic path.
 * @returns the typed patch.
 */
function parseSettingsPatch(value: unknown, path: string): SettingsPatch {
  const record = requiredRecord(value, path)
  const patch: { modelNudge?: boolean; proseCandidates?: boolean; llmExtraction?: boolean } = {}
  if (record['modelNudge'] !== undefined) patch.modelNudge = requiredBoolean(record['modelNudge'], `${path}.modelNudge`)
  if (record['proseCandidates'] !== undefined) {
    patch.proseCandidates = requiredBoolean(record['proseCandidates'], `${path}.proseCandidates`)
  }
  if (record['llmExtraction'] !== undefined) {
    patch.llmExtraction = requiredBoolean(record['llmExtraction'], `${path}.llmExtraction`)
  }
  return patch
}

/**
 * `promote`: confirm one candidate, turning it into a structural item.
 *
 * Candidate-only: a structural item is already confirmed, and a settled item
 * cannot be promoted (the store's typed transition error maps to `conflict`).
 * The optional `patch` corrects the inferred item in the same CAS write; the
 * route owns its shape (known fields only, closed kind enum, bounded strings and
 * options) and the store owns the rekey/reply semantics.
 * @param deps - route dependencies.
 * @param payload - `PromoteRequest`.
 * @returns the written record (and whether the kind was corrected).
 */
async function promote(deps: OpenItemsRouteDeps, payload: unknown): Promise<PromoteValue> {
  const record = requiredRecord(payload, 'payload')
  const itemId = requiredString(record['itemId'], 'payload.itemId', 128)
  const expectedVersion = requiredInteger(record['expectedVersion'], 'payload.expectedVersion')
  if (expectedVersion < 1) throw new BadRequest('payload.expectedVersion must be at least 1')
  const patch = parsePromotePatch(record['patch'])
  // Readable before the write: a kind change rekeys the row, so `reclassified`
  // is the one fact the returned record alone cannot state.
  const before = deps.service.store.get(itemId)
  const item = await deps.service.promote(itemId, expectedVersion, patch)
  const reclassified = patch?.kind !== undefined && before !== undefined && before.kind !== patch.kind
  return { item, ...(reclassified ? { reclassified: true } : {}) }
}

/** The only keys a `promote` patch may carry; anything else is a caller bug. */
const PROMOTE_PATCH_FIELDS: readonly string[] = ['kind', 'title', 'body', 'quote', 'options']

/**
 * Validate one `promote` correction patch. Every field is optional, unknown
 * fields are rejected (a silent typo would silently not correct the item), and
 * the bounds are the stored-record bounds so an accepted patch always persists.
 * @param value - candidate patch (`undefined` means "no correction").
 * @returns the typed patch, or undefined when absent.
 */
function parsePromotePatch(value: unknown): PromotePatch | undefined {
  if (value === undefined) return undefined
  const record = requiredRecord(value, 'payload.patch')
  for (const key of Object.keys(record)) {
    if (!PROMOTE_PATCH_FIELDS.includes(key)) throw new BadRequest(`payload.patch.${key} is not a known field`)
  }
  const patch: {
    kind?: OpenItemKind
    title?: string
    body?: string
    quote?: string
    options?: readonly string[]
  } = {}
  if (record['kind'] !== undefined) patch.kind = oneOf(record['kind'], ITEM_KINDS, 'payload.patch.kind')
  if (record['title'] !== undefined) {
    patch.title = requiredString(record['title'], 'payload.patch.title', MAX_TITLE_CHARS)
  }
  if (record['body'] !== undefined) {
    patch.body = requiredString(record['body'], 'payload.patch.body', MAX_BODY_CHARS)
  }
  if (record['quote'] !== undefined) {
    patch.quote = requiredString(record['quote'], 'payload.patch.quote', MAX_BODY_CHARS)
  }
  if (record['options'] !== undefined) {
    const options = arrayOf(record['options'], 'payload.patch.options')
    if (options.length > MAX_OPTIONS) {
      throw new BadRequest(`payload.patch.options must have at most ${MAX_OPTIONS} entries`)
    }
    patch.options = options.map((entry, index) =>
      requiredString(entry, `payload.patch.options[${index}]`, MAX_BODY_CHARS))
  }
  return patch
}

/**
 * `suppress`: dismiss one candidate and suppress its fingerprint for good.
 *
 * Candidate-only, for the same reason as `promote`; the store writes the
 * exact-key suppressor so a later fold cannot re-raise the artifact.
 * @param deps - route dependencies.
 * @param payload - `SuppressRequest`.
 * @returns the resolved record.
 */
async function suppress(deps: OpenItemsRouteDeps, payload: unknown): Promise<SuppressValue> {
  const record = requiredRecord(payload, 'payload')
  const itemId = requiredString(record['itemId'], 'payload.itemId', 128)
  const expectedVersion = requiredInteger(record['expectedVersion'], 'payload.expectedVersion')
  if (expectedVersion < 1) throw new BadRequest('payload.expectedVersion must be at least 1')
  const reason = optionalString(record['reason'], 'payload.reason', MAX_HISTORY_DETAIL_CHARS)
  return { item: await deps.service.suppress(itemId, expectedVersion, reason) }
}

/* ------------------------------------------------------------------ *
 * Envelope and payload validation
 * ------------------------------------------------------------------ */

/** A caller error the wire reports as `bad-request`. */
class BadRequest extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequest'
  }
}

/** A capability this deployment deliberately does not have. */
class NotConfigured extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotConfigured'
  }
}

/**
 * Validate the request envelope.
 * @param body - parsed JSON body.
 * @returns the endpoint and its unvalidated payload.
 */
function parseEnvelope(body: unknown): { readonly endpoint: OpenItemsEndpoint; readonly payload: unknown } {
  const record = requiredRecord(body, 'body')
  const endpoint = record['endpoint']
  if (typeof endpoint !== 'string' || !(OPEN_ITEMS_ENDPOINTS as readonly string[]).includes(endpoint)) {
    throw new BadRequest('unknown endpoint')
  }
  return { endpoint: endpoint as OpenItemsEndpoint, payload: record['payload'] }
}

/**
 * Validate one `list`/`register` query. Unknown keys are ignored (version skew),
 * known keys are type-checked so a malformed page request cannot reach the view.
 * @param value - candidate query.
 * @returns the typed query.
 */
function parseInboxQuery(value: unknown): InboxQuery {
  if (value === undefined) return {}
  const record = requiredRecord(value, 'query')
  const query: {
    scope?: { sessionId?: string; workspaceId?: string }
    status?: ListStatusFilter
    kinds?: readonly OpenItemKind[]
    tiers?: readonly OpenItemTier[]
    states?: readonly OpenItemState[]
    sources?: readonly ('user' | 'detector')[]
    since?: number
    until?: number
    search?: string
    limit?: number
    cursor?: string
  } = {}
  if (record['status'] !== undefined) {
    query.status = oneOf(record['status'], STATUS_FILTERS, 'query.status')
  }
  if (record['kinds'] !== undefined) {
    query.kinds = arrayOf(record['kinds'], 'query.kinds').map((entry, index) =>
      oneOf(entry, ITEM_KINDS, `query.kinds[${index}]`))
  }
  if (record['tiers'] !== undefined) {
    query.tiers = arrayOf(record['tiers'], 'query.tiers').map((entry, index) =>
      oneOf(entry, TIERS, `query.tiers[${index}]`))
  }
  if (record['states'] !== undefined) {
    query.states = arrayOf(record['states'], 'query.states').map((entry, index) =>
      oneOf(entry, OPEN_ITEM_STATES, `query.states[${index}]`))
  }
  if (record['sources'] !== undefined) {
    query.sources = arrayOf(record['sources'], 'query.sources').map((entry, index) =>
      oneOf(entry, SOURCES, `query.sources[${index}]`))
  }
  if (record['since'] !== undefined) query.since = requiredInteger(record['since'], 'query.since')
  if (record['until'] !== undefined) query.until = requiredInteger(record['until'], 'query.until')
  if (record['search'] !== undefined) query.search = requiredString(record['search'], 'query.search', MAX_WIRE_STRING)
  if (record['limit'] !== undefined) {
    const limit = requiredInteger(record['limit'], 'query.limit')
    if (limit < 1) throw new BadRequest('query.limit must be positive')
    query.limit = Math.min(limit, LIMITS.listPageMax)
  }
  if (record['cursor'] !== undefined) query.cursor = requiredString(record['cursor'], 'query.cursor', MAX_WIRE_STRING)
  if (record['scope'] !== undefined) {
    const scope = requiredRecord(record['scope'], 'query.scope')
    const sessionId = optionalString(scope['sessionId'], 'query.scope.sessionId', 128)
    const workspaceId = optionalString(scope['workspaceId'], 'query.scope.workspaceId', 128)
    query.scope = {
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
    }
  }
  return query
}

/**
 * Validate one `reply` request (the engine owns the answer matrix, not the shape).
 * @param payload - candidate request.
 * @returns the typed request.
 */
function parseReplyRequest(payload: unknown): ReplyRequest {
  const record = requiredRecord(payload, 'payload')
  const itemId = requiredString(record['itemId'], 'payload.itemId', 128)
  const expectedVersion = requiredInteger(record['expectedVersion'], 'payload.expectedVersion')
  if (expectedVersion < 1) throw new BadRequest('payload.expectedVersion must be at least 1')
  const deliveryId = requiredString(record['deliveryId'], 'payload.deliveryId', 128)
  const replyPayload = parseReplyPayload(record['payload'], 'payload.payload')
  const requestedTrack = record['requestedTrack'] === undefined
    ? undefined
    : oneOf(record['requestedTrack'], REPLY_TRACKS, 'payload.requestedTrack')
  const confirmedWake = record['confirmedWake'] === undefined
    ? undefined
    : requiredBoolean(record['confirmedWake'], 'payload.confirmedWake')
  return {
    itemId,
    expectedVersion,
    deliveryId,
    payload: replyPayload,
    ...(requestedTrack === undefined ? {} : { requestedTrack }),
    ...(confirmedWake === undefined ? {} : { confirmedWake }),
  }
}

/**
 * Validate one answer payload, exactly as the user submitted it.
 * @param value - candidate payload.
 * @param path - diagnostic path.
 * @returns the typed payload.
 */
function parseReplyPayload(value: unknown, path: string): ReplyPayload {
  const record = requiredRecord(value, path)
  const type = oneOf(record['type'], REPLY_TYPES, `${path}.type`)
  switch (type) {
    case 'option':
      return { type, option: requiredString(record['option'], `${path}.option`, MAX_BODY_CHARS) }
    case 'text': {
      const text = requiredString(record['text'], `${path}.text`, MAX_BODY_CHARS)
      if (text.trim() === '') throw new BadRequest(`${path}.text must not be empty`)
      return { type, text }
    }
    case 'approval': {
      const outcome = oneOf(record['outcome'], APPROVAL_OUTCOMES, `${path}.outcome`)
      const note = optionalString(record['note'], `${path}.note`, MAX_HISTORY_DETAIL_CHARS)
      return { type, outcome, ...(note === undefined ? {} : { note }) }
    }
    case 'task-action': {
      const action = requiredString(record['action'], `${path}.action`, 256)
      const note = optionalString(record['note'], `${path}.note`, MAX_HISTORY_DETAIL_CHARS)
      return { type, action, ...(note === undefined ? {} : { note }) }
    }
    case 'dismiss': {
      const reason = optionalString(record['reason'], `${path}.reason`, MAX_HISTORY_DETAIL_CHARS)
      return { type, ...(reason === undefined ? {} : { reason }) }
    }
  }
}

/**
 * Resolve the reply engine, tolerating late plugin activation.
 * @param deps - route dependencies.
 * @returns the engine, or undefined when the delivery layer is not mounted.
 */
function engineOf(deps: OpenItemsRouteDeps): ReplyEngine | undefined {
  const engine = deps.engine
  if (engine === undefined) return undefined
  return typeof engine === 'function' ? engine() : engine
}

/* ------------------------------------------------------------------ *
 * Error mapping and replies
 * ------------------------------------------------------------------ */

/**
 * Map one thrown failure to the wire's stable code.
 *
 * Messages are the ones this plugin authored; an unexpected error is reported as
 * `unknown` with a generic sentence and logged, so no stack, path or record id
 * ever reaches the browser.
 * @param deps - route dependencies (logger).
 * @param error - the caught value.
 * @returns the failure envelope.
 */
function failureOf(deps: OpenItemsRouteDeps, error: unknown): RouteReply<never> {
  if (error instanceof BadRequest) return failure('bad-request', error.message)
  if (error instanceof NotConfigured) return failure('not-configured', error.message)
  if (error instanceof NotFoundError) return failure('not-found', 'no open item with that id')
  if (error instanceof ConflictError) return failure('conflict', 'the item changed since you loaded it; refresh')
  if (error instanceof InvalidTransitionError) {
    return failure('conflict', `that action is not allowed while the item is ${error.from}`)
  }
  if (error instanceof LimitError) return failure('limit-reached', 'the inbox live-item cap is reached')
  if (error instanceof InvalidArgumentError) return failure('bad-request', error.message)
  if (error instanceof ReplyEngineError) return failure(error.code, error.message)
  deps.log?.warn(`open-items route: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  return failure('unknown', 'the request failed')
}

/**
 * One failure envelope.
 * @param code - stable wire code.
 * @param message - user-safe message.
 * @returns the envelope.
 */
function failure(code: OpenItemsErrorCode, message: string): RouteReply<never> {
  return { ok: false, error: { code, message: message.slice(0, 300) } }
}

/**
 * One JSON response. Every application outcome — success or failure — keeps
 * status 200, so the browser maps a single envelope shape and treats HTTP status
 * as transport, exactly like the per-endpoint Remote calls it replaces.
 * @param reply - envelope.
 * @returns the HTTP response.
 */
function json(reply: RouteReply<unknown>): Response {
  return new Response(JSON.stringify(reply), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/* ------------------------------------------------------------------ *
 * Delivery lookup
 * ------------------------------------------------------------------ */

/**
 * Find one delivery attempt and its item across the stored records.
 *
 * The store keys items, not deliveries (one delivery belongs to exactly one
 * item), and the P0 scale is hundreds of records, so one scan is the honest
 * implementation; a secondary index would be a durability change, not a route
 * change.
 * @param records - every stored record.
 * @param deliveryId - delivery to find.
 * @returns the delivery and its item, or undefined.
 */
function findDelivery(
  records: readonly OpenItemRecord[],
  deliveryId: string,
): { readonly delivery: DeliveryRecord; readonly item: OpenItemRecord } | undefined {
  for (const record of records) {
    for (const attempt of record.deliveries) {
      if (attempt.deliveryId === deliveryId) return { delivery: attempt, item: record }
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * Small validators
 * ------------------------------------------------------------------ */

/**
 * Read a required plain object.
 * @param value - candidate.
 * @param path - diagnostic path.
 * @returns the record.
 */
function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequest(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

/**
 * Read an optional plain object (an omitted payload is the empty request).
 * @param value - candidate.
 * @returns the record, or undefined.
 */
function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  return requiredRecord(value, 'payload')
}

/**
 * Read a required non-empty string within a length cap.
 * @param value - candidate.
 * @param path - diagnostic path.
 * @param maxChars - cap.
 * @returns the string.
 */
function requiredString(value: unknown, path: string, maxChars: number): string {
  if (typeof value !== 'string') throw new BadRequest(`${path} must be a string`)
  if (value.length > maxChars) throw new BadRequest(`${path} is longer than ${maxChars} characters`)
  if (value.trim() === '') throw new BadRequest(`${path} must not be empty`)
  return value
}

/**
 * Read an optional string within a length cap.
 * @param value - candidate.
 * @param path - diagnostic path.
 * @param maxChars - cap.
 * @returns the string, or undefined.
 */
function optionalString(value: unknown, path: string, maxChars: number): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, path, maxChars)
}

/**
 * Read a required safe integer.
 * @param value - candidate.
 * @param path - diagnostic path.
 * @returns the integer.
 */
function requiredInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new BadRequest(`${path} must be an integer`)
  }
  return value
}

/**
 * Read a required boolean.
 * @param value - candidate.
 * @param path - diagnostic path.
 * @returns the boolean.
 */
function requiredBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new BadRequest(`${path} must be a boolean`)
  return value
}

/**
 * Read a required array.
 * @param value - candidate.
 * @param path - diagnostic path.
 * @returns the array.
 */
function arrayOf(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new BadRequest(`${path} must be an array`)
  return value
}

/**
 * Read one value from a closed set.
 * @param value - candidate.
 * @param allowed - allowed values.
 * @param path - diagnostic path.
 * @returns the member.
 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new BadRequest(`${path} must be one of ${allowed.join(', ')}`)
  }
  return value as T
}
