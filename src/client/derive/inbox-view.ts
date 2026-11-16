/**
 * Pure derivations behind the inbox page: tab filtering, the workspace facet,
 * session and workspace grouping, and the counts that must agree everywhere.
 *
 * Everything here is synchronous and React-free so the rules can be tested
 * without a DOM. The page renders only what these functions return; no
 * component re-implements a rule.
 *
 * Rules (DESIGN §5.10, UI.md §4.2-§4.3):
 * - Needs you = structural items in `open`, `stale` or `awaiting`.
 * - Candidates = candidate-tier items that are still open; Snoozed = `snoozed`;
 *   Resolved = `resolved` or `archived` (the register's active window).
 * - Ownership is the item's workspace snapshot resolved against the host
 *   workspace rows; a session with no membership is honestly Ungrouped.
 * - Workspace groups order by newest item activity, tie-broken by the sidebar's
 *   durable workspace order; Ungrouped is always last.
 * - Sessions inside a workspace order by newest item.
 * - Items order by severity, then longest waiting first.
 * - Facet counts come from the current section only, so they never disagree
 *   with the list they filter.
 *
 * @module dsh-open-items/client/derive/inbox-view
 */
import { isNeedsYouRecord } from '../../shared/records'
import { toPlainText } from '../ui/prose-text'
import type {
  InboxSnapshot,
  OpenItemKind,
  OpenItemRecord,
  SessionInboxRow,
  WorkspaceInboxRow,
} from '../../shared/schema'
import {
  ALL_WORKSPACES,
  UNGROUPED_WORKSPACE,
  type InboxTab,
  type PageFilters,
} from '../data/page-store'
import type { SessionTitleResolver } from '../format'

/** One session group inside the two grouping modes. */
export interface SessionGroupView {
  readonly sessionId: string
  /** Session title from the item snapshot; absent when unknown. */
  readonly title: string | undefined
  /** Workspace key this session's items resolve to. */
  readonly workspaceKey: string
  readonly workspaceTitle: string | undefined
  /** Newest item activity in the group (epoch ms). */
  readonly updatedAt: number
  /** Items in triage order (severity, then longest waiting first). */
  readonly items: readonly OpenItemRecord[]
}

/** One workspace group of the workspace grouping mode. */
export interface WorkspaceGroupView {
  /** Workspace id, `ungrouped`, or a removed workspace's remembered id. */
  readonly key: string
  readonly workspaceId: string | undefined
  /** Live or remembered title; absent for the Ungrouped bucket. */
  readonly title: string | undefined
  readonly path: string | undefined
  /** The workspace row exists live but the workspace is gone. */
  readonly removed: boolean
  /** True for the bucket collecting sessions without workspace membership. */
  readonly ungrouped: boolean
  readonly itemCount: number
  readonly sessionCount: number
  readonly updatedAt: number
  readonly sessions: readonly SessionGroupView[]
}

/** One option of the workspace facet. */
export interface WorkspaceFacetView {
  readonly key: string
  readonly workspaceId: string | undefined
  readonly title: string | undefined
  readonly removed: boolean
  readonly ungrouped: boolean
  /** Items in the current section that belong here. */
  readonly count: number
}

/** Counts rendered by the page-head count badges and the nav row. */
export interface TabCounts {
  readonly needsYou: number
  readonly candidates: number
  readonly snoozed: number
  readonly resolved: number
}

/** Everything the page renders. */
export interface InboxView {
  readonly tab: InboxTab
  /** Items visible after the tab, search and workspace narrowing. */
  readonly items: readonly OpenItemRecord[]
  /** Session grouping of {@link items}. */
  readonly sessionGroups: readonly SessionGroupView[]
  /** Workspace grouping of {@link items}; empty when grouping by session. */
  readonly workspaceGroups: readonly WorkspaceGroupView[]
  /** Workspace facet options, counts computed from the current section. */
  readonly facets: readonly WorkspaceFacetView[]
  /** Section size before workspace narrowing (the facet counts must sum to it). */
  readonly sectionTotal: number
  /** Counts for the four tabs (populated even when the current tab is empty). */
  readonly counts: TabCounts
  /** Answered-but-unacknowledged items (the register's in-flight band). */
  readonly awaiting: number
  /** Low-priority structural items for the collapsed FYI group of Needs you. */
  readonly fyi: readonly OpenItemRecord[]
  /** True when a search or workspace narrowing hides items. */
  readonly narrowed: boolean
}

