/**
 * Page view state of the inbox: tabs, grouping, the workspace lens, filters,
 * folds, selection and the list scroll offset.
 *
 * It lives outside React on purpose. The `main` page unmounts whenever the
 * reader opens a conversation, and the inbox spec requires the reader's filters,
 * grouping and scroll position to come back unchanged. One app-scoped store is
 * created in the plugin's `apply` and injected into the page registration, so
 * navigation away and back is not a reset.
 *
 * Every mutation is a named action over an immutable snapshot; the store holds
 * no data and no transport state (that is `inbox-store.ts`).
 *
 * @module dsh-open-items/client/data/page-store
 */
import type { OpenItemKind } from '../../shared/schema'

/** The four sections of the page. */
export type InboxTab = 'needs-you' | 'candidates' | 'snoozed' | 'resolved'

/** Grouping axis of the list. */
export type GroupBy = 'session' | 'workspace'

/** Workspace facet sentinel: no workspace narrowing. */
export const ALL_WORKSPACES = 'all'
/** Workspace facet sentinel: items whose session has no workspace membership. */
export const UNGROUPED_WORKSPACE = 'ungrouped'

/** Current filter combination of the page. */
export interface PageFilters {
  readonly tab: InboxTab
  readonly groupBy: GroupBy
  /** `ALL_WORKSPACES`, `UNGROUPED_WORKSPACE`, or a workspace id. */
  readonly workspace: string
  /** Case-insensitive substring over title, session title and workspace title. */
  readonly search: string
  /** Session narrowing (OD-12): set by the panel "View all" and session links. */
  readonly sessionId?: string
}

/** Immutable page view snapshot. */
export interface PageState {
  readonly filters: PageFilters
  /** Folded disclosure keys: `workspace:<key>` / `session:<id>`. */
  readonly collapsed: ReadonlySet<string>
  /** Selected item id, or null. */
  readonly selectedId: string | null
  /** Candidates ticked for a bulk confirm (Candidates tab only). */
  readonly candidateSelection: ReadonlySet<string>
  /** Last remembered list scroll offset in pixels. */
  readonly scrollTop: number
}

/** Named actions over the page state. */
export interface PageStoreActions {
  setTab(tab: InboxTab): void
  setGroupBy(groupBy: GroupBy): void
  /** Set the workspace facet: a workspace id, `all` or `ungrouped`. */
  setWorkspace(workspace: string): void
  setSearch(search: string): void
  /** Narrow the page to one Session, or clear the narrowing. */
  setSession(sessionId: string | undefined): void
  /** Replace the whole filter combination at once (used by lens arrivals). */
  setFilters(patch: Partial<PageFilters>): void
  toggleCollapsed(key: string): void
  select(itemId: string | null): void
  /** Tick/untick one candidate for a bulk confirm. */
  toggleCandidate(itemId: string): void
  /** Drop one candidate from the bulk selection (it left the list). */
  untickCandidate(itemId: string): void
  /** Clear the bulk-candidate selection. */
  clearCandidates(): void
  /**
   * Drop ticks for candidates the list no longer shows.
   *
   * Called after every narrowing and snapshot refresh so the bulk bar can never
   * count a hidden row (the old `promoteSelected` silently filtered them out on
   * write). Returns how many ticks were dropped, so the page can say so instead
   * of losing them quietly.
   * @param visibleIds - ids the current section actually renders.
   * @returns the number of dropped ticks.
   */
  pruneCandidates(visibleIds: Iterable<string>): number
  /** Remember the list scroll offset without notifying subscribers. */
  rememberScroll(scrollTop: number): void
  /** Explicit reset, used by tests and a future "clear view" control. */
  reset(): void
}

/** The injected page store: an observable read side plus named actions. */
export interface PageStore {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => PageState
  readonly actions: PageStoreActions
}

/** Initial filters: Needs you, grouped by session, no workspace narrowing. */
export const INITIAL_FILTERS: PageFilters = {
  tab: 'needs-you',
  groupBy: 'session',
  workspace: ALL_WORKSPACES,
  search: '',
}

/** Fold key of one workspace group. */
export function workspaceGroupKey(key: string): string {
  return `workspace:${key}`
}

