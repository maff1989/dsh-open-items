/**
 * Durable store for open items over the `open_items` storage domain
 * (PLAN M1 items 1–4, 6; DESIGN §7.1, §7.4).
 *
 * The domain gives authoritative in-memory state plus a per-domain write chain:
 * `table.update` is an atomic read-modify-write at its queue slot, so every
 * mutation here is a real CAS on the item's `version`. Reads are synchronous
 * from the domain; a rejected durable write leaves memory untouched.
 *
 * The store owns:
 * - install identity and the one-time P0-document migration;
 * - authored and derived record creation, dedupe (one dedupe key = one item),
 *   and the capture sink the projection/backfill branch calls;
 * - the v3 lifecycle (answer → awaiting → resolve, dismiss, reopen, snooze →
 *   wake, deliveries, acknowledgement);
 * - retention: acknowledgement window, 365 d active→archive, cap pruning,
 *   live-cap archiving.
 *
 * Session-log policy: this module never touches a Session log (see
 * `docs/session-log-policy.md`); the store's `history[]` is the audit trail.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'

import type { CaptureSink, DerivedItemDraft } from './capture-contract'
import type { RecordAttemptInput } from './delivery-contract'
import { BACKFILL_META_KEY, INSTALL_META_KEY, SETTINGS_META_KEY, openItemsDomain, type OpenItemsDomain } from './domain'
import { migrateLegacyStore, type LegacyMigrationReport } from './migration'
import { planRetention, type RetentionPolicy } from './retention'
import {
  DEFAULT_SETTINGS,
  LIMITS,
  type BackfillReportRecord,
  type PromotePatch,
  type SettingsPatch,
  type SettingsRecord,
  type SettingsWriteValue,
} from '../shared/protocol'
import type {
  Acknowledgement,
  AcknowledgementEvidence,
  DeliveryRecord,
  DetectionSource,
  DetectionCursor,
  InstallRecord,
  ItemSourceRef,
  OpenItemId,
  OpenItemKind,
  OpenItemRecord,
  OpenItemState,
  OpenItemTier,
  ReplyPayload,
  Resolution,
  Severity,
  SuppressorRecord,
  WorkspaceRef,
} from '../shared/schema'
import {
  MAX_DELIVERIES,
  MAX_HISTORY_DETAIL_CHARS,
  MAX_OCCURRENCES,
  MAX_RESOLUTION_LOG,
  ITEM_KINDS,
  appendHistory,
  authoredDedupeKey,
  defaultReply,
  derivedDedupeKey,
  isCandidateRecord,
  isNeedsYouRecord,
  normalizeBody,
  normalizeTitle,
  isBackfillReportRecord,
  isInstallRecord,
  isSettingsRecord,
  parseBackfillReportRecord,
  parseDerivedDedupeKey,
  parseDetectionCursor,
  parseInstallRecord,
  parseItemRecord,
  parseSettingsRecord,
  parseSuppressorRecord,
  proseAskKey,
  LIVE_STATES,
} from '../shared/records'

/** Title a tombstone carries once its own text is dropped. */
export const TOMBSTONE_TITLE = '[deleted]'

/**
 * Detector code of the team-task orphan artifact (the disabled family's only
 * historical producer), and the closure code its retirement records. Both are
 * read back by {@link OpenItemsStore.retireTeamTaskItems} so the cleanup is
 * explainable in the register.
 */
export const TEAM_TASK_ORPHAN_CODE = 'team/task:in-progress-orphan'
export const TEAM_TASK_ALERTS_DISABLED_CODE = 'team/task:alerts-disabled'

/**
 * Prose-candidate detector and closure codes owned by the store's migration
 * (contract §2.2). They are duplicated here — deliberately, as plain strings
 * with no import from the fold — because the store must keep closing rows the
 * *old* gate raised after the detection code moves on; the codes themselves are
 * the durable audit vocabulary (acceptance/UI filters key on the `prose:` /
 * `prose-gate:` prefixes).
 */
export const PROSE_CANDIDATE_DETECTOR_CODE = 'prose-gate:decision-request'
/** Closure code the legacy (pre-split) prose candidates are retired with. */
export const LEGACY_PROSE_SUPERSEDED_CODE = 'prose-gate:superseded-by-scope-change'
/** Closure code for a candidate that duplicates an already-promoted prose item. */
export const PROSE_DUPLICATE_OF_PROMOTED_CODE = 'prose-gate:duplicate-of-promoted'

/**
 * The pre-split prose artifact id: one bare `prose:<16 hex>` per turn. The split
 * gate emits `prose:t<turn>:<12 hex>` per item instead, so a key that still
 * matches this pattern describes a row the one-artifact gate raised.
 */
const LEGACY_PROSE_ARTIFACT_ID = /^prose:[0-9a-f]{16}$/u

/**
 * A legacy prose suppressor prefix: `derived|<kind>|<session>|prose:<16 hex>` —
 * the exact key of one pre-split artifact. The migration expands it to both kind
 * families' session-scoped prose prefixes and deletes this row.
 */
const LEGACY_PROSE_SUPPRESSOR_PREFIX = /^derived\|(?:question|decision)\|([^|]+)\|prose:[0-9a-f]{16}$/u

/**
 * The acknowledgement evidence kind a detector closure really proves.
 *
 * A resolution must record *what* closed the item, not a blanket `tool-result`
 * (REVIEW-rc1 P1 "detector evidence hardcoded"): a goal leaving `blocked`, a
 * completed team task, a superseded turn and a retried call are different
 * evidence from the UI's point of view (DESIGN §7.4.2). The closure detector
 * code carries the closing event type, so it maps directly:
 *
 * | closure code prefix | evidence kind |
 * |---|---|
 * | `goal/` | `goal-resumed` |
 * | `team/task` | `task-completed` |
 * | `turn/start` | `turn-continued` |
 * | `tool/call` | `call-retried` |
 * | `tool/result` | `tool-result` |
 * | `approval/` | `call-retried` (the action ran on a retried approval) |
 * | `job/` | `tool-result` (a settled background job is the tool's outcome) |
 *
 * An unknown future code falls back to `tool-result`, the pre-rc2 value, so a
 * new detector is never silently mislabelled as something it is not.
 * @param code - closure detector code (`closes.code` / `resolution.payload.code`).
 * @returns the evidence kind to record.
 */
export function detectorEvidenceKind(code: string): AcknowledgementEvidence {
  if (code.startsWith('goal/')) return 'goal-resumed'
  if (code.startsWith('team/task')) return 'task-completed'
  if (code.startsWith('turn/start')) return 'turn-continued'
  if (code.startsWith('tool/call')) return 'call-retried'
  if (code.startsWith('tool/result')) return 'tool-result'
  if (code.startsWith('approval/')) return 'call-retried'
  if (code.startsWith('job/')) return 'tool-result'
  return 'tool-result'
}

/** The detector code carried by a detector resolution, when it has one. */
function resolutionCode(resolution: Resolution): string {
  return resolution.payload.type === 'detector' ? resolution.payload.code : ''
}

/** No item with that id exists. */
export class NotFoundError extends Error {
  constructor(readonly id: OpenItemId) {
    super(`open item ${id} not found`)
    this.name = 'NotFoundError'
  }
}

/** The caller's `expectedVersion` is stale: someone else wrote the item first. */
export class ConflictError extends Error {
  constructor(
    readonly id: OpenItemId,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`open item ${id} changed (expected version ${expectedVersion}, found ${actualVersion})`)
    this.name = 'ConflictError'
  }
}

/** The live-item cap is reached and no archive candidate could free a slot. */
export class LimitError extends Error {
  constructor(readonly maxLiveItems: number) {
    super(`open item limit reached (${maxLiveItems} live items)`)
    this.name = 'LimitError'
  }
}

/** The requested transition is illegal for the item's current state. */
export class InvalidTransitionError extends Error {
  constructor(
    readonly id: OpenItemId,
    readonly from: OpenItemState,
    readonly action: string,
  ) {
    super(`cannot ${action} open item ${id} while it is ${from}`)
    this.name = 'InvalidTransitionError'
  }
}

/** A caller-supplied draft failed validation at the store boundary. */
export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidArgumentError'
  }
}

/** Log sink the wiring site supplies (Host logger); optional in tests. */
export interface StoreLogger {
  warn(message: string): void
  info?(message: string): void
}

/** Plugin-side policy the store enforces. */
export interface StoreLimits {
  readonly maxLiveItems: number
  readonly maxResolvedRecords: number
  readonly activeResolveDays: number
  readonly acknowledgementWindowHours: number
}

/** What {@link OpenItemsStore.open} needs to start. */
export interface StoreOptions extends Partial<StoreLimits> {
  /** Absolute path of a P0 document to import once; omit to skip migration. */
  readonly legacyStorePath?: string
  /** Injectable clock; defaults to `Date.now` (tests pin it). */
  readonly now?: () => number
  /** Optional logger for migration/retention diagnostics. */
  readonly log?: StoreLogger
}

/** The concrete policy a store runs with (defaults filled from `LIMITS`). */
export interface ResolvedStoreLimits extends StoreLimits {}

/** One authored create request (the tool's `raise` path). */
export interface AuthoredItemInput {
  readonly kind?: OpenItemKind
  readonly title: string
  readonly body?: string
  readonly quote?: string
  readonly options?: readonly string[]
  readonly blocking?: boolean
  readonly tier?: OpenItemTier
  readonly severity?: Severity
  readonly sessionId?: string
  readonly sessionTitle?: string
  readonly workspace?: WorkspaceRef
  readonly cwd?: string
  readonly seq?: number
  readonly turn?: number
  readonly callId?: string
  readonly messageId?: string
  /**
   * Set when a subagent raised the item and it rolled up to the root session:
   * the session that actually asked, with its display title when known.
   */
  readonly raisedBy?: { readonly sessionId: string; readonly title?: string }
  readonly detectedBy?: readonly DetectionSource[]
}

/** Result of {@link OpenItemsStore.create}. */
export interface CreateRecordResult {
  readonly item: OpenItemRecord
  /** True when a live item with the same dedupe key was returned instead. */
  readonly deduped: boolean
}

