/**
 * `ctx.openItems`: the Host service that owns the cross-session inbox
 * (PLAN M1 item 5).
 *
 * The Cordis service is the extension point every other host half talks to:
 * the model-facing `open_items` tool, the exact Fetch route, the projection
 * capture engine (which sees this object as its `CaptureSink`) and a future
 * programmatic consumer. Constructing the instance registers `ctx.openItems` on
 * the owning fiber; Cordis removes it when the plugin unloads.
 *
 * The service is a thin, documented surface: durability, dedupe, CAS and
 * retention live in the store; read projections live in `view.ts`.
 */
import { Service, type Context } from '@deepseek-ai/cordis'

import type { CaptureEvidence, CaptureSink, DerivedItemDraft } from './capture-contract'
import type { RecordAttemptInput, ReplyStorePort } from './delivery-contract'
import { OpenItemsStore, type AuthoredItemInput, type CreateRecordResult, type ResolvedStoreLimits, type SweepReport } from './store'
import { buildRegister, buildSnapshot, countSummary, matchingCount, type RegisterProjection, type ViewOptions } from './view'
import {
  PROTOCOL_VERSION,
  type BackfillReportRecord,
  type PromotePatch,
  type SettingsPatch,
  type SettingsRecord,
  type SettingsWriteValue,
} from '../shared/protocol'
import type {
  AcknowledgementEvidence,
  CountSummary,
  DeliveryEvidence,
  DeliveryRecord,
  DetectionCursor,
  InboxQuery,
  InboxSnapshot,
  OpenItemId,
  OpenItemRecord,
  ReplyPayload,
  Resolution,
  SuppressorRecord,
} from '../shared/schema'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The cross-session open-items inbox (present while `dsh-open-items` is mounted). */
    openItems: OpenItemsService
  }
}

/** Extra evidence a reply path can attach to an answer. */
export interface AnswerExtras {
  readonly deliveryId?: string
  readonly evidence?: Resolution['evidence']
  /**
   * Who produced the answer: `'user'` (the default, browser reply path) or
   * `'model'` when the `open_items` tool records an answer the user gave in
   * conversation. The tool passes `'model'` so the register can tell the two
   * apart (audit integrity); the browser route leaves it unset.
   */
  readonly actor?: 'user' | 'model'
}

/** A settings-change listener (wired by `index.ts` to apply the nudge immediately). */
export type SettingsChangeListener = (settings: SettingsRecord) => void

/**
 * Cross-session open-items service.
 *
 * Implements {@link CaptureSink} directly so a capture engine can be handed
 * `ctx.openItems` and needs no knowledge of the store.
 */
export class OpenItemsService extends Service implements CaptureSink, ReplyStorePort {
  /** Listeners notified after a settings write lands (the immediate nudge re-apply). */
  private readonly settingsListeners = new Set<SettingsChangeListener>()

  constructor(
    ctx: Context,
    /** The durable store this service reads and writes. */
    readonly store: OpenItemsStore,
  ) {
    super(ctx, 'openItems')
  }

  /** Install identity stamped on records (the sink contract). */
  get installId(): string {
    return this.store.installId
  }

  /** Domain format version (for `hello`). */
  get domainVersion(): number {
    return this.store.domainFormatVersion
  }

  /**
   * Persist one reply attempt atomically (the reply engine's store port).
   * @param input - attempt to persist.
   * @returns the written record, or the existing one for a replayed delivery.
   */
  recordAttempt(input: RecordAttemptInput): Promise<OpenItemRecord> {
    return this.store.recordAttempt(input)
  }

  /** Record schema version (for `hello`). */
  get schemaVersion(): number {
    return this.store.schemaVersion
  }

  /** Wire protocol version (for `hello`). */
  get protocolVersion(): number {
    return PROTOCOL_VERSION
  }

  /** Monotonic in-process revision for snapshot readers. */
  get revision(): number {
    return this.store.revision
  }

  /** True when a cap pruned stored resolutions. */
  get earlierRecordsPruned(): boolean {
    return this.store.earlierRecordsPruned
  }

  /** Effective retention/cap policy. */
  get limits(): ResolvedStoreLimits {
    return this.store.policy
  }

  /** Counts the nav pill, badges and page header render. */
  counts(): CountSummary {
    return countSummary(this.store.all(), {}, this.viewOptions())
  }

  /* ------------------------------------------------------------------ *
   * Settings
   * ------------------------------------------------------------------ */

  /**
   * Read the install's settings record (defaults served while no row exists).
   * @returns the live settings record.
   */
  settings(): SettingsRecord {
    return this.store.settings()
  }

