/**
 * Team-task fold: a shared task board entry left `in_progress`.
 *
 * **Disabled by decision D5** (PLAN-remediation §6): the liveness gate this
 * family depends on is frozen at activation, so "not running" is not knowable
 * here and every task claim raised a false "Teammate task stalled" row
 * (GAP-ANALYSIS G-03/G-06). The family is not dispatched from `folds/index.ts`
 * in either the live or the cold fold, so it produces no item today; the module
 * and its unit tests stay exported for the redesigned gate. Do not re-enable it
 * without a liveness source that can prove an owner is not running.
 *
 * `team/task` snapshots are appended to the root session's log and carry the
 * whole task, including `ownerId` (`repo:packages/team/agent-team/src/types.ts`).
 * A task still `in_progress` when its owning session is no longer running is an
 * orphan: the work was promised but nobody is doing it.
 *
 * "Not running" is not derivable from one session's log, so the fold emits the
 * owning session id on an internal draft superset and the capture wiring drops
 * the draft only when a live roster says that owner is still running. Backfill
 * of a cold session emits, which is correct: nobody is running it.
 *
 * Closing detector: a later snapshot of the same task that is `completed` or
 * `deleted`.
 *
 * @module dsh-open-items/host/folds/team-task
 */

import type { CaptureEvent, CaptureSessionInfo } from '../capture-contract'
import type { DetectionSource } from '../../shared/schema'
import { type FoldStep, closeDraft, openDraft, type OwnedDraft } from './drafts'
import { arrayOf, bodyFrom, OPEN_ITEMS_LIMITS, quoteFrom, recordOf, textOf, titleFrom } from './limits'
import { type LedgerState, type OpenArtifact, putArtifact, removeArtifact } from './state'

/** Statuses that close an orphan item. */
const CLOSED_STATUSES = new Set(['completed', 'deleted'])

/** Artifact identity for one task. */
export function taskArtifactId(taskId: string): string {
  return `team-task:${taskId}`
}

/**
 * Fold one event for the team-task artifact family.
 * @param state - current ledger state.
 * @param event - next committed event.
 * @param session - owning session metadata (the root session that owns the board).
 * @param source - detector source to stamp on drafts.
 * @returns the next state and drafts, or undefined when the event is unrelated.
 */
export function foldTeamTask(
  state: LedgerState,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
  now?: number,
  historical?: boolean,
): FoldStep | undefined {
  if (event.type !== 'team/task') return undefined
  // A historical sweep must not manufacture orphans for team runs that ended:
  // an abandoned board task is only actionable while its session is still live.
  if (historical === true) return undefined
  const task = taskOf(event.data)
  if (task === undefined) return undefined
  if (CLOSED_STATUSES.has(task.status)) {
    const artifact = state.items[taskArtifactId(task.id)]
    if (artifact === undefined) return undefined
    return {
      state: removeArtifact(state, artifact.artifactId),
      drafts: [closeDraft(artifact, { session, source }, event.time, `team/task:${task.status}`)],
    }
  }
  if (task.status !== 'in_progress') return undefined
  // A finished run's leftovers are history, not an open loop (see limits).
  if (now !== undefined && event.time < now - OPEN_ITEMS_LIMITS.orphanFreshnessDays * 86_400_000) return undefined
  const artifact: OpenArtifact = {
    artifactId: taskArtifactId(task.id),
    kind: 'task',
    severity: 2,
    seq: event.seq,
    title: titleFrom(`Teammate task stalled: ${task.subject}`),
    body: bodyFrom(
      `A shared task on this session's board is still in progress while its owning session is not running.\n\n`
      + `Task: ${task.subject}`
      + (task.description === '' ? '' : `\n${task.description}`)
      + (task.ownerId === undefined ? '\nOwner: none' : `\nOwner session: ${task.ownerId}`)
      + (task.blockedBy.length === 0 ? '' : `\nBlocked by: ${task.blockedBy.join(', ')}`),
    ),
    detectorCode: 'team/task:in-progress-orphan',
    blocking: false,
    raisedAt: event.time,
    taskId: task.id,
    quote: quoteFrom(task.subject),
    ...task.ownerId === undefined ? {} : { ownerSessionId: task.ownerId },
    reply: {
      controls: ['task-action'],
      options: ['Complete'],
      freeText: true,
      requiresConfirm: true,
    },
  }
  return { state: putArtifact(state, artifact), drafts: [openDraft(artifact, { session, source })] as OwnedDraft[] }
}

/** Read the real `team/task` payload (version 2 snapshot). */
function taskOf(data: unknown): {
  id: string
  subject: string
  description: string
  status: string
  ownerId?: string
  blockedBy: readonly string[]
} | undefined {
  const task = recordOf(recordOf(data)?.['task'])
  if (task === undefined) return undefined
  const id = textOf(task['id'])
  const subject = textOf(task['subject'])
  const status = textOf(task['status'])
  if (id === undefined || subject === undefined || status === undefined) return undefined
  const blockedBy: string[] = []
  for (const entry of arrayOf(task['blockedBy'])) {
    const value = textOf(entry)
    if (value !== undefined) blockedBy.push(value)
  }
  return {
    id,
    subject,
    description: textOf(task['description']) ?? '',
    status,
    blockedBy,
    ...textOf(task['ownerId']) === undefined ? {} : { ownerId: textOf(task['ownerId']) },
  }
}
