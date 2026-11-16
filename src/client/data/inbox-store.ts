/**
 * App-scoped inbox store: one snapshot every surface reads.
 *
 * The page, the nav count pill and (later) the in-session surfaces all project
 * this one source, so a refresh updates them together. Reads are single-flight
 * with a short freshness window; a failed read keeps the last good snapshot
 * (the page stays readable offline) and only a read with no snapshot at all
 * becomes an error state. Nothing here mutates Host state — writes arrive with
 * the reply milestone.
 *
 * @module dsh-open-items/client/data/inbox-store
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

import type { HelloValue, ListRequest } from '../../shared/protocol'
import type { InboxSnapshot } from '../../shared/schema'
import { OpenItemsRpcError, type InboxTransport } from './transport'

/** Load lifecycle of the inbox snapshot. */
export type InboxStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Everything every surface observes. */
export interface InboxState {
  readonly status: InboxStatus
  /** Last successful snapshot; stays readable while offline. */
  readonly snapshot: InboxSnapshot | undefined
  /** Capability probe result; drives degradation copy. */
  readonly hello: HelloValue | undefined
  /** Last failure message, cleared by the next success. */
  readonly error: string | undefined
  /** True when the last failure was a carrier fault rather than a Host refusal. */
  readonly offline: boolean
  /** Epoch ms of the last successful read. */
  readonly lastReadAt: number
  /** True while a read is in flight with a snapshot already on screen. */
  readonly refreshing: boolean
  /** Cursor of the next list page, when the Host has more matching rows. */
  readonly nextCursor?: string | undefined
  /** True while a further page is loading (never replaces the visible list). */
  readonly loadingMore?: boolean
  /** A refused/failed further-page read; the list itself stays intact. */
  readonly loadMoreError?: string | undefined
  /**
   * Section key of the read in flight (the page passes its active tab), and of
   * the last successful read. The page compares them with its own section so a
   * tab switch never renders the previous section's rows as the new section's
   * truth while the re-read is pending.
   */
  readonly requestedKey?: string | undefined
  readonly readKey?: string | undefined
}

/** How long a successful read satisfies a non-forced refresh. */
const FRESHNESS_MS = 2_000

/** The inbox store face injected into surfaces. */
export interface InboxStore {
  /** Observable snapshot for slot `hooks`. */
  readonly source: ObservableSnapshot<InboxState>
  /** Current state (synchronous). */
  getSnapshot(): InboxState
  /**
   * Read `hello` and the list once.
   * @param force - ignore the freshness window and supersede an in-flight read.
   * @param request - optional list query (scope/status/paging).
   * @param key - opaque section key the page compares with its active section.
   * @returns completion of the read; never rejects.
   */
  refresh(force?: boolean, request?: ListRequest, key?: string): Promise<void>
  /**
   * Append the next list page (`nextCursor`) to the current snapshot.
   * Keeps the counts the latest read reported and dedupes by item id.
   * @returns completion of the read; never rejects.
   */
  loadMore(): Promise<void>
  /** Drop listeners and abort an in-flight read. */
  dispose(): void
}

/** Whether a thrown value is a transient carrier fault worth showing as offline. */
function isTransportFailure(error: unknown): boolean {
  return error instanceof OpenItemsRpcError && error.code === 'transport'
}

/**
 * Create one inbox store.
 * @param transport - typed route transport.
 * @param now - injected clock for tests.
 * @returns the store.
 */
export function createInboxStore(transport: InboxTransport, now: () => number = Date.now): InboxStore {
  let state: InboxState = {
    status: 'idle',
    snapshot: undefined,
    hello: undefined,
    error: undefined,
    offline: false,
    lastReadAt: 0,
    refreshing: false,
    nextCursor: undefined,
    loadingMore: false,
    requestedKey: undefined,
    readKey: undefined,
  }
  const listeners = new Set<() => void>()
  let inflight: Promise<void> | undefined
  let abort: AbortController | undefined
  /** The query the last full read used, so a page read keeps the same filters. */
  let lastRequest: ListRequest | undefined

  const publish = (patch: Partial<InboxState>): void => {
    const next: InboxState = { ...state, ...patch }
    if (next === state) return
    state = next
    for (const listener of [...listeners]) listener()
  }

  const read = async (request: ListRequest | undefined, key: string | undefined): Promise<void> => {
    lastRequest = request
    const wasReady = state.snapshot !== undefined
    publish(wasReady
      ? { refreshing: true, status: 'ready', requestedKey: key }
      : { status: 'loading', refreshing: false, requestedKey: key })
    const controller = new AbortController()
    abort = controller
    try {
      const [hello, list] = await Promise.all([
        transport.hello(controller.signal),
        transport.list(request, controller.signal),
      ])
      publish({
        status: 'ready',
        snapshot: list.snapshot,
        hello,
        error: undefined,
        offline: false,
        lastReadAt: now(),
        refreshing: false,
        nextCursor: list.snapshot.nextCursor,
        loadingMore: false,
        loadMoreError: undefined,
        readKey: key,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        publish({ refreshing: false, loadingMore: false })
        return
      }
      const offline = isTransportFailure(error)
      publish({
        status: state.snapshot === undefined ? 'error' : 'ready',
        error: error instanceof Error ? error.message : String(error),
        offline,
        refreshing: false,
        loadingMore: false,
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
    getSnapshot: () => state,
    async refresh(force = false, request, key) {
      if (inflight !== undefined) {
        if (!force) return inflight
        abort?.abort()
        await inflight.catch(() => undefined)
      }
      if (!force && state.status === 'ready' && now() - state.lastReadAt < FRESHNESS_MS) return
      inflight = read(request, key)
      try {
        await inflight
      } finally {
        inflight = undefined
      }
    },
    async loadMore() {
      const cursor = state.nextCursor
      if (cursor === undefined || state.loadingMore) return
      publish({ loadingMore: true, loadMoreError: undefined })
      const base = lastRequest
      const request: ListRequest = {
        query: { ...(base?.query ?? {}), cursor },
      }
      try {
        const list = await transport.list(request)
        const current = state.snapshot
        if (current === undefined) {
          publish({ loadingMore: false })
          return
        }
        const seen = new Set(current.items.map(item => item.id))
        const appended = [
          ...current.items,
          ...list.snapshot.items.filter(item => !seen.has(item.id)),
        ]
        publish({
          snapshot: { ...current, items: appended, nextCursor: list.snapshot.nextCursor },
          nextCursor: list.snapshot.nextCursor,
          loadingMore: false,
          lastReadAt: now(),
        })
      } catch (error) {
        // A paging failure is not a page failure: keep the visible list and
        // report the failure beside the Load-more control.
        publish({
          loadingMore: false,
          loadMoreError: error instanceof Error ? error.message : String(error),
        })
      }
    },
    dispose() {
      abort?.abort()
      listeners.clear()
    },
  }
}

/** Convenience selector used by the nav row's new-count sentence and the page title badges. */
export function countOf(state: InboxState): number {
  return state.snapshot?.counts.needsYou ?? state.hello?.counts.needsYou ?? 0
}
