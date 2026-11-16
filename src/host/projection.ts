/**
 * Projection unit and whole-log fold for the open-items capture engine.
 *
 * Two drivers share one pure fold (DESIGN §3.2, D1):
 * - the **projection unit** registered on `ctx.sessionProjections`, whose
 *   per-session state the harness checkpoints at `turn/end` and after detach;
 * - the **backfill** pass, which folds a cold session's complete log once.
 *
 * Fork cut asymmetry (deliberate, confirmed with the integration owner): the
 * projection's `init(header, inheritedEventCount)` receives the exact inherited
 * prefix length from the registry, while a backfill read through
 * `CaptureContext.readSession` receives only events, so it derives the cut from
 * the log's last `session/end-seed { inherited: true }` marker plus one. A
 * current-format seeded header always carries that marker, and 0 means "not a
 * fork".
 *
 * The unit is declared structurally rather than importing the harness
 * projection types: the registry only calls `stateSchema.parse`, `init`,
 * `apply`, and the wire block, so no zod dependency is added to this package.
 *
 * @module dsh-open-items/host/projection
 */

import type { CaptureEvent, CaptureEvidence, CaptureSessionInfo, DerivedItemDraft } from './capture-contract'
import type { DetectionSource } from '../shared/schema'
import { finalizeOpenItems, foldOpenItemsEvent, initialLedgerState, openDraftsOf, readLedgerState, type LedgerState } from './folds'

/** Projection key this plugin owns on the session-projection registry. */
export const OPEN_ITEMS_PROJECTION_KEY = 'openItems'

/**
 * Projection state version; bump when fold semantics change so cursors replay.
 *
 * **Must move together with `OPEN_ITEMS_FOLD_VERSION`** (`folds/limits.ts`):
 * the two counters describe the same fold semantics — one is the projection
 * unit's `stateVersion`, the other gates cursor replay in the backfill — and a
 * lone bump leaves checkpoints or cursors interpreting new state with old rules
 * (GAP-ANALYSIS G-13). Version 3 reworks the prose candidate gate into an
 * additive multi-item detector (per-item `prose:t<turn>:<hash>` ids, raw
 * line-bound turn text, batch-aware bounds, `finalizeProse`), matching
 * `OPEN_ITEMS_FOLD_VERSION` 3 exactly.
 */
export const OPEN_ITEMS_PROJECTION_VERSION = 3

/** The minimal committed-event shape the fold reads. */
export interface SessionEventLike {
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly data: unknown
}

/** The minimal session shape the projection's `init` receives. */
export interface SessionHeaderLike {
  readonly id?: string
  readonly createdAt?: number
}

/** Structural schema: the registry only ever calls `parse`. */
export interface SchemaLike<T> {
  parse(value: unknown): T
}

/** Structural projection unit accepted by `ctx.sessionProjections.register`. */
export interface ProjectionUnitLike<S> {
  readonly key: string
  readonly stateVersion: number
  readonly stateSchema: SchemaLike<S>
  init(header: SessionHeaderLike, inheritedEventCount: number): S
  apply(state: S, event: SessionEventLike): S
  readonly wire: {
    readonly viewSchema: SchemaLike<unknown>
    view(state: S): unknown
    readonly summary?: boolean
  }
}

/** The projection drives state only and emits no draft, so it carries no session identity. */
const PROJECTION_SESSION: CaptureSessionInfo = { sessionId: '', updatedAt: 0, archived: false }

/** Accept any plain object as a projection value; the fold normalises it. */
const anyObjectSchema: SchemaLike<unknown> = {
  parse: (value: unknown) => (typeof value === 'object' && value !== null ? value : {}),
}

/** The registered projection unit: the whole per-session ledger, excluded from summaries in V1. */
export const openItemsProjection: ProjectionUnitLike<LedgerState> = {
  key: OPEN_ITEMS_PROJECTION_KEY,
  stateVersion: OPEN_ITEMS_PROJECTION_VERSION,
  stateSchema: { parse: (value: unknown) => readLedgerState(value as Record<string, unknown>) },
  init: (_header, inheritedEventCount) => initialLedgerState(inheritedEventCount),
  apply: (state, event) => foldOpenItemsEvent(state, toCaptureEvent(event), PROJECTION_SESSION, 'projection').state,
  wire: {
    // V1 keeps the whole ledger off session summaries (PLAN §3 item 3).
    viewSchema: anyObjectSchema,
    view: state => state,
    summary: false,
  },
}

/** Convert one committed session event to the fold's event shape. */
export function toCaptureEvent(event: SessionEventLike): CaptureEvent {
  return { seq: event.seq, type: event.type, time: event.time, data: event.data }
}

/** Derive the fork cut from a complete event list (backfill path). */
export function deriveInheritedEventCount(events: readonly CaptureEvent[]): number {
  let cut = 0
  for (const event of events) {
    if (event.type !== 'session/end-seed') continue
    const data = event.data as { inherited?: unknown } | undefined
    if (data?.inherited !== true) continue
    cut = event.seq + 1
  }
  return cut
}