/** Outcome of one retention sweep. */
export interface SweepReport {
  readonly unacknowledged: number
  readonly archived: number
  readonly liveArchived: number
  readonly pruned: number
}

/**
 * Mint a UUIDv7: 48-bit big-endian millisecond timestamp, random tail.
 * @param now - Millisecond timestamp to embed.
 * @returns the formatted UUID.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[0] = (now / 2 ** 40) & 0xff
  bytes[1] = (now / 2 ** 32) & 0xff
  bytes[2] = (now / 2 ** 24) & 0xff
  bytes[3] = (now / 2 ** 16) & 0xff
  bytes[4] = (now / 2 ** 8) & 0xff
  bytes[5] = now & 0xff
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Ensure the single `meta` install row exists.
 *
 * The `meta` table now holds two shapes (install identity and the settings
 * record), so the row is narrowed before it is trusted as install identity; a
 * missing or unreadable row is re-created exactly as before.
 * @param domain - opened domain.
 * @param now - clock.
 * @returns the install record.
 */
async function ensureInstallRecord(domain: Domain<OpenItemsDomain>, now: () => number): Promise<InstallRecord> {
  const table = domain.table('meta')
  const existing = table.get(INSTALL_META_KEY)
  if (existing !== undefined && isInstallRecord(existing)) return existing
  const created = parseInstallRecord({ installId: uuidv7(now()), createdAt: now() })
  await table.put(INSTALL_META_KEY, created)
  return created
}

/** The plugin's durable store, constructed through {@link OpenItemsStore.open}. */
export class OpenItemsStore implements CaptureSink {
  /** Identity index: every stored record by id (the in-memory register index). */
  private readonly items = new Map<OpenItemId, OpenItemRecord>()
  /** In-process write counter exposed to clients as the snapshot revision. */
  private revisionCounter = 1
  /** True once a cap prune removed resolved rows; surfaced as `earlierRecordsPruned`. */
  private pruned = false
  /** Lazy snooze-wake writes queued by a read; awaited by {@link flush}. */
  private readonly wakeWrites = new Set<Promise<unknown>>()
  /** Serialises read-modify-index sequences (create/derived/import). */
  private chain: Promise<unknown> = Promise.resolve()
  /** Serialises settings writes so the first (unstored) write is put-if-absent. */
  private settingsChain: Promise<unknown> = Promise.resolve()
  /** Tail of every store mutation, awaited by {@link flush}. */
  private pending: Promise<unknown> = Promise.resolve()
  /** Migration result, when a legacy document was present. */
  private migrationReport: LegacyMigrationReport | undefined
  /** Values served while no settings record has been written. */
  private readonly defaultSettings: SettingsRecord = DEFAULT_SETTINGS

  private constructor(
    private readonly domain: Domain<OpenItemsDomain>,
    readonly installId: string,
    private readonly limits: ResolvedStoreLimits,
    private readonly clock: () => number,
    private readonly log: StoreLogger | undefined,
  ) {}

  /**
   * Open the domain, ensure install identity, migrate the P0 document and run
   * one retention sweep.
   * @param ctx - Host context owning the storage facility.
   * @param options - caps, migration path, clock and logger.
   * @returns the ready store.
   */
  static async open(ctx: Context, options: StoreOptions = {}): Promise<OpenItemsStore> {
    const limits: ResolvedStoreLimits = {
      maxLiveItems: options.maxLiveItems ?? LIMITS.maxLiveItems,
      maxResolvedRecords: options.maxResolvedRecords ?? LIMITS.maxResolvedRecords,
      activeResolveDays: options.activeResolveDays ?? LIMITS.activeResolveDays,
      acknowledgementWindowHours: options.acknowledgementWindowHours ?? LIMITS.acknowledgementWindowHours,
    }
    const clock = options.now ?? Date.now
    const domain = await ctx.storageDomain.open(openItemsDomain)
    try {
      const install = await ensureInstallRecord(domain, clock)
      const store = new OpenItemsStore(domain, install.installId, limits, clock, options.log)
      store.rebuildIndex()
      if (options.legacyStorePath !== undefined) await store.migrateLegacy(options.legacyStorePath)
      await store.sweep()
      return store
    } catch (error) {
      await domain.close()
      throw error
    }
  }

  /** Closed-domain flag; writes after close reject through the domain. */
  private closed = false

  /** Domain name (for `hello`). */
  get domainName(): string {
    return this.domain.name
  }

  /** Domain format version (for `hello`). */
  get domainFormatVersion(): number {
    return openItemsDomain.version
  }

  /** Record schema version (for `hello`). */
  get schemaVersion(): number {
    return 3
  }

  /** Monotonic in-process revision for snapshot readers. */
  get revision(): number {
    return this.revisionCounter
  }

  /** True when a cap pruned stored resolutions (never silent: surfaced in snapshots). */
  get earlierRecordsPruned(): boolean {
    return this.pruned
  }

  /** The migration outcome, when this store opened over a legacy document. */
  get migration(): LegacyMigrationReport | undefined {
    return this.migrationReport
  }

  /** Effective policy (diagnostics and tests). */
  get policy(): ResolvedStoreLimits {
    return this.limits
  }

  /* ------------------------------------------------------------------ *
   * Settings (the `meta` table's `settings` key)
   * ------------------------------------------------------------------ */

  /**
   * Read the settings record.
   *
   * Synchronous from the domain's in-memory state like every other read; the
   * unstored defaults (version 0) are served until the first write, so an
   * install that never opens Settings materialises no row.
   * @returns the live settings record.
   */
  settings(): SettingsRecord {
    const stored = this.domain.table('meta').get(SETTINGS_META_KEY)
    if (stored !== undefined && isSettingsRecord(stored)) return stored
    return this.defaultSettings
  }

