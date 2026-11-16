/**
 * Capture wiring: the sink bridge, the live projection driver and the backfill
 * kickoff.
 *
 * The engine has three seams and each degrades independently, because a profile
 * may compose the plugin without one of the optional capabilities:
 * - **projection**: `ctx.sessionProjections` (base bundle) — registers the
 *   per-session ledger so the harness checkpoints it; skipped when absent.
 * - **live**: `ctx.on('session/event')` — folds each committed event and pushes
 *   drafts to the sink immediately; skipped when the event service is absent.
 *   The driver hydrates a session's ledger from its committed log on the first
 *   event, so a restart does not drop the pending closers (PLAN §8).
 * - **backfill**: needs a `CaptureContext`; runs once on activation and then on
 *   a bounded periodic re-scan, resumable, and never awaited by the caller.
 *
 * The sink is the only durable writer. The capture engine never touches the
 * Session log (D2): it reads committed events and reports drafts.
 *
 * `createCaptureDriver` is also the M1 acceptance-harness entry point: a pure
 * driver exposing `driveSession(session, events)` with `{ sink, now,
 * isSessionRunning }` options.
 *
 * @module dsh-open-items/host/capture
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'

import type {
  CaptureContext,
  CaptureEvent,
  CaptureEvidence,
  CaptureRuntimeSettings,
  CaptureSessionInfo,
  CaptureSink,
  DerivedItemDraft,
  ProseExtractionInput,
  ProseExtractionVerdict,
} from './capture-contract'
import type { DetectionSource, SessionId, WorkspaceRef } from '../shared/schema'
import {
  LIVE_ASKS_SERVICE,
  type LiveAskCarrier,
  type LiveAskObservation,
} from './delivery-contract'
import { initialLedgerState, foldOpenItemsEvent, normalizeFoldSession, type LedgerState } from './folds'
import { OPEN_ITEMS_LIMITS } from './folds/limits'
import { isProseDraft, proseCandidatesEnabled, proseEmittedUnderSetting } from './folds/prose'
import { openItemsProjection, type ProjectionUnitLike } from './projection'
import {
  InMemoryDetectionCursorStore,
  isRootSession,
  runBackfill,
  type BackfillLimits,
  type BackfillReport,
  type DetectionCursorStore,
} from './backfill'
import { createHostWorkspaceResolver } from './capture-context'
import type { OwnedDraft } from './folds/drafts'

export type { CaptureRuntimeSettings, ProseExtractionInput, ProseExtractionVerdict } from './capture-contract'

/** What started one backfill pass (the durable report's trigger column). */
export type BackfillTrigger = 'activation' | 'rescan'

/** Default period of the bounded re-scan after activation: 15 minutes. */
export const DEFAULT_RESCAN_INTERVAL_MS = 15 * 60_000

/**
 * Structural view of a live `Session` record; only these fields are read.
 *
 * The live shape keeps its durable facts in `header` (installed
 * `dsh-session/lib/types/types.d.ts` `SessionHeader`); `id` and
 * `inheritedEventCount` live on the `Session` itself.
 */
export interface LiveSessionLike {
  readonly id: string
  readonly inheritedEventCount?: number
  readonly header?: {
    readonly id?: string
    readonly createdAt?: number
    readonly cwd?: string
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly parentSession?: string
  }
}

/** Session input a driver accepts: capture metadata, `{ info }`, or a live Session. */
export type CaptureSessionInput =
  | CaptureSessionInfo
  | { readonly info: CaptureSessionInfo & { readonly inheritedEventCount?: number } }
  | LiveSessionLike