  /**
   * Compare-and-set one settings patch.
   *
   * A written record notifies every listener synchronously before the promise
   * resolves, so the opt-in nudge is registered/disposed on the same turn the
   * route answers (contract §1: settings changes apply immediately).
   * @param expectedVersion - version the caller read (0 while serving defaults).
   * @param patch - validated fields to change.
   * @returns the written record or the live record on a CAS conflict.
   */
  async setSettings(expectedVersion: number, patch: SettingsPatch): Promise<SettingsWriteValue> {
    const value = await this.store.setSettings(expectedVersion, patch)
    if (value.status === 'written') {
      for (const listener of [...this.settingsListeners]) {
        try {
          listener(value.settings)
        } catch {
          // A listener failure must never fail the write the caller waited for.
        }
      }
    }
    return value
  }

  /**
   * Subscribe to settings writes.
   * @param listener - called with the written record.
   * @returns the unsubscribe function.
   */
  onSettingsChange(listener: SettingsChangeListener): () => void {
    this.settingsListeners.add(listener)
    return () => {
      this.settingsListeners.delete(listener)
    }
  }

  /* ------------------------------------------------------------------ *
   * Durable backfill report
   * ------------------------------------------------------------------ */

  /**
   * The last persisted backfill pass report, if any (survives restarts).
   * @returns the report, or undefined before one was persisted.
   */
  backfillReport(): BackfillReportRecord | undefined {
    return this.store.backfillReport()
  }

  /**
   * Persist one completed backfill pass report.
   * @param record - the pass report to keep.
   */
  putBackfillReport(record: BackfillReportRecord): Promise<void> {
    return this.store.putBackfillReport(record)
  }

  /** One record by id. */
  get(id: OpenItemId): OpenItemRecord | undefined {
    return this.store.get(id)
  }

  /**
   * The merged inbox snapshot (authored + derived items, session/workspace
   * rows, counts and cursor paging).
   * @param query - filters, scope and page request.
   * @returns the snapshot every client surface renders from.
   */
  list(query: InboxQuery = {}): InboxSnapshot {
    return buildSnapshot(this.store.all(), query, this.viewOptions())
  }

  /**
   * Number of records a query matches (before paging).
   * @param query - caller query.
   * @returns the inbox match count.
   */
  countMatches(query: InboxQuery = {}): number {
    return matchingCount(this.store.all(), query, 'inbox')
  }

  /**
   * One page of the resolution register (resolutions only, newest first).
   * @param query - filters and page request.
   * @returns the register page.
   */
  register(query: InboxQuery = {}): RegisterProjection {
    return buildRegister(this.store.all(), query, this.viewOptions())
  }

  /**
   * Raise an authored item (the tool's `raise` path).
   * @param input - authored draft.
   * @returns the record and whether it was a dedupe hit.
   */
  create(input: AuthoredItemInput): Promise<CreateRecordResult> {
    return this.store.create(input)
  }

  /**
   * Record the user's answer: `open → awaiting` until the session acknowledges.
   * @param id - item id.
   * @param expectedVersion - CAS token from the row the user acted on.
   * @param payload - exactly what the user submitted.
   * @param extra - delivery/evidence coordinates and the resolution actor.
   * @returns the written record.
   */
  answer(
    id: OpenItemId,
    expectedVersion: number | undefined,
    payload: ReplyPayload,
    extra: AnswerExtras = {},
  ): Promise<OpenItemRecord> {
    return this.store.answer(id, expectedVersion, payload, extra)
  }

  /**
   * Dismiss an item: `open → resolved` with a dismissal resolution.
   * @param id - item id.
   * @param expectedVersion - CAS token.
   * @param reason - why it is no longer needed.
   * @returns the written record.
   */
  dismiss(id: OpenItemId, expectedVersion: number | undefined, reason?: string): Promise<OpenItemRecord> {
    return this.store.dismiss(id, expectedVersion, reason)
  }

  /**
   * Promote one live candidate to a structural item (the user confirmed it).
   * The optional patch corrects the inferred kind/title/body/quote/options in
   * the same compare-and-set write; a kind change rekeys the record rather than
   * duplicating it.
   * @param id - item id.
   * @param expectedVersion - CAS token from the candidate row.
   * @param patch - optional corrections to the inferred item.
   * @returns the written record.
   */
  promote(
    id: OpenItemId,
    expectedVersion: number | undefined,
    patch?: PromotePatch,
  ): Promise<OpenItemRecord> {
    return this.store.promote(id, expectedVersion, patch)
  }

