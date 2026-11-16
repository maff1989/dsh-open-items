/**
 * The aggregate open-items log fold.
 *
 * One pure synchronous pass over a session's committed events. Each artifact
 * family (approval, question/plan review, interrupted turn, goal, background
 * job, prose decision request, abandoned plan) is a small handler with its own
 * state slice and its own closing detector, so the fold can never produce an
 * item nothing can close.
 *
 * Contract rules this module keeps:
 * - **Totality:** a malformed or unknown payload never throws; the handler
 *   simply does not apply.
 * - **Same-reference returns:** an uninteresting event returns the previous
 *   state by reference, which is what suppresses downstream projection work.
 * - **Fork cut:** events with `seq < inheritedEventCount` are skipped, so an
 *   item inherited from a parent session is never re-raised in the child.
 * - **Plain JSON state:** the state is checkpointable beside a detection cursor.
 *
 * The team-task family is deliberately **not dispatched** (decision D5): its
 * liveness gate is frozen at activation and manufactures false "stalled" rows
 * (GAP-ANALYSIS G-03/G-06). The module and its unit tests stay exported for the
 * redesigned gate; no live or cold fold raises a task item today.
 *
 * @module dsh-open-items/host/folds
 */

import type { CaptureEvent, CaptureEvidence, CaptureSessionInfo, DerivedItemDraft, FoldDefinition, FoldState } from '../capture-contract'
import type { DetectionSource } from '../../shared/schema'
import { type FoldStep, type OwnedDraft, openDraft } from './drafts'
import { foldApproval } from './approval'
import { foldGoal } from './goal'
import { foldInterrupted, turnOfEvent } from './interrupted'
import { foldQuestions, toolResultCallId } from './questions'
import { finalizeJobs, foldJobs } from './jobs'
import { finalizeProse, foldProse, markStructuralTurn } from './prose'
import { foldTodo, finalizeTodo } from './todo'
import { foldEvidence } from './evidence'
import { initialLedgerState, type LedgerState, readLedgerState } from './state'
import { isRecord, numberOf, OPEN_ITEMS_FOLD_VERSION, recordOf, textOf } from './limits'

export type { LedgerState, OpenArtifact } from './state'
export { initialLedgerState, readLedgerState } from './state'

/**
 * Capture metadata normalised from whichever session record a driver was handed.
 *
 * A live `Session` keeps its durable facts in `session.header` (`id`,
 * `createdAt`, `cwd`, `origin`, `delegationDepth`, `parentSession`), while the
 * acceptance harness passes either a flat record or a `{ info }` wrapper. The
 * extra fields are capture-internal: they are read for root detection and
 * provenance, not part of the persisted item contract.
 */
export interface NormalizedFoldSession extends CaptureSessionInfo {
  /** Creation time from the durable header (live) or the flat record. */
  readonly createdAt?: number
  /**
   * Direct creator of a subagent Session. **Presence alone does not classify a
   * Session as non-root** (an ordinary fork may retain it), so the root gate
   * never keys on this field; it is carried for provenance only.
   */
  readonly parentSession?: string
}

/** Normalise whatever session record a driver hands the fold into capture metadata. */
export function normalizeFoldSession(session: unknown): NormalizedFoldSession {
  const record = isRecord(session) ? session : {}
  const header = isRecord(record['header']) ? record['header'] : undefined
  // The M1 acceptance harness wraps metadata as `{ info }`; live drivers pass the
  // flat record. Both are read here so the fold has one shape to work with. A
  // live `Session` nests the durable facts one level deeper, in `header`.
  const nested = isRecord(record['info']) ? record['info'] : record
  const sessionId = textOf(nested['sessionId'])
    ?? textOf(nested['id'])
    ?? (header === undefined ? undefined : textOf(header['id']))
    ?? ''
  const createdAt = numberOf(nested['createdAt'])
    ?? (header === undefined ? undefined : numberOf(header['createdAt']))
  const cwd = textOf(nested['cwd'])
    ?? (header === undefined ? undefined : textOf(header['cwd']))
  const title = textOf(nested['title'])
  const delegationDepth = numberOf(nested['delegationDepth'])
    ?? (header === undefined ? undefined : numberOf(header['delegationDepth']))
  // `origin` is the only classification DSH defines for a subagent session; a
  // `parentSession` id on an ordinary fork must not demote a root session.
  const origin = nested['origin'] === 'subagent' || header?.['origin'] === 'subagent'
    ? 'subagent' as const
    : undefined
  const parentSession = textOf(nested['parentSession'])
    ?? (header === undefined ? undefined : textOf(header['parentSession']))
  const lastActivityAt = numberOf(nested['lastActivityAt'])
  return {
    sessionId,
    updatedAt: numberOf(nested['updatedAt']) ?? createdAt ?? 0,
    archived: nested['archived'] === true,
    ...title === undefined ? {} : { title },
    ...cwd === undefined ? {} : { cwd },
    ...delegationDepth === undefined ? {} : { delegationDepth },
    ...origin === undefined ? {} : { origin },
    ...createdAt === undefined ? {} : { createdAt },
    ...parentSession === undefined ? {} : { parentSession },
    ...lastActivityAt === undefined ? {} : { lastActivityAt },
  }
}

