/**
 * Read projections: the merged inbox snapshot and the resolution register
 * (PLAN M1 item 5; DESIGN §5.10, §7.4.5).
 *
 * Pure functions over a record snapshot: the store owns durability, this module
 * owns filtering, ordering, paging and the derived rows the client renders.
 * Keeping it pure means the merge precedence and paging are testable without a
 * domain fake.
 *
 * Counts are computed over every stored record, not the filtered page, because
 * the nav pill and badges must not change when the user filters.
 */
import type {
  CountSummary,
  InboxQuery,
  InboxSnapshot,
  OpenItemRecord,
  Resolution,
  SessionInboxRow,
  WorkspaceInboxRow,
} from '../shared/schema'
import { LIMITS } from '../shared/protocol'
import { NEEDS_YOU_STATES, isAuthored, isCandidateRecord, isNeedsYouRecord } from '../shared/records'

/** Options every projection needs from the store. */
export interface ViewOptions {
  /** Store revision at read time (clients re-read, never patch). */
  readonly revision: number
  /** Read timestamp. */
  readonly now: number
  /** Whether a cap pruned stored resolutions. */
  readonly earlierRecordsPruned: boolean
  /** True while a refresh read is queued. */
  readonly refreshing: boolean
}

/** One register page (mirrors the wire `RegisterValue` without importing protocol). */
export interface RegisterProjection {
  readonly items: readonly OpenItemRecord[]
  readonly total: number
  readonly earlierRecordsPruned: boolean
  readonly nextCursor?: string
}

/**
 * The page bound of a query, clamped to `LIMITS`.
 * @param query - caller query.
 * @param fallback - default page size.
 * @returns `{ limit, offset }`.
 */
function pageOf(query: InboxQuery, fallback: number): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? fallback), 1), LIMITS.listPageMax)
  const offset = decodeCursor(query.cursor)
  return { limit, offset }
}

/**
 * Decode an opaque cursor.
 * @param cursor - cursor from a previous page, or undefined.
 * @returns the offset (0 for an absent/invalid cursor).
 */
export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return 0
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown }
    return typeof parsed.o === 'number' && Number.isSafeInteger(parsed.o) && parsed.o >= 0 ? parsed.o : 0
  } catch {
    return 0
  }
}

/**
 * Encode the cursor of the next page.
 * @param offset - first unread offset.
 * @returns the opaque cursor.
 */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url')
}

/**
 * The timestamp a row sorts/filters by: resolution time for settled rows,
 * last update otherwise.
 * @param record - stored record.
 * @returns the timestamp.
 */
function sortTimestamp(record: OpenItemRecord): number {
  return record.resolvedAt ?? record.updatedAt
}

/**
 * Whether one record matches a status filter.
 *
 * The register has its own defaults: it is the resolutions view, so an absent
 * filter means "active resolutions + in-flight answers", not "needs you".
 * @param record - stored record.
 * @param status - requested filter.
 * @param mode - inbox or register semantics.
 * @returns whether it belongs to the page.
 */
function matchesStatus(record: OpenItemRecord, status: InboxQuery['status'], mode: 'inbox' | 'register'): boolean {
  if (mode === 'register') {
    const settled = record.state === 'resolved' || record.state === 'awaiting'
    if (!settled) return false
    if (status === undefined) return record.state === 'awaiting' || record.retention.class === 'active'
    if (status === 'all') return true
    if (status === 'awaiting') return record.state === 'awaiting'
    if (status === 'resolved') return record.state === 'resolved' && record.retention.class === 'active'
    if (status === 'archived') return record.state === 'resolved' && record.retention.class === 'archived'
    return false
  }
  if (status === undefined || status === 'open') return NEEDS_YOU_STATES.includes(record.state)
  if (status === 'all') return true
  if (status === 'awaiting') return record.state === 'awaiting'
  if (status === 'resolved') return record.state === 'resolved'
  return record.state === 'archived'
}