/** Options for the pure capture driver. */
export interface CaptureDriverOptions {
  /** Where drafts go; omitted keeps them in the returned array only. */
  readonly sink?: CaptureSink
  /** Detector provenance; live wiring reports `projection`. */
  readonly source?: DetectionSource
  readonly now?: () => number
  /** Whether a team task's owning session is still running (orphan gate). */
  readonly isSessionRunning?: (sessionId: string) => boolean | undefined
  /**
   * Workspace membership resolver stamped on every draft, exactly as the
   * backfill stamps it: membership in `workspace.sessionIds`, never `cwd`.
   * Omitted leaves drafts ungrouped.
   */
  readonly workspaceOf?: (sessionId: SessionId) => WorkspaceRef | undefined
  /** Drafts per sink call. */
  readonly batchSize?: number
  /** Contained failures: a sink outage must not reach a session dispatch. */
  readonly onError?: (error: unknown) => void
  /**
   * Runtime settings reader consulted before emitting drafts (PLAN §8). The
   * prose candidate family is gated on `proseCandidates`; the todo aggregate is
   * always emitted. Absent or throwing reads as the default (prose on).
   */
  readonly settings?: () => CaptureRuntimeSettings
  /**
   * Cold-log read seam for **hydration** (PLAN §8, P1 fix).
   *
   * A driver that starts inside a running process has no ledger for a session
   * that predates it, so a later closing detector (`tool/result`,
   * `approval/decided`, …) would silently miss. On a session's first event, when
   * no state exists yet, the driver reads the log once, folds the prefix with
   * the live fold (no draft emission) and seeds its state and `seenSeqs` from
   * it. Omitted = no hydration (the harness/one-shot callers keep today's
   * behaviour); a failing read is contained and never aborts the live path.
   */
  readonly readSession?: (sessionId: SessionId) => Promise<readonly CaptureEvent[]>
  /**
   * Optional model-assisted extraction seam for prose candidates
   * (PLAN-remediation §12.4).
   *
   * Called once per prose **raise** (never for structural/todo drafts, never for
   * a prose closure, and never on the backfill path — historical candidates stay
   * gate-only), with that raise's own turn text. `undefined` keeps the gate's
   * draft unchanged, `keep:false` drops it, and any other verdict emits a
   * refined clone overriding only `kind`/`title`. The call is awaited but
   * contained: a rejection is reported and the gate's draft is kept, so
   * extraction can never break the live event path.
   */
  readonly extraction?: (input: ProseExtractionInput) => Promise<ProseExtractionVerdict | undefined>
}

/** The driver a Host plugin (or the acceptance harness) folds sessions through. */
export interface CaptureDriver {
  /**
   * Fold new events for one session and report the drafts they produced.
   *
   * Incremental: the driver keeps the ledger per session id, so a live caller
   * passes one event at a time and a harness may pass a whole log at once.
   * @param session - session metadata (flat or `{ info }`).
   * @param events - committed events in seq order; already-folded seqs are ignored.
   * @returns drafts produced by this call, after the orphan gate.
   */
  driveSession(session: CaptureSessionInput, events: readonly CaptureEvent[]): Promise<readonly DerivedItemDraft[]>
  /** Drain every queued draft into the sink. */
  flush(): Promise<void>
  /** Forget one session's ledger (session disposal). */
  forgetSession(sessionId: string): void
}