/** Every item kind, used for exhaustive copy mapping. */
export const ITEM_KINDS: readonly OpenItemKind[] = [
  'decision',
  'approval',
  'question',
  'plan-review',
  'blocker',
  'risk',
  'follow-up',
  'task',
]

/** The locked "needs you" predicate (OD-05/OI-05, mirrors the Host counts): a
 * structural open|stale item of severity 1|2 that is not a tombstone. Candidates
 * have their own tab, `awaiting` has the in-flight band, `snoozed` its own tab. */
export function isNeedsYou(item: OpenItemRecord): boolean {
  // Single source of truth shared with the Host counts (OI-05).
  return isNeedsYouRecord(item)
}

/**
 * A low-priority (severity 3) structural item that still needs the reader.
 *
 * It is not "Needs you" (OD-05 locks that badge to severity 1|2), but it must not
 * vanish: the page renders it as a collapsed FYI group at the bottom of Needs
 * you. Jobs, todo-derived rows and authored FYI notes land here.
 * @param item - the durable record.
 * @returns true for a live severity-3 structural item.
 */
export function isFyi(item: OpenItemRecord): boolean {
  return item.deletedAt === undefined
    && item.tier === 'structural'
    && (item.state === 'open' || item.state === 'stale')
    && item.severity >= 3
}

/** A prose-inferred candidate waiting for confirmation. */
export function isCandidate(item: OpenItemRecord): boolean {
  return item.tier === 'candidate' && (item.state === 'open' || item.state === 'stale')
}

/** An item the reader deferred. */
export function isSnoozed(item: OpenItemRecord): boolean {
  return item.state === 'snoozed'
}

/** An item in the register (resolved or decayed). */
export function isResolved(item: OpenItemRecord): boolean {
  return item.state === 'resolved' || item.state === 'archived'
}

/** Items belonging to one section, tombstones removed. */
export function itemsForTab(items: readonly OpenItemRecord[], tab: InboxTab): readonly OpenItemRecord[] {
  const live = items.filter(item => item.deletedAt === undefined)
  switch (tab) {
    case 'needs-you':
      return live.filter(isNeedsYou)
    case 'candidates':
      return live.filter(isCandidate)
    case 'snoozed':
      return live.filter(isSnoozed)
    case 'resolved':
      return live.filter(isResolved)
  }
}

/** Workspace key of one item: the snapshot id or the Ungrouped bucket. */
export function workspaceKeyOf(item: OpenItemRecord): string {
  return item.source.workspace?.workspaceId ?? UNGROUPED_WORKSPACE
}

/** Workspace facet row for the Ungrouped bucket, when one is needed. */
function ungroupedFacet(): WorkspaceFacetView {
  return { key: UNGROUPED_WORKSPACE, workspaceId: undefined, title: undefined, removed: false, ungrouped: true, count: 0 }
}

/** Facet row from a host workspace row. */
function facetOf(row: WorkspaceInboxRow): WorkspaceFacetView {
  const workspaceId = row.workspaceId
  return {
    key: workspaceId ?? UNGROUPED_WORKSPACE,
    workspaceId,
    title: row.title,
    removed: row.removed,
    ungrouped: workspaceId === undefined,
    count: 0,
  }
}

/**
 * The workspace facet for one section.
 *
 * Host order first (`snapshot.workspaces`), then workspaces known only from item
 * snapshots (a deleted workspace keeps its group), then Ungrouped last. Every
 * live workspace is listed even at `0` so "clear" is visible.
 * @param items - section items after search narrowing (not workspace narrowing).
 * @param snapshot - current Host snapshot, when loaded.
 * @returns facet rows in render order.
 */