/**
 * Whether one record matches every requested filter.
 * @param record - stored record.
 * @param query - caller query.
 * @param mode - inbox or register (source semantics differ).
 * @returns whether it matches.
 */
function matchesQuery(record: OpenItemRecord, query: InboxQuery, mode: 'inbox' | 'register'): boolean {
  if (record.deletedAt !== undefined) return false
  if (!matchesStatus(record, query.status, mode)) return false
  if (query.scope?.sessionId !== undefined && record.source.sessionId !== query.scope.sessionId) return false
  if (query.scope?.workspaceId !== undefined
    && record.source.workspace?.workspaceId !== query.scope.workspaceId) return false
  if (query.kinds !== undefined && !query.kinds.includes(record.kind)) return false
  if (query.tiers !== undefined && !query.tiers.includes(record.tier)) return false
  if (query.states !== undefined && !query.states.includes(record.state)) return false
  if (query.sources !== undefined) {
    const recordSource = mode === 'register'
      ? (record.resolution?.actor === 'detector' ? 'detector' : 'user')
      : (isAuthored(record) ? 'user' : 'detector')
    if (!query.sources.includes(recordSource)) return false
  }
  const timestamp = sortTimestamp(record)
  // `since` is the client's new-item watermark (it feeds newSinceLastVisit in
  // countSummary), not an inbox list filter: filtering the page by it hid every
  // item older than the previous visit while the counts still covered them. It
  // is a real lower bound only in the register, where it is the period filter.
  if (mode === 'register' && query.since !== undefined && timestamp < query.since) return false
  if (query.until !== undefined && timestamp > query.until) return false
  if (query.search !== undefined && query.search.trim() !== '') {
    const needle = query.search.trim().toLowerCase()
    if (!searchText(record).includes(needle)) return false
  }
  return true
}

/** The concatenated text one search query may match. */
function searchText(record: OpenItemRecord): string {
  const resolutionText = record.resolution === undefined ? '' : payloadText(record.resolution.payload)
  return [record.title, record.body, resolutionText, record.source.sessionTitle ?? ''].join('\n').toLowerCase()
}

/** Text of a resolution payload. */
function payloadText(payload: Resolution['payload'] | undefined): string {
  if (payload === undefined || payload === null || typeof payload !== 'object') return ''
  const typed = payload as Record<string, unknown>
  return [typed['text'], typed['option'], typed['action'], typed['note'], typed['reason'], typed['code']]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
}

/**
 * Sort the inbox by the documented triage rule: severity ascending, then the
 * item that has waited longest (`firstSeenAt` ascending), then id ascending as
 * a stable final tie-break.
 *
 * The Host is the single owner of this order (D-17): the client joins
 * consecutive pages and re-sorts them with the same rule
 * (`compareItems` in `src/client/derive/inbox-view.ts`), so paging is
 * append-only — "Load more" cannot interleave rows the reader has seen.
 * @param left - record.
 * @param right - record.
 * @returns comparator result.
 */