/** Apply the turn bookkeeping that every family depends on. */
function withTurnBookkeeping(state: LedgerState, event: CaptureEvent): LedgerState {
  if (event.type === 'turn/start') {
    const turn = turnOfEvent(event.data)
    if (turn === undefined || turn === state.currentTurn) return state
    return { ...state, currentTurn: turn }
  }
  if (event.type === 'turn/end') return state.currentTurn === null ? state : { ...state, currentTurn: null }
  return state
}

/** One artifact family's fold handler. */
type FoldHandler = (
  state: LedgerState,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
) => FoldStep | undefined

/**
 * The dispatched families, in state-dependency order.
 *
 * Team-task alerts are disabled by decision D5 (see the module comment): the
 * fold exists, is unit-tested, and is intentionally absent from this table.
 */
const FOLD_HANDLERS: readonly FoldHandler[] = [
  foldQuestions,
  foldInterrupted,
  foldApproval,
  foldGoal,
  foldJobs,
  foldProse,
  foldTodo,
]

/**
 * Fold one committed event through every artifact family.
 * @param state - previous ledger state.
 * @param event - next committed event, in seq order.
 * @param session - owning session metadata (stamped on drafts).
 * @param source - detector source to stamp on drafts.
 * @param now - retained clock argument: the dispatched families timestamp from
 *   the event, so the positional signature stays for callers that pass it (the
 *   disabled team-task family was its only reader).
 * @param historical - true for a cold-log sweep (suppresses live-only raises).
 * @returns the next state and every draft the event produced.
 */
export function foldOpenItemsEvent(
  state: LedgerState,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
  now?: number,
  historical?: boolean,
): FoldStep {
  // Fork cut: the inherited prefix belongs to the parent's items, not this one.
  if (event.seq < state.inheritedEventCount) return { state, drafts: [] }
  const withTurn = withTurnBookkeeping(state, event)
  // Evidence is read from the pre-step ledger: the artifact families remove
  // their pending entries in this same event, and the ask identity is what the
  // delivery/acknowledgement evidence needs.
  const evidence = foldEvidence(withTurn, event, session)
  // Handlers run in sequence over the evolving ledger, not over one shared
  // snapshot: two families may legitimately act on the same event (`turn/end`
  // raises unsettled jobs, a prose candidate and the abandoned-plan aggregate),
  // and a snapshot-per-handler dispatch would silently drop every earlier
  // family's state change (the drafts survived, their ledger entries did not).
  let next = withTurn
  const drafts: OwnedDraft[] = []
  for (const handler of FOLD_HANDLERS) {
    const step = handler(next, event, session, source)
    if (step === undefined) continue
    next = step.state
    drafts.push(...step.drafts)
  }
  // Prose gate rule 3: remember the turn whose fold raised a blocking structural
  // item, so the turn's prose cannot duplicate it as a candidate. Read from the
  // raw drafts (not the historical filter): a structural raise still happened
  // even when a cold read suppresses its live-only emission. On `turn/end`
  // `currentTurn` has already been cleared, so the event's own turn number is the
  // marker — otherwise a turn/end-raised blocking item could never set it (G16).
  const structuralTurn = event.type === 'turn/end'
    ? numberOf(recordOf(event.data)?.['turn'])
    : withTurn.currentTurn
  if (structuralTurn !== null && structuralTurn !== undefined
    && drafts.some(draft => draft.closes === undefined && draft.blocking === true)) {
    next = markStructuralTurn(next, structuralTurn)
  }
  // A live-only artifact (a pending ask) is truthful only while it is observed
  // live: a cold-log fold must not raise it, or every boot would resurrect an
  // ask whose card is long gone. Closures of it still pass, so a decided ask
  // closes a stale live row.
  const emitted = historical === true
    ? drafts.filter(draft => draft.liveOnly !== true)
    : drafts
  // A result answers its call for every family; handlers read the call first.
  if (event.type === 'tool/result') {
    const callId = toolResultCallId(event.data)
    const pending = callId === undefined ? undefined : next.calls[callId]
    if (callId !== undefined && pending !== undefined) {
      const calls = { ...next.calls }
      delete calls[callId]
      next = { ...next, calls }
    }
  }
  const lastSeq = Math.max(next.lastSeq, event.seq)
  if (next === state && emitted.length === 0 && evidence.length === 0) {
    return { state, drafts: [] }
  }
  return {
    state: next.lastSeq === lastSeq ? next : { ...next, lastSeq },
    drafts: emitted,
    ...evidence.length === 0 ? {} : { evidence },
  }
}

