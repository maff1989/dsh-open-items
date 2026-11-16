/**
 * Bounded, resumable backfill of sessions that predate the plugin.
 *
 * The projection unit only starts folding a session once the plugin is
 * installed, so history has no checkpoint (DESIGN §4 step 2). This pass folds
 * each cold session's complete log once through the same pure fold, work-sliced
 * behind the event loop so it never blocks a session from opening.
 *
 * Resumability: a cursor is written only after every draft for that session has
 * been accepted by the sink, so an interrupted run (or a failing sink) retries
 * the session instead of losing it.
 *
 * Watermark: a session is skipped without reading its log **only** when the
 * roster reported a real activity time that the cursor already covers. The
 * persisted header's creation time is never treated as activity (a roster-less
 * session that gains events later would be skipped forever), so such a session
 * is re-read and the cursor's `lastScannedSeq`/`lastEventTime` coverage decides.
 * A delta re-fold emits only transitions from events after the cursor, so a
 * restart never replays a resolution the store already holds.
 *
 * Fork cut: the read seam returns events but no inherited-prefix length, so the
 * cut is derived from the log's last `session/end-seed { inherited: true }`
 * marker plus one (a current-format seeded header always carries it). The live
 * projection path instead receives the exact count from `init`.
 *
 * @module dsh-open-items/host/backfill
 */

import type {
  CaptureContext,
  CaptureEvent,
  CaptureRuntimeSettings,
  CaptureSink,
  CaptureSessionInfo,
  DerivedItemDraft,
} from './capture-contract'
import type { DetectionCursor, DetectionSource, SessionId } from '../shared/schema'
import { OPEN_ITEMS_FOLD_VERSION, OPEN_ITEMS_LIMITS } from './folds/limits'
import { proseCandidatesEnabled, proseEmittedUnderSetting } from './folds/prose'
import { foldSession } from './projection'

/** Store for per-session detection cursors. */
export interface DetectionCursorStore {
  get(sessionId: SessionId): DetectionCursor | undefined | Promise<DetectionCursor | undefined>
  put(cursor: DetectionCursor): void | Promise<void>
}

/** In-memory cursors: the default so the pass runs before the store table is wired. */
export class InMemoryDetectionCursorStore implements DetectionCursorStore {
  private readonly cursors = new Map<SessionId, DetectionCursor>()

  /** @param sessionId - session whose cursor to read. */
  get(sessionId: SessionId): DetectionCursor | undefined {
    return this.cursors.get(sessionId)
  }

  /** @param cursor - cursor to remember. */
  put(cursor: DetectionCursor): void {
    this.cursors.set(cursor.sessionId, cursor)
  }
}

/** Deployment-tunable backfill bounds; defaults come from {@link OPEN_ITEMS_LIMITS}. */
export interface BackfillLimits {
  /** Newest sessions considered by one run. */
  readonly maxSessions: number
  /** Activity age cap in days. */
  readonly maxAgeDays: number
  /** Drafts per sink call. */
  readonly sinkBatch: number
  /** Sessions folded between event-loop yields. */
  readonly sessionsPerYield: number
}

/** Default backfill bounds (OI-10: 90 days, 200 sessions). */
export const DEFAULT_BACKFILL_LIMITS: BackfillLimits = {
  maxSessions: OPEN_ITEMS_LIMITS.maxBackfillSessions,
  maxAgeDays: OPEN_ITEMS_LIMITS.maxBackfillAgeDays,
  sinkBatch: OPEN_ITEMS_LIMITS.sinkBatch,
  sessionsPerYield: OPEN_ITEMS_LIMITS.sessionsPerYield,
}

/** Everything one backfill run did. */
export interface BackfillReport {
  /** Sessions in the catalog after root/age filtering, before the cap. */
  readonly sessionsEligible: number
  /** Sessions whose log was read and folded. */
  readonly sessionsFolded: number
  /** Sessions skipped because a cursor already covered them. */
  readonly sessionsSkipped: number
  /** Sessions whose read or sink write failed (retried on the next run). */
  readonly sessionsFailed: number
  /** Drafts accepted by the sink. */
  readonly draftsEmitted: number
  /** Sink calls made. */
  readonly batches: number
  /** Sessions dropped by the per-run cap. */
  readonly deferredByLimit: number
  /** Wall-clock duration of the run. */
  readonly durationMs: number
}

/** Options for one backfill run. */
export interface BackfillOptions {
  readonly context: CaptureContext
  readonly sink: CaptureSink
  readonly cursors: DetectionCursorStore
  /** Detector provenance; the backfill always reports `log-fold`. */
  readonly source?: DetectionSource
  readonly limits?: Partial<BackfillLimits>
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number
  /** Stop between sessions when aborted. */
  readonly signal?: AbortSignal
  /**
   * Runtime settings reader (PLAN §8). When `proseCandidates` is false the pass
   * drops prose candidate **raises** instead of writing them; closures (of an
   * already-open candidate) and the todo aggregate are always emitted. Absent or
   * throwing reads as the default (prose on).
   */
  readonly settings?: () => CaptureRuntimeSettings
  /** Test seam: awaited between sessions; defaults to a macrotask yield. */
  readonly yieldTo?: () => Promise<void>
}

