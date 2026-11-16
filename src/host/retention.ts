/**
 * Retention and acknowledgement planning (PLAN M1 item 6, DESIGN §7.3/§7.4.4).
 *
 * Pure functions over records: the store applies the plan through its CAS write
 * path. Keeping the policy pure makes the awkward parts testable — the 365-day
 * active→archive boundary, the 24 h acknowledgement window, and the
 * prune-only-on-append cap.
 *
 * Two distinct meanings of "archive" stay explicit:
 * - an **open** item decays to `state: 'archived'` (hidden from Needs you, still
 *   listed under the Archived filter);
 * - a **resolved** item moves to `retention.class: 'archived'` (body/quote
 *   dropped, decision kept forever until a cap prunes it).
 */
import type { OpenItemId, OpenItemRecord } from '../shared/schema'
import { LIVE_STATES } from '../shared/records'

/** Milliseconds in one day. */
export const DAY_MS = 24 * 60 * 60 * 1000

/** Milliseconds in one hour. */
export const HOUR_MS = 60 * 60 * 1000

/** Policy inputs of one sweep. */
export interface RetentionPolicy {
  /** Current millisecond timestamp. */
  readonly now: number
  /** Resolved items leave the active register after this many days. */
  readonly activeResolveDays: number
  /** Unacknowledged deliveries become "no acknowledgement observed" after this many hours. */
  readonly acknowledgementWindowHours: number
  /** Safety cap on stored resolutions; oldest archived rows prune first. */
  readonly maxResolvedRecords: number
  /** Cap on live (open/stale/snoozed) items; a breach archives the oldest, never deletes. */
  readonly maxLiveItems?: number
}

/** What one sweep should do. */
export interface RetentionPlan {
  /** Awaiting items whose window elapsed with no evidence. */
  readonly unacknowledged: readonly OpenItemRecord[]
  /** Resolved items whose retention class becomes `archived` this sweep. */
  readonly archive: readonly OpenItemRecord[]
  /** Archived resolved records to delete to satisfy the cap. */
  readonly prune: readonly OpenItemId[]
  /** Live items to archive to satisfy the live cap (oldest stale first). */
  readonly archiveLive: readonly OpenItemRecord[]
}

/** The instant an item last produced evidence of life (for the ack window). */
function lastActivityAt(record: OpenItemRecord): number {
  const deliveryTimes = record.deliveries.map(delivery => delivery.at)
  const resolutionAt = record.resolution?.at ?? 0
  return Math.max(resolutionAt, ...deliveryTimes, record.updatedAt)
}

/**
 * Whether an awaiting item is still inside its acknowledgement window.
 * @param record - awaiting record.
 * @param now - current timestamp.
 * @param windowHours - configured window.
 * @returns true while evidence may still arrive.
 */
export function isInsideAcknowledgementWindow(record: OpenItemRecord, now: number, windowHours: number): boolean {
  if (record.state !== 'awaiting') return false
  if (record.acknowledgement?.state !== 'pending') return false
  return now - lastActivityAt(record) < windowHours * HOUR_MS
}

/**
 * Plan one retention sweep.
 * @param records - all stored records (any state).
 * @param policy - current time and configured caps.
 * @returns the plan the store applies.
 */
export function planRetention(records: readonly OpenItemRecord[], policy: RetentionPolicy): RetentionPlan {
  const { now } = policy
  const unacknowledged: OpenItemRecord[] = []
  const archive: OpenItemRecord[] = []

  for (const record of records) {
    // A tombstone is not a register row: an explicit "delete forever" keeps it
    // out of retention accounting entirely (it is never archived or pruned, so
    // the deletion stays final and cannot be resurrected by dropping the row).
    if (record.deletedAt !== undefined) continue
    if (record.state === 'awaiting' && record.acknowledgement?.state === 'pending'
      && now - lastActivityAt(record) >= policy.acknowledgementWindowHours * HOUR_MS) {
      unacknowledged.push(record)
    }
    if (record.state === 'resolved' && record.retention.class === 'active' && record.resolvedAt !== undefined
      && now - record.resolvedAt >= policy.activeResolveDays * DAY_MS) {
      archive.push(record)
    }
  }

  return {
    unacknowledged,
    archive,
    prune: planPrune(records, archive, policy.maxResolvedRecords),
    archiveLive: planLiveArchive(records, policy),
  }
}

/**
 * Choose archived resolved rows to prune on append.
 *
 * Resolution count includes rows being archived this sweep. Only rows already
 * in the archived retention class are candidates; active resolutions are never
 * pruned. The oldest archived rows go first, so the register loses the least
 * interesting tail and can honestly report "earlier records pruned".
 * @param records - all records.
 * @param archiving - records about to become archived.
 * @param cap - configured resolution cap.
 * @returns ids to delete.
 */
function planPrune(
  records: readonly OpenItemRecord[],
  archiving: readonly OpenItemRecord[],
  cap: number,
): readonly OpenItemId[] {
  const archivingIds = new Set(archiving.map(record => record.id))
  // Tombstones do not occupy the resolution cap and are never prune candidates:
  // deleting one would let a later fold re-raise the artifact the user
  // permanently deleted.
  const resolved = records.filter(record => record.state === 'resolved' && record.deletedAt === undefined)
  const excess = resolved.length - cap
  if (excess <= 0) return []
  const candidates = records
    .filter(record => record.state === 'resolved'
      && record.deletedAt === undefined
      && (record.retention.class === 'archived' || archivingIds.has(record.id)))
    .sort((left, right) => (left.resolvedAt ?? 0) - (right.resolvedAt ?? 0) || (left.id < right.id ? -1 : 1))
  return candidates.slice(0, Math.max(0, excess)).map(record => record.id)
}

/**
 * Choose live items to archive when the live cap is breached.
 *
 * "Archives the oldest `stale` first, then the lowest severity — it does not
 * destroy them" (DESIGN §7.3). Already-archived records are excluded.
 * @param records - all records.
 * @param policy - policy inputs (cap optional).
 * @returns live records to move to `archived`.
 */
function planLiveArchive(records: readonly OpenItemRecord[], policy: RetentionPolicy): readonly OpenItemRecord[] {
  const cap = policy.maxLiveItems
  if (cap === undefined) return []
  const live = records.filter(record => LIVE_STATES.includes(record.state))
  const excess = live.length - cap
  if (excess <= 0) return []
  const ordered = [...live].sort((left, right) => {
    const staleFirst = Number(right.state === 'stale') - Number(left.state === 'stale')
    if (staleFirst !== 0) return staleFirst
    if (left.severity !== right.severity) return right.severity - left.severity
    return left.updatedAt - right.updatedAt
  })
  return ordered.slice(0, excess)
}
