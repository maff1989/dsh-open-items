/**
 * App-scoped register store: the Resolved tab's data, filters and write path.
 *
 * One store serves the tab, the resolved detail and the export dialog, so the
 * header counts, the list and the export always describe the same filter. It
 * owns no view state (selection is the only exception, because the detail pane
 * lives in the page shell) and it never mutates Host state except through the
 * typed transport.
 *
 * Reads:
 * - the active page for the current period/source/kind/search/session filter;
 * - the in-flight band (`status: 'awaiting'`), fetched separately because the
 *   Host register page takes one status per query;
 * - the archive count for the header line.
 *
 * Writes: `reopen` (DESIGN §7.4.3) only. Delete-forever has no endpoint yet and
 * is deliberately not invented here.
 *
 * Filters are applied twice: server-side through `registerQueryOf` (so paging
 * and totals are right) and client-side through `selectRegisterItems` (so a
 * page being slow, or a query field the Host does not know yet, cannot make the
 * list disagree with its header).
 *
 * @module dsh-open-items/client/data/register-store
 */
import type { InboxQuery, OpenItemRecord } from '../../shared/schema'
import { STORE_SCHEMA_VERSION } from '../../shared/schema'
import { LIMITS, type DeleteValue, type RegisterValue, type ReopenValue } from '../../shared/protocol'
import type { ExportOptions } from '../../shared/export'
import type { DownloadResult } from '../export/download'
import {
  dayHeadingOf,
  exportSummaryOf,
  groupRegisterByDay,
  inFlightOf,
  inFlightQueryOf,
  registerHeaderFacts,
  registerQueryOf,
  archivedCountQueryOf,
  selectRegisterItems,
  sortRegisterItems,
  INITIAL_REGISTER_FILTERS,
  type RegisterDayGroup,
  type RegisterHeaderFacts,
  type RegisterExportSummary,
  type RegisterFilters,
} from '../derive/register-view'
import { downloadExport } from '../export/download'

/** Load lifecycle of the register page. */
export type RegisterStatus = 'idle' | 'loading' | 'ready' | 'error'

/** A localized-by-the-component outcome notice; the store holds codes, not prose. */
export type RegisterNotice =
  | { readonly tone: 'ok'; readonly code: 'reopened' | 'deleted' | 'exported'; readonly filename?: string; readonly byteLength?: number }
  | { readonly tone: 'error'; readonly code: 'reopen-failed' | 'delete-failed' | 'export-failed' | 'unavailable'; readonly message: string }

/** Everything the register surfaces observe. */
export interface RegisterState {
  readonly status: RegisterStatus
  readonly filters: RegisterFilters
  /** Rows for the current filter (server page, client-mirrored). */
  readonly items: readonly OpenItemRecord[]
  /** Answers waiting on the session (UI.md §4.6 in-flight band). */
  readonly inFlight: readonly OpenItemRecord[]
  /** Server total matching the current filter (before paging). */
  readonly total: number
  /** Archived resolutions matching the session scope, for the header line. */
  readonly archived: number
  /** The Host pruned older rows: the register is not complete. */
  readonly earlierRecordsPruned: boolean
  /** Cursor of the next register page, if any. */
  readonly nextCursor?: string
  /** True while a further page is loading. */
  readonly loadingMore: boolean
  readonly error?: string
  /** True when the last failure was a carrier fault rather than a Host refusal. */
  readonly offline: boolean
  readonly lastReadAt: number
  /** Selected register row (the detail pane lives in the page shell). */
  readonly selectedId: string | null
  /** Item currently being reopened (CAS write in flight). */
  readonly busyId?: string
  /** True while an export is being generated/downloaded. */
  readonly exporting: boolean
  readonly notice?: RegisterNotice
}