/** Root sessions only (D5): subagent and delegated sessions own no user decisions. */
export function isRootSession(session: CaptureSessionInfo): boolean {
  return session.origin !== 'subagent' && (session.delegationDepth ?? 0) === 0
}

/** Highest seq/time in one log; an empty log has no coverage at all. */
function logCoverage(events: readonly CaptureEvent[]): { readonly lastSeq: number; readonly lastTime: number } {
  let lastSeq = -1
  let lastTime = 0
  for (const event of events) {
    if (event.seq > lastSeq) lastSeq = event.seq
    if (event.time > lastTime) lastTime = event.time
  }
  return { lastSeq, lastTime }
}

/**
 * Whether a *proven* activity time lets the cursor skip a log read.
 *
 * `lastActivityAt` may only be set by a Host that can prove it is an upper bound
 * on the newest committed event. `updatedAt` can never stand in for it: the
 * installed roster derives it from `max(createdAt, lastPromptAt)`, a lower bound
 * that would hide tool/approval events committed after the last user prompt. The
 * seam omits the field today, so in the shipped profile every eligible session is
 * read and judged by {@link coveredByLog}.
 * @param cursor - durable detection cursor for the session.
 * @param session - session metadata from the catalog.
 * @returns true when the session's log is provably unchanged.
 */
function coveredByActivity(cursor: DetectionCursor, session: CaptureSessionInfo): boolean {
  const activity = session.lastActivityAt
  if (activity === undefined || !Number.isFinite(activity)) return false
  return activity <= cursor.lastEventTime
}

/**
 * Whether the cursor covers every event the log contains.
 *
 * The read is the proof: a scan that found a blank log recorded an empty
 * coverage, and a later event (any event time is positive) exceeds it.
 * @param cursor - durable detection cursor for the session.
 * @param coverage - the log's last seq/time.
 * @returns true when folding would emit nothing new.
 */
function coveredByLog(
  cursor: DetectionCursor,
  coverage: { readonly lastSeq: number; readonly lastTime: number },
): boolean {
  return coverage.lastSeq <= cursor.lastScannedSeq && coverage.lastTime <= cursor.lastEventTime
}

/** Yield to the event loop so a backfill never blocks a session operation. */
function defaultYield(): Promise<void> {
  return new Promise<void>(resolve => { setImmediate(resolve) })
}

/** Stamp the owning workspace onto drafts that do not carry one yet. */
function withWorkspace(
  drafts: readonly DerivedItemDraft[],
  workspace: DerivedItemDraft['workspace'],
): DerivedItemDraft[] {
  if (workspace === undefined) return [...drafts]
  return drafts.map(draft => ({ ...draft, workspace }))
}

/**
 * Run one bounded backfill pass.
 *
 * Never throws for a per-session failure: it is counted in the report and
 * retried on the next run. An aborted signal stops between sessions and returns
 * the partial report.
 * @param options - capture seams, cursor store and bounds.
 * @returns what the pass examined and emitted.
 */
