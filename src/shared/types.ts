/**
 * Pure value types of the open-items domain, shared by the durable store, the
 * `openItems` service and the model-facing `open_items` tool.
 *
 * Nothing in this module imports the Host: the same shapes are used by unit
 * tests, so a failing type here is a failing data contract, not a wiring issue.
 * @module dsh-open-items/shared/types
 */

/**
 * Version of the on-disk store document.
 *
 * v2 added the per-item audit `history`. v1 documents remain readable: their
 * items load with an empty history and the next write rewrites the document as
 * v2. A reader rejects anything newer than {@link STORE_SCHEMA_VERSION}.
 */
export const STORE_SCHEMA_VERSION = 2

/** Oldest store document version a reader still accepts (upgraded on next write). */
export const MIN_SUPPORTED_STORE_VERSION = 1

/** The kinds of unfinished human attention this store tracks. */
export const ITEM_KINDS = ['decision', 'approval', 'question', 'uncertainty'] as const

/** One {@link ITEM_KINDS} member. */
export type ItemKind = (typeof ITEM_KINDS)[number]

/**
 * Lifecycle of one item.
 *
 * `open` waits on the user. `answered` and `dismissed` are terminal for a
 * pending run, but not permanent: `reopen` returns an item to `open` and
 * increments {@link OpenItem.reopenCount}.
 */
export const ITEM_STATUSES = ['open', 'answered', 'dismissed'] as const

/** One {@link ITEM_STATUSES} member. */
export type ItemStatus = (typeof ITEM_STATUSES)[number]

/** Maximum length of a user/model-authored title, after normalisation. */
export const MAX_TITLE_CHARS = 200

/** Maximum length of an item detail body. */
export const MAX_DETAIL_CHARS = 4000

/** Maximum length of a recorded answer. */
export const MAX_ANSWER_CHARS = 4000

/** Maximum length of a dismissal reason. */
export const MAX_DISMISS_REASON_CHARS = 500

/** Maximum length of a session id stamped on an item. */
export const MAX_SESSION_ID_CHARS = 128

/** The audit actions one item's history can record. */
export const HISTORY_ACTIONS = ['raised', 'answered', 'dismissed', 'reopened'] as const

/** One {@link HISTORY_ACTIONS} member. */
export type HistoryAction = (typeof HISTORY_ACTIONS)[number]

/**
 * Per-item audit history cap.
 *
 * The store document is rewritten whole on every mutation, so history must stay
 * bounded: the oldest entries are dropped once an item has more than this many.
 * The cap is generous enough to hold many user cycles, small enough that a
 * pathological reopen loop cannot grow the document without bound.
 */
export const MAX_HISTORY_ENTRIES = 50

/** Maximum length of one history entry's detail body. */
export const MAX_HISTORY_DETAIL_CHARS = 500

/**
 * One append-only audit entry: what happened to an item, and when.
 *
 * This is the store's own answer to "what happened", independent of any
 * Session log (see `docs/session-log-policy.md`: an out-of-tree plugin must not
 * write non-ignorable session events, so the store is the only durable record).
 */
export interface ItemHistoryEntry {
  /** Millisecond timestamp of the transition. */
  readonly at: number
  readonly action: HistoryAction
  /** Answer text, dismissal reason, or the status a reopen came from. */
  readonly detail?: string
}

