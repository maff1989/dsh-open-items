/**
 * Plain-JSON fold state shared by the projection unit and the backfill pass.
 *
 * The state must survive the projection cache and a detection cursor, so it is
 * plain JSON with no `Map`/`Set`. Every reader normalises a partially written
 * state (the projection cache may seed a row from an older build), which keeps
 * the folds total: an unreadable sub-state degrades to "nothing known yet".
 *
 * @module dsh-open-items/host/folds/state
 */

import type { FoldState } from '../capture-contract'
import type { DetectionSource, OpenItemKind, OpenItemTier, Severity, ReplyDescriptor } from '../../shared/schema'
import { arrayOf, isRecord, numberOf, recordOf, textOf } from './limits'

/** One item the fold currently considers open. */
export interface OpenArtifact {
  readonly artifactId: string
  readonly kind: OpenItemKind
  /** Policy tier override; absent means `structural` (the detector families' default). */
  readonly tier?: OpenItemTier
  readonly severity: Severity
  /** Seq of the evidence event that raised it. */
  readonly seq: number
  readonly turn?: number
  readonly title: string
  readonly body: string
  readonly quote?: string
  readonly callId?: string
  readonly approvalId?: string
  readonly goalId?: string
  readonly goalRevision?: number
  readonly taskId?: string
  readonly jobId?: string
  /** Owning Session of a team task; capture-internal, used for the orphan gate. */
  readonly ownerSessionId?: string
  /** Detector that raised it, e.g. `approval/decided:unavailable`. */
  readonly detectorCode: string
  /**
   * Detector provenance override; absent stamps the driver's source. The prose
   * candidate is produced by the regex gate, not by the projection/backfill read,
   * so it names itself in the design's detection-source vocabulary.
   */
  readonly detectedBy?: readonly DetectionSource[]
  /** True when the agent said it is waiting on this to continue. */
  readonly blocking: boolean
  readonly reply?: Partial<ReplyDescriptor>
  /** Wall-clock time of the evidence event. */
  readonly raisedAt: number
  /**
   * True for a pending ask that is only truthful while observed live: a
   * historical log read must not raise it (no card, nobody waiting).
   */
  readonly liveOnly?: boolean
}

/**
 * The final assistant text of the turn, kept only until the turn ends.
 *
 * `text` is the **raw** text with newlines preserved, bounded to the last
 * `PROSE_LIMITS.textChars` characters on a line boundary (`tailBoundLines`):
 * the gate parses block structure (a trailing ask heading and its list items),
 * so collapsing newlines before the bound would destroy the very structure it
 * reads. A legacy checkpoint that holds a single-line 1200-character value still
 * parses — it simply finds no section and falls back to the prose tail test.
 */
export interface ProseTurnText {
  readonly turn: number
  readonly seq: number
  readonly at: number
  readonly text: string
}

/** Prose candidate-gate state slice (PLAN-remediation §4). */
export interface ProseFoldState {
  /** Final assistant text of the open turn, or null between turns. */
  readonly lastText: ProseTurnText | null
  /**
   * Turn whose fold already raised a blocking structural item. The prose gate
   * does not fire for that turn: a structural detector already carries it.
   */
  readonly structuralTurn: number | null
}

/** The last `todo/write` snapshot of the session (PLAN-remediation §5). */
export interface TodoSnapshot {
  readonly seq: number
  readonly at: number
  /** Unfinished items (status `pending` or `in_progress`). */
  readonly pending: number
  /** Up to `TODO_LIMITS.maxLabels` unfinished labels, bounded in length. */
  readonly items: readonly string[]
}

/** One `tool/call` this fold tracks until its `tool/result` lands. */
export interface PendingCall {
  readonly name: string
  readonly turn: number
  readonly seq: number
  /** Present only for an `ask_user_question` / `exit_plan_mode` call. */
  readonly intent?: 'question' | 'plan-review'
}

/** One `approval/asked` awaiting its `approval/decided`. */
export interface PendingApproval {
  readonly toolName: string
  readonly seq: number
  readonly callId?: string
  readonly reason?: string
}

/** One `job/registered` awaiting its `job/settled`. */
export interface OpenJob {
  readonly label: string
  readonly kind: string
  readonly seq: number
  /** Already raised as an item (raised at the owning turn's end, not on registration). */
  readonly raised: boolean
}

/** One synthetic `TOOL_OUTCOME_UNKNOWN` result whose outcome is still unverified. */
export interface InterruptedCall {
  readonly name: string
  readonly seq: number
  readonly turn: number
  readonly at: number
}