  /**
   * Merge one validated patch into the settings record (compare-and-set).
   *
   * The first write is put-if-absent through a serialised chain (the defaults
   * were never stored, so there is no row to update); every later write is an
   * atomic `KvTable.update` that re-checks the CAS token inside the domain's
   * write chain. A stale token returns the live record as a `conflict` value,
   * never an exception: the client re-renders from Host truth.
   * @param expectedVersion - version the caller read (0 while serving defaults).
   * @param patch - validated fields to change.
   * @returns the accepted record, or the live record when the version was stale.
   * @throws {InvalidArgumentError} when the CAS token is not a non-negative integer.
   */
  async setSettings(expectedVersion: number, patch: SettingsPatch): Promise<SettingsWriteValue> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new InvalidArgumentError('expectedVersion must be a non-negative integer')
    }
    const run = async (): Promise<SettingsWriteValue> => {
      const table = this.domain.table('meta')
      const stored = table.get(SETTINGS_META_KEY)
      const current = stored !== undefined && isSettingsRecord(stored) ? stored : this.defaultSettings
      if (current.version !== expectedVersion) return { status: 'conflict', settings: current }
      const candidate = parseSettingsRecord({
        schemaVersion: 1,
        version: current.version + 1,
        modelNudge: patch.modelNudge ?? current.modelNudge,
        proseCandidates: patch.proseCandidates ?? current.proseCandidates,
        llmExtraction: patch.llmExtraction ?? current.llmExtraction,
      })
      if (stored === undefined) {
        // Put-if-absent: the settings chain makes this the only first writer.
        await table.put(SETTINGS_META_KEY, candidate)
      } else {
        try {
          await table.update(SETTINGS_META_KEY, live => {
            const liveSettings = isSettingsRecord(live) ? live : this.defaultSettings
            if (liveSettings.version !== expectedVersion) throw new StaleSettingsError()
            return candidate
          })
        } catch (error) {
          if (error instanceof StaleSettingsError) return { status: 'conflict', settings: this.settings() }
          throw error
        }
      }
      this.revisionCounter += 1
      return { status: 'written', settings: candidate }
    }
    const next = this.settingsChain.then(run, run)
    this.settingsChain = next.catch(() => undefined)
    return next
  }

  /* ------------------------------------------------------------------ *
   * Durable backfill report (the `meta` table's `backfill` key)
   * ------------------------------------------------------------------ */

  /**
   * Read the last durable backfill report, if a pass has completed on this
   * install. This is the record that lets `hello.capture.lastBackfill` survive a
   * restart (contract §12.5): counts only, no session ids or content.
   * @returns the persisted report, or undefined before the first persisted pass.
   */
  backfillReport(): BackfillReportRecord | undefined {
    const stored = this.domain.table('meta').get(BACKFILL_META_KEY)
    if (stored !== undefined && isBackfillReportRecord(stored)) return stored
    return undefined
  }

  /**
   * Persist one completed backfill pass report (serialized with every other
   * store write, so a pass cannot land half-written).
   * @param record - validated pass report.
   */
  async putBackfillReport(record: BackfillReportRecord): Promise<void> {
    const parsed = parseBackfillReportRecord(record)
    await this.serialize(async () => {
      await this.domain.table('meta').put(BACKFILL_META_KEY, parsed)
      this.revisionCounter += 1
    })
  }

  /** Await every queued store mutation and every lazy snooze-wake write. */
  async flush(): Promise<void> {
    await this.pending
    await Promise.all([...this.wakeWrites])
  }

  /** Close the domain (idempotent). */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.flush()
    await this.domain.close()
  }

  /** One record by id. */
  get(id: OpenItemId): OpenItemRecord | undefined {
    return this.items.get(id)
  }

  /**
   * Snapshot of every stored record.
   *
   * Wakes due snoozes first ({@link wakeDue}), so a read is the earliest point a
   * deferred item returns to the inbox: a browser that reads before the periodic
   * sweep still sees it, and every read projection (snapshot, register, counts)
   * is built from the woken records. Idempotent and cheap (one scan).
   * @returns every stored record, woken ones included.
   */
  all(): readonly OpenItemRecord[] {
    this.wakeDue()
    return [...this.items.values()]
  }

  /** Number of live (open/stale/snoozed) items. */
  countLive(): number {
    let count = 0
    for (const record of this.items.values()) if (LIVE_STATES.includes(record.state)) count += 1
    return count
  }

  /**
   * Counts the inbox surfaces use.
   *
   * `needsYou` and `candidates` use the shared OI-05 predicates
   * ({@link isNeedsYouRecord}, {@link isCandidateRecord}), the same ones the
   * read projections use, so `hello.counts` and `snapshot.counts` can never
   * disagree. Tombstones (`deletedAt`) are absent from every count: a confirmed
   * "delete forever" is not a resolved item.
   */
  counts(): {
    needsYou: number
    candidates: number
    awaiting: number
    snoozed: number
    resolved: number
  } {
    // A count read wakes due snoozes first, so `needsYou` and `snoozed` describe
    // the same state the inbox snapshot renders.
    this.wakeDue()
    let needsYou = 0
    let candidates = 0
    let awaiting = 0
    let snoozed = 0
    let resolved = 0
    for (const record of this.items.values()) {
      if (record.deletedAt !== undefined) continue
      if (isNeedsYouRecord(record)) needsYou += 1
      if (isCandidateRecord(record)) candidates += 1
      if (record.state === 'awaiting') awaiting += 1
      if (record.state === 'snoozed') snoozed += 1
      if (record.state === 'resolved') resolved += 1
    }
    return { needsYou, candidates, awaiting, snoozed, resolved }
  }

  /**
   * Find the record for one dedupe key, preferring live records and then the
   * most recently updated one.
   * @param dedupeKey - stable dedupe key.
   * @returns the record, or undefined.
   */
  findByDedupeKey(dedupeKey: string): OpenItemRecord | undefined {
    let best: OpenItemRecord | undefined
    for (const record of this.items.values()) {
      if (record.dedupeKey !== dedupeKey) continue
      if (best === undefined) {
        best = record
        continue
      }
      const live = LIVE_STATES.includes(record.state)
      const bestLive = LIVE_STATES.includes(best.state)
      if (live !== bestLive) {
        if (live) best = record
        continue
      }
      if (record.updatedAt > best.updatedAt) best = record
    }
    return best
  }

  /* ------------------------------------------------------------------ *
   * Authored items (tool raise)
   * ------------------------------------------------------------------ */

  /**
   * Raise an authored item, deduping against live items with the same key.
   * @param input - authored draft.
   * @returns the record and whether it was a dedupe hit.
   * @throws {LimitError} when the live cap is reached and nothing can be archived.
   */
  async create(input: AuthoredItemInput): Promise<CreateRecordResult> {
    const kind = input.kind ?? 'decision'
    const sessionId = input.sessionId ?? 'unknown-session'
    const title = normalizeTitle(input.title)
    if (title === '') throw new InvalidArgumentError('title must be a non-empty string')
    const dedupeKey = authoredDedupeKey({ kind, sessionId, title })
    return this.serialize(async () => {
      const existing = this.findByDedupeKey(dedupeKey)
      if (existing !== undefined && LIVE_STATES.includes(existing.state)) {
        return { item: existing, deduped: true }
      }
      await this.ensureLiveCapacity()
      const now = this.clock()
      const options = boundedOptions(input.options)
      const record: OpenItemRecord = {
        schemaVersion: 3,
        id: uuidv7(now),
        origin: this.installId,
        kind,
        state: 'open',
        tier: input.tier ?? 'structural',
        severity: input.severity ?? 2,
        title,
        body: normalizeBody(input.body ?? ''),
        ...(input.quote === undefined || input.quote.trim() === '' ? {} : { quote: normalizeBody(input.quote) }),
        ...(options === undefined ? {} : { options }),
        source: authoredSource(input, sessionId),
        blocking: input.blocking ?? true,
        reply: defaultReply(kind, options),
        deliveries: [],
        occurrences: [{ sessionId, seenAt: now }],
        dedupeKey,
        detectedBy: input.detectedBy ?? ['tool'],
        firstSeenAt: now,
        lastSeenAt: now,
        updatedAt: now,
        version: 1,
        reopenCount: 0,
        retention: { class: 'active' },
        history: appendHistory([], now, 'raised'),
      }
      await this.putRecord(record)
      return { item: record, deduped: false }
    })
  }

  /* ------------------------------------------------------------------ *
   * Capture sink (projection folds + backfill)
   * ------------------------------------------------------------------ */

  /**
   * Apply a batch of derived drafts: open/re-raise items, merge occurrences and
   * close the ones whose artifacts resolved.
   *
   * Precedence rule: an authored settlement (a human answered/dismissed the
   * item) beats a derived re-raise — the detector never silently reopens a
   * decision the user already made. A detector-closed item does reopen when the
   * artifact reappears, because the artifact itself is the new evidence.
   * @param drafts - fold output.
   * @returns how many records were created or updated.
   */
  async upsertDerived(drafts: readonly DerivedItemDraft[]): Promise<number> {
    return this.serialize(async () => {
      let changes = 0
      for (const draft of drafts) {
        changes += draft.closes === undefined
          ? await this.applyDerived(draft)
          : await this.applyClosure(draft.closes, draft.sessionId)
      }
      return changes
    })
  }

  /**
   * Read one detection cursor (capture branch).
   * @param sessionId - session id.
   * @returns the cursor, or undefined.
   */
  getCursor(sessionId: string): DetectionCursor | undefined {
    return this.domain.table('cursors').get(sessionId)
  }

  /**
   * Count durable detection cursors: roughly how many sessions a backfill pass
   * has already scanned (`hello.capture.cursors`).
   * @returns the number of stored cursors.
   */
  cursorCount(): number {
    return this.domain.table('cursors').size
  }

  /**
   * Write one detection cursor (capture branch).
   * @param cursor - validated cursor.
   */
  async putCursor(cursor: DetectionCursor): Promise<void> {
    const parsed = parseDetectionCursor(cursor)
    await this.domain.table('cursors').put(parsed.sessionId, parsed)
  }

  /**
   * Read one suppressor (capture branch).
   * @param prefix - dedupe prefix.
   * @returns the suppressor, or undefined.
   */
  getSuppressor(prefix: string): SuppressorRecord | undefined {
    return this.domain.table('suppressors').get(prefix)
  }

  /**
   * Write one suppressor ("this is not an item").
   * @param suppressor - validated suppressor.
   */
  async putSuppressor(suppressor: SuppressorRecord): Promise<void> {
    const parsed = parseSuppressorRecord(suppressor)
    await this.domain.table('suppressors').put(parsed.dedupePrefix, parsed)
  }

  /**
   * Delete one suppressor by its exact dedupe prefix.
   *
   * Used when a suppressor's identity follows a corrected item (a promoted
   * candidate whose kind changed is rekeyed, contract §2.1) and by the one-time
   * legacy-prose migration, which replaces the old exact-key row with
   * session-scoped prefixes (contract §2.2).
   * @param prefix - the stored suppressor key (its `dedupePrefix`).
   * @returns whether a row was removed.
   */
  async deleteSuppressor(prefix: string): Promise<boolean> {
    return await this.domain.table('suppressors').delete(prefix)
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  /**
   * Record the user's answer: `open/stale/snoozed → awaiting`.
   * The item is resolved when the session acknowledges it (or the window elapses).
   * @param id - item id.
   * @param expectedVersion - CAS token, or undefined to write unconditionally.
   * @param payload - exactly what the user submitted.
   * @param extra - delivery/evidence coordinates plus the resolution actor
   *   (`'user'` for a browser answer, the default; `'model'` when the model
   *   records an answer the user gave in conversation).
   * @returns the written record.
   */
  async answer(
    id: OpenItemId,
    expectedVersion: number | undefined,
    payload: ReplyPayload,
    extra: {
      readonly deliveryId?: string
      readonly evidence?: Resolution['evidence']
      readonly actor?: 'user' | 'model'
    } = {},
  ): Promise<OpenItemRecord> {
    const now = this.clock()
    return this.mutateOrThrow(id, expectedVersion, 'answer', current => {
      if (current.state === 'resolved') throw new InvalidTransitionError(id, current.state, 'answer')
      if (current.state === 'awaiting') throw new InvalidTransitionError(id, current.state, 'answer')
      if (current.state === 'archived') throw new InvalidTransitionError(id, current.state, 'answer')
      return {
        ...current,
        state: 'awaiting',
        resolution: {
          kind: 'answered',
          at: now,
          actor: extra.actor ?? 'user',
          payload,
          ...(extra.deliveryId === undefined ? {} : { deliveryId: extra.deliveryId }),
          ...(extra.evidence === undefined ? {} : { evidence: extra.evidence }),
        },
        acknowledgement: { state: 'pending' },
        resolvedAt: undefined,
        updatedAt: now,
        version: current.version + 1,
        history: appendHistory(current.history, now, 'answered', replySummary(payload)),
      }
    })
  }

  /**
   * Persist one reply attempt atomically — the reply engine's store port.
   *
   * One write covers the version CAS, the delivery record, the resolution the
   * attempt settled, the acknowledgement placeholder and the next item state, so
   * an attempt either lands whole or not at all. A repeated `deliveryId` returns
   * the recorded item unchanged: a lost response must never become a second send.
   * @param input - attempt to persist (see `delivery-contract.ts`).
   * @returns the written record, or the existing one for a replayed delivery.
   */
  async recordAttempt(input: RecordAttemptInput): Promise<OpenItemRecord> {
    const current = this.get(input.itemId)
    if (current === undefined) throw new NotFoundError(input.itemId)
    if (current.deliveries.some(entry => entry.deliveryId === input.delivery.deliveryId)) return current
    const now = this.clock()
    const failed = input.delivery.state === 'failed'
    // Any attempt that is not a recorded failure takes the item out of the open
    // queue: a queued track-3 message is "waiting on the agent" exactly like a
    // settled answer (DESIGN §6.3 / §7.4.2 — the register's in-flight band).
    return this.mutateOrThrow(input.itemId, input.expectedVersion, 'reply', record => {
      if (record.state !== 'open') throw new InvalidTransitionError(input.itemId, record.state, 'reply')
      return {
        ...record,
        state: failed ? record.state : 'awaiting',
        deliveries: [...record.deliveries, input.delivery],
        ...failed
          ? {}
          : {
              ...(input.resolution === undefined
                ? {}
                : { resolution: { ...input.resolution, deliveryId: input.delivery.deliveryId } }),
              resolvedAt: undefined,
              acknowledgement: input.acknowledgement ?? { state: 'pending' as const },
            },
        updatedAt: now,
        version: record.version + 1,
        history: appendHistory(record.history, now, failed ? 'reply-failed' : 'replied', input.delivery.track),
      }
    })
  }

  /**
   * Dismiss an item: `open/stale/snoozed/awaiting → resolved`.
   * @param id - item id.
   * @param expectedVersion - CAS token, or undefined to write unconditionally.
   * @param reason - why it is no longer needed.
   * @returns the written record.
   */
  async dismiss(id: OpenItemId, expectedVersion: number | undefined, reason?: string): Promise<OpenItemRecord> {
    const now = this.clock()
    const record = await this.mutateOrThrow(id, expectedVersion, 'dismiss', current => {
      if (current.state === 'resolved') throw new InvalidTransitionError(id, current.state, 'dismiss')
      const payload: ReplyPayload = {
        type: 'dismiss',
        ...(reason === undefined || reason.trim() === '' ? {} : { reason: reason.trim().slice(0, 500) }),
      }
      return {
        ...current,
        state: 'resolved',
        resolution: { kind: 'dismissed', at: now, actor: 'user', payload },
        acknowledgement: { state: 'none' },
        resolvedAt: now,
        snoozedUntil: undefined,
        updatedAt: now,
        version: current.version + 1,
        history: appendHistory(current.history, now, 'dismissed', payload.type === 'dismiss' ? payload.reason : undefined),
      }
    })
    await this.maybePrune()
    return record
  }

  /* ------------------------------------------------------------------ *
   * Candidate lifecycle (promote / suppress)
   * ------------------------------------------------------------------ */

  /**
   * Promote one candidate: the user confirmed the inferred item is real.
   *
   * Only a live candidate can be promoted. Promotion keeps the artifact
   * identity and occurrence evidence (so a later fold still dedupes into this
   * record) but takes the structural defaults the inbox renders: not a
   * candidate anymore, blocking, severity 2. The version is bumped so a stale
   * row cannot be promoted twice.
   *
   * The optional patch corrects the inference in the *same* compare-and-set
   * write (contract §2.1): title/body/quote are normalised and bounded, options
   * are bounded, and a `kind` change rekeys the derived dedupe key (kind is part
   * of the key) so the record is corrected in place instead of duplicated. The
   * reply surface is recomputed from the structural defaults of the final
   * kind/options, and an exact-key suppressor on the old key follows the new one.
   * @param id - item id.
   * @param expectedVersion - CAS token from the candidate row the user acted on.
   * @param patch - optional corrections to the inferred item.
   * @returns the written record.
   * @throws {NotFoundError} when no such item exists.
   * @throws {ConflictError} when the CAS token is stale.
   * @throws {InvalidTransitionError} when the item is not a live candidate.
   * @throws {InvalidArgumentError} when the patch carries an unknown kind or an empty title.
   */
  async promote(
    id: OpenItemId,
    expectedVersion: number | undefined,
    patch?: PromotePatch,
  ): Promise<OpenItemRecord> {
    if (patch?.kind !== undefined && !(ITEM_KINDS as readonly string[]).includes(patch.kind)) {
      throw new InvalidArgumentError(`unknown item kind: ${String(patch.kind)}`)
    }
    const now = this.clock()
    // Set when the write actually rekeys the record: the suppressor must follow
    // the new identity, but only for a real kind change.
    let rekey: { readonly from: string; readonly to: string } | undefined
    const record = await this.mutateOrThrow(id, expectedVersion, 'promote', current => {
      if (current.tier !== 'candidate') throw new InvalidTransitionError(id, current.state, 'promote (not a candidate)')
      if (!LIVE_STATES.includes(current.state)) throw new InvalidTransitionError(id, current.state, 'promote')
      const kind = patch?.kind ?? current.kind
      const kindChanged = kind !== current.kind
      const options = patch?.options === undefined ? current.options : boundedOptions(patch.options)
      const title = patch?.title === undefined ? current.title : normalizeTitle(patch.title)
      if (title === '') throw new InvalidArgumentError('title must be a non-empty string')
      const body = patch?.body === undefined ? current.body : normalizeBody(patch.body)
      const quote = patch?.quote === undefined ? current.quote : normalizeBody(patch.quote)
      let dedupeKey = current.dedupeKey
      if (kindChanged) {
        const parts = parseDerivedDedupeKey(current.dedupeKey)
        if (parts !== undefined) {
          dedupeKey = derivedDedupeKey({ kind, sessionId: parts.sessionId, artifactId: parts.artifactId })
          rekey = { from: current.dedupeKey, to: dedupeKey }
        }
      }
      let history = appendHistory(current.history, now, 'promoted')
      if (kindChanged) history = appendHistory(history, now, 'reclassified', `${current.kind} -> ${kind}`)
      return {
        ...current,
        kind,
        title,
        body,
        quote: quote === undefined || quote === '' ? undefined : quote,
        options: options === undefined ? undefined : options,
        tier: 'structural',
        blocking: true,
        severity: 2,
        dedupeKey,
        reply: defaultReply(kind, options),
        updatedAt: now,
        version: current.version + 1,
        history,
      }
    })
    // An exact-key suppressor ("this artifact is not an item") followed the
    // record's old key; it must keep suppressing the corrected identity.
    if (rekey !== undefined && this.getSuppressor(rekey.from) !== undefined) {
      await this.deleteSuppressor(rekey.from)
      await this.putSuppressor({ dedupePrefix: rekey.to, kindFamily: record.kind, createdAt: now })
    }
    return record
  }

  /**
   * Suppress one candidate: dismiss it *and* remember not to infer it again.
   *
   * The record takes the ordinary `dismissed` resolution (actor user) so the
   * register shows a human decision, and a {@link SuppressorRecord} keyed by the
   * item's own dedupe key is written so a later fold of the same artifact cannot
   * re-raise the fingerprint. Only a live candidate can be suppressed.
   * @param id - item id.
   * @param expectedVersion - CAS token from the candidate row the user acted on.
   * @param reason - why the candidate is not an item.
   * @returns the resolved record.
   * @throws {NotFoundError} when no such item exists.
   * @throws {ConflictError} when the CAS token is stale.
   * @throws {InvalidTransitionError} when the item is not a live candidate.
   */
  async suppress(id: OpenItemId, expectedVersion: number | undefined, reason?: string): Promise<OpenItemRecord> {
    const now = this.clock()
    const record = await this.mutateOrThrow(id, expectedVersion, 'suppress', current => {
      if (current.tier !== 'candidate') throw new InvalidTransitionError(id, current.state, 'suppress (not a candidate)')
      if (!LIVE_STATES.includes(current.state)) throw new InvalidTransitionError(id, current.state, 'suppress')
      const payload: ReplyPayload = {
        type: 'dismiss',
        ...(reason === undefined || reason.trim() === ''
          ? { reason: 'candidate suppressed' }
          : { reason: reason.trim().slice(0, MAX_HISTORY_DETAIL_CHARS) }),
      }
      return {
        ...current,
        state: 'resolved',
        resolution: { kind: 'dismissed', at: now, actor: 'user', payload },
        acknowledgement: { state: 'none' },
        resolvedAt: now,
        snoozedUntil: undefined,
        updatedAt: now,
        version: current.version + 1,
        history: appendHistory(current.history, now, 'suppressed', payload.reason),
      }
    })
    // Exact-key suppressor: `isSuppressed` matches by prefix, so the item's own
    // dedupe key suppresses this artifact (and only this artifact).
    await this.putSuppressor({
      dedupePrefix: record.dedupeKey,
      kindFamily: record.kind,
      createdAt: now,
    })
    await this.maybePrune()
    return record
  }

  /**
   * Retire open derived team-task items (decision D5: team-task alerts disabled).
   *
   * The fold no longer emits the family, but rows raised before the change are
   * still open in the inbox. Each open `derived|task|…` record whose history
   * carries the `team/task:in-progress-orphan` detector is closed as
   * `detected-closed` with code `team/task:alerts-disabled`, so the register
   * shows *why* it closed (audit visible) rather than a silent disappearance.
   * Idempotent: a second call finds nothing to close.
   * @returns how many records were closed.
   */
  async retireTeamTaskItems(): Promise<number> {
    return this.serialize(async () => {
      let retired = 0
      for (const record of this.all()) {
        if (!LIVE_STATES.includes(record.state)) continue
        if (!record.dedupeKey.startsWith('derived|task|')) continue
        const orphan = record.history.some(entry => entry.detail === TEAM_TASK_ORPHAN_CODE)
        if (!orphan) continue
        await this.resolve(record.id, undefined, {
          kind: 'detected-closed',
          at: this.clock(),
          actor: 'detector',
          payload: { type: 'detector', code: TEAM_TASK_ALERTS_DISABLED_CODE },
        })
        retired += 1
      }
      return retired
    })
  }

  /**
   * Retire open prose candidates raised before the per-item gate (contract §2.2).
   *
   * The detector now emits one artifact per ask (`prose:t<turn>:<hash>`), so the
   * pre-split rows (`prose:<16 hex>`, one per turn) would linger in the inbox
   * next to the replayed per-item rows — and would never be re-raised, because
   * the new gate cannot reproduce their artifact id. Each live (`open|stale|
   * snoozed`) candidate-tier row raised by `prose-gate:decision-request` whose
   * artifact id still has the legacy bare shape is closed as `detected-closed`
   * with code {@link LEGACY_PROSE_SUPERSEDED_CODE}, so the register explains the
   * disappearance (actor detector, history entry). Promoted (structural) rows and
   * rows with any other detector are never touched.
   *
   * Must run before the capture mount: the version bump replays every session as
   * a baseline, and that replay is what surfaces the new per-item rows.
   * Idempotent: a second activation finds nothing left to retire.
   * @returns how many records were closed.
   */
  async retireLegacyProseCandidates(): Promise<number> {
    return this.serialize(async () => {
      let retired = 0
      const now = this.clock()
      for (const record of this.all()) {
        if (!LIVE_STATES.includes(record.state)) continue
        if (record.tier !== 'candidate') continue
        if (!isProseGateRecord(record)) continue
        const artifactId = derivedArtifactOf(record.dedupeKey)
        if (artifactId === undefined || !LEGACY_PROSE_ARTIFACT_ID.test(artifactId)) continue
        await this.resolve(record.id, undefined, {
          kind: 'detected-closed',
          at: now,
          actor: 'detector',
          payload: { type: 'detector', code: LEGACY_PROSE_SUPERSEDED_CODE },
        })
        retired += 1
      }
      if (retired > 0) this.log?.warn(`open-items: retired ${retired} legacy prose candidate(s)`)
      return retired
    })
  }

  /**
   * Expand legacy prose suppressors to session-scoped per-kind prefixes (§2.2).
   *
   * A pre-split "not an item" suppressed exactly one bare artifact id
   * (`derived|<kind>|<session>|prose:<16 hex>`). The split gate emits per-item
   * ids, so the old exact key would never match again — and could resurface a
   * dismissal. Each legacy row is replaced with two rows, one per kind family,
   * keyed by the session-scoped prose prefix `derived|<kind>|<session>|prose:`,
   * and the legacy key is deleted.
   *
   * Safe direction: a dismissal cannot resurface. The cost is that the whole
   * session's prose candidates of that kind are suppressed too (they share the
   * prefix) — a dismissal of a heuristic candidate is allowed to over-suppress;
   * the user can still raise the item through the tool.
   * @returns how many legacy suppressors were replaced.
   */
  async migrateLegacyProseSuppressors(): Promise<number> {
    return this.serialize(async () => {
      const legacy: { readonly key: string; readonly sessionId: string; readonly suppressor: SuppressorRecord }[] = []
      for (const [key, suppressor] of this.domain.table('suppressors').entries()) {
        const match = LEGACY_PROSE_SUPPRESSOR_PREFIX.exec(key)
        if (match === null) continue
        const sessionId = match[1]
        if (sessionId === undefined) continue
        legacy.push({ key, sessionId, suppressor })
      }
      for (const entry of legacy) {
        for (const kind of ['question', 'decision'] as const) {
          await this.putSuppressor({
            dedupePrefix: `derived|${kind}|${entry.sessionId}|prose:`,
            kindFamily: kind,
            createdAt: entry.suppressor.createdAt,
            ...(entry.suppressor.expiresAt === undefined ? {} : { expiresAt: entry.suppressor.expiresAt }),
          })
        }
        await this.deleteSuppressor(entry.key)
      }
      if (legacy.length > 0) {
        this.log?.warn(`open-items: migrated ${legacy.length} legacy prose suppressor(s) to session-scoped prefixes`)
      }
      return legacy.length
    })
  }

  /**
   * Close candidates that duplicate a promoted prose item (contract §2.2).
   *
   * A version bump replays every session as a baseline, and a corrected item can
   * change identity (kind is part of the derived key), so the replay can offer a
   * second copy of a decision the user already confirmed. A candidate is only a
   * duplicate when it came from the **same turn anyway AND its ask identity**
   * (normalised title, quote as secondary evidence) matches the promoted row:
   * a partially confirmed multi-item turn (the reason the gate now emits one
   * candidate per ask) must keep its unconfirmed siblings A–D live when only E
   * was confirmed. Matching by `(sessionId, turn)` alone would auto-close them,
   * which is exactly the one-artifact behavior the split removes; the identity
   * match is what narrows this to the replay duplicate the migration must not
   * re-offer.
   *
   * Called after every completed backfill pass; idempotent, and cheap on an
   * inbox with no promoted prose rows.
   * @returns how many candidates were closed.
   */
  async reconcileProseCandidates(): Promise<number> {
    return this.serialize(async () => {
      // Promoted turn → the ask identities confirmed in it. A set per turn keeps
      // the multi-item case intact: several promote actions simply add keys.
      const promotedAsks = new Map<string, Set<string>>()
      for (const record of this.all()) {
        if (record.tier !== 'structural') continue
        if (record.deletedAt !== undefined) continue
        if (!isProseGateRecord(record)) continue
        if (record.source.turn === undefined) continue
        const keys = proseAskKeysOf(record)
        if (keys.length === 0) continue
        const group = turnKey(record.source.sessionId, record.source.turn)
        const confirmed = promotedAsks.get(group)
        if (confirmed === undefined) promotedAsks.set(group, new Set(keys))
        else for (const key of keys) confirmed.add(key)
      }
      if (promotedAsks.size === 0) return 0
      const now = this.clock()
      let closed = 0
      for (const record of this.all()) {
        if (record.tier !== 'candidate') continue
        if (!LIVE_STATES.includes(record.state)) continue
        if (!isProseGateRecord(record)) continue
        if (record.source.turn === undefined) continue
        const confirmed = promotedAsks.get(turnKey(record.source.sessionId, record.source.turn))
        if (confirmed === undefined) continue
        const keys = proseAskKeysOf(record)
        if (!keys.some(key => confirmed.has(key))) continue
        await this.resolve(record.id, undefined, {
          kind: 'detected-closed',
          at: now,
          actor: 'detector',
          payload: { type: 'detector', code: PROSE_DUPLICATE_OF_PROMOTED_CODE },
        })
        closed += 1
      }
      if (closed > 0) this.log?.warn(`open-items: closed ${closed} prose candidate(s) duplicating a promoted item`)
      return closed
    })
  }

  /**
   * Resolve an item directly (detector closure or an evidenced settle).
   *
   * A detector closure records the evidence kind the closing event really
   * proves ({@link detectorEvidenceKind}) instead of one hardcoded value; the
   * register renders "what happened next" from it (DESIGN §7.4.2).
   * @param id - item id.
   * @param expectedVersion - CAS token, or undefined to write unconditionally.
   * @param resolution - the recorded resolution.
   * @returns the written record.
   */
  async resolve(id: OpenItemId, expectedVersion: number | undefined, resolution: Resolution): Promise<OpenItemRecord> {
    const record = await this.mutateOrThrow(id, expectedVersion, 'resolve', current => {
      if (current.state === 'resolved') throw new InvalidTransitionError(id, current.state, 'resolve')
      const acknowledgement: Acknowledgement = resolution.actor === 'detector'
        ? {
            state: 'observed',
            at: resolution.at,
            evidence: { kind: detectorEvidenceKind(resolutionCode(resolution)) },
          }
        : { state: 'none' }
      return {
        ...current,
        state: 'resolved',
        resolution,
        acknowledgement,
        resolvedAt: resolution.at,
        updatedAt: Math.max(resolution.at, current.updatedAt),
        version: current.version + 1,
        history: appendHistory(current.history, resolution.at, 'resolved', resolution.kind),
      }
    })
    await this.maybePrune()
    return record
  }

  /**
   * Record that the session acted on a pending answer: `awaiting → resolved`.
   * @param id - item id.
   * @param evidence - what proved it (the log coordinate).
   * @returns the written record, or undefined when the item is not awaiting.
   */
  async acknowledge(id: OpenItemId, evidence: { readonly seq?: number; readonly kind: AcknowledgementEvidence }): Promise<OpenItemRecord | undefined> {
    const current = this.items.get(id)
    if (current === undefined) throw new NotFoundError(id)
    if (current.state !== 'awaiting') return undefined
    const now = this.clock()
    const record = await this.mutateOrThrow(id, undefined, 'acknowledge', record => {
      if (record.state !== 'awaiting') throw new InvalidTransitionError(id, record.state, 'acknowledge')
      // A resolved record requires a resolution. Tracks 1-2 already recorded the
      // user's answer; a track-3 message deliberately has none until the session
      // acts, so the answer it carried becomes the resolution now — that is what
      // makes "answered → acknowledged" a truthful register row.
      const latest = [...record.deliveries].reverse().find(delivery => delivery.state !== 'failed')
      const resolution = record.resolution ?? {
        kind: 'answered' as const,
        at: now,
        actor: 'user' as const,
        payload: latest?.payload ?? { type: 'text' as const, text: 'Answered from the inbox' },
        ...latest === undefined ? {} : { deliveryId: latest.deliveryId },
      }
      return {
        ...record,
        state: 'resolved',
        resolution,
        acknowledgement: { state: 'observed', at: now, evidence },
        resolvedAt: now,
        updatedAt: now,
        version: record.version + 1,
        history: appendHistory(record.history, now, 'acknowledged', evidence.kind),
      }
    })
    await this.maybePrune()
    return record
  }

  /**
   * Reopen a settled item (`resolved/awaiting/archived → open`).
   * The previous resolution moves to `resolutionLog`; nothing is rewritten.
   * @param id - item id.
   * @param expectedVersion - CAS token, or undefined to write unconditionally.
   * @returns the written record.
   */
  async reopen(id: OpenItemId, expectedVersion?: number): Promise<OpenItemRecord> {
    const now = this.clock()
    return this.mutateOrThrow(id, expectedVersion, 'reopen', current => {
      if (current.state === 'open' || current.state === 'stale' || current.state === 'snoozed') {
        throw new InvalidTransitionError(id, current.state, 'reopen')
      }
      if (current.resolution?.payload.type === 'approval' && current.acknowledgement?.state === 'observed') {
        throw new InvalidTransitionError(id, current.state, 'reopen after an executed approval')
      }
      const resolutionLog = current.resolution === undefined
        ? current.resolutionLog
        : [...(current.resolutionLog ?? []), current.resolution].slice(-MAX_RESOLUTION_LOG)
      return {
        ...current,
        state: 'open',
        ...(resolutionLog === undefined ? {} : { resolutionLog }),
        resolution: undefined,
        acknowledgement: undefined,
        resolvedAt: undefined,
        snoozedUntil: undefined,
        reopenCount: current.reopenCount + 1,
        updatedAt: now,
        version: current.version + 1,
        history: appendHistory(current.history, now, 'reopened', `was ${current.state}`),
      }
    })
  }

  /**
   * Snooze a live item until a timestamp.
   * @param id - item id.
   * @param expectedVersion - CAS token, or undefined.
   * @param until - millisecond timestamp.
   * @returns the written record.
   */
  async snooze(id: OpenItemId, expectedVersion: number | undefined, until: number): Promise<OpenItemRecord> {
    const now = this.clock()
    return this.mutateOrThrow(id, expectedVersion, 'snooze', current => {
      if (!LIVE_STATES.includes(current.state)) throw new InvalidTransitionError(id, current.state, 'snooze')
      return {
        ...current,
        state: 'snoozed',
        snoozedUntil: until,
        updatedAt: now,
        version: current.version + 1,
        history: appendHistory(current.history, now, 'snoozed', new Date(until).toISOString()),
      }
    })
  }

  /**
   * Wake every snoozed item whose `snoozedUntil` has come due.
   *
   * A snooze is a deferral with an end, not a settlement: when the instant
   * passes, the item returns to `open` so it appears in "Needs you" again and
   * its counts move from `snoozed` to `needsYou` in the same read (review
   * finding P0-1/D-1 — before this, a deferred item was a one-way trip).
   *
   * The in-memory transition is synchronous because it is called from the read
   * projections (via {@link all}), and the read that discovers the due item must
   * already show it woken. Each durable write is queued immediately afterwards
   * on the domain's own write chain, so a later CAS write from a client that
   * read the woken version is ordered after it (the version it sees is the
   * version it will find). Idempotent: a record already woken (or no longer due)
   * is left untouched by the queued write, and a repeated call scans and wakes
   * nothing.
   *
   * The wake records a `woken` history entry (the v3 history action vocabulary
   * is an open string, so this needs no schema change), clears `snoozedUntil`
   * and bumps `version`. It does not touch `reopenCount`: a scheduled deferral
   * ending is not the user reopening a settled item.
   * @param now - wake instant (defaults to the store clock).
   * @returns how many records were woken.
   */
  wakeDue(now: number = this.clock()): number {
    const due: OpenItemRecord[] = []
    for (const record of this.items.values()) {
      if (record.state !== 'snoozed') continue
      const until = record.snoozedUntil
      if (until === undefined || until > now) continue
      due.push(record)
    }
    if (due.length === 0) return 0
    for (const record of due) this.items.set(record.id, wokenRecord(record, now))
    this.revisionCounter += 1
    for (const record of due) {
      const write = this.persistWake(record, now)
      this.wakeWrites.add(write)
      void write.then(
        () => this.wakeWrites.delete(write),
        () => this.wakeWrites.delete(write),
      )
    }
    return due.length
  }

  /**
   * Persist one woken record behind the domain's write chain.
   *
   * The transform re-checks the durable record instead of trusting the
   * in-memory snapshot: if the item was answered, dismissed or re-snoozed in the
   * meantime it is no longer a due snooze and the write is a no-op (the write
   * that changed it already refreshed the in-memory index). A failed write
   * resyncs the index from durable truth and leaves the record snoozed, so the
   * next read (or the periodic sweep) retries — the read path never throws
   * because a wake could not be persisted.
   * @param previous - the snoozed record the read observed.
   * @param now - wake instant.
   */
  private async persistWake(previous: OpenItemRecord, now: number): Promise<void> {
    try {
      await this.mutateOrThrow(previous.id, undefined, 'wake', current => {
        if (current.state !== 'snoozed') throw new NoChangeError()
        const until = current.snoozedUntil
        if (until === undefined || until > now) throw new NoChangeError()
        return wokenRecord(current, now)
      })
    } catch (error) {
      if (error instanceof NoChangeError) return
      if (error instanceof NotFoundError) {
        this.items.delete(previous.id)
        return
      }
      this.log?.warn(`open-items: wake of ${previous.id} failed: ${error instanceof Error ? error.message : String(error)}`)
      this.resyncRecord(previous.id)
    }
  }

  /** Reload one in-memory record from the durable table (best-effort). */
  private resyncRecord(id: OpenItemId): void {
    try {
      const durable = this.domain.table('items').get(id)
      if (durable === undefined) this.items.delete(id)
      else this.items.set(id, durable)
    } catch {
      // A closed or failed domain cannot be resynced: the current index is the
      // best read available until the next open.
    }
  }

  /**
   * Permanently delete one record: the explicit, confirmed "delete forever"
   * (DESIGN §7.4.3, README "only an explicit user action deletes").
   *
   * The record is kept as a **tombstone** rather than physically removed, so a
   * later fold cannot resurrect the artifact and the audit trail keeps a
   * truthful "this was deleted" row:
   * - `deletedAt` set, `state: resolved`, `retention: archived`, `version` bumped;
   * - transcript-derived text dropped (`body`, `quote`, `options`, deliveries,
   *   resolution log, session/workspace snapshots and the old title);
   * - identity kept (`id`, `origin`, `kind`, `tier`, `severity`, `dedupeKey`,
   *   `detectedBy`, `firstSeenAt`, `lastSeenAt`), which is what dedupe and the
   *   acknowledgement window need;
   * - absent from `list`, the register and every export (`view.ts` and
   *   `export.ts` both filter `deletedAt`), and from `counts()`.
   *
   * Idempotent: repeating the request with the same CAS token returns the
   * tombstone unchanged (a lost response is not a second delete); a stale token
   * is a {@link ConflictError} and a missing id a {@link NotFoundError}.
   * @param id - item id.
   * @param expectedVersion - CAS token from the row the user acted on.
   * @returns the tombstone record.
   */
  async deleteForever(id: OpenItemId, expectedVersion: number): Promise<OpenItemRecord> {
    const current = this.get(id)
    if (current === undefined) throw new NotFoundError(id)
    if (current.deletedAt !== undefined) {
      if (expectedVersion !== current.version) throw new ConflictError(id, expectedVersion, current.version)
      return current
    }
    const now = this.clock()
    return this.mutateOrThrow(id, expectedVersion, 'delete', record => {
      // A concurrent delete won the CAS: keep the existing tombstone version.
      if (record.deletedAt !== undefined) return record
      return {
        ...record,
        state: 'resolved',
        title: TOMBSTONE_TITLE,
        body: '',
        quote: undefined,
        options: undefined,
        source: { sessionId: record.source.sessionId },
        reply: defaultReply(record.kind),
        deliveries: [],
        occurrences: [],
        resolution: {
          kind: 'dismissed',
          at: now,
          actor: 'user',
          payload: { type: 'dismiss', reason: 'deleted forever' },
        },
        resolutionLog: undefined,
        acknowledgement: { state: 'none' },
        resolvedAt: now,
        snoozedUntil: undefined,
        retention: { class: 'archived', archivedAt: now },
        history: appendHistory([], now, 'deleted-forever'),
        deletedAt: now,
        updatedAt: now,
        version: record.version + 1,
      }
    })
  }

  /**
   * Append one reply attempt (append-only; the row renders the last one).
   * @param id - item id.
   * @param expectedVersion - CAS token, or undefined.
   * @param delivery - the attempt.
   * @returns the written record.
   */
  async recordDelivery(id: OpenItemId, expectedVersion: number | undefined, delivery: DeliveryRecord): Promise<OpenItemRecord> {
    const now = this.clock()
    return this.mutateOrThrow(id, expectedVersion, 'record a delivery', current => {
      const deliveries = [...current.deliveries, delivery].slice(-MAX_DELIVERIES)
      const becomesAwaiting = delivery.state === 'delivered' && current.state !== 'resolved'
      return {
        ...current,
        deliveries,
        ...(becomesAwaiting
          ? {
            state: 'awaiting' as const,
            acknowledgement: current.acknowledgement ?? { state: 'pending' as const },
          }
          : {}),
        updatedAt: now,
        version: current.version + 1,
        history: appendHistory(current.history, now, 'delivery', delivery.state),
      }
    })
  }

  /* ------------------------------------------------------------------ *
   * Retention
   * ------------------------------------------------------------------ */

  /**
   * Run one retention sweep: wake due snoozes, then the acknowledgement window,
   * active→archive and caps.
   *
   * The wake belongs here as well as on the read path because the periodic sweep
   * is the only writer that runs without a browser (the plugin's timer): a due
   * snooze must return to the inbox even when nobody reads.
   * @param now - sweep timestamp (defaults to the store clock).
   * @returns what the sweep did.
   */
  async sweep(now: number = this.clock()): Promise<SweepReport> {
    return this.serialize(async () => {
      this.wakeDue(now)
      const policy: RetentionPolicy = {
        now,
        activeResolveDays: this.limits.activeResolveDays,
        acknowledgementWindowHours: this.limits.acknowledgementWindowHours,
        maxResolvedRecords: this.limits.maxResolvedRecords,
      }
      const plan = planRetention(this.all(), policy)
      let unacknowledged = 0
      let archived = 0
      let liveArchived = 0

      for (const record of plan.unacknowledged) {
        const changed = await this.applyRetention(record.id, current => {
          if (current.state !== 'awaiting') return undefined
          // A resolved record requires a resolution. A track-3 message has none
          // until the session acts, so when the window elapses with no evidence
          // the answer it carried becomes the resolution here too (same synthesis
          // as `acknowledge`); otherwise the honest `none` fallback could not be
          // written at all.
          const latest = [...current.deliveries].reverse().find(delivery => delivery.state !== 'failed')
          const resolution = current.resolution ?? {
            kind: 'answered' as const,
            at: now,
            actor: 'user' as const,
            payload: latest?.payload ?? { type: 'text' as const, text: 'Answered from the inbox' },
            ...latest === undefined ? {} : { deliveryId: latest.deliveryId },
          }
          return {
            ...current,
            state: 'resolved',
            resolution,
            acknowledgement: { state: 'none', at: now },
            resolvedAt: now,
            updatedAt: now,
            version: current.version + 1,
            history: appendHistory(current.history, now, 'acknowledgement-none'),
          }
        })
        if (changed) unacknowledged += 1
      }
      for (const record of plan.archive) {
        const changed = await this.applyRetention(record.id, current => {
          if (current.state !== 'resolved' || current.retention.class === 'archived') return undefined
          return {
            ...current,
            body: '',
            quote: undefined,
            retention: { class: 'archived', archivedAt: now },
            updatedAt: now,
            version: current.version + 1,
            history: appendHistory(current.history, now, 'archived'),
          }
        })
        if (changed) archived += 1
      }
      for (const record of plan.archiveLive) {
        const changed = await this.applyRetention(record.id, current => {
          if (!LIVE_STATES.includes(current.state)) return undefined
          return {
            ...current,
            state: 'archived',
            updatedAt: now,
            version: current.version + 1,
            history: appendHistory(current.history, now, 'archived', 'live cap'),
          }
        })
        if (changed) liveArchived += 1
      }
      const pruned = await this.pruneRecords(plan.prune)
      if (archived > 0 || pruned > 0 || unacknowledged > 0) this.revisionCounter += 1
      return { unacknowledged, archived, liveArchived, pruned }
    })
  }

  /* ------------------------------------------------------------------ *
   * Migration
   * ------------------------------------------------------------------ */

  /**
   * Import records put-if-absent (the migration's write path).
   * @param records - v3 records with stable ids.
   * @returns how many were newly stored.
   */
  async importRecords(records: readonly OpenItemRecord[]): Promise<number> {
    return this.serialize(async () => {
      let imported = 0
      for (const record of records) {
        const parsed = parseItemRecord(record)
        if (this.items.has(parsed.id)) continue
        await this.domain.table('items').put(parsed.id, parsed)
        this.items.set(parsed.id, parsed)
        this.revisionCounter += 1
        imported += 1
      }
      return imported
    })
  }

  /* ------------------------------------------------------------------ *
   * Internals
   * ------------------------------------------------------------------ */

  /** Rebuild the identity index from the domain's authoritative state. */
  private rebuildIndex(): void {
    this.items.clear()
    for (const [id, record] of this.domain.table('items').entries()) this.items.set(id, record)
  }

  /** Import the P0 document once, logging the outcome (never fatal for a corrupt file). */
  private async migrateLegacy(legacyPath: string): Promise<void> {
    const report = await migrateLegacyStore({
      legacyPath,
      installId: this.installId,
      now: this.clock,
      importRecords: records => this.importRecords(records),
    })
    this.migrationReport = report
    if (!report.found) return
    if (report.quarantinedPath !== undefined) {
      this.log?.warn(`open-items: legacy store was unreadable and quarantined at ${report.quarantinedPath}`)
      return
    }
    this.log?.info?.(`open-items: migrated ${report.imported} legacy item(s) from ${legacyPath}`)
  }

  /** Apply one derived draft; see {@link upsertDerived} for the precedence rule. */
  private async applyDerived(draft: DerivedItemDraft): Promise<number> {
    const dedupeKey = derivedDedupeKey({
      kind: draft.kind,
      sessionId: draft.sessionId,
      artifactId: draft.artifactId,
    })
    if (draft.tier === 'candidate' && this.isSuppressed(dedupeKey, draft.kind)) return 0
    const existing = this.findByDedupeKey(dedupeKey)
    const now = this.clock()
    const options = boundedOptions(draft.reply?.options)

    if (existing !== undefined) {
      // A tombstone is a final user decision: a later fold of the same artifact
      // must never resurrect it (the explicit "delete forever" wins over the
      // detector re-raise, exactly like an authored settlement below).
      if (existing.deletedAt !== undefined) return 0
      const authoredSettlement = existing.state === 'resolved'
        && existing.resolution !== undefined
        && existing.resolution.actor === 'user'
      const merged = mergeOccurrence(existing.occurrences, {
        sessionId: draft.sessionId,
        ...(draft.seq === undefined ? {} : { seq: draft.seq }),
        seenAt: now,
      })
      if (authoredSettlement) {
        await this.mutateOrThrow(existing.id, undefined, 're-raise', current => ({
          ...current,
          occurrences: merged,
          lastSeenAt: Math.max(current.lastSeenAt, now),
          updatedAt: now,
          version: current.version + 1,
          history: appendHistory(current.history, now, 're-raise-suppressed', draft.detectorCode),
        }))
        return 1
      }
      // A promoted row is user-confirmed truth and a candidate draft is only a
      // detector inference: a re-raise must not demote it or overwrite the
      // user's corrections (kind/title/body/quote/reply/severity/blocking). This
      // is the baseline replay after a detection-version bump re-emitting a
      // prose artifact the user already confirmed — same no-op as an authored
      // settlement, with the evidence still merged into the audit trail.
      if (existing.tier === 'structural' && draft.tier === 'candidate') {
        await this.mutateOrThrow(existing.id, undefined, 're-raise', current => ({
          ...current,
          occurrences: merged,
          lastSeenAt: Math.max(current.lastSeenAt, now),
          updatedAt: now,
          version: current.version + 1,
          history: appendHistory(current.history, now, 're-raise-suppressed', draft.detectorCode),
        }))
        return 1
      }
      if (existing.state === 'resolved') {
        await this.mutateOrThrow(existing.id, undefined, 'reopen', current => ({
          ...current,
          state: 'open',
          resolutionLog: current.resolution === undefined
            ? current.resolutionLog
            : [...(current.resolutionLog ?? []), current.resolution].slice(-MAX_RESOLUTION_LOG),
          resolution: undefined,
          acknowledgement: undefined,
          resolvedAt: undefined,
          reopenCount: current.reopenCount + 1,
          occurrences: merged,
          lastSeenAt: Math.max(current.lastSeenAt, now),
          updatedAt: now,
          version: current.version + 1,
          history: appendHistory(current.history, now, 'reopened', draft.detectorCode),
        }))
        return 1
      }
      await this.mutateOrThrow(existing.id, undefined, 're-raise', current => ({
        ...current,
        title: normalizeTitle(draft.title),
        body: normalizeBody(draft.body),
        ...(draft.quote === undefined ? {} : { quote: normalizeBody(draft.quote) }),
        ...(options === undefined ? {} : { options }),
        reply: { ...defaultReply(draft.kind, options), ...draft.reply },
        severity: draft.severity,
        blocking: draft.blocking,
        source: { ...current.source, ...derivedSource(draft) },
        detectedBy: unionDetectors(current.detectedBy, draft.detectedBy),
        occurrences: merged,
        lastSeenAt: Math.max(current.lastSeenAt, now),
        updatedAt: now,
        version: current.version + 1,
        history: appendHistory(current.history, now, 're-raised', draft.detectorCode),
      }))
      return 1
    }

    await this.ensureLiveCapacity()
    const record: OpenItemRecord = {
      schemaVersion: 3,
      id: uuidv7(now),
      origin: this.installId,
      kind: draft.kind,
      state: 'open',
      tier: draft.tier,
      severity: draft.severity,
      title: normalizeTitle(draft.title),
      body: normalizeBody(draft.body),
      ...(draft.quote === undefined || draft.quote.trim() === '' ? {} : { quote: normalizeBody(draft.quote) }),
      ...(options === undefined ? {} : { options }),
      source: { sessionId: draft.sessionId, ...derivedSource(draft) },
      blocking: draft.blocking,
      reply: { ...defaultReply(draft.kind, options), ...draft.reply },
      deliveries: [],
      occurrences: [{
        sessionId: draft.sessionId,
        ...(draft.seq === undefined ? {} : { seq: draft.seq }),
        seenAt: now,
      }],
      dedupeKey,
      detectedBy: [...draft.detectedBy],
      firstSeenAt: now,
      lastSeenAt: now,
      updatedAt: now,
      version: 1,
      reopenCount: 0,
      retention: { class: 'active' },
      history: appendHistory([], now, 'raised', draft.detectorCode),
    }
    await this.putRecord(record)
    return 1
  }

  /** Apply one closure draft: resolve the live item for its artifact. */
  private async applyClosure(
    closes: NonNullable<DerivedItemDraft['closes']>,
    sessionId: string,
  ): Promise<number> {
    const suffix = `|${sessionId}|${closes.artifactId}`
    const target = this.all().find(record =>
      record.dedupeKey.startsWith('derived|')
      && record.dedupeKey.endsWith(suffix)
      && LIVE_STATES.includes(record.state))
    if (target === undefined) return 0
    await this.resolve(target.id, undefined, {
      kind: 'detected-closed',
      at: closes.at,
      actor: 'detector',
      payload: { type: 'detector', code: closes.code },
    })
    return 1
  }

  /** Whether a candidate dedupe key is suppressed by the user. */
  private isSuppressed(dedupeKey: string, kind: OpenItemKind): boolean {
    const now = this.clock()
    for (const [, record] of this.domain.table('suppressors').entries()) {
      if (record.kindFamily !== kind) continue
      if (record.expiresAt !== undefined && record.expiresAt <= now) continue
      if (dedupeKey.startsWith(record.dedupePrefix)) return true
    }
    return false
  }

  /** Archive enough live items to leave room for one new open item. */
  private async ensureLiveCapacity(): Promise<void> {
    if (this.countLive() < this.limits.maxLiveItems) return
    const plan = planRetention(this.all(), {
      now: this.clock(),
      activeResolveDays: this.limits.activeResolveDays,
      acknowledgementWindowHours: this.limits.acknowledgementWindowHours,
      maxResolvedRecords: this.limits.maxResolvedRecords,
      maxLiveItems: this.limits.maxLiveItems - 1,
    })
    for (const record of plan.archiveLive) {
      await this.applyRetention(record.id, current => {
        if (!LIVE_STATES.includes(current.state)) return undefined
        return {
          ...current,
          state: 'archived',
          updatedAt: this.clock(),
          version: current.version + 1,
          history: appendHistory(current.history, this.clock(), 'archived', 'live cap'),
        }
      })
    }
    if (this.countLive() >= this.limits.maxLiveItems) throw new LimitError(this.limits.maxLiveItems)
  }

  /** Delete archived resolved records (cap prune, only ever called on append or sweep). */
  private async pruneRecords(ids: readonly OpenItemId[]): Promise<number> {
    if (ids.length === 0) return 0
    const table = this.domain.table('items')
    for (const id of ids) {
      const removed = await table.delete(id)
      if (removed) {
        this.items.delete(id)
        this.pruned = true
      }
    }
    if (ids.length > 0) this.revisionCounter += 1
    return ids.length
  }

  /** Prune after a resolution is appended (never on a timer). */
  private async maybePrune(): Promise<void> {
    const resolvedCount = this.counts().resolved
    if (resolvedCount <= this.limits.maxResolvedRecords) return
    const excess = resolvedCount - this.limits.maxResolvedRecords
    // Tombstones are not resolutions: never prune one (that would let a later
    // fold re-raise the artifact the user permanently deleted).
    const candidates = this.all()
      .filter(record => record.state === 'resolved'
        && record.retention.class === 'archived'
        && record.deletedAt === undefined)
      .sort((left, right) => (left.resolvedAt ?? 0) - (right.resolvedAt ?? 0))
      .slice(0, excess)
      .map(record => record.id)
    await this.pruneRecords(candidates)
  }

  /** Apply one retention transform, skipping when the transform decides nothing changed. */
  private async applyRetention(
    id: OpenItemId,
    transform: (current: OpenItemRecord) => OpenItemRecord | undefined,
  ): Promise<boolean> {
    if (!this.items.has(id)) return false
    let changed = false
    try {
      await this.mutateOrThrow(id, undefined, 'retention', record => {
        const next = transform(record)
        if (next === undefined) throw new NoChangeError()
        changed = true
        return next
      })
    } catch (error) {
      if (!(error instanceof NoChangeError)) throw error
    }
    if (changed) this.revisionCounter += 1
    return changed
  }

  /** Write one new record and index it. */
  private async putRecord(record: OpenItemRecord): Promise<void> {
    const parsed = parseItemRecord(record)
    await this.domain.table('items').put(parsed.id, parsed)
    this.items.set(parsed.id, parsed)
    this.revisionCounter += 1
  }

  /** CAS mutation: read current, enforce expectedVersion, apply, validate, store. */
  private async mutateOrThrow(
    id: OpenItemId,
    expectedVersion: number | undefined,
    action: string,
    transform: (current: OpenItemRecord) => OpenItemRecord,
  ): Promise<OpenItemRecord> {
    if (!this.items.has(id)) throw new NotFoundError(id)
    const table = this.domain.table('items')
    const next = await table.update(id, current => {
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw new ConflictError(id, expectedVersion, current.version)
      }
      const candidate = transform(current)
      return parseItemRecord(candidate)
    })
    this.items.set(next.id, next)
    this.revisionCounter += 1
    return next
  }

  /** Serialise a read-modify-index sequence behind every earlier one. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work)
    this.chain = next.then(
      () => undefined,
      () => undefined,
    )
    this.pending = this.chain
    return next
  }
}

/** Internal signal: a retention transform decided the record needs no write. */
class NoChangeError extends Error {}