function compareInbox(left: OpenItemRecord, right: OpenItemRecord): number {
  if (left.severity !== right.severity) return left.severity - right.severity
  if (left.firstSeenAt !== right.firstSeenAt) return left.firstSeenAt - right.firstSeenAt
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/**
 * Sort the register: newest resolution first, id as a stable tie-break.
 * @param left - record.
 * @param right - record.
 * @returns comparator result.
 */
function compareRegister(left: OpenItemRecord, right: OpenItemRecord): number {
  const leftAt = sortTimestamp(left)
  const rightAt = sortTimestamp(right)
  if (leftAt !== rightAt) return rightAt - leftAt
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/**
 * Number of records a query matches (before paging).
 * @param records - every stored record.
 * @param query - caller query.
 * @param mode - inbox or register semantics.
 * @returns the match count.
 */
export function matchingCount(
  records: readonly OpenItemRecord[],
  query: InboxQuery,
  mode: 'inbox' | 'register',
): number {
  let count = 0
  for (const record of records) if (matchesQuery(record, query, mode)) count += 1
  return count
}

/**
 * Build the merged inbox snapshot.
 * @param records - every stored record.
 * @param query - caller query (or `{}`).
 * @param options - store revision, clock and flags.
 * @returns the snapshot the page renders.
 */
export function buildSnapshot(
  records: readonly OpenItemRecord[],
  query: InboxQuery = {},
  options: ViewOptions,
): InboxSnapshot {
  const { limit, offset } = pageOf(query, LIMITS.listPageDefault)
  const matching = records.filter(record => matchesQuery(record, query, 'inbox')).sort(compareInbox)
  const page = matching.slice(offset, offset + limit)
  const nextOffset = offset + page.length
  return {
    revision: options.revision,
    generatedAt: options.now,
    items: page,
    sessions: sessionRows(records),
    workspaces: workspaceRows(records),
    counts: countSummary(records, query, options),
    refreshing: options.refreshing,
    ...(nextOffset < matching.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
  }
}

/**
 * Build one register page (resolutions only, newest first).
 * @param records - every stored record.
 * @param query - caller query (or `{}`).
 * @param options - store revision, clock and flags.
 * @returns the page and its total.
 */
export function buildRegister(
  records: readonly OpenItemRecord[],
  query: InboxQuery = {},
  options: ViewOptions,
): RegisterProjection {
  const { limit, offset } = pageOf(query, LIMITS.registerPageDefault)
  const matching = records.filter(record => matchesQuery(record, query, 'register')).sort(compareRegister)
  const page = matching.slice(offset, offset + limit)
  const nextOffset = offset + page.length
  return {
    items: page,
    total: matching.length,
    earlierRecordsPruned: options.earlierRecordsPruned,
    ...(nextOffset < matching.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
  }
}

/**
 * Counts for the nav pill, badges and header.
 *
 * `needsYou` and `candidates` use the shared OI-05 predicates
 * ({@link isNeedsYouRecord}, {@link isCandidateRecord}) — the same functions the
 * store's `counts()` uses — so the totals agree with `hello` and with the
 * workspace lens (`counts.needsYou === Σ workspaces.itemCount`). Counts are
 * global: a filtered read still reports the totals, because a filter must not
 * change the nav badge. An absent `scope`/`status`/`kinds` is therefore ignored;
 * only `since` feeds `newSinceLastVisit`.
 * @param records - every stored record.
 * @param query - caller query (only `since` affects `newSinceLastVisit`).
 * @param options - store revision, clock and flags.
 * @returns the count summary.
 */
export function countSummary(
  records: readonly OpenItemRecord[],
  query: InboxQuery,
  options: ViewOptions,
): CountSummary {
  let needsYou = 0
  let candidates = 0
  let awaiting = 0
  let snoozed = 0
  let resolved = 0
  let newSinceLastVisit = 0
  for (const record of records) {
    if (record.deletedAt !== undefined) continue
    if (isNeedsYouRecord(record)) needsYou += 1
    if (isCandidateRecord(record)) candidates += 1
    if (record.state === 'awaiting') awaiting += 1
    if (record.state === 'snoozed') snoozed += 1
    if (record.state === 'resolved') resolved += 1
    if (query.since !== undefined && record.firstSeenAt >= query.since) newSinceLastVisit += 1
  }
  return {
    needsYou,
    candidates,
    awaiting,
    snoozed,
    resolved,
    newSinceLastVisit,
    earlierRecordsPruned: options.earlierRecordsPruned,
  }
}

/**
 * One row per session that owns at least one item.
 *
 * `origin` describes the **session itself**, so it is only ever set from
 * session metadata — never inferred from an item's `raisedBy`. A subagent that
 * rolled an item up to the root session (OI-02) leaves the root row a root row;
 * the roll-up attribution lives on the item's `source.raisedBy`. The capture
 * path is root-only (D5), so every owning session here is a root session and no
 * row is labelled `subagent`.
 * @param records - every stored record.
 * @returns session rows, newest activity first.
 */
export function sessionRows(records: readonly OpenItemRecord[]): readonly SessionInboxRow[] {
  const rows = new Map<string, {
    title: string | undefined
    workspaceId: string | undefined
    workspaceTitle: string | undefined
    updatedAt: number
    needsYou: number
    awaiting: number
  }>()
  for (const record of records) {
    if (record.deletedAt !== undefined) continue
    const sessionId = record.source.sessionId
    const current = rows.get(sessionId) ?? {
      title: record.source.sessionTitle,
      workspaceId: record.source.workspace?.workspaceId,
      workspaceTitle: record.source.workspace?.title,
      updatedAt: 0,
      needsYou: 0,
      awaiting: 0,
    }
    if (record.source.sessionTitle !== undefined) current.title = record.source.sessionTitle
    if (record.source.workspace?.workspaceId !== undefined) current.workspaceId = record.source.workspace.workspaceId
    if (record.source.workspace?.title !== undefined) current.workspaceTitle = record.source.workspace.title
    current.updatedAt = Math.max(current.updatedAt, record.updatedAt)
    if (isNeedsYouRecord(record)) current.needsYou += 1
    if (record.state === 'awaiting') current.awaiting += 1
    rows.set(sessionId, current)
  }
  return [...rows.entries()]
    .map(([sessionId, row]): SessionInboxRow => ({
      sessionId,
      ...(row.title === undefined ? {} : { title: row.title }),
      ...(row.workspaceId === undefined ? {} : { workspaceId: row.workspaceId }),
      ...(row.workspaceTitle === undefined ? {} : { workspaceTitle: row.workspaceTitle }),
      updatedAt: row.updatedAt,
      running: false,
      archived: false,
      counts: { needsYou: row.needsYou, awaiting: row.awaiting },
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt || (left.sessionId < right.sessionId ? -1 : 1))
}

/**
 * One row per workspace lens bucket.
 *
 * `itemCount` counts needs-you items only, and every needs-you item lands in
 * exactly one bucket (`Ungrouped` when no workspace snapshot exists), so the nav
 * invariant `counts.needsYou === Σ workspaces.itemCount` holds by construction.
 * @param records - every stored record.
 * @returns workspace rows, largest first.
 */
export function workspaceRows(records: readonly OpenItemRecord[]): readonly WorkspaceInboxRow[] {
  const rows = new Map<string, {
    workspaceId: string | undefined
    title: string
    path: string | undefined
    itemCount: number
    sessions: Set<string>
  }>()
  for (const record of records) {
    if (record.deletedAt !== undefined) continue
    if (!isNeedsYouRecord(record)) continue
    const workspaceId = record.source.workspace?.workspaceId
    const key = workspaceId ?? 'ungrouped'
    const current = rows.get(key) ?? {
      workspaceId,
      title: workspaceId === undefined ? 'Ungrouped' : record.source.workspace?.title ?? 'Workspace',
      path: record.source.workspace?.path,
      itemCount: 0,
      sessions: new Set<string>(),
    }
    if (workspaceId !== undefined && record.source.workspace?.title !== undefined) {
      current.title = record.source.workspace.title
    }
    current.itemCount += 1
    current.sessions.add(record.source.sessionId)
    rows.set(key, current)
  }
  return [...rows.values()]
    .map(row => ({
      ...(row.workspaceId === undefined ? {} : { workspaceId: row.workspaceId }),
      title: row.title,
      ...(row.path === undefined ? {} : { path: row.path }),
      removed: false,
      itemCount: row.itemCount,
      sessionCount: row.sessions.size,
    }))
    .sort((left, right) => right.itemCount - left.itemCount || left.title.localeCompare(right.title))
}