/** Read the inherited prefix length from whichever session record was supplied. */
function inheritedCountOf(session: unknown): number {
  const record = typeof session === 'object' && session !== null ? session as Record<string, unknown> : {}
  const nested = typeof record['info'] === 'object' && record['info'] !== null
    ? record['info'] as Record<string, unknown>
    : record
  const value = nested['inheritedEventCount']
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

/** Keep a draft only when its owning session is not known to be running. */
function keepDraft(draft: OwnedDraft, isSessionRunning: CaptureDriverOptions['isSessionRunning']): boolean {
  if (draft.ownerSessionId === undefined || isSessionRunning === undefined) return true
  return isSessionRunning(draft.ownerSessionId) !== true
}

/** Stamp the resolved workspace snapshot, tolerating a throwing resolver. */
function withWorkspaceSnapshot(
  draft: DerivedItemDraft,
  workspace: WorkspaceRef | undefined,
): DerivedItemDraft {
  return workspace === undefined ? draft : { ...draft, workspace }
}

/**
 * Apply one extraction verdict as a clone: only `kind`/`title` may change.
 *
 * Defensive about the runtime shape even though the seam is typed: a malformed
 * verdict must behave like `undefined` (keep the gate's draft) rather than throw
 * inside a live session dispatch. Dropping (`keep:false`) is decided by the
 * caller, so this helper never removes a draft.
 * @param draft - the gate-produced prose draft.
 * @param verdict - the extractor's verdict (possibly undefined at runtime).
 * @returns the unchanged draft, or a refined clone overriding kind/title.
 */
function refineProseDraft(draft: DerivedItemDraft, verdict: ProseExtractionVerdict | undefined): DerivedItemDraft {
  const raw = verdict as { kind?: unknown; title?: unknown } | undefined | null
  if (raw === undefined || raw === null) return draft
  const kind = raw.kind === 'question' || raw.kind === 'decision' ? raw.kind : undefined
  const title = typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim() : undefined
  if (kind === undefined && title === undefined) return draft
  return {
    ...draft,
    ...kind === undefined ? {} : { kind },
    ...title === undefined ? {} : { title },
  }
}

/**
 * Create the pure capture driver.
 * @param options - sink, clock, orphan gate, workspace resolver and detector provenance.
 * @returns a driver that folds sessions into drafts.
 */
export function createCaptureDriver(options: CaptureDriverOptions = {}): CaptureDriver {
  const source = options.source ?? 'projection'
  const batchSize = Math.max(1, options.batchSize ?? OPEN_ITEMS_LIMITS.sinkBatch)
  const states = new Map<string, LedgerState>()
  /** Highest seq already handed to the fold, so a duplicate delivery is a no-op. */
  const seenSeqs = new Map<string, number>()
  const queue: DerivedItemDraft[] = []
  const report = (error: unknown): void => {
    try {
      options.onError?.(error)
    } catch {
      // An error reporter must never become the failure it reports.
    }
  }
  /** Resolve one session's workspace without letting the lens abort capture. */
  const resolveWorkspace = (sessionId: SessionId): WorkspaceRef | undefined => {
    if (options.workspaceOf === undefined) return undefined
    try {
      return options.workspaceOf(sessionId)
    } catch (error) {
      report(error)
      return undefined
    }
  }
  const drain = async (): Promise<void> => {
    if (options.sink === undefined) {
      queue.length = 0
      return
    }
    while (queue.length > 0) {
      const chunk = queue.splice(0, batchSize)
      try {
        await options.sink.upsertDerived(chunk)
      } catch (error) {
        report(error)
      }
    }
  }
  /**
   * Run the optional extraction seam over this batch's prose **raises**.
   *
   * Only prose raises are extracted; every closure and every other family passes
   * through in order. A closure is a lifecycle fact, not a judgement: extracting
   * it could drop or rewrite the close of an open candidate (G7). Each raise is
   * sent its **own turn's** final message (a batch may span turns); when the
   * batch did not fold that turn, the current fold text is the best available
   * fallback. A per-draft failure is contained (reported, the gate's draft kept)
   * so the seam can never abort a session dispatch. Dropping means "not emitted"
   * — the caller never queues it.
   * @param drafts - the kept drafts of one drive call, setting gate applied.
   * @param sessionId - owning session id sent to the extractor.
   * @param turnText - final assistant text tail per folded turn.
   * @param currentText - current fold text, used when the raise's turn is absent.
   * @returns the drafts to emit, in order.
   */
  const extractProseDrafts = async (
    drafts: readonly DerivedItemDraft[],
    sessionId: string,
    turnText: ReadonlyMap<number, string>,
    currentText: string,
  ): Promise<DerivedItemDraft[]> => {
    const extraction = options.extraction
    if (extraction === undefined) return [...drafts]
    const emitted: DerivedItemDraft[] = []
    for (const draft of drafts) {
      if (!isProseDraft(draft) || draft.closes !== undefined) {
        emitted.push(draft)
        continue
      }
      const text = draft.turn === undefined ? undefined : turnText.get(draft.turn)
      let verdict: ProseExtractionVerdict | undefined
      try {
        verdict = await extraction({
          sessionId,
          title: draft.title,
          quote: draft.quote ?? '',
          text: text ?? currentText,
        })
      } catch (error) {
        // Contained: a failed extraction must never lose the gate's candidate
        // or break the live event path.
        report(error)
        emitted.push(draft)
        continue
      }
      const raw = verdict as { keep?: unknown } | undefined
      if (raw !== undefined && raw.keep === false) continue
      emitted.push(refineProseDraft(draft, verdict))
    }
    return emitted
  }
  /** One in-flight hydration per session: concurrent first events share the read. */
  const hydrations = new Map<string, Promise<void>>()
  /**
   * Seed a session's ledger from its committed log once.
   *
   * The live driver only sees events from the moment it is attached, so after a
   * Host restart a closing detector (`tool/result`, `approval/decided`, …) has no
   * open artifact to close. Reading the log once on the first event restores the
   * ledger. The events are folded with the *live* fold (`historical:false`) but
   * with no draft emission: the store already holds (or the upcoming baseline
   * will raise) the artifacts, and a hydrate-then-emit would replay them.
   *
   * The prefix is strictly `seq < firstSeq`: the event that triggered hydration
   * is folded by the caller, so its own raise/close is never lost to the silent
   * prefix fold. A read failure is contained (reported) and leaves an empty
   * ledger, exactly the pre-hydration behaviour.
   */
  const hydrate = async (
    sessionId: string,
    info: CaptureSessionInfo,
    cut: number,
    firstSeq: number,
  ): Promise<void> => {
    const inFlight = hydrations.get(sessionId)
    if (inFlight !== undefined) {
      await inFlight
      return
    }
    const read = options.readSession
    if (read === undefined || states.has(sessionId)) return
    const task = (async () => {
      try {
        const events = await read(sessionId)
        let state = initialLedgerState(cut)
        let seen = -1
        for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
          if (event.seq >= firstSeq || event.seq <= seen) continue
          seen = event.seq
          if (event.seq < state.inheritedEventCount) continue
          state = foldOpenItemsEvent(state, event, info, source, undefined, false).state
        }
        states.set(sessionId, state)
        seenSeqs.set(sessionId, Math.max(seenSeqs.get(sessionId) ?? -1, seen))
      } catch (error) {
        report(error)
      } finally {
        hydrations.delete(sessionId)
      }
    })()
    hydrations.set(sessionId, task)
    await task
  }
  return {
    async driveSession(session, events) {
      const info = normalizeFoldSession(session)
      // D5 root-only: a subagent/delegated session owns no user decisions, so
      // its live events never produce drafts. The backfill applies the same
      // filter; drops are silent (a subagent log is not an error).
      if (!isRootSession(info)) {
        states.delete(info.sessionId)
        seenSeqs.delete(info.sessionId)
        return []
      }
      const cut = inheritedCountOf(session)
      // First event of a session this process has never folded: restore the
      // ledger from the committed log before folding the new event.
      const firstSeq = events[0]?.seq
      if (firstSeq !== undefined && !states.has(info.sessionId)) {
        await hydrate(info.sessionId, info, cut, firstSeq)
      }
      let state = states.get(info.sessionId) ?? initialLedgerState(cut)
      let seen = seenSeqs.get(info.sessionId) ?? -1
      const produced: DerivedItemDraft[] = []
      const evidence: CaptureEvidence[] = []
      // Per-turn final text: the extraction seam must judge a raise against the
      // message of *its own* turn, not whichever turn the batch happened to end
      // on. The fold keeps only the latest text, so it is snapshotted here.
      const turnText = new Map<number, string>()
      for (const event of events) {
        // A committed seq is folded once per session ledger: replaying a batch
        // (a duplicate live delivery, or a harness passing a whole log again)
        // must not re-raise an artifact the fold already reported.
        if (event.seq <= seen) continue
        seen = event.seq
        if (event.seq < state.inheritedEventCount) continue
        const step = foldOpenItemsEvent(state, event, info, source, undefined, false)
        state = step.state
        produced.push(...step.drafts)
        if (step.evidence !== undefined) evidence.push(...step.evidence)
        const lastText = state.prose.lastText
        if (lastText !== null) turnText.set(lastText.turn, lastText.text)
      }
      states.set(info.sessionId, state)
      seenSeqs.set(info.sessionId, seen)
      // Evidence lands before the drafts of the same batch: or a track-1 answer
      // recorded while the ask was live would be overwritten by the ask's own
      // detector closure before it could be acknowledged.
      if (evidence.length > 0 && options.sink?.applyEvidence !== undefined) {
        try {
          await options.sink.applyEvidence(evidence)
        } catch (error) {
          report(error)
        }
      }
      // The prose candidate gate is the one family that can be switched off
      // (D1/D2 default on); todo candidates are always emitted. Read the setting
      // per batch so a change applies without remounting the driver. The setting
      // suppresses raises only: a closure always passes, or an open candidate
      // could never close once the check is off (G6).
      const proseOn = proseCandidatesEnabled(options.settings)
      const workspace = resolveWorkspace(info.sessionId)
      const kept = produced
        .filter(draft => keepDraft(draft as OwnedDraft, options.isSessionRunning)
          && proseEmittedUnderSetting(draft, proseOn))
        .map(draft => withWorkspaceSnapshot(draft, workspace))
      // Model-assisted extraction runs on the live path only, after the setting
      // gate, and only for prose candidates (PLAN §12.4). The seam is absent by
      // default, and when it is absent this stays synchronous with the old
      // pipeline (no extra microtask, no behaviour change); backfill deliberately
      // does not extract: historical candidates stay gate-only (cost/privacy).
      const emitted = options.extraction === undefined
        ? kept
        : await extractProseDrafts(kept, info.sessionId, turnText, state.prose.lastText?.text ?? '')
      queue.push(...emitted)
      await drain()
      return emitted
    },
    async flush() {
      await drain()
    },
    forgetSession(sessionId) {
      states.delete(sessionId)
      seenSeqs.delete(sessionId)
    },
  }
}

