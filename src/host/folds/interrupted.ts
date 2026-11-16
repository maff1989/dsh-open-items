/**
 * Interrupted-turn fold: a synthetic `TOOL_OUTCOME_UNKNOWN` tool result.
 *
 * Resume repair appends that result for a recorded tool call whose completed
 * outcome was never durably recorded (`repo:packages/core/session/src/repair.ts`).
 * The model is told the outcome is unknown; the user is the only one who can
 * verify external state, so the artifact is severity 1.
 *
 * Closing detectors: the same tool is retried by a later `tool/call` with the
 * same name, or any later `turn/start` (the user moved on, so the interrupted
 * outcome is superseded). Dismissal is the store's user action.
 *
 * @module dsh-open-items/host/folds/interrupted
 */

import type { CaptureEvent, CaptureSessionInfo } from '../capture-contract'
import type { DetectionSource } from '../../shared/schema'
import { type FoldStep, closeDraft, openDraft } from './drafts'
import { bodyFrom, contentText, quoteFrom, recordOf, textOf, titleFrom } from './limits'
import { type InterruptedCall, type LedgerState, type OpenArtifact, putArtifact, removeArtifact, withMap } from './state'
import { toolResultCallId } from './questions'

/** Repair error code for a recorded call whose completed outcome was not durably recorded. */
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/** Artifact identity for one unknown-outcome tool call. */
export function interruptedArtifactId(callId: string): string {
  return `interrupted:${callId}`
}

/**
 * Fold one event for the interrupted-turn artifact family.
 * @param state - current ledger state.
 * @param event - next committed event.
 * @param session - owning session metadata.
 * @param source - detector source to stamp on drafts.
 * @returns the next state and drafts, or undefined when the event is unrelated.
 */
export function foldInterrupted(
  state: LedgerState,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
): FoldStep | undefined {
  if (event.type === 'tool/result') return onUnknownResult(state, event, session, source)
  if (event.type === 'tool/call') return onRetry(state, event, session, source)
  if (event.type === 'turn/start') return onNextTurn(state, event, session, source)
  return undefined
}

/** Raise the item when the synthetic unknown-outcome result lands. */
function onUnknownResult(
  state: LedgerState,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
): FoldStep | undefined {
  const record = recordOf(event.data)
  const error = recordOf(record?.['error'])
  if (textOf(error?.['code']) !== TOOL_OUTCOME_UNKNOWN) return undefined
  const callId = toolResultCallId(event.data)
  if (callId === undefined) return undefined
  const turn = typeof record?.['turn'] === 'number' ? record['turn'] : 0
  // The tool name comes from the tool/call this result answers; when the call
  // predates the fork cut the name is genuinely unknown here.
  const name = state.calls[callId]?.name ?? state.interrupted[callId]?.name ?? 'tool call'
  const messageText = contentText(recordOf(record?.['message'])?.['content'])
  const artifact: OpenArtifact = {
    artifactId: interruptedArtifactId(callId),
    kind: 'blocker',
    severity: 1,
    seq: event.seq,
    turn,
    title: titleFrom(`Unknown outcome: ${name}`),
    body: bodyFrom(
      `The process ended while \`${name}\` was running, so the harness never recorded how it finished. `
      + 'Confirm the external state before treating the work as done.'
      + (messageText === '' ? '' : `\n\n${messageText}`),
    ),
    detectorCode: `tool/result:${TOOL_OUTCOME_UNKNOWN}`,
    blocking: true,
    raisedAt: event.time,
    callId,
    ...messageText === '' ? {} : { quote: quoteFrom(messageText) },
    reply: { controls: ['text'], freeText: true, requiresConfirm: true },
  }
  const interrupted = { ...state.interrupted, [callId]: { name, seq: event.seq, turn, at: event.time } }
  return {
    state: putArtifact(withMap(state, 'interrupted', interrupted), artifact),
    drafts: [openDraft(artifact, { session, source })],
  }
}

/** Close every interrupted artifact whose tool is retried by name. */
function onRetry(
  state: LedgerState,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
): FoldStep | undefined {
  const call = recordOf(event.data)
  const name = textOf(call?.['name'])
  if (name === undefined) return undefined
  const matches = Object.keys(state.interrupted).filter(callId => state.interrupted[callId]?.name === name)
  if (matches.length === 0) return undefined
  const drafts = []
  let next = state
  const interrupted = { ...state.interrupted }
  for (const callId of matches) {
    delete interrupted[callId]
    const artifact = next.items[interruptedArtifactId(callId)]
    if (artifact === undefined) continue
    drafts.push(closeDraft(artifact, { session, source }, event.time, 'tool/call:retried'))
    next = removeArtifact(next, artifact.artifactId)
  }
  return { state: withMap(next, 'interrupted', interrupted), drafts }
}

/** Close every interrupted artifact once the user starts another turn. */
function onNextTurn(
  state: LedgerState,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
): FoldStep | undefined {
  const turn = typeof recordOf(event.data)?.['turn'] === 'number' ? Number(recordOf(event.data)?.['turn']) : undefined
  if (turn === undefined) return undefined
  const stale = Object.keys(state.interrupted).filter(callId => {
    const record = state.interrupted[callId]
    return record !== undefined && record.turn < turn
  })
  if (stale.length === 0) return undefined
  let next = state
  const drafts = []
  const interrupted = { ...state.interrupted }
  for (const callId of stale) {
    delete interrupted[callId]
    const artifact = next.items[interruptedArtifactId(callId)]
    if (artifact === undefined) continue
    drafts.push(closeDraft(artifact, { session, source }, event.time, 'turn/start:superseded'))
    next = removeArtifact(next, artifact.artifactId)
  }
  return { state: withMap(next, 'interrupted', interrupted), drafts }
}

/** Read the recorded turn number of one `turn/start`. */
export function turnOfEvent(data: unknown): number | undefined {
  const value = recordOf(data)?.['turn']
  return typeof value === 'number' ? value : undefined
}

/** Re-exported for the aggregate fold's turn bookkeeping. */
export type { InterruptedCall }