/** The seams the store consumes; all injectable so tests need no network. */
export interface RegisterStoreDeps {
  /** `register` endpoint; absent when the Host route has not landed yet. */
  readonly register?: (query: InboxQuery, signal?: AbortSignal) => Promise<RegisterValue>
  /** `reopen` endpoint. */
  readonly reopen?: (itemId: string, expectedVersion: number) => Promise<ReopenValue | OpenItemRecord>
  /** `delete` endpoint (OD-06): tombstone one record after an explicit confirmation. */
  readonly deleteRecord?: (itemId: string, expectedVersion: number) => Promise<DeleteValue>
  /** Download wrapper; defaults to the real browser download. */
  readonly download?: (records: readonly OpenItemRecord[], options: ExportOptions) => DownloadResult
  /** Clock injection for deterministic periods and `generatedAt`. */
  readonly now?: () => number
  /** Plugin version stamped into export headers. */
  readonly pluginVersion?: string
  /** Store schema version stamped into export headers. */
  readonly schemaVersion?: number
}

/** A page of register rows, in the shape the UI renders. */
export interface RegisterPageView {
  readonly items: readonly OpenItemRecord[]
  readonly inFlight: readonly OpenItemRecord[]
  readonly header: RegisterHeaderFacts
  readonly nextCursor?: string
}

/** Result of collecting the whole filtered register for export. */
export type RegisterExportData =
  | { readonly ok: true; readonly records: readonly OpenItemRecord[]; readonly inFlight: number; readonly summary: RegisterExportSummary }
  | { readonly ok: false; readonly error: string }

/** Download outcome the dialog renders. */
export type RegisterDownloadResult =
  | { readonly ok: true; readonly filename: string; readonly byteLength: number }
  | { readonly ok: false; readonly error: string }

/** The register store face injected into the page. */
export interface RegisterStore {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => RegisterState
  /** Plugin version and schema version for export headers. */
  readonly pluginVersion: string
  readonly schemaVersion: number
  /** Current wall clock from the injected clock (export `generatedAt`). */
  now(): number
  readonly actions: {
    /** Merge filters, clear the selection and reload. */
    setFilters(patch: Partial<RegisterFilters>): void
    /** Clear every filter except the tab-owned period default. */
    clearFilters(): void
    select(itemId: string | null): void
    /** Read the current filter (first page + band + archive count). */
    refresh(): Promise<void>
    /** Append the next page of the current filter. */
    loadMore(): Promise<void>
    /** Reopen one settled item; a refusal is a typed notice, never a throw. */
    reopen(itemId: string): Promise<void>
    /** Delete one record forever (confirmed by the caller); resolves true on success. */
    delete(itemId: string, expectedVersion: number): Promise<boolean>
    /** Collect every filtered record for a complete export. */
    collectForExport(): Promise<RegisterExportData>
    /** Collect and download one export; failure is a notice, never a throw. */
    downloadArchive(options: ExportOptions): Promise<RegisterDownloadResult>
    /** Dismiss the current notice. */
    dismissNotice(): void
  }
}

/** Register page size: the Host's maximum page, so a typical store is one read. */
const PAGE_SIZE = LIMITS.listPageMax

/** Hard bound on pages collected for export (the store's resolution cap). */
const MAX_EXPORT_PAGES = Math.ceil(LIMITS.maxResolvedRecords / PAGE_SIZE)

/** Whether a thrown value is a transient carrier fault worth showing as offline. */
function isTransportError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'transport'
}

/** Stable one-line description of a thrown value. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Create one register store.
 * @param deps - transport/seam injection.
 * @returns the store.
 */