/** One unfinished item waiting on the user. */
export interface OpenItem {
  /** Stable UUIDv7 identity; sortable by creation time. */
  readonly id: string
  /**
   * Dedupe key derived from kind, normalised title and session id.
   *
   * The same model re-raising the same decision in the same session is one
   * item, not a duplicate. The same title in a different session is a
   * different item: it is different context the user is being asked about.
   */
  readonly fingerprint: string
  readonly kind: ItemKind
  readonly status: ItemStatus
  /** One-line summary the inbox shows. */
  readonly title: string
  /** Optional longer explanation. */
  readonly detail?: string
  /** Session that raised the item, when the caller had one. */
  readonly sessionId?: string
  /** Recorded answer, present on `answered` items. */
  readonly answer?: string
  /** Recorded dismissal reason, present on `dismissed` items. */
  readonly dismissReason?: string
  /** Millisecond timestamp of creation. */
  readonly createdAt: number
  /** Millisecond timestamp of the last write. */
  readonly updatedAt: number
  /** Millisecond timestamp of the answering write. */
  readonly answeredAt?: number
  /** Millisecond timestamp of the dismissing write. */
  readonly dismissedAt?: number
  /** Millisecond timestamp of the most recent reopen. */
  readonly reopenedAt?: number
  /** How many times the item moved back to `open`. */
  readonly reopenCount: number
  /** Append-only audit trail, oldest first, capped at {@link MAX_HISTORY_ENTRIES}. */
  readonly history: readonly ItemHistoryEntry[]
}

/** The validated input of a create call. */
export interface OpenItemDraft {
  readonly kind: ItemKind
  readonly title: string
  readonly detail?: string
  readonly sessionId?: string
}

/** Result of {@link OpenItemsStore.create}: the item plus whether it was a duplicate. */
export interface CreateResult {
  readonly item: OpenItem
  /** True when an already-open item with the same fingerprint was returned. */
  readonly deduped: boolean
}

/** Status filter of a list call. `all` includes settled items. */
export type ListStatusFilter = ItemStatus | 'all'

/** Filters applied by {@link OpenItemsStore.list}. */
export interface ListFilter {
  /** Defaults to `open`: the inbox is the pending set. */
  readonly status?: ListStatusFilter
  /** Restrict to one kind. */
  readonly kind?: ItemKind
  /** Restrict to one raising session. */
  readonly sessionId?: string
  /** Page size; the store clamps it to its own maximum. */
  readonly limit?: number
}

/** The on-disk document, one JSON object per store file. */
export interface StoreFile {
  readonly schemaVersion: number
  /** Monotonic in-process write counter, for diagnostics. */
  readonly revision: number
  /** Millisecond timestamp the snapshot was written. */
  readonly updatedAt: number
  readonly items: readonly OpenItem[]
}

/** A stored record failed shape validation. */
export class InvalidRecordError extends Error {
  constructor(
    readonly path: string,
    readonly problem: string,
  ) {
    super(`invalid open item at ${path}: ${problem}`)
    this.name = 'InvalidRecordError'
  }
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

/**
 * Normalise a title for storage and display: collapse whitespace, trim, cap.
 * @param value - candidate title.
 * @returns the normalised title (possibly empty).
 */
export function normalizeTitle(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, MAX_TITLE_CHARS)
}

/**
 * Normalise a free-text body: trim, cap, and drop an all-whitespace value.
 * @param value - candidate body, or undefined.
 * @param maxChars - cap for this field.
 * @returns the trimmed body, or undefined when absent/empty.
 */
export function normalizeBody(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.slice(0, maxChars)
}

/**
 * Fold a string into its dedupe-comparable form: case-insensitive, whitespace-
 * collapsed. Only titles are folded; detail bodies deliberately are not part of
 * the fingerprint, so a re-raise with a longer explanation still dedupes.
 * @param value - raw title.
 * @returns the folded title.
 */
export function foldTitle(value: string): string {
  return normalizeTitle(value).toLowerCase()
}

/* ------------------------------------------------------------------ *
 * Validation of untrusted on-disk JSON
 * ------------------------------------------------------------------ */

/**
 * Read one required plain object.
 * @param value - candidate.
 * @param path - diagnostic path.
 * @returns the record.
 */
function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRecordError(path, 'expected an object')
  }
  return value as Record<string, unknown>
}

/**
 * Read one required string, optionally length-capped.
 * @param value - candidate.
 * @param path - diagnostic path.
 * @param maxChars - cap.
 * @returns the string.
 */