  /**
   * Suppress one live candidate: dismiss it and write the exact-key suppressor
   * so the same fingerprint cannot be inferred again.
   * @param id - item id.
   * @param expectedVersion - CAS token from the candidate row.
   * @param reason - why the candidate is not an item.
   * @returns the resolved record.
   */
  suppress(id: OpenItemId, expectedVersion: number | undefined, reason?: string): Promise<OpenItemRecord> {
    return this.store.suppress(id, expectedVersion, reason)
  }

  /**
   * Retire open derived team-task items raised before alerts were disabled
   * (decision D5; called once at activation).
   * @returns how many records were closed.
   */
  retireTeamTaskItems(): Promise<number> {
    return this.store.retireTeamTaskItems()
  }

  /**
   * Retire live prose candidates raised by the pre-split one-artifact gate
   * (contract §2.2; called once at activation, before the capture mount).
   * @returns how many records were closed.
   */
  retireLegacyProseCandidates(): Promise<number> {
    return this.store.retireLegacyProseCandidates()
  }

  /**
   * Replace legacy exact-key prose suppressors with session-scoped per-kind
   * prefixes (contract §2.2; called once at activation).
   * @returns how many legacy suppressors were replaced.
   */
  migrateLegacyProseSuppressors(): Promise<number> {
    return this.store.migrateLegacyProseSuppressors()
  }

  /**
   * Close live prose candidates duplicating a promoted item from the same
   * session+turn (contract §2.2; called after every completed backfill pass).
   * @returns how many candidates were closed.
   */
  reconcileProseCandidates(): Promise<number> {
    return this.store.reconcileProseCandidates()
  }

  /**
   * Permanently delete one record ("delete forever"): the record becomes a
   * tombstone that every read surface, the register and the exports exclude.
   * @param id - item id.
   * @param expectedVersion - CAS token from the row the user acted on.
   * @returns the tombstone record.
   */
  deleteForever(id: OpenItemId, expectedVersion: number): Promise<OpenItemRecord> {
    return this.store.deleteForever(id, expectedVersion)
  }

  /**
   * Reopen a settled item, keeping the previous resolution in the log.
   * @param id - item id.
   * @param expectedVersion - CAS token.
   * @returns the written record.
   */
  reopen(id: OpenItemId, expectedVersion?: number): Promise<OpenItemRecord> {
    return this.store.reopen(id, expectedVersion)
  }

  /**
   * Snooze a live item.
   * @param id - item id.
   * @param expectedVersion - CAS token.
   * @param until - millisecond timestamp.
   * @returns the written record.
   */
  snooze(id: OpenItemId, expectedVersion: number | undefined, until: number): Promise<OpenItemRecord> {
    return this.store.snooze(id, expectedVersion, until)
  }

  /**
   * Append one reply attempt (append-only delivery state machine).
   * @param id - item id.
   * @param expectedVersion - CAS token.
   * @param delivery - the attempt.
   * @returns the written record.
   */
  recordDelivery(id: OpenItemId, expectedVersion: number | undefined, delivery: DeliveryRecord): Promise<OpenItemRecord> {
    return this.store.recordDelivery(id, expectedVersion, delivery)
  }

  /**
   * Resolve an item directly (detector closure or an evidenced settle).
   * @param id - item id.
   * @param expectedVersion - CAS token.
   * @param resolution - the recorded resolution.
   * @returns the written record.
   */
  resolve(id: OpenItemId, expectedVersion: number | undefined, resolution: Resolution): Promise<OpenItemRecord> {
    return this.store.resolve(id, expectedVersion, resolution)
  }

  /**
   * Record that the session acted on a pending answer.
   * @param id - item id.
   * @param evidence - what proved it.
   * @returns the written record, or undefined when it was not awaiting.
   */
  acknowledge(
    id: OpenItemId,
    evidence: { readonly seq?: number; readonly kind: AcknowledgementEvidence },
  ): Promise<OpenItemRecord | undefined> {
    return this.store.acknowledge(id, evidence)
  }

  /**
   * Capture sink: apply derived drafts from the projection/backfill engine.
   * @param drafts - fold output.
   * @returns how many records were created or updated.
   */
  upsertDerived(drafts: readonly DerivedItemDraft[]): Promise<number> {
    return this.store.upsertDerived(drafts)
  }

  /**
   * Capture sink: apply delivery/acknowledgement evidence from the session log.
   *
   * `delivered` moves a recorded `queued` attempt to `delivered` (the durable
   * reply message with our `deliveryId` landed); an acknowledgement resolves the
   * awaiting item with `observed` evidence *without* replacing the user's
   * answer. Nothing is inferred: only log-proven transitions are applied, and
   * the 24 h sweep stays the `none` fallback.
   * @param evidence - evidenced transitions, in log order.
   * @returns how many item records the evidence changed.
   */
  async applyEvidence(evidence: readonly CaptureEvidence[]): Promise<number> {
    let applied = 0
    for (const entry of evidence) {
      applied += entry.type === 'delivered'
        ? await this.applyDeliveredEvidence(entry)
        : await this.applyAcknowledgedEvidence(entry)
    }
    return applied
  }