/** Structural session-list service used by the roster probe. */
interface SessionListLike {
  list(request: unknown, signal: AbortSignal): Promise<{ items: readonly { sessionId?: unknown; running?: unknown }[] }>
}

/** Structural projection registry used by the optional registration. */
export interface ProjectionRegistryLike {
  register(definition: ProjectionUnitLike<LedgerState>): unknown
}

/** Read the workspace registry lazily (the lens is optional). */
function findSessionList(get: (name: string) => unknown): SessionListLike | undefined {
  const candidate = get('sessionController')
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const list = (candidate as { list?: unknown }).list
  if (typeof list !== 'function') return undefined
  return candidate as SessionListLike
}

/** Read the session-projection registry, or undefined when the profile omits it. */
export function findProjectionRegistry(get: (name: string) => unknown): ProjectionRegistryLike | undefined {
  const candidate = get('sessionProjections')
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const register = (candidate as { register?: unknown }).register
  if (typeof register !== 'function') return undefined
  return candidate as ProjectionRegistryLike
}

/** Upper bound on in-memory live-ask observations (diagnostics only; nothing persists). */
const MAX_LIVE_ASKS = 200

/** Mutable live-ask registry the capture wiring provides for the reply bridge. */
interface LiveAskRegistry extends LiveAskCarrier {
  record(observation: LiveAskObservation): void
  settle(sessionId: string, callId: string, outcome: string | undefined): void
}