/** The complete fold state for one Session. */
export interface LedgerState extends FoldState {
  /** Fork cut: events at or below this index are inherited and never folded. */
  readonly inheritedEventCount: number
  /** Highest event seq folded so far. */
  readonly lastSeq: number
  /** The open turn number, or `null` between turns. */
  readonly currentTurn: number | null
  readonly calls: Record<string, PendingCall>
  readonly approvals: Record<string, PendingApproval>
  readonly jobs: Record<string, OpenJob>
  readonly interrupted: Record<string, InterruptedCall>
  readonly items: Record<string, OpenArtifact>
  /** Prose candidate gate: the turn's final assistant text and rule-3 marker. */
  readonly prose: ProseFoldState
  /** Last `todo/write` whole-list snapshot, or null before the first write. */
  readonly todo: TodoSnapshot | null
}

/** State for a session with no folded events yet. */
export function initialLedgerState(inheritedEventCount = 0): LedgerState {
  return {
    inheritedEventCount: Math.max(0, Math.trunc(inheritedEventCount)),
    lastSeq: -1,
    currentTurn: null,
    calls: {},
    approvals: {},
    jobs: {},
    interrupted: {},
    items: {},
    prose: { lastText: null, structuralTurn: null },
    todo: null,
  }
}

/** Narrow one ledger map, dropping malformed entries. */
function readMap<T>(
  value: unknown,
  read: (entry: Record<string, unknown>) => T | undefined,
): Record<string, T> {
  const source = recordOf(value)
  const result: Record<string, T> = {}
  if (source === undefined) return result
  for (const key of Object.keys(source)) {
    const entry = recordOf(source[key])
    if (entry === undefined) continue
    const read_ = read(entry)
    if (read_ !== undefined) result[key] = read_
  }
  return result
}

/** Every detection source the shared schema recognises. */
const DETECTION_SOURCES: ReadonlySet<string> = new Set<DetectionSource>([
  'projection',
  'log-fold',
  'regex-gate',
  'llm',
  'tool',
  'user',
])

/** Normalise a persisted `detectedBy` list, dropping unknown entries. */
function detectionSourcesOf(value: unknown): readonly DetectionSource[] | undefined {
  const sources: DetectionSource[] = []
  for (const entry of arrayOf(value)) {
    if (typeof entry !== 'string' || !DETECTION_SOURCES.has(entry)) continue
    if (!sources.includes(entry as DetectionSource)) sources.push(entry as DetectionSource)
  }
  return sources.length === 0 ? undefined : sources
}

/** Normalise the prose-gate slice; a partially written state reads as empty. */
function readProseState(value: unknown): ProseFoldState {
  const source = recordOf(value)
  const last = recordOf(source?.['lastText'])
  const turn = numberOf(last?.['turn'])
  const seq = numberOf(last?.['seq'])
  const at = numberOf(last?.['at'])
  const text = textOf(last?.['text'])
  const lastText = turn === undefined || seq === undefined || at === undefined || text === undefined
    ? null
    : { turn: Math.trunc(turn), seq: Math.trunc(seq), at, text }
  const structuralTurn = numberOf(source?.['structuralTurn'])
  return {
    lastText,
    structuralTurn: structuralTurn === undefined ? null : Math.trunc(structuralTurn),
  }
}

/** Normalise the todo snapshot; a partially written state reads as "none yet". */
function readTodoState(value: unknown): TodoSnapshot | null {
  const source = recordOf(value)
  if (source === undefined) return null
  const seq = numberOf(source['seq'])
  const at = numberOf(source['at'])
  const pending = numberOf(source['pending'])
  if (seq === undefined || at === undefined || pending === undefined) return null
  const items: string[] = []
  for (const entry of arrayOf(source['items'])) {
    const label = textOf(entry)
    if (label !== undefined) items.push(label)
  }
  return { seq: Math.trunc(seq), at, pending: Math.max(0, Math.trunc(pending)), items }
}

/**
 * Normalise an arbitrary fold state into a ledger.
 *
 * Total by construction: a state written by an older fold version, a partially
 * initialised state, or `{}` all read as the empty ledger.
 * @param state - the raw state handed to a fold.
 * @returns a complete ledger state.
 */