/**
 * Raise whatever the log end leaves open.
 *
 * A log that ends inside a turn never appended the `turn/end` that normally
 * raises unsettled background jobs, an abandoned plan or the turn's prose asks,
 * so the backfill and the cold projection read call this after the last event.
 * @param state - ledger after the last event.
 * @param session - owning session metadata.
 * @param source - detector source to stamp on drafts.
 * @param at - event time to stamp on the raised artifacts.
 * @returns the next state and the finalized drafts (possibly none).
 */
export function finalizeOpenItems(
  state: LedgerState,
  session: CaptureSessionInfo,
  source: DetectionSource,
  at: number,
): FoldStep {
  let next = state
  const drafts: DerivedItemDraft[] = []
  for (const finalize of [finalizeJobs, finalizeTodo, finalizeProse]) {
    const step = finalize(next, session, source, at)
    if (step === undefined) continue
    next = step.state
    drafts.push(...step.drafts)
  }
  if (next === state && drafts.length === 0) return { state, drafts: [] }
  return { state: next, drafts }
}

/**
 * Open drafts for every artifact the fold still considers open.
 *
 * The backfill baseline uses this: on first contact with a historical log the
 * useful output is the set of items still open, not the resolution history of
 * every ask the session already answered (a store has nothing to close yet).
 * @param state - folded ledger state.
 * @param session - owning session metadata.
 * @param source - detector source to stamp on drafts.
 * @returns one draft per open artifact, in stable artifact-id order.
 */
export function openDraftsOf(
  state: LedgerState,
  session: CaptureSessionInfo,
  source: DetectionSource,
): OwnedDraft[] {
  return Object.keys(state.items)
    .sort()
    .map(artifactId => state.items[artifactId] as NonNullable<LedgerState['items'][string]>)
    // A first contact with a historical log cannot raise a live-only pending
    // ask: the ask is not live, so the row would be a permanent falsehood.
    .filter(artifact => artifact.liveOnly !== true)
    .map(artifact => openDraft(artifact, { session, source }))
}

/** The contract fold definition plus the initial-state factory a driver needs. */
export interface OpenItemsFoldDefinition extends FoldDefinition {
  /** Initial state for a session with the given inherited-prefix length. */
  readonly initial: (inheritedEventCount?: number) => FoldState
}

/**
 * Build the contract-facing fold definition.
 *
 * The definition carries no source: the projection unit and the backfill pass
 * have different detector provenance, so each captures the source in a factory
 * call instead of in the shared definition. The zero-argument form is the
 * acceptance-harness entry point and reports `log-fold`.
 * @param source - detector source stamped on every draft.
 * @returns the fold definition the capture wiring drives.
 */
export function createOpenItemsFold(
  source: DetectionSource = 'log-fold',
  options: { readonly now?: () => number; readonly historical?: boolean } = {},
): OpenItemsFoldDefinition {
  const now = options.now ?? (() => Date.now())
  return {
    foldVersion: OPEN_ITEMS_FOLD_VERSION,
    initial: (inheritedEventCount = 0) => initialLedgerState(inheritedEventCount),
    fold: (state: FoldState, event: CaptureEvent, session: CaptureSessionInfo) => {
      const step = foldOpenItemsEvent(readLedgerState(state), event, normalizeFoldSession(session), source, now(), options.historical === true)
      return {
        state: step.state,
        result: { drafts: step.drafts, throughSeq: event.seq },
      }
    },
  }
}

/** Initial fold state by its acceptance-harness name. */
export function initialFoldState(inheritedEventCount = 0): FoldState {
  return initialLedgerState(inheritedEventCount)
}