/** One ask identity shared by the observers and the carrier. */
interface AskIdentity {
  readonly sessionId: string
  readonly callId: string
  readonly kind: 'approval' | 'question'
  readonly toolName?: string
}

/** Build the bounded, in-memory live-ask registry (never persisted). */
function createLiveAskRegistry(now: () => number): LiveAskRegistry {
  const asks = new Map<string, LiveAskObservation>()
  const key = (sessionId: string, callId: string): string => `${sessionId}\u0000${callId}`
  return {
    get(sessionId, callId) {
      return asks.get(key(sessionId, callId))
    },
    get observed() {
      return asks.size
    },
    record(observation) {
      while (asks.size >= MAX_LIVE_ASKS) {
        const oldest = asks.keys().next()
        if (oldest.done === true) break
        asks.delete(oldest.value)
      }
      asks.set(key(observation.sessionId, observation.callId), observation)
    },
    settle(sessionId, callId, outcome) {
      const current = asks.get(key(sessionId, callId))
      if (current === undefined) return
      asks.set(key(sessionId, callId), {
        ...current,
        state: 'settled',
        ...outcome === undefined ? {} : { outcome },
      })
    },
  }
}

/** Read a nested string member without assuming the runtime shape. */
function nestedString(value: unknown, ...path: readonly string[]): string | undefined {
  let current: unknown = value
  for (const step of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[step]
  }
  return typeof current === 'string' ? current : undefined
}

/** The ask identity an `approval/request` waterfall request carries. */
function approvalAskOf(request: unknown): AskIdentity | undefined {
  const sessionId = nestedString(request, 'agent', 'session', 'id')
  const callId = nestedString(request, 'callId')
  if (sessionId === undefined || callId === undefined) return undefined
  const toolName = nestedString(request, 'toolName')
  return { sessionId, callId, kind: 'approval', ...toolName === undefined ? {} : { toolName } }
}

/** The ask identity a `user-questions/request` waterfall request carries. */
function questionAskOf(request: unknown): AskIdentity | undefined {
  const sessionId = nestedString(request, 'agent', 'session', 'id')
  const callId = nestedString(request, 'wait', 'callId')
  if (sessionId === undefined || callId === undefined) return undefined
  return { sessionId, callId, kind: 'question' }
}

/** Listener shape of a Cordis waterfall hook. */
type WaterfallNext = () => Promise<unknown>
type WaterfallListener = (request: unknown, next: WaterfallNext) => Promise<unknown>

/**
 * Attach the observe-only ask observers (OD-14).
 *
 * Each listener records the ask identity and then delegates with `next()`
 * exactly once: it never claims the request, never prepends, never holds or
 * awaits the user, and returns the outcome it was given. Observation failures
 * are contained so a broken observer can never turn an ask into `unavailable`.
 * @param ctx - Host plugin context.
 * @param registry - live-ask carrier to populate.
 * @param now - injected clock (observation freshness).
 * @param report - contained error reporter.
 * @returns a detach function and whether at least one observer registered.
 */