function requireString(value: unknown, path: string, maxChars: number): string {
  if (typeof value !== 'string') throw new InvalidRecordError(path, 'expected a string')
  if (value.trim() === '') throw new InvalidRecordError(path, 'expected a non-empty string')
  if (value.length > maxChars) throw new InvalidRecordError(path, `longer than ${maxChars} characters`)
  return value
}

/**
 * Read one optional string.
 * @param value - candidate.
 * @param path - diagnostic path.
 * @param maxChars - cap.
 * @returns the string, or undefined.
 */
function optionalString(value: unknown, path: string, maxChars: number): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, path, maxChars)
}

/**
 * Read one enum member.
 * @param value - candidate.
 * @param path - diagnostic path.
 * @param allowed - allowed values.
 * @returns the member.
 */
function requireEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new InvalidRecordError(path, `expected one of ${allowed.join(', ')}`)
  }
  return value as T
}

/**
 * Read one non-negative safe-integer timestamp.
 * @param value - candidate.
 * @param path - diagnostic path.
 * @returns the integer.
 */
function requireTimestamp(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidRecordError(path, 'expected a non-negative integer timestamp')
  }
  return value
}

/**
 * Read one optional timestamp.
 * @param value - candidate.
 * @param path - diagnostic path.
 * @returns the timestamp, or undefined.
 */
function optionalTimestamp(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined
  return requireTimestamp(value, path)
}

/**
 * Validate one stored record.
 *
 * The checks are deliberately stricter than the writer: the store file is
 * durable state that a human may edit, so a reader validates every field and
 * status-specific invariant before trusting it.
 * @param value - untrusted JSON value.
 * @param path - diagnostic path.
 * @returns the validated record.
 * @throws {InvalidRecordError} when the value is not a coherent record.
 */