/** Internal signal: a concurrent settings write won the CAS inside `KvTable.update`. */
class StaleSettingsError extends Error {}

/**
 * Build the source ref of an authored item.
 * @param input - authored draft.
 * @param sessionId - resolved session id.
 * @returns the source ref.
 */
function authoredSource(input: AuthoredItemInput, sessionId: string): ItemSourceRef {
  return {
    sessionId,
    ...(input.sessionTitle === undefined ? {} : { sessionTitle: normalizeTitle(input.sessionTitle) }),
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.seq === undefined ? {} : { seq: input.seq }),
    ...(input.turn === undefined ? {} : { turn: input.turn }),
    ...(input.callId === undefined ? {} : { callId: input.callId }),
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    ...(input.raisedBy === undefined
      ? {}
      : {
        raisedBy: {
          sessionId: input.raisedBy.sessionId,
          ...(input.raisedBy.title === undefined || input.raisedBy.title.trim() === ''
            ? {}
            : { title: normalizeTitle(input.raisedBy.title) }),
        },
      }),
  }
}

/**
 * Build the source patch of a derived draft (session id is added by the caller).
 * @param draft - derived draft.
 * @returns the source fields the artifact carries.
 */
function derivedSource(draft: DerivedItemDraft): Partial<ItemSourceRef> {
  return {
    ...(draft.sessionTitle === undefined ? {} : { sessionTitle: normalizeTitle(draft.sessionTitle) }),
    ...(draft.workspace === undefined ? {} : { workspace: draft.workspace }),
    ...(draft.cwd === undefined ? {} : { cwd: draft.cwd }),
    ...(draft.seq === undefined ? {} : { seq: draft.seq }),
    ...(draft.turn === undefined ? {} : { turn: draft.turn }),
    ...(draft.callId === undefined ? {} : { callId: draft.callId }),
    ...(draft.approvalId === undefined ? {} : { approvalId: draft.approvalId }),
    ...(draft.goalId === undefined ? {} : { goalId: draft.goalId }),
    ...(draft.goalRevision === undefined ? {} : { goalRevision: draft.goalRevision }),
    ...(draft.taskId === undefined ? {} : { taskId: draft.taskId }),
    ...(draft.jobId === undefined ? {} : { jobId: draft.jobId }),
  }
}

