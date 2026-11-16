/**
 * The session-scoped data store behind the right-panel tab.
 *
 * One store per panel instance (therefore per session: the sidebar mints a tab
 * body only for the session it belongs to). It reads with the exact route the
 * inbox uses, narrowed by `scope.sessionId`, so the panel can only ever list its
 * own session's items:
 *
 * - `list` with `status: 'all'` — this session's open, stale and awaiting rows;
 * - `register` — this session's active resolutions (the "Resolved here"
 *   disclosure) plus the register's own `total`.
 *
 * Reads are single-flight with a short freshness window. A failed read keeps the
 * last good rows, so a restored panel degrades to "stale list + banner" instead
 * of a false empty state. Nothing here is a second inbox: no cross-session
 * reads, no counts from `snapshot.counts` (the Host computes those over every
 * stored record and ignores `scope`, so the panel derives its own counts from
 * the rows it received).
 *
 * Writes: one `reply` per activation, with a client-minted `deliveryId` so a
 * double click can never double-deliver (DESIGN §6.3). The Host validates the
 * track. The panel has no settle channel of its own, so it names no track for
 * an ordinary answer and lets the Host choose/downgrade — except for an
 * approval decision: the panel only renders *authored* approvals (a mirrored one
 * is hand-off only), which have no live card to settle, so their decision must
 * travel on `session-message` (DESIGN §6.4/§6.8).
 *
 * @module dsh-open-items/client/ui/panel/panel-store
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

import type { DeliveryId, OpenItemRecord, ReplyPayload } from '../../../shared/schema'
import { OpenItemsRpcError, type InboxErrorCode, type InboxTransport } from '../../data/transport'

/** Load lifecycle of the panel. */
export type PanelStatus = 'idle' | 'loading' | 'ready' | 'error'

/** The outcome of one reply attempt, as the row reports it. */
export type PanelOutcome =
  | { readonly kind: 'sent'; readonly itemId: string; readonly outcome: 'applied' | 'sent' | 'recorded'; readonly note?: string }
  | { readonly kind: 'conflict'; readonly itemId: string }
  | { readonly kind: 'failed'; readonly itemId: string; readonly code: InboxErrorCode; readonly message: string }

/** Everything the panel renders. */
export interface PanelState {
  readonly status: PanelStatus
  /** Session items in `open`/`stale`/`awaiting`; resolved rows live below. */
  readonly items: readonly OpenItemRecord[]
  /** The register page: active resolutions, newest first. */
  readonly resolved: readonly OpenItemRecord[]
  /** Register total for this session. */
  readonly resolvedTotal: number
  /** Open items across every session (the footer's cross-session count). */
  readonly globalOpen: number
  readonly error: string | undefined
  /** True when the last failure was a carrier fault rather than a Host refusal. */
  readonly offline: boolean
  /** Epoch ms of the last successful read; 0 before the first one. */
  readonly lastReadAt: number
  readonly refreshing: boolean
  /** True once a read has landed: the difference between cold and empty. */
  readonly loaded: boolean
  /** Item ids with a reply in flight. */
  readonly pending: ReadonlySet<string>
  /** The most recent reply result, for the row that produced it. */
  readonly outcome: PanelOutcome | undefined
}

/** Options one panel store needs. */
export interface PanelStoreOptions {
  /** Session this panel belongs to; every read is narrowed to it. */
  readonly sessionId: string
  /** Injected clock (tests). */
  readonly now?: () => number
  /** How many resolved rows to request for the disclosure. */
  readonly resolvedLimit?: number
  /** Delivery id minter (tests pin it). */
  readonly mintDeliveryId?: () => DeliveryId
}

/** The store face injected into the panel body. */
export interface PanelStore {
  readonly source: ObservableSnapshot<PanelState>
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => PanelState
  /**
   * Read this session's list and register.
   * @param force - ignore the freshness window and supersede an in-flight read.
   * @returns completion; never rejects.
   */
  refresh(force?: boolean): Promise<void>
  /**
   * Send one answer through the route.
   * @param item - the record the user acted on (its `version` is the CAS token).
   * @param payload - the answer exactly as chosen.
   * @param options - `confirmedWake` for an explicit wake confirmation (an
   *   approval's shipped confirmation is that explicit consent).
   * @returns the outcome; never rejects.
   */
  reply(item: OpenItemRecord, payload: ReplyPayload, options?: { readonly confirmedWake?: boolean }): Promise<PanelOutcome>
  /** Drop listeners and abort an in-flight read. */
  dispose(): void
}

/** How long a successful read satisfies a non-forced refresh. */
const FRESHNESS_MS = 2_000

/** Whether a thrown value is a transient carrier fault worth showing as offline. */
function isTransportFailure(error: unknown): boolean {
  return error instanceof OpenItemsRpcError && error.code === 'transport'
}

/** Mint a delivery id without assuming the platform crypto surface. */
function defaultDeliveryId(): DeliveryId {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  return `d${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`
}

/** Whether a record belongs in the open list rather than the register. */
function isLiveRecord(record: OpenItemRecord): boolean {
  return record.deletedAt === undefined && (record.state === 'open' || record.state === 'stale' || record.state === 'awaiting')
}

/**
 * Apply a Host-returned record to one state, keeping sections honest without a
 * re-read: the returned record is authoritative for its own item.
 * @param state - current state.
 * @param record - record returned by `reply`.
 * @returns patched state.
 */