function attachLiveAskObservers(
  ctx: Context,
  registry: LiveAskRegistry,
  now: () => number,
  report: (message: string, error: unknown) => void,
): { detach: () => void; registered: number } {
  const onWaterfall = (ctx as unknown as { on?: unknown }).on
  if (typeof onWaterfall !== 'function') return { detach: () => undefined, registered: 0 }
  const on = onWaterfall.bind(ctx) as (name: string, listener: WaterfallListener) => () => boolean
  const disposers: (() => boolean)[] = []
  const observe = (identity: AskIdentity | undefined, next: WaterfallNext): Promise<unknown> => {
    if (identity === undefined) return next()
    let observedAt = 0
    try {
      observedAt = now()
      registry.record({
        kind: identity.kind,
        sessionId: identity.sessionId,
        callId: identity.callId,
        ...identity.toolName === undefined ? {} : { toolName: identity.toolName },
        observedAt,
        state: 'pending',
      })
    } catch (error) {
      // Observation is best-effort; the ask itself must proceed untouched.
      try {
        report('live ask observation failed', error)
      } catch {
        // Reporting must not break the waterfall either.
      }
    }
    const settle = (outcome: unknown): void => {
      try {
        registry.settle(identity.sessionId, identity.callId, typeof outcome === 'string' ? outcome : undefined)
      } catch {
        // Same containment as above.
      }
    }
    try {
      return Promise.resolve(next()).then(
        (outcome) => {
          settle(outcome)
          return outcome
        },
        (error: unknown) => {
          settle(undefined)
          throw error
        },
      )
    } catch (error) {
      settle(undefined)
      throw error
    }
  }
  try {
    disposers.push(on('approval/request', (request, next) => {
      let identity: AskIdentity | undefined
      try {
        identity = approvalAskOf(request)
      } catch {
        identity = undefined
      }
      return observe(identity, next)
    }))
  } catch (error) {
    report('approval/request observer unavailable', error)
  }
  try {
    disposers.push(on('user-questions/request', (request, next) => {
      let identity: AskIdentity | undefined
      try {
        identity = questionAskOf(request)
      } catch {
        identity = undefined
      }
      return observe(identity, next)
    }))
  } catch (error) {
    report('user-questions/request observer unavailable', error)
  }
  return {
    registered: disposers.length,
    detach: () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // Detach must never throw out of plugin teardown.
        }
      }
    },
  }
}

/** Build the orphan gate from a roster service; absent capability means "unknown". */
function createRosterGate(options: {
  provided?: (sessionId: string) => boolean | undefined
  sessionList?: SessionListLike
  now: () => number
  ttlMs?: number
  onError?: (error: unknown) => void
}): { isRunning: (sessionId: string) => boolean | undefined; refresh: () => Promise<void> } {
  if (options.provided !== undefined) {
    return { isRunning: options.provided, refresh: async () => undefined }
  }
  const list = options.sessionList
  if (list === undefined) return { isRunning: () => undefined, refresh: async () => undefined }
  const cache = new Map<string, boolean>()
  let refreshedAt = Number.NEGATIVE_INFINITY
  let refreshing: Promise<void> | undefined
  const ttlMs = options.ttlMs ?? 60_000
  const refresh = async (): Promise<void> => {
    if (refreshing !== undefined) return refreshing
    const controller = new AbortController()
    refreshing = (async () => {
      try {
        const value = await list.list({}, controller.signal)
        cache.clear()
        for (const row of value.items) {
          if (typeof row.sessionId === 'string') cache.set(row.sessionId, row.running === true)
        }
        refreshedAt = options.now()
      } catch (error) {
        try {
          options.onError?.(error)
        } catch {
          // Reporting must not break the gate.
        }
      } finally {
        refreshing = undefined
      }
    })()
    return refreshing
  }
  return {
    isRunning: (sessionId: string): boolean | undefined => {
      const cached = cache.get(sessionId)
      if (cached !== undefined) return cached
      if (options.now() - refreshedAt > ttlMs) void refresh()
      return undefined
    },
    refresh,
  }
}

/** Options for mounting the capture engine on a Host context. */
export interface OpenItemsCaptureOptions {
  /** Durable sink implemented by the store/service branch. */
  readonly sink: CaptureSink
  /** Cold-session read/roster/workspace seam for the backfill pass. */
  readonly context: CaptureContext
  /** Durable cursor table; defaults to in-memory so backfill still runs. */
  readonly cursors?: DetectionCursorStore
  /** Override the orphan gate (tests, or a caller with better liveness data). */
  readonly isSessionRunning?: (sessionId: string) => boolean | undefined
  /**
   * Override the workspace membership resolver the live driver stamps on drafts.
   * Defaults to the Host `workspaceRegistry` seam (membership by
   * `workspace.sessionIds`, never `cwd`); absent leaves items ungrouped.
   */
  readonly workspaceOf?: (sessionId: SessionId) => WorkspaceRef | undefined
  readonly limits?: Partial<BackfillLimits>
  readonly now?: () => number
  /** Run the bounded backfill on activation (default true). */
  readonly autoBackfill?: boolean
  /**
   * Runtime settings reader (PLAN §8): when `proseCandidates` is false the
   * driver and the backfill stop emitting prose candidates. Absent = on.
   */
  readonly settings?: () => CaptureRuntimeSettings
  /**
   * Period of the bounded re-scan after activation, in milliseconds (PLAN §8).
   * Defaults to {@link DEFAULT_RESCAN_INTERVAL_MS}; `false` disables it. The
   * timer is unref'd and cleared on dispose, and it is only armed when the
   * activation pass is enabled.
   */
  readonly rescanIntervalMs?: number | false
  /**
   * Optional model-assisted extraction seam (PLAN §12.4/§12.5, opt-in): passed
   * to the live driver, so a prose candidate may be confirmed, refined or
   * dropped before it reaches the sink. Absent = gate-only capture; the
   * backfill never extracts.
   */
  readonly extraction?: (input: ProseExtractionInput) => Promise<ProseExtractionVerdict | undefined>
  /**
   * Durable report sink for every completed backfill pass (PLAN §12.4/§12.5):
   * called once per pass with the trigger that started it ('activation' for the
   * mount pass and manual `backfillNow()` calls, 'rescan' for the periodic
   * timer). Contained: it must never block or abort capture, and a throwing
   * callback is reported through `onError`.
   */
  readonly reportBackfill?: (report: BackfillReport, trigger: BackfillTrigger) => void
  readonly onError?: (error: unknown) => void
}