/** Union of detection sources, first-use order, no duplicates. */
function unionDetectors(left: readonly DetectionSource[], right: readonly DetectionSource[]): readonly DetectionSource[] {
  const result = [...left]
  for (const source of right) if (!result.includes(source)) result.push(source)
  return result
}

/**
 * Merge one occurrence into an item's occurrence list (newest last, deduped by
 * session+seq, capped).
 * @param occurrences - existing occurrences.
 * @param next - sighting to add.
 * @returns the merged, capped list.
 */
function mergeOccurrence(
  occurrences: readonly { readonly sessionId: string; readonly seq?: number; readonly seenAt: number }[],
  next: { readonly sessionId: string; readonly seq?: number; readonly seenAt: number },
): readonly { readonly sessionId: string; readonly seq?: number; readonly seenAt: number }[] {
  const duplicate = occurrences.findIndex(entry =>
    entry.sessionId === next.sessionId
    && (next.seq === undefined ? entry.seq === undefined : entry.seq === next.seq))
  if (duplicate >= 0) {
    const merged = [...occurrences]
    const existing = merged[duplicate]!
    merged[duplicate] = { ...existing, seenAt: Math.max(existing.seenAt, next.seenAt) }
    return merged.slice(-MAX_OCCURRENCES)
  }
  return [...occurrences, next].slice(-MAX_OCCURRENCES)
}

