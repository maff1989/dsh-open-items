/**
 * Goal fold: the session's current goal is in the `blocked` phase.
 *
 * `goal/change` carries either a complete post-mutation snapshot or a clear
 * tombstone (`repo:packages/goal/goal/src/types.ts`), so the fold keeps one
 * artifact per goal id and re-raises it on every blocked mutation.
 *
 * Closing detector: any later mutation of the same goal that leaves the
 * `blocked` phase (`active`, `paused`, `complete`), or a clear tombstone.
 *
 * @module dsh-open-items/host/folds/goal
 */

import type { CaptureEvent, CaptureSessionInfo } from '../capture-contract'
import type { DetectionSource } from '../../shared/schema'
import { type FoldStep, closeDraft, openDraft } from './drafts'
import { bodyFrom, quoteFrom, recordOf, textOf, titleFrom } from './limits'
import { type LedgerState, type OpenArtifact, putArtifact, removeArtifact } from './state'

/** Artifact identity: one artifact per goal identity, across revisions. */
export function goalArtifactId(goalId: string): string {
  return `goal:${goalId}`
}

/**
 * Fold one event for the goal artifact family.
 * @param state - current ledger state.
 * @param event - next committed event.
 * @param session - owning session metadata.
 * @param source - detector source to stamp on drafts.
 * @returns the next state and drafts, or undefined when the event is unrelated.
 */
export function foldGoal(
  state: LedgerState,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
): FoldStep | undefined {
  if (event.type !== 'goal/change') return undefined
  const data = recordOf(event.data)
  if (data === undefined || data['kind'] !== 'goal/change') return undefined
  const operation = textOf(data['operation'])
  if (operation === 'clear') {
    const cleared = recordOf(data['cleared'])
    const goalId = textOf(cleared?.['id'])
    return goalId === undefined ? undefined : closeGoal(state, goalId, event, session, source, 'goal/change:clear')
  }
  const goal = recordOf(data['goal'])
  const goalId = textOf(goal?.['id'])
  const phase = textOf(goal?.['phase'])
  if (goalId === undefined || phase === undefined) return undefined
  if (phase !== 'blocked') {
    return closeGoal(state, goalId, event, session, source, `goal/change:${phase}`)
  }
  const objective = textOf(goal?.['objective']) ?? 'the active goal'
  const blocked = recordOf(goal?.['blockedReason'])
  const code = textOf(blocked?.['code'])
  const message = textOf(blocked?.['message'])
  const revision = typeof goal?.['revision'] === 'number' ? goal['revision'] : undefined
  const artifact: OpenArtifact = {
    artifactId: goalArtifactId(goalId),
    kind: 'blocker',
    severity: 2,
    seq: event.seq,
    title: titleFrom(`Goal blocked: ${objective}`),
    body: bodyFrom(
      `The session's goal is blocked, so the agent cannot continue it on its own.\n\nGoal: ${objective}`
      + (message === undefined ? '' : `\nReason: ${message}`)
      + (code === undefined ? '' : ` (${code})`),
    ),
    detectorCode: 'goal/change:blocked',
    blocking: true,
    raisedAt: event.time,
    goalId,
    quote: quoteFrom(objective),
    ...revision === undefined ? {} : { goalRevision: revision },
    reply: { controls: ['text'], freeText: true, requiresConfirm: true },
  }
  return {
    state: putArtifact(state, artifact),
    drafts: [openDraft(artifact, { session, source }, undefined)],
  }
}

/** Close the goal artifact when the goal leaves the blocked phase. */
function closeGoal(
  state: LedgerState,
  goalId: string,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
  code: string,
): FoldStep | undefined {
  const artifact = state.items[goalArtifactId(goalId)]
  if (artifact === undefined) return undefined
  return {
    state: removeArtifact(state, artifact.artifactId),
    drafts: [closeDraft(artifact, { session, source }, event.time, code)],
  }
}