export function deriveWorkspaceFacets(
  items: readonly OpenItemRecord[],
  snapshot: InboxSnapshot | undefined,
): readonly WorkspaceFacetView[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    const key = workspaceKeyOf(item)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const facets: WorkspaceFacetView[] = []
  const seen = new Set<string>()
  const rows = snapshot?.workspaces ?? []
  for (const row of rows) {
    // The Ungrouped bucket is derived, never taken from a Host label: its copy
    // is locale-owned by the page, and the fallback label lives here.
    if (row.workspaceId === undefined) continue
    const facet = facetOf(row)
    if (seen.has(facet.key)) continue
    seen.add(facet.key)
    facets.push({ ...facet, count: counts.get(facet.key) ?? 0 })
  }
  // Workspaces known only from an item snapshot (deleted after the item was
  // raised): show them under the remembered title, flagged removed.
  for (const item of items) {
    const key = workspaceKeyOf(item)
    if (key === UNGROUPED_WORKSPACE || seen.has(key)) continue
    seen.add(key)
    facets.push({
      key,
      workspaceId: key,
      title: item.source.workspace?.title ?? item.source.workspace?.path,
      removed: true,
      ungrouped: false,
      count: counts.get(key) ?? 0,
    })
  }
  facets.push({ ...ungroupedFacet(), count: counts.get(UNGROUPED_WORKSPACE) ?? 0 })
  // Ungrouped is always last; host order is preserved for everything else.
  const ungroupedIndex = facets.findIndex(facet => facet.ungrouped)
  if (ungroupedIndex !== -1 && ungroupedIndex !== facets.length - 1) {
    const [ungrouped] = facets.splice(ungroupedIndex, 1)
    if (ungrouped !== undefined) facets.push(ungrouped)
  }
  return facets
}

/** Whether the workspace narrowing keeps one item. */
function matchesWorkspace(item: OpenItemRecord, workspace: string): boolean {
  if (workspace === ALL_WORKSPACES) return true
  const key = workspaceKeyOf(item)
  if (workspace === UNGROUPED_WORKSPACE) return key === UNGROUPED_WORKSPACE
  return key === workspace
}

/**
 * Whether the search keeps one item (title, body, session title, workspace title).
 * Prose is matched by its projected text, so a reader can find
 * "E — Ship together" without typing the transcript's `**`/`- ` markers.
 */
function matchesSearch(item: OpenItemRecord, needle: string): boolean {
  if (needle === '') return true
  const lowered = needle.toLowerCase()
  return (toPlainText(item.title).toLowerCase().includes(lowered)
    || toPlainText(item.body).toLowerCase().includes(lowered)
    || (item.source.sessionTitle?.toLowerCase().includes(lowered) ?? false)
    || (item.source.workspace?.title?.toLowerCase().includes(lowered) ?? false))
}

/** Triage order inside a group or a flat list. */
export function compareItems(left: OpenItemRecord, right: OpenItemRecord): number {
  if (left.severity !== right.severity) return left.severity - right.severity
  // Same severity: the item that has waited longest comes first.
  if (left.firstSeenAt !== right.firstSeenAt) return left.firstSeenAt - right.firstSeenAt
  return left.id.localeCompare(right.id)
}

/** Newest item activity of a non-empty item set. */
function newestAt(items: readonly OpenItemRecord[]): number {
  let newest = 0
  for (const item of items) newest = Math.max(newest, item.updatedAt)
  return newest
}

/** Session rows indexed by session id. */
function sessionsById(snapshot: InboxSnapshot | undefined): ReadonlyMap<string, SessionInboxRow> {
  const index = new Map<string, SessionInboxRow>()
  for (const row of snapshot?.sessions ?? []) index.set(row.sessionId, row)
  return index
}

/**
 * Group items by their session (the default grouping).
 * @param items - items after all narrowing.
 * @param snapshot - current Host snapshot (session-title fallback).
 * @param resolveSessionTitle - optional live catalogue lookup, read per session.
 * @returns session groups, newest activity first.
 */