/** Bound and normalise verbatim reply options. */
function boundedOptions(options: readonly string[] | undefined): readonly string[] | undefined {
  if (options === undefined || options.length === 0) return undefined
  return options.slice(0, 10).map(option => normalizeBody(option, 500)).filter(option => option !== '')
}

/**
 * Whether a record was raised by the prose gate.
 *
 * The gate is the only `regex-gate` producer, and a derived raise records its
 * detector code as the history entry's detail (`raised` / `re-raised`), which is
 * how the store can identify the family without a new record field (the schema
 * is closed: contract §0.6). Used by the legacy migration and the promotion
 * reconciliation.
 * @param record - stored record.
 * @returns true for a prose-gate-raised row.
 */
function isProseGateRecord(record: OpenItemRecord): boolean {
  if (!record.detectedBy.includes('regex-gate')) return false
  return record.history.some(entry =>
    (entry.action === 'raised' || entry.action === 're-raised')
    && entry.detail === PROSE_CANDIDATE_DETECTOR_CODE)
}

/**
 * The artifact id of a derived record's dedupe key.
 * @param dedupeKey - stored `derived|<kind>|<sessionId>|<artifactId>` key.
 * @returns the artifact id, or undefined for a non-derived key.
 */
function derivedArtifactOf(dedupeKey: string): string | undefined {
  return parseDerivedDedupeKey(dedupeKey)?.artifactId
}