export function createRegisterStore(deps: RegisterStoreDeps = {}): RegisterStore {
  const now = deps.now ?? Date.now
  let state: RegisterState = {
    status: 'idle',
    filters: INITIAL_REGISTER_FILTERS,
    items: [],
    inFlight: [],
    total: 0,
    archived: 0,
    earlierRecordsPruned: false,
    loadingMore: false,
    offline: false,
    lastReadAt: 0,
    selectedId: null,
    exporting: false,
  }
  const listeners = new Set<() => void>()
  let generation = 0

  const publish = (patch: Partial<RegisterState>): void => {
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }

  const readPage = async (
    query: InboxQuery,
  ): Promise<RegisterValue> => {
    if (deps.register === undefined) {
      throw new Error('register-unavailable')
    }
    return deps.register(query)
  }

  const archivedCount = async (filters: RegisterFilters): Promise<number> => {
    if (filters.period === 'archive') return 0
    const page = await readPage(archivedCountQueryOf(filters))
    return page.total
  }

  const refresh = async (): Promise<void> => {
    const token = ++generation
    const filters = state.filters
    publish({
      status: state.items.length === 0 ? 'loading' : 'ready',
      error: undefined,
    })
    try {
      const current = now()
      const [main, band, archived] = await Promise.all([
        readPage(registerQueryOf(filters, current, { limit: PAGE_SIZE })),
        readPage(inFlightQueryOf(filters)),
        archivedCount(filters),
      ])
      if (token !== generation) return
      const items = selectRegisterItems(main.items, filters, current)
      const inFlight = inFlightOf(band.items, filters)
      const header = registerHeaderFacts(
        filters.period === 'archive' ? items.length : main.total,
        inFlight,
        archived,
        main.earlierRecordsPruned || band.earlierRecordsPruned,
      )
      publish({
        status: 'ready',
        filters,
        items,
        inFlight,
        total: header.resolved,
        archived: header.archived,
        earlierRecordsPruned: header.earlierRecordsPruned,
        nextCursor: main.nextCursor,
        loadingMore: false,
        error: undefined,
        offline: false,
        lastReadAt: current,
        // A record in the in-flight band is still selectable: resolved-tab
        // handoffs for answered-but-unacknowledged items land there.
        ...(state.selectedId !== null
          && !items.some(item => item.id === state.selectedId)
          && !inFlight.some(item => item.id === state.selectedId)
          ? { selectedId: null }
          : {}),
      })
    } catch (error) {
      if (token !== generation) return
      publish({
        status: state.items.length === 0 ? 'error' : 'ready',
        loadingMore: false,
        error: describe(error),
        offline: isTransportError(error),
      })
    }
  }

  const collectForExport = async (): Promise<RegisterExportData> => {
    const filters = state.filters
    const current = now()
    try {
      let cursor: string | undefined
      const collected: OpenItemRecord[] = []
      let pruned = state.earlierRecordsPruned
      for (let page = 0; page < MAX_EXPORT_PAGES; page += 1) {
        const value = await readPage(registerQueryOf(filters, current, {
          limit: PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        }))
        collected.push(...value.items)
        pruned = pruned || value.earlierRecordsPruned
        if (value.nextCursor === undefined) {
          cursor = undefined
          break
        }
        cursor = value.nextCursor
      }
      // A still-open cursor after the hard page bound means the file cannot be
      // complete; say so instead of exporting a silent subset.
      if (cursor !== undefined) pruned = true
      const records = selectRegisterItems(collected, filters, current)
      const inFlight = inFlightOf(state.inFlight, filters)
      return {
        ok: true,
        records,
        inFlight: inFlight.length,
        summary: exportSummaryOf(records, inFlight, pruned),
      }
    } catch (error) {
      return { ok: false, error: describe(error) }
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => state,
    pluginVersion: deps.pluginVersion ?? 'unknown',
    schemaVersion: deps.schemaVersion ?? STORE_SCHEMA_VERSION,
    now,
    actions: {
      setFilters(patch) {
        const filters: RegisterFilters = { ...state.filters, ...patch }
        publish({ filters, notice: undefined, selectedId: null })
        void refresh()
      },
      clearFilters() {
        const filters: RegisterFilters = { ...INITIAL_REGISTER_FILTERS }
        publish({ filters, notice: undefined, selectedId: null })
        void refresh()
      },
      select(itemId) {
        if (itemId === state.selectedId) return
        publish({ selectedId: itemId })
      },
      refresh,
      async loadMore() {
        const cursor = state.nextCursor
        if (cursor === undefined || state.loadingMore) return
        publish({ loadingMore: true })
        try {
          const value = await readPage(registerQueryOf(state.filters, now(), { limit: PAGE_SIZE, cursor }))
          const current = now()
          const merged = selectRegisterItems([...state.items, ...value.items], state.filters, current)
          publish({
            items: merged,
            nextCursor: value.nextCursor,
            loadingMore: false,
          })
        } catch (error) {
          publish({ loadingMore: false, error: describe(error), offline: isTransportError(error) })
        }
      },
      async reopen(itemId) {
        const record = state.items.find(candidate => candidate.id === itemId)
          ?? state.inFlight.find(candidate => candidate.id === itemId)
        if (record === undefined) return
        if (deps.reopen === undefined) {
          publish({ notice: { tone: 'error', code: 'unavailable', message: 'reopen-unavailable' } })
          return
        }
        publish({ busyId: itemId, notice: undefined })
        try {
          await deps.reopen(itemId, record.version)
          publish({
            busyId: undefined,
            selectedId: state.selectedId === itemId ? null : state.selectedId,
            items: state.items.filter(item => item.id !== itemId),
            inFlight: state.inFlight.filter(item => item.id !== itemId),
            total: Math.max(0, state.total - 1),
            notice: { tone: 'ok', code: 'reopened' },
          })
          // Reconcile with the Host: the reopened item now belongs to Needs you.
          void refresh()
        } catch (error) {
          publish({
            busyId: undefined,
            notice: { tone: 'error', code: 'reopen-failed', message: describe(error) },
          })
        }
      },
      async delete(itemId, expectedVersion) {
        if (deps.deleteRecord === undefined) {
          publish({ notice: { tone: 'error', code: 'unavailable', message: 'delete-unavailable' } })
          return false
        }
        publish({ busyId: itemId, notice: undefined })
        try {
          await deps.deleteRecord(itemId, expectedVersion)
          publish({
            busyId: undefined,
            selectedId: state.selectedId === itemId ? null : state.selectedId,
            items: state.items.filter(item => item.id !== itemId),
            inFlight: state.inFlight.filter(item => item.id !== itemId),
            total: Math.max(0, state.total - 1),
            notice: { tone: 'ok', code: 'deleted' },
          })
          // Reconcile with the Host: the tombstone must leave every surface.
          void refresh()
          return true
        } catch (error) {
          publish({
            busyId: undefined,
            notice: { tone: 'error', code: 'delete-failed', message: describe(error) },
          })
          return false
        }
      },
      collectForExport,
      async downloadArchive(options) {
        publish({ exporting: true, notice: undefined })
        const collected = await collectForExport()
        if (!collected.ok) {
          publish({ exporting: false, notice: { tone: 'error', code: 'export-failed', message: collected.error } })
          return { ok: false, error: collected.error }
        }
        const download = deps.download ?? downloadExport
        let result: DownloadResult
        try {
          result = download(collected.records, options)
        } catch (error) {
          result = { ok: false, error: describe(error) }
        }
        if (!result.ok) {
          publish({ exporting: false, notice: { tone: 'error', code: 'export-failed', message: result.error } })
          return { ok: false, error: result.error }
        }
        publish({
          exporting: false,
          notice: { tone: 'ok', code: 'exported', filename: result.filename, byteLength: result.byteLength },
        })
        return { ok: true, filename: result.filename, byteLength: result.byteLength }
      },
      dismissNotice() {
        if (state.notice === undefined) return
        publish({ notice: undefined })
      },
    },
  }
}

/** Rows of one page grouped by day, with their headings resolved to copy keys. */
export function pageGroups(
  items: readonly OpenItemRecord[],
  now: number,
): readonly { readonly group: RegisterDayGroup; readonly heading: 'today' | 'yesterday' | 'date' }[] {
  return groupRegisterByDay(items).map(group => ({
    group,
    heading: dayHeadingOf(group.start, now),
  }))
}

/** Sorted in-flight rows (band order). */
export function sortedInFlight(records: readonly OpenItemRecord[]): readonly OpenItemRecord[] {
  return sortRegisterItems(records)
}