export function groupBySession(
  items: readonly OpenItemRecord[],
  snapshot: InboxSnapshot | undefined,
  resolveSessionTitle?: SessionTitleResolver,
): readonly SessionGroupView[] {
  const sessions = sessionsById(snapshot)
  const groups = new Map<string, { title: string | undefined; workspaceKey: string; items: OpenItemRecord[] }>()
  for (const item of items) {
    const sessionId = item.source.sessionId
    const key = workspaceKeyOf(item)
    const existing = groups.get(sessionId)
    if (existing === undefined) {
      groups.set(sessionId, {
        // The item snapshot first, then the live catalogue, then the Host row:
        // an authored raise never stamps a title, and that proves nothing.
        title: item.source.sessionTitle ?? resolveSessionTitle?.(sessionId) ?? sessions.get(sessionId)?.title,
        workspaceKey: key,
        items: [item],
      })
    } else {
      existing.items.push(item)
    }
  }
  const views: SessionGroupView[] = []
  for (const [sessionId, group] of groups) {
    const sorted = [...group.items].sort(compareItems)
    views.push({
      sessionId,
      title: group.title,
      workspaceKey: group.workspaceKey,
      workspaceTitle: undefined,
      updatedAt: newestAt(sorted),
      items: sorted,
    })
  }
  return views.sort((left, right) => right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId))
}

/** Internal accumulator for the workspace grouping. */
interface WorkspaceAccumulator {
  readonly key: string
  readonly workspaceId: string | undefined
  readonly title: string | undefined
  readonly path: string | undefined
  readonly removed: boolean
  readonly ungrouped: boolean
  /** Host registry position, used as the ordering tie-break. */
  readonly order: number
  readonly items: OpenItemRecord[]
}

/**
 * Group items by workspace, with sessions nested one level down.
 * @param items - items after all narrowing.
 * @param snapshot - current Host snapshot (workspace rows and session titles).
 * @param resolveSessionTitle - optional live catalogue lookup, read per session.
 * @returns workspace groups, newest activity first, Ungrouped last.
 */
export function groupByWorkspace(
  items: readonly OpenItemRecord[],
  snapshot: InboxSnapshot | undefined,
  resolveSessionTitle?: SessionTitleResolver,
): readonly WorkspaceGroupView[] {
  const rows = snapshot?.workspaces ?? []
  const rowByKey = new Map<string, { row: WorkspaceInboxRow; order: number }>()
  rows.forEach((row, order) => {
    rowByKey.set(row.workspaceId ?? UNGROUPED_WORKSPACE, { row, order })
  })
  const accumulators = new Map<string, WorkspaceAccumulator>()
  const ensure = (key: string, seed?: OpenItemRecord): WorkspaceAccumulator => {
    const existing = accumulators.get(key)
    if (existing !== undefined) return existing
    const known = rowByKey.get(key)
    const ungrouped = key === UNGROUPED_WORKSPACE
    const accumulator: WorkspaceAccumulator = {
      key,
      workspaceId: ungrouped ? undefined : key,
      title: ungrouped
        ? undefined
        : known?.row.title ?? seed?.source.workspace?.title ?? seed?.source.workspace?.path,
      path: known?.row.path ?? seed?.source.workspace?.path,
      removed: ungrouped ? false : known === undefined || known.row.removed,
      ungrouped,
      order: known?.order ?? Number.POSITIVE_INFINITY,
      items: [],
    }
    accumulators.set(key, accumulator)
    return accumulator
  }
  for (const item of items) {
    ensure(workspaceKeyOf(item), item).items.push(item)
  }
  const sessions = sessionsById(snapshot)
  const views: WorkspaceGroupView[] = []
  for (const accumulator of accumulators.values()) {
    const sorted = [...accumulator.items].sort(compareItems)
    const sessionGroups = groupBySession(sorted, snapshot, resolveSessionTitle).map(group => ({
      ...group,
      workspaceTitle: accumulator.title,
      title: group.title ?? sessions.get(group.sessionId)?.title,
    }))
    views.push({
      key: accumulator.key,
      workspaceId: accumulator.workspaceId,
      title: accumulator.title,
      path: accumulator.path,
      removed: accumulator.removed,
      ungrouped: accumulator.ungrouped,
      itemCount: sorted.length,
      sessionCount: sessionGroups.length,
      updatedAt: newestAt(sorted),
      sessions: sessionGroups,
    })
  }
  return views.sort((left, right) => {
    if (left.ungrouped !== right.ungrouped) return left.ungrouped ? 1 : -1
    if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt
    return left.key.localeCompare(right.key)
  })
}