export function readLedgerState(state: FoldState): LedgerState {
  const source = isRecord(state) ? state : {}
  return {
    inheritedEventCount: Math.max(0, Math.trunc(numberOf(source['inheritedEventCount']) ?? 0)),
    lastSeq: Math.trunc(numberOf(source['lastSeq']) ?? -1),
    currentTurn: typeof source['currentTurn'] === 'number' ? source['currentTurn'] : null,
    prose: readProseState(source['prose']),
    todo: readTodoState(source['todo']),
    calls: readMap(source['calls'], entry => {
      const name = textOf(entry['name'])
      const turn = numberOf(entry['turn'])
      const seq = numberOf(entry['seq'])
      if (name === undefined || turn === undefined || seq === undefined) return undefined
      const intent = entry['intent'] === 'plan-review' ? 'plan-review' : entry['intent'] === 'question' ? 'question' : undefined
      return { name, turn, seq, ...intent === undefined ? {} : { intent } }
    }),
    approvals: readMap(source['approvals'], entry => {
      const toolName = textOf(entry['toolName'])
      const seq = numberOf(entry['seq'])
      if (toolName === undefined || seq === undefined) return undefined
      return {
        toolName,
        seq,
        ...textOf(entry['callId']) === undefined ? {} : { callId: textOf(entry['callId']) },
        ...textOf(entry['reason']) === undefined ? {} : { reason: textOf(entry['reason']) },
      }
    }),
    jobs: readMap(source['jobs'], entry => {
      const label = textOf(entry['label'])
      const kind = textOf(entry['kind'])
      const seq = numberOf(entry['seq'])
      if (label === undefined || kind === undefined || seq === undefined) return undefined
      return { label, kind, seq, raised: entry['raised'] === true }
    }),
    interrupted: readMap(source['interrupted'], entry => {
      const name = textOf(entry['name'])
      const seq = numberOf(entry['seq'])
      const turn = numberOf(entry['turn'])
      const at = numberOf(entry['at'])
      if (name === undefined || seq === undefined || turn === undefined || at === undefined) return undefined
      return { name, seq, turn, at }
    }),
    items: readMap(source['items'], entry => {
      const artifactId = textOf(entry['artifactId'])
      const kind = textOf(entry['kind'])
      const severity = numberOf(entry['severity'])
      const seq = numberOf(entry['seq'])
      const title = textOf(entry['title'])
      const body = textOf(entry['body'])
      const detectorCode = textOf(entry['detectorCode'])
      const raisedAt = numberOf(entry['raisedAt'])
      if (artifactId === undefined || kind === undefined || severity === undefined
        || seq === undefined || title === undefined || body === undefined
        || detectorCode === undefined || raisedAt === undefined) return undefined
      const detectedBy = detectionSourcesOf(entry['detectedBy'])
      return {
        artifactId,
        kind: kind as OpenItemKind,
        severity: (severity === 2 || severity === 3 ? severity : 1) as Severity,
        seq,
        title,
        body,
        detectorCode,
        raisedAt,
        blocking: entry['blocking'] === true,
        ...entry['tier'] === 'candidate' ? { tier: 'candidate' as const } : {},
        ...detectedBy === undefined ? {} : { detectedBy },
        ...textOf(entry['quote']) === undefined ? {} : { quote: textOf(entry['quote']) },
        ...numberOf(entry['turn']) === undefined ? {} : { turn: numberOf(entry['turn']) },
        ...textOf(entry['callId']) === undefined ? {} : { callId: textOf(entry['callId']) },
        ...textOf(entry['approvalId']) === undefined ? {} : { approvalId: textOf(entry['approvalId']) },
        ...textOf(entry['goalId']) === undefined ? {} : { goalId: textOf(entry['goalId']) },
        ...numberOf(entry['goalRevision']) === undefined ? {} : { goalRevision: numberOf(entry['goalRevision']) },
        ...textOf(entry['taskId']) === undefined ? {} : { taskId: textOf(entry['taskId']) },
        ...textOf(entry['ownerSessionId']) === undefined ? {} : { ownerSessionId: textOf(entry['ownerSessionId']) },
        ...textOf(entry['jobId']) === undefined ? {} : { jobId: textOf(entry['jobId']) },
        ...entry['liveOnly'] === true ? { liveOnly: true as const } : {},
        ...recordOf(entry['reply']) === undefined ? {} : { reply: entry['reply'] as OpenArtifact['reply'] },
      }
    }),
  }
}

/** Return a new state with one open artifact recorded. */
export function putArtifact(state: LedgerState, artifact: OpenArtifact): LedgerState {
  return { ...state, items: { ...state.items, [artifact.artifactId]: artifact } }
}

/** Return a new state without one artifact. */
export function removeArtifact(state: LedgerState, artifactId: string): LedgerState {
  if (!(artifactId in state.items)) return state
  const items = { ...state.items }
  delete items[artifactId]
  return { ...state, items }
}

/** Return a new state with one ledger map entry replaced. */
export function withMap<T>(
  state: LedgerState,
  key: 'calls' | 'approvals' | 'jobs' | 'interrupted',
  next: Record<string, T>,
): LedgerState {
  switch (key) {
    case 'calls': return { ...state, calls: next as LedgerState['calls'] }
    case 'approvals': return { ...state, approvals: next as LedgerState['approvals'] }
    case 'jobs': return { ...state, jobs: next as LedgerState['jobs'] }
    case 'interrupted': return { ...state, interrupted: next as LedgerState['interrupted'] }
  }
}