/** What the mounted capture engine actually wired. */
export interface OpenItemsCapture {
  /** Whether the session-projection unit was registered. */
  readonly projection: boolean
  /** Whether the live `session/event` drive was attached. */
  readonly live: boolean
  /** Whether the observe-only ask observers registered (never claim or hold). */
  readonly observeLiveAsks: boolean
  /** Whether a backfill context was available. */
  readonly backfill: boolean
  /** Run (or join) the single in-flight backfill pass. */
  backfillNow(): Promise<BackfillReport | undefined>
  /** Detach the live drive and flush queued drafts. */
  dispose(): Promise<void>
}

/**
 * Mount the capture engine on a Host context.
 *
 * Every capability is probed with `ctx.get` and skipped when absent, so the
 * plugin still loads in a profile that composes only the store. Activation never
 * awaits the backfill: the pass is started and left to finish in the background.
 * @param ctx - Host plugin context.
 * @param options - sink, cold-read seam and optional overrides.
 * @returns the wiring report and lifecycle handles.
 */
export function registerOpenItemsCapture(ctx: Context, options: OpenItemsCaptureOptions): OpenItemsCapture {
  const now = options.now ?? Date.now
  const logger = ctx.logger('open-items')
  const report = (message: string, error: unknown): void => {
    try {
      options.onError?.(error)
    } catch {
      // Reporting must not throw into a session dispatch.
    }
    try {
      logger.warn('%s: %s', message, error instanceof Error ? error.message : String(error))
    } catch {
      // A logger failure is not a capture failure.
    }
  }

  // --- orphan gate: explicit dep first, then the Session roster ---------------
  const registry = findProjectionRegistry(name => ctx.get(name))
  const sessionList = findSessionList(name => ctx.get(name))
  const roster = createRosterGate({
    ...options.isSessionRunning === undefined ? {} : { provided: options.isSessionRunning },
    ...sessionList === undefined ? {} : { sessionList },
    now,
    onError: error => { report('session roster refresh failed', error) },
  })
  // --- driver + sink bridge ---------------------------------------------------
  // Live drafts are stamped with the same workspace snapshot the backfill
  // resolves, so an item captured after install groups under its workspace
  // instead of falling to Ungrouped (P0-04c). Built from the Host registry seam;
  // absent capability simply means "no workspace lens".
  const workspaceOf = options.workspaceOf ?? createHostWorkspaceResolver(ctx)
  const driver = createCaptureDriver({
    sink: options.sink,
    source: 'projection',
    now,
    isSessionRunning: roster.isRunning,
    ...workspaceOf === undefined ? {} : { workspaceOf },
    // Hydration reads the committed log once per session on its first live
    // event, so a closing detector after a restart is not lost (PLAN §8).
    readSession: sessionId => options.context.readSession(sessionId),
    ...options.settings === undefined ? {} : { settings: options.settings },
    // Opt-in extraction applies to live prose candidates only (PLAN §12.4).
    ...options.extraction === undefined ? {} : { extraction: options.extraction },
    onError: error => { report('sink write failed', error) },
  })

  // --- optional projection unit ----------------------------------------------
  let projection = false
  if (registry !== undefined) {
    try {
      const result = registry.register(openItemsProjection)
      const thenable = result as { catch?: unknown } | undefined
      if (typeof thenable?.catch === 'function') {
        void (result as Promise<unknown>).catch((error: unknown) => {
          report('projection registration failed', error)
        })
      }
      projection = true
    } catch (error) {
      report('projection registration failed', error)
    }
  }

  // --- live drive over committed events --------------------------------------
  let live = false
  let detach: (() => void) | undefined
  try {
    detach = ctx.on('session/event', (session, event) => {
      void driver.driveSession(session, [event]).catch((error: unknown) => {
        report('live fold failed', error)
      })
    })
    live = true
  } catch (error) {
    report('live session drive unavailable', error)
  }

  // --- observe-only live asks (OD-14) ---------------------------------------
  // The pending row itself comes from the log fold (`approval/asked`,
  // `tool/call`); these observers add the carrier the reply bridge uses for the
  // track-1 "is the ask still live" re-read. They never claim, prepend or hold.
  const liveAsks = createLiveAskRegistry(now)
  let observers: ReturnType<typeof attachLiveAskObservers> = { detach: () => undefined, registered: 0 }
  try {
    observers = attachLiveAskObservers(ctx, liveAsks, now, report)
  } catch (error) {
    report('live ask observers unavailable', error)
  }
  const observeLiveAsks = observers.registered > 0
  if (observeLiveAsks) {
    try {
      ctx.effect(() => {
        const dispose = ctx.reflect.provide(LIVE_ASKS_SERVICE, liveAsks)
        return () => { dispose() }
      }, 'open-items: live ask carrier')
    } catch (error) {
      report('live ask carrier unavailable', error)
    }
  }

  // --- bounded backfill -------------------------------------------------------
  const cursors = options.cursors ?? new InMemoryDetectionCursorStore()
  /**
   * Hand one completed pass to the durable-report hook without letting the hook
   * affect capture: a throwing callback is contained and reported (§12.4).
   */
  const reportPass = (reportValue: BackfillReport, trigger: BackfillTrigger): void => {
    const callback = options.reportBackfill
    if (callback === undefined) return
    try {
      callback(reportValue, trigger)
    } catch (error) {
      report('backfill report failed', error)
    }
  }
  let inFlight: Promise<BackfillReport> | undefined
  const runBackfillPass = async (trigger: BackfillTrigger): Promise<BackfillReport | undefined> => {
    // A pass already in flight is joined, not restarted; its own trigger owns
    // the single report for that pass (no duplicate report on join).
    if (inFlight !== undefined) return inFlight
    inFlight = (async () => {
      try {
        await roster.refresh()
        const result = await runBackfill({
          context: options.context,
          sink: options.sink,
          cursors,
          source: 'log-fold',
          ...options.limits === undefined ? {} : { limits: options.limits },
          // The settings gate applies to cold emission too: a rescan must not
          // reintroduce prose candidates the user switched off.
          ...options.settings === undefined ? {} : { settings: options.settings },
          now,
        })
        // The callback runs after the pass has fully settled (cursors written,
        // drafts accepted) so the durable record can never describe a pass that
        // later failed.
        reportPass(result, trigger)
        return result
      } finally {
        inFlight = undefined
      }
    })()
    try {
      return await inFlight
    } catch (error) {
      report('backfill failed', error)
      return undefined
    }
  }
  /**
   * Public pass entry point. A manual run reports as an activation-triggered
   * pass (the report's trigger vocabulary is exactly activation/rescan); the
   * mount pass and the periodic timer call `runBackfillPass` directly.
   */
  const backfillNow = (): Promise<BackfillReport | undefined> => runBackfillPass('activation')
  if (options.autoBackfill !== false) void runBackfillPass('activation')

  // Periodic bounded re-scan (PLAN §8): the activation pass runs once, but a
  // session that gains foldable events afterwards and is not live-observed in
  // this process would otherwise wait for the next restart. Unref'd so a timer
  // never keeps the process alive, and cleared on dispose.
  let rescan: ReturnType<typeof setInterval> | undefined
  const rescanIntervalMs = options.rescanIntervalMs === undefined
    ? DEFAULT_RESCAN_INTERVAL_MS
    : options.rescanIntervalMs
  if (options.autoBackfill !== false && rescanIntervalMs !== false && rescanIntervalMs > 0) {
    try {
      rescan = setInterval(() => { void runBackfillPass('rescan') }, rescanIntervalMs)
      ;(rescan as { unref?: () => void }).unref?.()
    } catch (error) {
      report('periodic rescan unavailable', error)
    }
  }

  return {
    projection,
    live,
    observeLiveAsks,
    backfill: true,
    backfillNow,
    async dispose() {
      if (rescan !== undefined) {
        clearInterval(rescan)
        rescan = undefined
      }
      detach?.()
      detach = undefined
      observers.detach()
      // Let an in-flight periodic pass finish against the still-open store
      // instead of racing plugin teardown; failures are already contained.
      if (inFlight !== undefined) {
        try {
          await inFlight
        } catch {
          // The pass reports its own failures; teardown must not throw.
        }
      }
      await driver.flush()
    },
  }
}