/** Result of folding one complete session log. */
export interface FoldedSession {
  readonly state: LedgerState
  readonly drafts: readonly DerivedItemDraft[]
  /** Delivery/acknowledgement evidence this log proves, in log order. */
  readonly evidence: readonly CaptureEvidence[]
  /** Highest seq the fold scanned; a cursor advances here. */
  readonly lastScannedSeq: number
  /** Highest event time the fold scanned. */
  readonly lastEventTime: number
  /** Exact inherited prefix length used for the fork cut. */
  readonly inheritedEventCount: number
}

/**
 * Draft emission mode.
 *
 * `delta` reports every artifact transition in the log, so a store that already
 * holds items sees the closures it needs. `baseline` reports only the artifacts
 * still open at the end of the log: on first contact with a historical session
 * there is nothing to close yet, and replaying every historical resolution
 * would create register rows for asks nobody is waiting on.
 */
export type FoldEmissionMode = 'delta' | 'baseline'

/**
 * Fold one complete session log and finalize whatever it leaves open.
 * @param events - committed events in any order; they are sorted by seq.
 * @param options - session metadata, detector source, an optional explicit fork
 *   cut, and (delta mode only) the scanned-through seq to resume from.
 * @returns the final ledger, every draft, and the cursor facts.
 */
export function foldSession(
  events: readonly CaptureEvent[],
  options: {
    readonly session: CaptureSessionInfo
    readonly source: DetectionSource
    readonly inheritedEventCount?: number
    readonly mode?: FoldEmissionMode
    /**
     * Delta resume point: emit only transitions caused by events with a greater
     * seq. The whole log is still folded so the ledger is complete; suppressing
     * already-scanned transitions is what stops a re-fold from replaying old
     * raises at the store (which reopens detector-closed items and bumps
     * version/reopenCount on every boot).
     */
    readonly sinceSeq?: number
    /** True for a cold-log sweep (backfill/acceptance): team-task orphans are live-only. */
    readonly historical?: boolean
  },
): FoldedSession {
  const inheritedEventCount = options.inheritedEventCount ?? deriveInheritedEventCount(events)
  const ordered = [...events].sort((left, right) => left.seq - right.seq)
  const mode: FoldEmissionMode = options.mode ?? 'delta'
  const sinceSeq = mode === 'delta' ? options.sinceSeq : undefined
  let state = initialLedgerState(inheritedEventCount)
  const drafts: DerivedItemDraft[] = []
  let lastEventTime = 0
  // Coverage is about the log that was read, not about which events produced
  // state changes: an uninteresting event must still move the cursor, or a
  // cursor written from `state.lastSeq` would lag and re-read the session.
  let lastScannedSeq = -1
  const deltas: DerivedItemDraft[] = []
  const evidence: CaptureEvidence[] = []
  for (const event of ordered) {
    const step = foldOpenItemsEvent(state, event, options.session, options.source, undefined, options.historical ?? true)
    state = step.state
    // Attribute each draft to the event that produced it: a closure's own
    // `seq` is the artifact's raising seq, so filtering on it would drop a
    // legitimate closure of an older item.
    const emit = sinceSeq === undefined || event.seq > sinceSeq
    if (emit) deltas.push(...step.drafts)
    if (step.evidence !== undefined) evidence.push(...evidenceOf(step.evidence, mode, emit))
    lastEventTime = Math.max(lastEventTime, event.time)
    if (event.seq > lastScannedSeq) lastScannedSeq = event.seq
  }
  if (ordered.length > 0) {
    const finalized = finalizeOpenItems(state, options.session, options.source, lastEventTime)
    state = finalized.state
    // Finalize drafts have no event of their own; the artifact's raising seq is
    // the only age evidence, and a previous pass already emitted those it could.
    deltas.push(...finalized.drafts.filter(draft => sinceSeq === undefined || (draft.seq ?? -1) > sinceSeq))
  }
  if (mode === 'delta') drafts.push(...deltas)
  else if (ordered.length > 0) drafts.push(...openDraftsOf(state, options.session, options.source))
  return { state, drafts, evidence, lastScannedSeq, lastEventTime, inheritedEventCount }
}

/**
 * Evidence a log read may apply.
 *
 * A delta applies evidence from the events it emitted. A first-contact
 * baseline applies only evidence that names its own artifact (the ask's own
 * resolution): a replayed old `turn/start` could otherwise acknowledge an item
 * that was answered long after that turn.
 * @param entries - evidence produced by one event.
 * @param mode - fold emission mode.
 * @param emitted - whether the owning event's transitions are being emitted.
 * @returns the evidence entries to apply.
 */
function evidenceOf(
  entries: readonly CaptureEvidence[],
  mode: FoldEmissionMode,
  emitted: boolean,
): readonly CaptureEvidence[] {
  if (mode === 'delta') return emitted ? entries : []
  return entries.filter(entry => entry.type === 'delivered' || entry.artifactId !== undefined)
}