export function parseOpenItem(
  value: unknown,
  path = 'item',
  options: { readonly historyRequired?: boolean } = {},
): OpenItem {
  const record = requireRecord(value, path)
  const id = requireString(record['id'], `${path}.id`, 64)
  const fingerprint = requireString(record['fingerprint'], `${path}.fingerprint`, 64)
  if (!/^[0-9a-f]{16}$/u.test(fingerprint)) {
    throw new InvalidRecordError(`${path}.fingerprint`, 'expected 16 lowercase hex characters')
  }
  const kind = requireEnum(record['kind'], `${path}.kind`, ITEM_KINDS)
  const status = requireEnum(record['status'], `${path}.status`, ITEM_STATUSES)
  const title = requireString(record['title'], `${path}.title`, MAX_TITLE_CHARS)
  const detail = optionalString(record['detail'], `${path}.detail`, MAX_DETAIL_CHARS)
  const sessionId = optionalString(record['sessionId'], `${path}.sessionId`, MAX_SESSION_ID_CHARS)
  const answer = optionalString(record['answer'], `${path}.answer`, MAX_ANSWER_CHARS)
  const dismissReason = optionalString(record['dismissReason'], `${path}.dismissReason`, MAX_DISMISS_REASON_CHARS)
  const createdAt = requireTimestamp(record['createdAt'], `${path}.createdAt`)
  const updatedAt = requireTimestamp(record['updatedAt'], `${path}.updatedAt`)
  const answeredAt = optionalTimestamp(record['answeredAt'], `${path}.answeredAt`)
  const dismissedAt = optionalTimestamp(record['dismissedAt'], `${path}.dismissedAt`)
  const reopenedAt = optionalTimestamp(record['reopenedAt'], `${path}.reopenedAt`)
  const reopenCount = record['reopenCount']
  if (typeof reopenCount !== 'number' || !Number.isSafeInteger(reopenCount) || reopenCount < 0) {
    throw new InvalidRecordError(`${path}.reopenCount`, 'expected a non-negative integer')
  }
  if (updatedAt < createdAt) throw new InvalidRecordError(`${path}.updatedAt`, 'earlier than createdAt')
  if (status === 'answered' && answeredAt === undefined) {
    throw new InvalidRecordError(`${path}.answeredAt`, 'required while status is answered')
  }
  if (status === 'dismissed' && dismissedAt === undefined) {
    throw new InvalidRecordError(`${path}.dismissedAt`, 'required while status is dismissed')
  }
  if (status === 'open' && (answeredAt !== undefined || dismissedAt !== undefined)) {
    throw new InvalidRecordError(`${path}.status`, 'open items must not carry a settlement timestamp')
  }
  const history = parseHistory(record['history'], `${path}.history`, options.historyRequired !== false)
  return {
    id,
    fingerprint,
    kind,
    status,
    title,
    ...(detail === undefined ? {} : { detail }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(answer === undefined ? {} : { answer }),
    ...(dismissReason === undefined ? {} : { dismissReason }),
    createdAt,
    updatedAt,
    ...(answeredAt === undefined ? {} : { answeredAt }),
    ...(dismissedAt === undefined ? {} : { dismissedAt }),
    ...(reopenedAt === undefined ? {} : { reopenedAt }),
    reopenCount,
    history,
  }
}

/**
 * Validate one item's audit history.
 *
 * A v1 document has no history field; `required: false` reads it as empty so an
 * old store file stays openable (the next write upgrades the document).
 * @param value - untrusted JSON value.
 * @param path - diagnostic path.
 * @param required - whether the field must be present.
 * @returns the validated entries (frozen).
 */
function parseHistory(value: unknown, path: string, required: boolean): readonly ItemHistoryEntry[] {
  if (value === undefined && !required) return []
  if (!Array.isArray(value)) throw new InvalidRecordError(path, 'expected an array')
  if (value.length > MAX_HISTORY_ENTRIES) {
    throw new InvalidRecordError(path, `longer than the ${MAX_HISTORY_ENTRIES}-entry cap`)
  }
  const entries: ItemHistoryEntry[] = []
  for (const [index, raw] of value.entries()) {
    const entryPath = `${path}[${index}]`
    const entry = requireRecord(raw, entryPath)
    const at = requireTimestamp(entry['at'], `${entryPath}.at`)
    const action = requireEnum(entry['action'], `${entryPath}.action`, HISTORY_ACTIONS)
    const detail = optionalString(entry['detail'], `${entryPath}.detail`, MAX_HISTORY_DETAIL_CHARS)
    entries.push({ at, action, ...(detail === undefined ? {} : { detail }) })
  }
  return Object.freeze(entries)
}

/**
 * Validate one store document.
 * @param value - untrusted JSON value.
 * @returns the validated document.
 * @throws {InvalidRecordError} when the document or one item is invalid.
 */
export function parseStoreFile(value: unknown): StoreFile {
  const record = requireRecord(value, 'store')
  const schemaVersion = record['schemaVersion']
  if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion)) {
    throw new InvalidRecordError('store.schemaVersion', 'expected an integer')
  }
  if (schemaVersion < MIN_SUPPORTED_STORE_VERSION || schemaVersion > STORE_SCHEMA_VERSION) {
    throw new InvalidRecordError(
      'store.schemaVersion',
      `outside the supported range ${MIN_SUPPORTED_STORE_VERSION}..${STORE_SCHEMA_VERSION}`,
    )
  }
  const revision = record['revision']
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw new InvalidRecordError('store.revision', 'expected a non-negative integer')
  }
  const updatedAt = requireTimestamp(record['updatedAt'], 'store.updatedAt')
  const rawItems = record['items']
  if (!Array.isArray(rawItems)) throw new InvalidRecordError('store.items', 'expected an array')
  const items: OpenItem[] = []
  const seen = new Set<string>()
  for (const [index, raw] of rawItems.entries()) {
    const item = parseOpenItem(raw, `store.items[${index}]`, { historyRequired: schemaVersion >= 2 })
    if (seen.has(item.id)) throw new InvalidRecordError(`store.items[${index}].id`, `duplicate id ${item.id}`)
    seen.add(item.id)
    items.push(item)
  }
  return { schemaVersion, revision, updatedAt, items }
}