function applyRecord(state: PanelState, record: OpenItemRecord): PanelState {
  const wasResolved = state.resolved.some(entry => entry.id === record.id)
  const items = state.items.filter(entry => entry.id !== record.id)
  const resolved = state.resolved.filter(entry => entry.id !== record.id)
  if (isLiveRecord(record)) {
    return { ...state, items: [...items, record], resolved, resolvedTotal: wasResolved ? state.resolvedTotal - 1 : state.resolvedTotal }
  }
  if (record.state === 'resolved' || record.state === 'archived') {
    return {
      ...state,
      items,
      resolved: [record, ...resolved].slice(0, Math.max(state.resolved.length, 1)),
      resolvedTotal: wasResolved ? state.resolvedTotal : state.resolvedTotal + 1,
    }
  }
  // Snoozed and unknown states leave both panel sections.
  return { ...state, items, resolved, resolvedTotal: wasResolved ? state.resolvedTotal - 1 : state.resolvedTotal }
}

/**
 * Create one panel store.
 * @param transport - typed route transport.
 * @param options - session scope, clock, page size and delivery-id minter.
 * @returns the store.
 */
export function createPanelStore(transport: InboxTransport, options: PanelStoreOptions): PanelStore {
  const now = options.now ?? Date.now
  const resolvedLimit = options.resolvedLimit ?? 5
  const mintDeliveryId = options.mintDeliveryId ?? defaultDeliveryId

  let state: PanelState = {
    status: 'idle',
    items: [],
    resolved: [],
    resolvedTotal: 0,
    globalOpen: 0,
    error: undefined,
    offline: false,
    lastReadAt: 0,
    refreshing: false,
    loaded: false,
    pending: new Set<string>(),
    outcome: undefined,
  }
  const listeners = new Set<() => void>()
  let inflight: Promise<void> | undefined
  let abort: AbortController | undefined

  const publish = (patch: Partial<PanelState>): void => {
    const next: PanelState = { ...state, ...patch }
    state = next
    for (const listener of [...listeners]) listener()
  }

  const read = async (): Promise<void> => {
    const controller = new AbortController()
    abort = controller
    publish(state.loaded ? { refreshing: true, status: 'ready' } : { status: 'loading', refreshing: false })
    try {
      const scope = { sessionId: options.sessionId }
      const [list, register, hello] = await Promise.all([
        transport.list({ query: { scope, status: 'all', limit: 200 } }, controller.signal),
        transport.register({ query: { scope, status: 'resolved', limit: resolvedLimit } }, controller.signal),
        // The footer's cross-session count: `hello.counts` is global by contract
        // (query filters and session scope never change it).
        transport.hello(controller.signal),
      ])
      if (controller.signal.aborted) return
      // Defensive scope: the Host narrows by `scope.sessionId`, and the panel
      // refuses anything else anyway — it can never render another session's row.
      const items = list.snapshot.items.filter(record => record.deletedAt === undefined
        && record.source.sessionId === options.sessionId)
      const resolved = register.items.filter(record => record.deletedAt === undefined
        && record.source.sessionId === options.sessionId)
      publish({
        status: 'ready',
        items,
        resolved,
        resolvedTotal: register.total,
        globalOpen: hello.counts.needsYou,
        error: undefined,
        offline: false,
        lastReadAt: now(),
        refreshing: false,
        loaded: true,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        publish({ refreshing: false })
        return
      }
      publish({
        status: state.loaded ? 'ready' : 'error',
        error: error instanceof Error ? error.message : String(error),
        offline: isTransportFailure(error),
        refreshing: false,
      })
    } finally {
      if (abort === controller) abort = undefined
    }
  }

  return {
    source: {
      getSnapshot: () => state,
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => state,
    async refresh(force = false) {
      if (inflight !== undefined) {
        if (!force) return inflight
        abort?.abort()
        await inflight.catch(() => undefined)
      }
      if (!force && state.loaded && now() - state.lastReadAt < FRESHNESS_MS) return
      inflight = read()
      try {
        await inflight
      } finally {
        inflight = undefined
      }
    },
    async reply(item, payload, replyOptions = {}) {
      if (state.pending.has(item.id)) {
        return { kind: 'failed', itemId: item.id, code: 'conflict', message: 'a reply is already in flight' }
      }
      const pending = new Set(state.pending)
      pending.add(item.id)
      publish({ pending, outcome: undefined })
      try {
        const value = await transport.reply({
          itemId: item.id,
          expectedVersion: item.version,
          deliveryId: mintDeliveryId(),
          payload,
          // The panel renders only authored approvals (mirrored ones hand off),
          // and an authored approval has no live request to settle: the decision
          // is a message into the session (DESIGN §6.4/§6.8).
          ...(payload.type === 'approval' ? { requestedTrack: 'session-message' as const } : {}),
          ...(replyOptions.confirmedWake === true ? { confirmedWake: true } : {}),
        })
        const remaining = new Set(state.pending)
        remaining.delete(item.id)
        const outcome: PanelOutcome = {
          kind: 'sent',
          itemId: item.id,
          outcome: value.outcome,
          ...(value.note === undefined ? {} : { note: value.note }),
        }
        publish({ ...applyRecord(state, value.item), pending: remaining, outcome })
        return outcome
      } catch (error) {
        const code: InboxErrorCode = error instanceof OpenItemsRpcError ? error.code : 'transport'
        const message = error instanceof Error ? error.message : String(error)
        const remaining = new Set(state.pending)
        remaining.delete(item.id)
        const outcome: PanelOutcome = code === 'conflict'
          ? { kind: 'conflict', itemId: item.id }
          : { kind: 'failed', itemId: item.id, code, message }
        publish({ pending: remaining, outcome, offline: code === 'transport' })
        if (code === 'conflict') void this.refresh(true)
        return outcome
      }
    },
    dispose() {
      abort?.abort()
      listeners.clear()
    },
  }
}
