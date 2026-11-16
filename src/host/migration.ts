/**
 * One-time migration of the P0 store document into the `open_items` domain
 * (PLAN M1 item 2).
 *
 * The P0 scaffold kept every item in one JSON document at
 * `<DSH_HOME>/open-items/store.json` (schema v1/v2). M1 moves the durable truth
 * to the storage domain, so an existing document is imported once and renamed
 * aside. The migration is idempotent:
 *
 * - imports are put-if-absent by the P0 id, so re-running cannot duplicate;
 * - the legacy file is renamed to `<path>.migrated` only after every record was
 *   accepted, so a crash mid-import is retried on the next activation;
 * - an unreadable document is quarantined to `<path>.corrupt-<ts>` and activation
 *   continues with the domain store (the file is never overwritten).
 *
 * The module takes an `importRecords` callback instead of the store itself, so
 * it stays unit-testable and the store keeps ownership of identity/index rules.
 */
import { readFile, rename } from 'node:fs/promises'

import type { OpenItemRecord, ReplyDescriptor, ReplyPayload, Resolution } from '../shared/schema'
import {
  MAX_HISTORY_ENTRIES,
  defaultReply,
  normalizeBody,
  normalizeTitle,
} from '../shared/records'
import { parseStoreFile, type OpenItem } from '../shared/types'

/** What one migration attempt did. */
export interface LegacyMigrationReport {
  /** Whether a legacy document was present. */
  readonly found: boolean
  /** Records imported into the domain. */
  readonly imported: number
  /** Records already present in the domain (idempotent re-run). */
  readonly skipped: number
  /** Set when the legacy document was unreadable and renamed aside. */
  readonly quarantinedPath?: string
  /** Set when the legacy document was imported and renamed aside. */
  readonly migratedPath?: string
}

/** Dependencies of {@link migrateLegacyStore}. */
export interface LegacyMigrationDeps {
  /** Absolute path of the P0 document. */
  readonly legacyPath: string
  /** Install identity stamped on imported records. */
  readonly installId: string
  /** Injectable clock for the archive timestamp; defaults to `Date.now`. */
  readonly now?: () => number
  /** Put-if-absent import; resolves the number of newly stored records. */
  readonly importRecords: (records: readonly OpenItemRecord[]) => Promise<number>
}

/** P0 `uncertainty` is a `risk` in the v3 vocabulary. */
const KIND_MAP: Readonly<Record<OpenItem['kind'], OpenItemRecord['kind']>> = {
  decision: 'decision',
  approval: 'approval',
  question: 'question',
  uncertainty: 'risk',
}

/**
 * Migrate one legacy document.
 * @param deps - path, install identity, clock and import callback.
 * @returns what happened; never throws for an unreadable legacy file.
 */
export async function migrateLegacyStore(deps: LegacyMigrationDeps): Promise<LegacyMigrationReport> {
  const now = deps.now ?? Date.now
  let raw: string
  try {
    raw = await readFile(deps.legacyPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { found: false, imported: 0, skipped: 0 }
    throw error
  }

  let items: readonly OpenItem[]
  try {
    const parsed = JSON.parse(raw) as unknown
    items = parseStoreFile(parsed).items
  } catch {
    const quarantinedPath = `${deps.legacyPath}.corrupt-${now()}`
    await rename(deps.legacyPath, quarantinedPath)
    return { found: true, imported: 0, skipped: 0, quarantinedPath }
  }

  const records = items.map(item => legacyRecord(item, deps.installId))
  const imported = await deps.importRecords(records)
  const migratedPath = `${deps.legacyPath}.migrated`
  await rename(deps.legacyPath, migratedPath)
  return { found: true, imported, skipped: records.length - imported, migratedPath }
}

/**
 * Map one P0 item to a v3 record.
 *
 * P0 had a two-state settlement (`answered` / `dismissed`); v3 records it as
 * `resolved` plus the resolution the user gave, with the P0 history carried
 * over. Nothing is inferred from prose: an answered item's answer text becomes
 * the resolution payload.
 * @param item - validated P0 item.
 * @param installId - install identity.
 * @returns the v3 record.
 */
export function legacyRecord(item: OpenItem, installId: string): OpenItemRecord {
  const kind = KIND_MAP[item.kind]
  const sessionId = item.sessionId ?? 'legacy-unattributed'
  const resolved = item.status !== 'open'
  const resolution = resolved ? legacyResolution(item) : undefined
  const resolvedAt = item.answeredAt ?? item.dismissedAt ?? (resolved ? item.updatedAt : undefined)
  const history = item.history.length === 0
    ? [{ at: item.createdAt, action: 'raised' }]
    : item.history.slice(-MAX_HISTORY_ENTRIES).map(entry => ({
      at: entry.at,
      action: entry.action,
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    }))
  const reply: ReplyDescriptor = defaultReply(kind)
  return {
    schemaVersion: 3,
    id: item.id,
    origin: installId,
    kind,
    state: resolved ? 'resolved' : 'open',
    tier: 'structural',
    severity: 2,
    title: normalizeTitle(item.title),
    body: normalizeBody(item.detail ?? ''),
    source: { sessionId },
    blocking: true,
    reply,
    deliveries: [],
    occurrences: [{ sessionId, seenAt: item.createdAt }],
    // Distinct from new authored keys: a migrated item and a later re-raise are
    // not silently merged across the storage-format change.
    dedupeKey: `legacy|${kind}|${sessionId}|${item.fingerprint}`,
    detectedBy: ['tool'],
    firstSeenAt: item.createdAt,
    lastSeenAt: item.updatedAt,
    updatedAt: item.updatedAt,
    version: 1,
    ...(resolution === undefined ? {} : { resolution }),
    ...(resolved
      ? { acknowledgement: { state: 'none' as const } }
      : {}),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    reopenCount: item.reopenCount,
    retention: { class: 'active' },
    history,
  }
}

/**
 * Build the resolution for a settled P0 item.
 * @param item - P0 item with `answered` or `dismissed` status.
 * @returns the v3 resolution.
 */
function legacyResolution(item: OpenItem): Resolution {
  const at = item.answeredAt ?? item.dismissedAt ?? item.updatedAt
  if (item.status === 'answered') {
    const payload: ReplyPayload = { type: 'text', text: item.answer ?? '' }
    return { kind: 'answered', at, actor: 'user', payload }
  }
  const payload: ReplyPayload = {
    type: 'dismiss',
    ...(item.dismissReason === undefined || item.dismissReason === '' ? {} : { reason: item.dismissReason }),
  }
  return { kind: 'dismissed', at, actor: 'user', payload }
}
