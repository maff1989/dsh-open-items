/**
 * Delivery/acknowledgement evidence fold: what the log proves happened to a
 * reply (DESIGN §6.3, §7.4.2; REVIEW-rc1 P0-03).
 *
 * Two families, both evidence-only (no item is raised or closed here):
 *
 * - **delivered**: our own `user/message` carries `source.kind: 'open-items'`
 *   with the `deliveryId` and `itemId` the reply engine wrote, so the message
 *   landing in the log is proof the answer reached the session (track 3).
 * - **acknowledged**: the session acted after the answer. The tracked evidence
 *   kinds are the ones the installed runtime can prove — the ask's own
 *   `tool/result`/`user-question-reply`, an `approval/decided`, a `turn/start`,
 *   a resumed goal, a completed task. The `24 h` sweep stays the *fallback*
 *   for "no acknowledgement observed"; nothing here is inferred.
 *
 * Evidence is folded from the *pre-step* ledger because the artifact families
 * remove their pending entries in the same event (an approval's decided event
 * both resolves the pending ask and records the decision): the identity must be
 * read before that cleanup happens.
 *
 * @module dsh-open-items/host/folds/evidence
 */

import type { CaptureEvent, CaptureEvidence, CaptureSessionInfo } from '../capture-contract'
import { recordOf, textOf } from './limits'
import { type LedgerState } from './state'

/** Artifact id of the pending/blocked approval an id belongs to. */
function approvalArtifactId(state: LedgerState, approvalId: string): string | undefined {
  const pending = state.approvals[approvalId]
  if (pending !== undefined) return `approval:${pending.callId ?? approvalId}`
  return undefined
}

/**
 * Fold one committed event for delivery/acknowledgement evidence.
 * @param state - ledger state *before* this event's artifact steps ran.
 * @param event - committed event.
 * @param session - owning session metadata.
 * @returns evidenced transitions, possibly empty.
 */
export function foldEvidence(
  state: LedgerState,
  event: CaptureEvent,
  session: CaptureSessionInfo,
): readonly CaptureEvidence[] {
  const evidence: CaptureEvidence[] = []
  if (event.type === 'user/message') {
    const message = recordOf(event.data)
    const source = recordOf(message?.['source'])
    const kind = textOf(source?.['kind'])
    const messageId = textOf(message?.['id'])
    const deliveryId = textOf(source?.['deliveryId'])
    const itemId = textOf(source?.['itemId'])
    if (kind === 'open-items' && deliveryId !== undefined && itemId !== undefined) {
      evidence.push({
        type: 'delivered',
        sessionId: session.sessionId,
        itemId,
        deliveryId,
        seq: event.seq,
        at: event.time,
        ...messageId === undefined ? {} : { messageId },
      })
    }
    // A timed question answered out-of-band records its own reply message.
    const replyCallId = textOf(source?.['callId'])
    if (kind === 'user-question-reply' && replyCallId !== undefined) {
      evidence.push({
        type: 'acknowledged',
        sessionId: session.sessionId,
        kind: 'tool-result',
        artifactId: `question:${replyCallId}`,
        seq: event.seq,
        at: event.time,
      })
    }
    return evidence
  }
  if (event.type === 'approval/decided') {
    const approvalId = textOf(recordOf(event.data)?.['id'])
    if (approvalId === undefined) return evidence
    const artifactId = approvalArtifactId(state, approvalId)
    if (artifactId !== undefined) {
      evidence.push({
        type: 'acknowledged',
        sessionId: session.sessionId,
        kind: 'call-retried',
        artifactId,
        seq: event.seq,
        at: event.time,
      })
    }
    return evidence
  }
  if (event.type === 'tool/result') {
    const message = recordOf(recordOf(event.data)?.['message'])
    const callId = textOf(message?.['toolCallId'])
    const intent = callId === undefined ? undefined : state.calls[callId]?.intent
    if (callId !== undefined && intent !== undefined) {
      evidence.push({
        type: 'acknowledged',
        sessionId: session.sessionId,
        kind: 'tool-result',
        artifactId: `question:${callId}`,
        seq: event.seq,
        at: event.time,
      })
    }
    return evidence
  }
  if (event.type === 'turn/start') {
    evidence.push({
      type: 'acknowledged',
      sessionId: session.sessionId,
      kind: 'next-turn',
      seq: event.seq,
      at: event.time,
    })
    return evidence
  }
  if (event.type === 'goal/change') {
    const goal = recordOf(recordOf(event.data)?.['goal'])
    const goalId = textOf(goal?.['id'])
    const operation = textOf(recordOf(event.data)?.['operation'])
    if (goalId !== undefined && (operation === 'resume' || operation === 'active' || operation === 'complete')) {
      evidence.push({
        type: 'acknowledged',
        sessionId: session.sessionId,
        kind: 'goal-resumed',
        artifactId: `goal:${goalId}`,
        seq: event.seq,
        at: event.time,
      })
    }
    return evidence
  }
  if (event.type === 'team/task') {
    const task = recordOf(recordOf(event.data)?.['task'])
    const taskId = textOf(task?.['id'])
    if (taskId !== undefined && textOf(task?.['status']) === 'completed') {
      evidence.push({
        type: 'acknowledged',
        sessionId: session.sessionId,
        kind: 'task-completed',
        artifactId: `team-task:${taskId}`,
        seq: event.seq,
        at: event.time,
      })
    }
  }
  return evidence
}
