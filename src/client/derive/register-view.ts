/**
 * Pure derivations behind the Resolved tab: the register filters, the query the
 * Host receives, the client-side mirror of the Host's register rules, day
 * grouping, the in-flight band and the header facts.
 *
 * Everything here is synchronous and React-free so the rules can be tested
 * without a DOM. The components render only what these functions return; no
 * component re-implements a filter, an order or a count.
 *
 * Sources of truth:
 * - DESIGN §7.4 (register record shape, acknowledgement, reopen, retention,
 *   `§7.4.5` queries) and §2.6 (resolved items are first-class records);
 * - UI.md §4.6 (Resolved tab, in-flight band, filters, header line), §4.7
 *   (per-session decision history), §5.1 (resolved read-only detail);
 * - the Host's register semantics in `src/host/view.ts` (`matchesStatus`,
 *   `matchesQuery`, `compareRegister`) — the query built here is exactly what
 *   that code accepts, and the client mirror below keeps the list honest while
 *   a page is loading or after a failed read.
 *
 * @module dsh-open-items/client/derive/register-view
 */
import type {
  AcknowledgementEvidence,
  InboxQuery,
  OpenItemKind,
  OpenItemRecord,
  ResolutionKind,
} from '../../shared/schema'
import { latestResolution, payloadText, resolvedAtOf } from '../../shared/export'
import type { PageTranslate } from '../format'

/** Period filter of the Resolved tab (UI.md §4.6). */
export type RegisterPeriod = 'today' | '7d' | '30d' | 'all' | 'archive'

/** Source filter: by you, automatic, or everything (UI.md §4.6). */
export type RegisterSource = 'all' | 'user' | 'detector'

/** Outcome filter; in-flight rows are reached through `all` (or the band). */
export type RegisterOutcome = 'all' | 'acknowledged' | 'no-acknowledgement' | 'dismissed' | 'superseded'

/** Kind filter; `all` keeps every kind. */
export type RegisterKind = OpenItemKind | 'all'

/** Current filter combination of the Resolved tab. */
export interface RegisterFilters {
  readonly period: RegisterPeriod
  readonly source: RegisterSource
  readonly kind: RegisterKind
  readonly outcome: RegisterOutcome
  /** Case-insensitive substring over title, decision text and session title. */
  readonly search: string
  /** Per-session decision history narrowing (UI.md §4.7); absent = all sessions. */
  readonly sessionId?: string
}

/** The initial Resolved-tab filter: the register's own default (UI.md §4.6). */
export const INITIAL_REGISTER_FILTERS: RegisterFilters = {
  period: '30d',
  source: 'all',
  kind: 'all',
  outcome: 'all',
  search: '',
}

/** Period options, in render order. */
export const REGISTER_PERIODS: readonly RegisterPeriod[] = ['today', '7d', '30d', 'all', 'archive']

/** Source options, in render order. */
export const REGISTER_SOURCES: readonly RegisterSource[] = ['all', 'user', 'detector']

/** Outcome options, in render order. */
export const REGISTER_OUTCOMES: readonly RegisterOutcome[] = [
  'all',
  'acknowledged',
  'no-acknowledgement',
  'dismissed',
  'superseded',
]

/** Every item kind, for the kind select. */
export const REGISTER_KINDS: readonly OpenItemKind[] = [
  'decision',
  'approval',
  'question',
  'plan-review',
  'blocker',
  'risk',
  'follow-up',
  'task',
]

/** Milliseconds in one day, for the rolling periods. */
const DAY_MS = 24 * 60 * 60 * 1000