export async function runBackfill(options: BackfillOptions): Promise<BackfillReport> {
  const startedAt = (options.now ?? Date.now)()
  const limits: BackfillLimits = { ...DEFAULT_BACKFILL_LIMITS, ...options.limits }
  const source: DetectionSource = options.source ?? 'log-fold'
  const yieldTo = options.yieldTo ?? defaultYield
  const report = {
    sessionsEligible: 0,
    sessionsFolded: 0,
    sessionsSkipped: 0,
    sessionsFailed: 0,
    draftsEmitted: 0,
    batches: 0,
    deferredByLimit: 0,
    durationMs: 0,
  }

  const catalog = await options.context.listSessions()
  const cutoff = startedAt - limits.maxAgeDays * 24 * 60 * 60 * 1000
  const eligible = catalog
    .filter(isRootSession)
    // An archived session is closed history: it must not be re-folded, and a
    // cold baseline over it would resurrect items the user already put away.
    .filter(session => session.archived !== true)
    .filter(session => session.updatedAt >= cutoff)
    .sort((left, right) => right.updatedAt - left.updatedAt)
  report.sessionsEligible = eligible.length
  const selected = eligible.slice(0, Math.max(0, limits.maxSessions))
  report.deferredByLimit = eligible.length - selected.length

  let batch: DerivedItemDraft[] = []
  let sinceYield = 0
  const maybeYield = async (): Promise<void> => {
    sinceYield += 1
    if (sinceYield < Math.max(1, limits.sessionsPerYield)) return
    sinceYield = 0
    await yieldTo()
  }
  /** Send up to one bounded chunk; returns false when the sink rejected it. */
  const flushChunk = async (): Promise<boolean> => {
    if (batch.length === 0) return true
    const chunk = batch.slice(0, Math.max(1, limits.sinkBatch))
    batch = batch.slice(chunk.length)
    try {
      await options.sink.upsertDerived(chunk)
      report.draftsEmitted += chunk.length
      report.batches += 1
      return true
    } catch {
      // The drafts are regenerated by refolding the session on the next run.
      return false
    }
  }
  /** Drain every queued draft in bounded chunks. */
  const flush = async (): Promise<boolean> => {
    while (batch.length > 0) {
      if (!await flushChunk()) return false
    }
    return true
  }

  for (const session of selected) {
    if (options.signal?.aborted === true) break
    const cursor = await options.cursors.get(session.sessionId)
    const fresh = cursor !== undefined && cursor.foldVersion === OPEN_ITEMS_FOLD_VERSION
    // Cheap path: only a Host that can prove an activity upper bound may skip the
    // read (the installed roster cannot; see `coveredByActivity`).
    if (fresh && coveredByActivity(cursor, session)) {
      report.sessionsSkipped += 1
      continue
    }
    let events: readonly CaptureEvent[]
    try {
      events = await options.context.readSession(session.sessionId)
    } catch {
      report.sessionsFailed += 1
      await maybeYield()
      continue
    }
    // The read is the coverage proof: a cursor covering every event needs no fold
    // and no sink write. A log *shorter* than the cursor was rewritten, so it is
    // rebuilt instead of skipped.
    const coverage = logCoverage(events)
    const rewritten = fresh && coverage.lastSeq < cursor.lastScannedSeq
    if (fresh && !rewritten && coveredByLog(cursor, coverage)) {
      report.sessionsSkipped += 1
      await maybeYield()
      continue
    }
    // First contact reports the currently-open set; a re-fold reports only the
    // transitions caused by events after the cursor, so the store closes what
    // resolved without replaying old raises (which would reopen detector-closed
    // items and bump version/reopenCount on every boot). A fold-version bump, a
    // previously-blank log and a rewritten log rebuild the baseline.
    const blankScan = fresh && cursor.lastScannedSeq === 0 && cursor.lastEventTime === 0
    const firstContact = !fresh || blankScan || rewritten
    const sinceSeq = !firstContact && cursor !== undefined ? cursor.lastScannedSeq : undefined
    let folded
    try {
      folded = foldSession(events, {
        session,
        source,
        mode: firstContact ? 'baseline' : 'delta',
        ...sinceSeq === undefined ? {} : { sinceSeq },
      })
    } catch {
      report.sessionsFailed += 1
      await maybeYield()
      continue
    }
    // Evidence is applied before the drafts of the same log read: a track-1
    // answer recorded live is acknowledged from its ask's own result before the
    // closure of that ask would otherwise resolve it as a detector closure.
    if (folded.evidence.length > 0 && options.sink.applyEvidence !== undefined) {
      try {
        await options.sink.applyEvidence(folded.evidence)
      } catch {
        // Keep the session un-cursored so the next pass retries it.
        report.sessionsFailed += 1
        batch = []
        await maybeYield()
        continue
      }
    }
    const workspace = await safeWorkspace(options.context, session.sessionId)
    // The prose candidate family is the only one gated at emission time; the
    // todo aggregate and every structural family always pass through, and a
    // prose closure always passes so an open candidate can still close while the
    // check is off (G6/H8).
    const proseOn = proseCandidatesEnabled(options.settings)
    const emitted = folded.drafts.filter(draft => proseEmittedUnderSetting(draft, proseOn))
    batch.push(...withWorkspace(emitted, workspace))
    let flushFailed = false
    while (batch.length > 0) {
      if (!await flushChunk()) {
        flushFailed = true
        break
      }
    }
    if (flushFailed) {
      // A failed write keeps the session un-cursored so the next run retries it.
      report.sessionsFailed += 1
      batch = []
      await maybeYield()
      continue
    }
    // A session with no committed events folds to `lastSeq = -1`, but a durable
    // cursor must be a non-negative integer: clamp it. `lastEventTime` records
    // the newest *committed event* time only (never the creation-time fallback),
    // so an empty log stays distinguishable from a scanned one. This validation
    // used to throw straight out of the loop and abort the whole pass (observed
    // on the live profile: two cursors, then nothing).
    const nextCursor: DetectionCursor = {
      sessionId: session.sessionId,
      lastScannedSeq: Math.max(0, Math.trunc(folded.lastScannedSeq)),
      lastEventTime: Math.max(0, Math.trunc(folded.lastEventTime)),
      lastScanAt: Math.trunc((options.now ?? Date.now)()),
      foldVersion: OPEN_ITEMS_FOLD_VERSION,
    }
    try {
      await options.cursors.put(nextCursor)
    } catch {
      // One unwritable cursor must not abort the remaining sessions: leave it
      // un-cursored (retried next pass) and keep going.
      report.sessionsFailed += 1
      batch = []
      await maybeYield()
      continue
    }
    report.sessionsFolded += 1
    await maybeYield()
  }
  await flush()
  report.durationMs = (options.now ?? Date.now)() - startedAt
  return report
}

/** Resolve a workspace snapshot without letting a resolver failure abort the run. */
async function safeWorkspace(
  context: CaptureContext,
  sessionId: SessionId,
): Promise<DerivedItemDraft['workspace']> {
  try {
    return await context.workspaceOf(sessionId)
  } catch {
    // Workspace grouping is a display lens; an item without it still lands.
    return undefined
  }
}