/** Counts per section from one item list. */
export function tabCounts(items: readonly OpenItemRecord[]): TabCounts {
  const live = items.filter(item => item.deletedAt === undefined)
  return {
    needsYou: live.filter(isNeedsYou).length,
    candidates: live.filter(isCandidate).length,
    snoozed: live.filter(isSnoozed).length,
    resolved: live.filter(isResolved).length,
  }
}

/**
 * Derive everything the page renders.
 * @param snapshot - current Host snapshot, or undefined before the first read.
 * @param filters - current page filters.
 * @param resolveSessionTitle - optional live catalogue lookup for Session labels
 *   (the group heading agrees with the row/detail label).
 * @returns the page view.
 */
export function deriveInboxView(
  snapshot: InboxSnapshot | undefined,
  filters: PageFilters,
  resolveSessionTitle?: SessionTitleResolver,
): InboxView {
  const all = snapshot?.items ?? []
  const section = itemsForTab(all, filters.tab)
  const searched = section.filter(item => matchesSearch(item, filters.search.trim()))
  // Session narrowing (OD-12): applied before facets so the facet counts and the
  // section total describe the narrowed page, never a hidden superset.
  const scoped = filters.sessionId === undefined
    ? searched
    : searched.filter(item => item.source.sessionId === filters.sessionId)
  const facets = deriveWorkspaceFacets(scoped, snapshot)
  const filtered = scoped.filter(item => matchesWorkspace(item, filters.workspace))
  const flat = [...filtered].sort(compareItems)
  // FYI belongs to the Needs-you surface only: live severity-3 structural rows,
  // narrowed by the same search/session/workspace filters, never counts.
  const fyi = filters.tab !== 'needs-you'
    ? []
    : all
      .filter(isFyi)
      .filter(item => matchesSearch(item, filters.search.trim()))
      .filter(item => filters.sessionId === undefined || item.source.sessionId === filters.sessionId)
      .filter(item => matchesWorkspace(item, filters.workspace))
      .sort(compareItems)
  const sessionGroups = groupBySession(flat, snapshot, resolveSessionTitle)
  const workspaceGroups = filters.groupBy === 'workspace' ? groupByWorkspace(flat, snapshot, resolveSessionTitle) : []
  return {
    tab: filters.tab,
    items: flat,
    sessionGroups,
    workspaceGroups,
    facets,
    sectionTotal: scoped.length,
    // The Host's counts are the nav pill's source of truth; deriving them from
    // the page's window would let the header disagree with the sidebar badge.
    counts: snapshot === undefined
      ? tabCounts(all)
      : {
          needsYou: snapshot.counts.needsYou,
          candidates: snapshot.counts.candidates,
          snoozed: snapshot.counts.snoozed,
          resolved: snapshot.counts.resolved,
        },
    awaiting: snapshot?.counts.awaiting ?? 0,
    fyi,
    narrowed: filters.search.trim() !== '' || filters.workspace !== ALL_WORKSPACES || filters.sessionId !== undefined,
  }
}

/**
 * The count invariant the design requires: the nav pill equals the sum of the
 * workspace counts plus Ungrouped, for the Needs you section.
 * @param view - derived page view.
 * @returns the invariant's two sides, for tests and diagnostics.
 */
export function workspaceCountInvariant(view: InboxView): { facets: number; items: number } {
  return {
    facets: view.facets.reduce((total, facet) => total + facet.count, 0),
    items: view.sectionTotal,
  }
}

/**
 * The locked counts invariant across the two sources: the Host's global
 * `needsYou` (the nav pill / tab label) must equal the sum of the workspace
 * facet counts plus Ungrouped, which are derived from the loaded page.
 * @param snapshot - current Host snapshot.
 * @param view - derived page view for the Needs you section, unnarrowed.
 * @returns both sides for tests and diagnostics.
 */
export function needsYouCountInvariant(
  snapshot: InboxSnapshot | undefined,
  view: InboxView,
): { pill: number; facets: number } {
  return {
    pill: snapshot?.counts.needsYou ?? view.counts.needsYou,
    facets: view.facets.reduce((total, facet) => total + facet.count, 0),
  }
}