/**
 * Grouping key of one `(session, turn)` source pair.
 * @param sessionId - session id.
 * @param turn - turn number.
 * @returns the opaque grouping key.
 */
function turnKey(sessionId: string, turn: number): string {
  return `${sessionId}\u0000${turn}`
}

/**
 * The ask identities one prose record can be matched by.
 *
 * The title is the primary identity; the quote is secondary evidence, so a row
 * promoted by the old gate (whose title was the clipped raw item) still matches
 * the clean per-item title/quote the split gate now stores. Blank candidates
 * fall back to whichever half still has text.
 * @param record - a prose-gate record (candidate or promoted).
 * @returns the non-empty normalised identities, in title-first order.
 */
function proseAskKeysOf(record: OpenItemRecord): readonly string[] {
  const keys = new Set<string>()
  const title = proseAskKey(record.title)
  if (title !== '') keys.add(title)
  if (record.quote !== undefined) {
    const quote = proseAskKey(record.quote)
    if (quote !== '') keys.add(quote)
  }
  return [...keys]
}

/** One-line summary of a reply payload for the audit history. */
function replySummary(payload: ReplyPayload): string {
  switch (payload.type) {
    case 'option': return payload.option
    case 'text': return payload.text
    case 'approval': return payload.outcome
    case 'task-action': return payload.action
    case 'dismiss': return payload.reason ?? 'dismissed'
  }
}

/**
 * Build the record a due snooze returns to the inbox as.
 *
 * `state: 'open'` with `snoozedUntil` cleared is what makes the item appear in
 * "Needs you" and become answerable again; the version bump makes the transition
 * visible to a CAS writer, and the `woken` history entry keeps the audit trail
 * honest ("deferred until X, then woken"). The snooze instant is kept as the
 * entry's detail so the pair reads as one story.
 * @param record - the snoozed record being woken.
 * @param now - wake instant.
 * @returns the woken record (not yet validated/stored).
 */
function wokenRecord(record: OpenItemRecord, now: number): OpenItemRecord {
  const until = record.snoozedUntil
  const at = Math.max(now, record.updatedAt)
  return {
    ...record,
    state: 'open',
    snoozedUntil: undefined,
    updatedAt: at,
    version: record.version + 1,
    history: appendHistory(
      record.history,
      at,
      'woken',
      until === undefined ? undefined : `was snoozed until ${new Date(until).toISOString()}`,
    ),
  }
}