  /** Apply one evidenced `delivered` transition (idempotent). */
  private async applyDeliveredEvidence(
    entry: Extract<CaptureEvidence, { readonly type: 'delivered' }>,
  ): Promise<number> {
    const item = this.store.get(entry.itemId)
    if (item === undefined || item.deletedAt !== undefined) return 0
    // The newest attempt for this id is the transition to move: the record is
    // append-only, so the queued entry and its delivered/acknowledged entries
    // coexist.
    const recorded = [...item.deliveries].reverse().find(delivery => delivery.deliveryId === entry.deliveryId)
    // Without the recorded attempt there is nothing to move: capture never
    // invents a delivery it did not record.
    if (recorded === undefined) return 0
    if (recorded.state === 'delivered' || recorded.state === 'acknowledged') return 0
    const evidence: DeliveryEvidence = {
      ...recorded.evidence,
      ...entry.seq === undefined ? {} : { seq: entry.seq },
      ...entry.messageId === undefined ? {} : { messageId: entry.messageId },
    }
    await this.store.recordDelivery(item.id, undefined, { ...recorded, state: 'delivered', evidence })
    return 1
  }

  /** Apply one evidenced acknowledgement to the awaiting item it names (idempotent). */
  private async applyAcknowledgedEvidence(
    entry: Extract<CaptureEvidence, { readonly type: 'acknowledged' }>,
  ): Promise<number> {
    const candidates = this.store.all().filter(record => {
      if (record.deletedAt !== undefined) return false
      if (record.state !== 'awaiting') return false
      if (record.acknowledgement?.state !== 'pending') return false
      if (record.source.sessionId !== entry.sessionId) return false
      if (entry.artifactId === undefined) return true
      return record.dedupeKey.endsWith(`|${entry.sessionId}|${entry.artifactId}`)
    })
    let applied = 0
    for (const record of candidates) {
      const acknowledged = await this.store.acknowledge(record.id, {
        ...entry.seq === undefined ? {} : { seq: entry.seq },
        kind: entry.kind,
      })
      if (acknowledged === undefined) continue
      applied += 1
      await this.markDeliveryAcknowledged(acknowledged, entry.seq)
    }
    return applied
  }

  /** Append the evidenced `acknowledged` transition for the latest delivery. */
  private async markDeliveryAcknowledged(
    record: OpenItemRecord,
    seq: number | undefined,
  ): Promise<void> {
    const latest = [...record.deliveries].reverse().find(delivery => delivery.state !== 'failed')
    if (latest === undefined) return
    const already = record.deliveries.some(delivery =>
      delivery.deliveryId === latest.deliveryId && delivery.state === 'acknowledged')
    if (already) return
    const evidence: DeliveryEvidence = {
      ...latest.evidence,
      ...seq === undefined ? {} : { seq },
    }
    await this.store.recordDelivery(record.id, undefined, { ...latest, state: 'acknowledged', evidence })
  }

  /** Read one detection cursor (capture engine). */
  getCursor(sessionId: string): DetectionCursor | undefined {
    return this.store.getCursor(sessionId)
  }

  /** Write one detection cursor (capture engine). */
  putCursor(cursor: DetectionCursor): Promise<void> {
    return this.store.putCursor(cursor)
  }

  /** Read one suppressor (capture engine). */
  getSuppressor(prefix: string): SuppressorRecord | undefined {
    return this.store.getSuppressor(prefix)
  }

  /** Write one suppressor (the user said "this is not an item"). */
  putSuppressor(suppressor: SuppressorRecord): Promise<void> {
    return this.store.putSuppressor(suppressor)
  }

  /** Delete one suppressor by its exact dedupe prefix (identity correction/migration). */
  deleteSuppressor(prefix: string): Promise<boolean> {
    return this.store.deleteSuppressor(prefix)
  }

  /** Run one retention sweep (the plugin runs it hourly and at open). */
  sweep(): Promise<SweepReport> {
    return this.store.sweep()
  }

  /** Await every queued write. */
  async flush(): Promise<void> {
    await this.store.flush()
  }

  /** Close the store and its domain. */
  async close(): Promise<void> {
    await this.store.close()
  }

  /** The view options for one read. */
  private viewOptions(): ViewOptions {
    return {
      revision: this.store.revision,
      now: Date.now(),
      earlierRecordsPruned: this.store.earlierRecordsPruned,
      refreshing: false,
    }
  }
}