/** Local start of the day containing `at`. */
export function startOfLocalDay(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Start of one period, or `undefined` for the unbounded periods.
 * `today` is the reader's local midnight; the rolling windows are exact
 * millisecond windows so a page that re-renders twice cannot shift a boundary.
 * @param period - selected period.
 * @param now - current epoch milliseconds.
 * @returns the inclusive lower bound, if the period has one.
 */
export function periodStart(period: RegisterPeriod, now: number): number | undefined {
  switch (period) {
    case 'today':
      return startOfLocalDay(now)
    case '7d':
      return now - 7 * DAY_MS
    case '30d':
      return now - 30 * DAY_MS
    case 'all':
    case 'archive':
      return undefined
  }
}

/**
 * The Host query for the current filters.
 *
 * Period maps to `status`: the archive period is the archive, everything else is
 * the active register (`resolved`), which is exactly the Host's
 * `matchesStatus(record, 'resolved'|'archived', 'register')`. The in-flight band
 * is fetched separately (`status: 'awaiting'`) because the Host's register page
 * has one status per query.
 * @param filters - current filters.
 * @param now - current epoch milliseconds.
 * @param extra - paging or limit overrides.
 * @returns the query payload for the `register` endpoint.
 */
export function registerQueryOf(
  filters: RegisterFilters,
  now: number,
  extra: Pick<InboxQuery, 'cursor' | 'limit'> = {},
): InboxQuery {
  const since = periodStart(filters.period, now)
  return {
    status: filters.period === 'archive' ? 'archived' : 'resolved',
    ...(since === undefined ? {} : { since }),
    ...(filters.source === 'all' ? {} : { sources: [filters.source] }),
    ...(filters.kind === 'all' ? {} : { kinds: [filters.kind] }),
    ...(filters.sessionId === undefined ? {} : { scope: { sessionId: filters.sessionId } }),
    ...(filters.search.trim() === '' ? {} : { search: filters.search.trim() }),
    ...(extra.limit === undefined ? {} : { limit: extra.limit }),
    ...(extra.cursor === undefined ? {} : { cursor: extra.cursor }),
  }
}

/**
 * The Host query for the in-flight band: answers waiting on the session.
 * Period is deliberately absent — a part of the register that is still in
 * flight is always relevant, even if it was answered yesterday.
 * @param filters - current filters (search, source, kind, session apply).
 */
export function inFlightQueryOf(filters: RegisterFilters): InboxQuery {
  return {
    status: 'awaiting',
    ...(filters.source === 'all' ? {} : { sources: [filters.source] }),
    ...(filters.kind === 'all' ? {} : { kinds: [filters.kind] }),
    ...(filters.sessionId === undefined ? {} : { scope: { sessionId: filters.sessionId } }),
    ...(filters.search.trim() === '' ? {} : { search: filters.search.trim() }),
  }
}

/** The Host query used only to read the archive count for the header line. */
export function archivedCountQueryOf(filters: RegisterFilters): InboxQuery {
  return {
    status: 'archived',
    ...(filters.sessionId === undefined ? {} : { scope: { sessionId: filters.sessionId } }),
    limit: 1,
  }
}

/**
 * The timestamp the register sorts and filters by, mirroring the Host exactly
 * (`resolvedAt ?? updatedAt`; `resolution.at` is not used).
 * @param record - one register record.
 * @returns epoch milliseconds.
 */
export function registerTimestampOf(record: OpenItemRecord): number {
  return record.resolvedAt ?? record.updatedAt
}

/** The settlement state the register considers: resolved or in flight. */
export function isRegisterRecord(record: OpenItemRecord): boolean {
  return record.state === 'resolved' || record.state === 'awaiting'
}

/** Whether the record is in the register's active window (not archived). */
export function isActiveResolution(record: OpenItemRecord): boolean {
  return record.state === 'resolved' && record.retention.class === 'active'
}

/** Resolution kind of one record, or `undefined` before an answer. */
export function resolutionKindOf(record: OpenItemRecord): ResolutionKind | undefined {
  return latestResolution(record)?.kind
}

/** One decision, verbatim, ready for localized presentation. */
export type DecisionSummary =
  | { readonly kind: 'option'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'approval'; readonly outcome: 'allow-once' | 'deny'; readonly note?: string }
  | { readonly kind: 'task-action'; readonly action: string; readonly note?: string }
  | { readonly kind: 'dismiss'; readonly reason?: string }
  | { readonly kind: 'detector'; readonly code: string }
  | { readonly kind: 'none' }

/**
 * "What you decided" for one record, verbatim payload — never a paraphrase
 * (DESIGN §7.4.1, UI.md §5.1).
 * @param record - one register record.
 * @returns the structured decision.
 */
export function decisionOf(record: OpenItemRecord): DecisionSummary {
  const payload = latestResolution(record)?.payload
  if (payload === undefined) return { kind: 'none' }
  switch (payload.type) {
    case 'option':
      return { kind: 'option', text: payload.option }
    case 'text':
      return { kind: 'text', text: payload.text }
    case 'approval':
      return {
        kind: 'approval',
        outcome: payload.outcome,
        ...(payload.note === undefined || payload.note === '' ? {} : { note: payload.note }),
      }
    case 'task-action':
      return {
        kind: 'task-action',
        action: payload.action,
        ...(payload.note === undefined || payload.note === '' ? {} : { note: payload.note }),
      }
    case 'dismiss':
      return {
        kind: 'dismiss',
        ...(payload.reason === undefined || payload.reason === '' ? {} : { reason: payload.reason }),
      }
    case 'detector':
      return { kind: 'detector', code: payload.code }
  }
}

/**
 * First line of a decision text, for the one-line row summary.
 * @param text - verbatim decision text.
 * @param maxChars - bound for the row (200 keeps a typical sentence readable).
 * @returns the first line, trimmed and bounded.
 */
export function firstLineOf(text: string, maxChars = 200): string {
  const firstLine = text.split(/\r?\n/u, 1)[0]?.trim() ?? ''
  return firstLine.length <= maxChars ? firstLine : `${firstLine.slice(0, maxChars).trimEnd()}…`
}

/** The register's source vocabulary: who closed it (mirrors the Host's `sources` filter). */
export function filterSourceOf(record: OpenItemRecord): 'user' | 'detector' {
  return latestResolution(record)?.actor === 'detector' ? 'detector' : 'user'
}

/** Which source word and tone a register row shows (UI.md §4.6, never colour-only). */
export type SourceIndicator = 'answered' | 'dismissed' | 'in-flight' | 'automatic'

/**
 * The two-channel source indicator of one row.
 * @param record - one register record.
 * @returns the indicator variant.
 */
export function sourceIndicatorOf(record: OpenItemRecord): SourceIndicator {
  if (record.state === 'awaiting') return 'in-flight'
  if (latestResolution(record)?.actor === 'detector') return 'automatic'
  return latestResolution(record)?.kind === 'dismissed' ? 'dismissed' : 'answered'
}

/** Acknowledgement presentation of one register record. */
export interface AcknowledgementView {
  readonly state: 'observed' | 'pending' | 'none' | 'not-applicable'
  readonly evidence?: AcknowledgementEvidence
  readonly at?: number
}

/**
 * "What happened next" for one record (DESIGN §7.4.2). A dismissal or a
 * supersede is not an answer, so its acknowledgement is `not-applicable` rather
 * than a misleading "no acknowledgement observed".
 * @param record - one register record.
 * @returns the structured acknowledgement.
 */
export function acknowledgementOf(record: OpenItemRecord): AcknowledgementView {
  const acknowledgement = record.acknowledgement
  const kind = resolutionKindOf(record)
  const notAnAnswer = kind === 'dismissed' || kind === 'superseded'
  if (acknowledgement === undefined) {
    if (record.state === 'awaiting') return { state: 'pending' }
    return { state: notAnAnswer ? 'not-applicable' : 'none' }
  }
  if (acknowledgement.state === 'observed') {
    return {
      state: 'observed',
      ...(acknowledgement.evidence === undefined ? {} : { evidence: acknowledgement.evidence.kind }),
      ...(acknowledgement.at === undefined ? {} : { at: acknowledgement.at }),
    }
  }
  if (acknowledgement.state === 'pending') return { state: 'pending' }
  return { state: notAnAnswer || kind === 'detected-closed' ? 'not-applicable' : 'none' }
}

/** Detector code of a detector-closed record, or `undefined`. */
export function detectorCodeOf(record: OpenItemRecord): string | undefined {
  const payload = latestResolution(record)?.payload
  return payload !== undefined && payload.type === 'detector' ? payload.code : undefined
}

/** Detector copy key families the UI knows how to phrase. */
export type DetectorFamily = 'approval' | 'goal' | 'task' | 'question' | 'session' | 'other'

/**
 * Classify a detector code into a phrase family. The raw code is always shown
 * beside the phrase, so an unknown detector stays auditable instead of silent.
 * @param code - detector code from the closure resolution.
 * @returns the copy family.
 */
export function detectorFamilyOf(code: string | undefined): DetectorFamily {
  if (code === undefined) return 'other'
  if (code.startsWith('approval/')) return 'approval'
  if (code.startsWith('goal/')) return 'goal'
  if (code.startsWith('team/') || code.startsWith('task/')) return 'task'
  if (code.startsWith('user-questions') || code.startsWith('question/')) return 'question'
  if (code.startsWith('session/')) return 'session'
  return 'other'
}

/** Why an item cannot be reopened, or that it can. */
export type ReopenEligibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not-resolved' | 'approval-executed' }

/**
 * Mirror of the Host's reopen guard (DESIGN §7.4.3; `OpenItemsStore.reopen`):
 * only a settled record can be reopened, and an approval whose permission was
 * already exercised cannot be un-exercised.
 * @param record - one register record.
 * @returns whether Reopen is offered, and why not when it is refused.
 */
export function reopenEligibilityOf(record: OpenItemRecord): ReopenEligibility {
  if (record.state !== 'resolved' && record.state !== 'awaiting' && record.state !== 'archived') {
    return { ok: false, reason: 'not-resolved' }
  }
  const payload = latestResolution(record)?.payload
  if (payload?.type === 'approval' && record.acknowledgement?.state === 'observed') {
    return { ok: false, reason: 'approval-executed' }
  }
  return { ok: true }
}

/** The concatenated text one filter search matches (mirrors the Host). */
export function registerSearchText(record: OpenItemRecord): string {
  const payload = latestResolution(record)?.payload
  const decision = payload === undefined
    ? ''
    : payload.type === 'detector'
      ? payload.code
      : payloadText(payload)
  return [record.title, record.body, decision, record.source.sessionTitle ?? ''].join('\n').toLowerCase()
}

/** Whether one record matches the client-side mirror of the filters. */
export function matchesRegisterFilters(
  record: OpenItemRecord,
  filters: RegisterFilters,
  now: number,
): boolean {
  if (record.deletedAt !== undefined) return false
  if (!isRegisterRecord(record)) return false
  // Status: archive period is the archive; every other period is the active register.
  if (filters.period === 'archive') {
    if (!(record.state === 'resolved' && record.retention.class === 'archived')) return false
  } else if (!isActiveResolution(record) && record.state !== 'awaiting') {
    return false
  }
  const since = periodStart(filters.period, now)
  if (since !== undefined && registerTimestampOf(record) < since) return false
  if (filters.source !== 'all' && filterSourceOf(record) !== filters.source) return false
  if (filters.kind !== 'all' && record.kind !== filters.kind) return false
  if (filters.sessionId !== undefined && record.source.sessionId !== filters.sessionId) return false
  if (!matchesOutcome(record, filters.outcome)) return false
  const needle = filters.search.trim().toLowerCase()
  if (needle !== '' && !registerSearchText(record).includes(needle)) return false
  return true
}

/**
 * Whether one record matches the outcome filter.
 *
 * The register's four outcomes are the reader's words, not the record's enum:
 * `acknowledged` is an answer the session acted on, `no-acknowledgement` is one
 * it did not, and the other two are the detector-free ways an item can close.
 * Detector closes are reached with `all` and Source = Automatic.
 * @param record - one register record.
 * @param outcome - selected outcome filter.
 * @returns whether it matches.
 */
export function matchesOutcome(record: OpenItemRecord, outcome: RegisterOutcome): boolean {
  if (outcome === 'all') return true
  const kind = resolutionKindOf(record)
  const acknowledgement = acknowledgementOf(record)
  switch (outcome) {
    case 'acknowledged':
      return kind === 'answered' && acknowledgement.state === 'observed'
    case 'no-acknowledgement':
      return kind === 'answered' && acknowledgement.state === 'none'
    case 'dismissed':
      return kind === 'dismissed'
    case 'superseded':
      return kind === 'superseded'
  }
}

/** Stable register order: `resolvedAt ?? updatedAt` descending, id ascending. */
export function sortRegisterItems(records: readonly OpenItemRecord[]): readonly OpenItemRecord[] {
  const sorted = [...records]
  sorted.sort((left, right) => {
    const leftAt = registerTimestampOf(left)
    const rightAt = registerTimestampOf(right)
    if (leftAt !== rightAt) return rightAt - leftAt
    if (left.id === right.id) return 0
    return left.id < right.id ? -1 : 1
  })
  return sorted
}

/**
 * Apply the client-side mirror of the filters, then the stable order.
 * @param records - records from a page or from a fallback snapshot.
 * @param filters - current filters.
 * @param now - current epoch milliseconds.
 * @returns the rows to render.
 */
export function selectRegisterItems(
  records: readonly OpenItemRecord[],
  filters: RegisterFilters,
  now: number,
): readonly OpenItemRecord[] {
  return sortRegisterItems(records.filter(record => matchesRegisterFilters(record, filters, now)))
}

/**
 * The in-flight band: answers sent but not acknowledged yet (UI.md §4.6).
 * Period and outcome do not narrow it — a waiting answer is always relevant,
 * and the archive period hides the band because nothing in flight is archived.
 * @param records - records, typically the awaiting query result.
 * @param filters - current filters (source/kind/search/session apply).
 * @returns the band rows, newest answer first.
 */
export function inFlightOf(
  records: readonly OpenItemRecord[],
  filters: RegisterFilters,
): readonly OpenItemRecord[] {
  if (filters.period === 'archive') return []
  const needle = filters.search.trim().toLowerCase()
  return sortRegisterItems(records.filter((record) => {
    if (record.state !== 'awaiting' || record.deletedAt !== undefined) return false
    if (filters.source !== 'all' && filterSourceOf(record) !== filters.source) return false
    if (filters.kind !== 'all' && record.kind !== filters.kind) return false
    if (filters.sessionId !== undefined && record.source.sessionId !== filters.sessionId) return false
    if (needle !== '' && !registerSearchText(record).includes(needle)) return false
    return true
  }))
}

/** One day of the register, grouped by the reader's calendar day. */
export interface RegisterDayGroup {
  /** Local calendar day key (`YYYY-MM-DD`). */
  readonly dayKey: string
  /** Local start of that day. */
  readonly start: number
  readonly items: readonly OpenItemRecord[]
}

/** Local calendar day key of one timestamp. */
export function dayKeyOf(at: number): string {
  const date = new Date(at)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Group rows by the reader's calendar day, newest day first.
 * @param records - already filtered and sorted rows.
 * @returns the day groups (the list is empty when there are no rows).
 */
export function groupRegisterByDay(records: readonly OpenItemRecord[]): readonly RegisterDayGroup[] {
  const groups: { dayKey: string; start: number; items: OpenItemRecord[] }[] = []
  for (const record of sortRegisterItems(records)) {
    const at = registerTimestampOf(record)
    const start = startOfLocalDay(at)
    const dayKey = dayKeyOf(at)
    const last = groups[groups.length - 1]
    if (last !== undefined && last.dayKey === dayKey) last.items.push(record)
    else groups.push({ dayKey, start, items: [record] })
  }
  return groups
}

/**
 * Relative day copy for one group heading: `today` / `yesterday` / a date.
 * @param groupStart - local start of the group's day.
 * @param now - current epoch milliseconds.
 * @returns which copy the heading uses.
 */
export function dayHeadingOf(groupStart: number, now: number): 'today' | 'yesterday' | 'date' {
  const today = startOfLocalDay(now)
  if (groupStart === today) return 'today'
  if (groupStart === today - DAY_MS) return 'yesterday'
  return 'date'
}

/** Facts the register header line must state honestly (UI.md §4.6). */
export interface RegisterHeaderFacts {
  /** Active resolutions in the current period (the server total). */
  readonly resolved: number
  /** Answers waiting on a session (the band). */
  readonly inFlight: number
  /** Archived resolutions, from the archive-count query. */
  readonly archived: number
  /** A retention cap pruned older rows: the register is not complete. */
  readonly earlierRecordsPruned: boolean
  /** Rows whose transcript text was dropped by compaction. */
  readonly compacted: number
}

/**
 * The header facts of one loaded register state.
 * @param resolvedTotal - server total for the main query.
 * @param inFlightRecords - the band rows.
 * @param archivedTotal - server total for the archive query.
 * @param earlierRecordsPruned - the Host's pruned flag.
 * @returns the facts the header renders.
 */
export function registerHeaderFacts(
  resolvedTotal: number,
  inFlightRecords: readonly OpenItemRecord[],
  archivedTotal: number,
  earlierRecordsPruned: boolean,
): RegisterHeaderFacts {
  return {
    resolved: resolvedTotal,
    inFlight: inFlightRecords.length,
    archived: archivedTotal,
    earlierRecordsPruned,
    compacted: inFlightRecords.filter(record => record.retention.class === 'archived').length,
  }
}

/** Count of rows whose transcript text compaction dropped, from any record set. */
export function compactedCount(records: readonly OpenItemRecord[]): number {
  return records.filter(record => record.retention.class === 'archived').length
}

/** One option label of the period select. */
export function periodKey(period: RegisterPeriod): 'register.period.today' | 'register.period.7d' | 'register.period.30d' | 'register.period.all' | 'register.period.archive' {
  switch (period) {
    case 'today':
      return 'register.period.today'
    case '7d':
      return 'register.period.7d'
    case '30d':
      return 'register.period.30d'
    case 'all':
      return 'register.period.all'
    case 'archive':
      return 'register.period.archive'
  }
}

/** One option label of the source select. */
export function sourceKey(source: RegisterSource): 'register.source.all' | 'register.source.user' | 'register.source.detector' {
  return source === 'all' ? 'register.source.all' : source === 'user' ? 'register.source.user' : 'register.source.detector'
}

/** One option label of the outcome select. */
export function outcomeKey(outcome: RegisterOutcome):
  | 'register.outcome.all'
  | 'register.outcome.acknowledged'
  | 'register.outcome.noAck'
  | 'register.outcome.dismissed'
  | 'register.outcome.superseded' {
  switch (outcome) {
    case 'all':
      return 'register.outcome.all'
    case 'acknowledged':
      return 'register.outcome.acknowledged'
    case 'no-acknowledgement':
      return 'register.outcome.noAck'
    case 'dismissed':
      return 'register.outcome.dismissed'
    case 'superseded':
      return 'register.outcome.superseded'
  }
}

/** Whether the filters differ from the initial ones (drives the Clear control). */
export function isFiltered(filters: RegisterFilters): boolean {
  return filters.period !== INITIAL_REGISTER_FILTERS.period
    || filters.source !== 'all'
    || filters.kind !== 'all'
    || filters.outcome !== 'all'
    || filters.search.trim() !== ''
    || filters.sessionId !== undefined
}

/**
 * Human description of the current filter, used by the register header and by
 * the export header (DESIGN §7.4.7 rule 6: every file names its filter).
 * @param t - namespace-bound translator.
 * @param filters - current filters.
 * @param sessionTitle - resolved title of the per-session narrowing, if known.
 * @returns one line, e.g. `30 days · by you · approvals`.
 */
export function filterLabelOf(
  t: PageTranslate,
  filters: RegisterFilters,
  sessionTitle?: string,
): string {
  const parts: string[] = [t(periodKey(filters.period))]
  parts.push(t(sourceKey(filters.source)))
  if (filters.kind !== 'all') parts.push(t(`kind.${filters.kind}`))
  if (filters.outcome !== 'all') parts.push(t(outcomeKey(filters.outcome)))
  if (filters.sessionId !== undefined) {
    parts.push(t('register.filter.sessionValue', { title: sessionTitle ?? filters.sessionId }))
  }
  if (filters.search.trim() !== '') parts.push(t('register.filter.searchValue', { text: filters.search.trim() }))
  return parts.join(' · ')
}

/** Export-relevant state the dialog shows before it opens. */
export interface RegisterExportSummary {
  /** Settled records that the generator will include. */
  readonly exportable: number
  /** In-flight rows that the generator cannot include until acknowledged. */
  readonly inFlight: number
  /** Archived rows present in the current filter (included only on request). */
  readonly archived: number
  /** A retention cap pruned rows, so the file cannot claim completeness. */
  readonly earlierRecordsPruned: boolean
}

/**
 * Summarize what an export of the current filter would contain.
 * `generateExport` only writes settled `resolved` records, so in-flight answers
 * are counted separately and the dialog says so (never a silent omission).
 * @param items - loaded register rows for the current filter.
 * @param inFlightRecords - the in-flight band rows.
 * @param earlierRecordsPruned - the Host's pruned flag.
 * @returns the counts the dialog renders.
 */
export function exportSummaryOf(
  items: readonly OpenItemRecord[],
  inFlightRecords: readonly OpenItemRecord[],
  earlierRecordsPruned: boolean,
): RegisterExportSummary {
  return {
    exportable: items.filter(record => record.state === 'resolved' && resolvedAtOf(record) !== undefined).length,
    inFlight: inFlightRecords.length,
    archived: items.filter(record => record.retention.class === 'archived').length,
    earlierRecordsPruned,
  }
}