/** Fold key of one session group. */
export function sessionGroupKey(sessionId: string): string {
  return `session:${sessionId}`
}

/**
 * Create one page store.
 * @param initial - optional initial filters (tests, deep links).
 * @param kinds - reserved for filter extensions; unused in the foundation.
 * @returns the store.
 */
export function createPageStore(initial: Partial<PageFilters> = {}): PageStore {
  let view: PageState = {
    filters: { ...INITIAL_FILTERS, ...initial },
    collapsed: new Set<string>(),
    selectedId: null,
    candidateSelection: new Set<string>(),
    scrollTop: 0,
  }
  const listeners = new Set<() => void>()

  const publish = (next: PageState): void => {
    if (next === view) return
    view = next
    for (const listener of [...listeners]) listener()
  }

  const setFilters = (patch: Partial<PageFilters>): void => {
    publish({ ...view, filters: { ...view.filters, ...patch } })
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => view,
    actions: {
      setTab(tab) {
        if (tab === view.filters.tab) return
        // Changing section keeps the workspace lens (the same axis still
        // applies) but drops the selection: the item may not be in the new tab.
        // A section change drops both the item selection and any bulk ticks.
        publish({ ...view, filters: { ...view.filters, tab }, selectedId: null, candidateSelection: new Set<string>() })
      },
      setGroupBy(groupBy) {
        if (groupBy === view.filters.groupBy) return
        publish({ ...view, filters: { ...view.filters, groupBy } })
      },
      setWorkspace(workspace) {
        if (workspace === view.filters.workspace) return
        publish({ ...view, filters: { ...view.filters, workspace }, selectedId: null })
      },
      setSearch(search) {
        if (search === view.filters.search) return
        publish({ ...view, filters: { ...view.filters, search } })
      },
      setSession(sessionId) {
        if (sessionId === view.filters.sessionId) return
        publish({ ...view, filters: { ...view.filters, sessionId }, selectedId: null })
      },
      setFilters,
      toggleCollapsed(key) {
        const collapsed = new Set(view.collapsed)
        if (collapsed.has(key)) collapsed.delete(key)
        else collapsed.add(key)
        publish({ ...view, collapsed })
      },
      toggleCandidate(itemId) {
        const candidateSelection = new Set(view.candidateSelection)
        if (candidateSelection.has(itemId)) candidateSelection.delete(itemId)
        else candidateSelection.add(itemId)
        publish({ ...view, candidateSelection })
      },
      untickCandidate(itemId) {
        if (!view.candidateSelection.has(itemId)) return
        const candidateSelection = new Set(view.candidateSelection)
        candidateSelection.delete(itemId)
        publish({ ...view, candidateSelection })
      },
      clearCandidates() {
        if (view.candidateSelection.size === 0) return
        publish({ ...view, candidateSelection: new Set<string>() })
      },
      pruneCandidates(visibleIds) {
        if (view.candidateSelection.size === 0) return 0
        const visible = new Set(visibleIds)
        let removed = 0
        const candidateSelection = new Set<string>()
        for (const id of view.candidateSelection) {
          if (visible.has(id)) candidateSelection.add(id)
          else removed += 1
        }
        if (removed === 0) return 0
        publish({ ...view, candidateSelection })
        return removed
      },
      select(itemId) {
        // Re-selecting the open item closes it again: on the medium layout the
        // inline detail has no visible Back control, so the row itself must be
        // the toggle (the same click also restores the wide detail's resting
        // state). Selecting another item replaces the selection.
        if (itemId === view.selectedId) {
          publish({ ...view, selectedId: null })
          return
        }
        publish({ ...view, selectedId: itemId })
      },
      rememberScroll(scrollTop) {
        // Deliberately silent: preserving the position must not re-render the
        // list while the reader scrolls.
        view = { ...view, scrollTop }
      },
      reset() {
        publish({
          filters: { ...INITIAL_FILTERS },
          collapsed: new Set<string>(),
          selectedId: null,
          candidateSelection: new Set<string>(),
          scrollTop: 0,
        })
      },
    },
  }
}

/** Kind narrowing is reserved for the filter bar; typed here so callers agree. */
export type KindFilter = readonly OpenItemKind[] | undefined
