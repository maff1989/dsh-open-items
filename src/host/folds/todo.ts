/**
 * `todo_write` abandonment fold: one aggregate candidate for a plan the session
 * ended without completing (PLAN-remediation §5, decision D3).
 *
 * `todo/write` is a whole-list replacement appended to the session log, so the
 * last snapshot is the session's live plan. When a turn ends (or the log ends)
 * with unfinished items, the work was promised and left open. The capture emits
 * **one** candidate per session rather than one per item — the plan is the unit
 * of intent, and per-item rows would be pure noise.
 *
 * Not `liveOnly`: a cold baseline surfaces the same aggregate for a historical
 * session, which is the only way the measured six abandoned plans can appear.
 *
 * Closing detector: a later `todo/write` whose whole list is completed
 * (`todo/write:completed`). The aggregate deliberately does not close on
 * `user/message`: a plan may legitimately continue across turns.
 *
 * @module dsh-open-items/host/folds/todo
 */

import type { CaptureEvent, CaptureSessionInfo } from '../capture-contract'
import type { DetectionSource } from '../../shared/schema'
import { type FoldStep, closeDraft, openDraft } from './drafts'
import { bodyFrom, quoteFrom, recordOf, singleLine, textOf, titleFrom, truncate } from './limits'
import { type LedgerState, type OpenArtifact, type TodoSnapshot, putArtifact, removeArtifact } from './state'

/** Identity of the one aggregate artifact a session may hold. */
export const TODO_ARTIFACT_ID = 'todo-open'

/** Detector code stamped on the aggregate candidate. */
export const TODO_DETECTOR_CODE = 'todo/write:unfinished-plan'

/** Closing detector: a later whole-list write with nothing left unfinished. */
export const TODO_COMPLETED_CODE = 'todo/write:completed'

/** Todo-fold bounds: the body lists at most five labels, each bounded. */
export const TODO_LIMITS = {
  /** Labels quoted in the body (state stays bounded). */
  maxLabels: 5,
  /** Character bound of one label. */
  labelChars: 120,
} as const

/** What one `todo/write` payload says about the plan's unfinished work. */
interface TodoPlan {
  /** Unfinished items: `pending` or `in_progress`, never `completed`. */
  readonly pending: number
  /** Up to {@link TODO_LIMITS.maxLabels} unfinished labels. */
  readonly items: readonly string[]
}

/**
 * Read one real `todo/write` payload.
 *
 * The payload is `{ todos: TodoItem[] }` where an item is `{ content, status }`
 * (`inst:dsh-tool-todo/lib/types/types.d.ts`). A payload without a `todos`
 * array is malformed and folds to nothing; an empty array is a legitimate
 * "my plan is now empty" write.
 * @param data - the event payload.
 * @returns the unfinished plan, or undefined when the payload is malformed.
 */
export function todoPlanOf(data: unknown): TodoPlan | undefined {
  const record = recordOf(data)
  if (record === undefined || !Array.isArray(record['todos'])) return undefined
  let pending = 0
  const items: string[] = []
  for (const entry of record['todos']) {
    const todo = recordOf(entry)
    if (todo === undefined) continue
    const content = textOf(todo['content'])
    if (content === undefined) continue
    if (todo['status'] === 'completed') continue
    pending += 1
    if (items.length < TODO_LIMITS.maxLabels) {
      items.push(truncate(singleLine(content), TODO_LIMITS.labelChars))
    }
  }
  return { pending, items }
}

/**
 * Fold one event for the abandoned-plan family.
 * @param state - current ledger state.
 * @param event - next committed event.
 * @param session - owning session metadata.
 * @param source - detector source to stamp on drafts.
 * @returns the next state and drafts, or undefined when the event is unrelated.
 */
export function foldTodo(
  state: LedgerState,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
): FoldStep | undefined {
  if (event.type === 'todo/write') return onTodoWrite(state, event, session, source)
  if (event.type === 'turn/end') return raiseAggregate(state, session, source, event.time)
  return undefined
}

/** Replace the plan snapshot, closing the aggregate when nothing is left. */
function onTodoWrite(
  state: LedgerState,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
): FoldStep | undefined {
  const plan = todoPlanOf(event.data)
  if (plan === undefined) return undefined
  const snapshot: TodoSnapshot = {
    seq: event.seq,
    at: event.time,
    pending: plan.pending,
    items: plan.items,
  }
  const next: LedgerState = { ...state, todo: snapshot }
  const artifact = next.items[TODO_ARTIFACT_ID]
  if (plan.pending > 0 || artifact === undefined) return { state: next, drafts: [] }
  return {
    state: removeArtifact(next, artifact.artifactId),
    drafts: [closeDraft(artifact, { session, source }, event.time, TODO_COMPLETED_CODE)],
  }
}

/**
 * Raise the aggregate when the log ends before a turn ends.
 *
 * A crash tail never appended the `turn/end` that normally raises it, so the
 * backfill and the cold projection read call this after the last event.
 * @param state - ledger after the last event.
 * @param session - owning session metadata.
 * @param source - detector source to stamp on drafts.
 * @param at - event time to stamp on the raised artifact.
 * @returns the next state and finalized drafts, or undefined when nothing is open.
 */
export function finalizeTodo(
  state: LedgerState,
  session: CaptureSessionInfo,
  source: DetectionSource,
  at: number,
): FoldStep | undefined {
  return raiseAggregate(state, session, source, at)
}

/** Open the one aggregate candidate for the session's unfinished plan. */
function raiseAggregate(
  state: LedgerState,
  session: CaptureSessionInfo,
  source: DetectionSource,
  at: number,
): FoldStep | undefined {
  const plan = state.todo
  if (plan === null || plan.pending <= 0) return undefined
  // One aggregate per session: an already-open artifact is not re-raised, so a
  // plan that spans several turns does not churn the store.
  if (state.items[TODO_ARTIFACT_ID] !== undefined) return undefined
  const lines = plan.items.map(label => `• ${label}`)
  const remaining = plan.pending - plan.items.length
  if (remaining > 0) lines.push(`…and ${remaining} more`)
  const bodyLines = lines.length === 0 ? [] : [lines.join('\n'), '']
  const firstLabel = plan.items[0]
  const artifact: OpenArtifact = {
    artifactId: TODO_ARTIFACT_ID,
    kind: 'follow-up',
    tier: 'candidate',
    severity: 3,
    seq: plan.seq,
    title: titleFrom(`Plan left unfinished (${plan.pending} items)`),
    body: bodyFrom(
      `${bodyLines.join('\n')}The session ended with plan items not completed.`,
    ),
    detectorCode: TODO_DETECTOR_CODE,
    blocking: false,
    raisedAt: at,
    ...firstLabel === undefined ? {} : { quote: quoteFrom(firstLabel) },
  }
  return { state: putArtifact(state, artifact), drafts: [openDraft(artifact, { session, source })] }
}
