/**
 * Approval fold: an approval that settled `rejected`, `cancelled` or
 * `unavailable` blocked a tool the agent asked to run.
 *
 * The audit pair is log-only (never model-visible), so the log is the only
 * place this artifact exists. The pair is joined by `ApprovalRequestId`;
 * `toolName`, `reason` and the optional `callId` come from the `asked` event.
 *
 * Closing detectors:
 * 1. **Same callId retried and allowed** — the retried ask carries the blocked
 *    call's id, so the artifact id joins directly.
 * 2. **Same tool retried and allowed** — a retry often gets a fresh `callId`
 *    (or the custom asker omitted one). A blocked approval is then kept in
 *    `approvals` as a *blocked marker* (the same event shape, so it survives
 *    the plain-JSON state round-trip) and the granted retry closes every
 *    blocked item for that tool: the action ran, the block is resolved.
 *
 * A blocked approval that is never retried has no closing evidence and can only
 * be closed by the user.
 *
 * @module dsh-open-items/host/folds/approval
 */

import type { CaptureEvent, CaptureSessionInfo } from '../capture-contract'
import type { DetectionSource } from '../../shared/schema'
import { type FoldStep, closeDraft, openDraft } from './drafts'
import { bodyFrom, quoteFrom, titleFrom } from './limits'
import { type LedgerState, type OpenArtifact, type PendingApproval, putArtifact, removeArtifact, withMap } from './state'

/** Outcomes that denied the action and therefore raise an item. */
const BLOCKED_OUTCOMES = new Set(['rejected', 'cancelled', 'unavailable'])

/** Stable artifact identity for one blocked approval. */
function blockedArtifactId(approval: PendingApproval, approvalId: string): string {
  return `approval:${approval.callId ?? approvalId}`
}

/**
 * Fold one event for the approval artifact family.
 * @param state - current ledger state.
 * @param event - next committed event.
 * @param session - owning session metadata.
 * @param source - detector source to stamp on drafts.
 * @returns the next state and drafts, or undefined when the event is unrelated.
 */
export function foldApproval(
  state: LedgerState,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
): FoldStep | undefined {
  const data = event.data
  if (event.type === 'approval/asked') {
    const record = asApprovalAsked(data)
    if (record === undefined) return undefined
    const withAsk = withMap(state, 'approvals', { ...state.approvals, [record.id]: record.approval })
    const artifactId = `approval:${record.approval.callId ?? record.id}`
    // A decided-blocked row for this identity stays actionable as-is; the live
    // pending row only fills the window where nothing was raised yet.
    if (state.items[artifactId] !== undefined) return { state: withAsk, drafts: [] }
    const artifact = pendingApprovalArtifact(event, record.approval, record.id)
    return {
      state: putArtifact(withAsk, artifact),
      drafts: [openDraft(artifact, { session, source })],
    }
  }
  if (event.type !== 'approval/decided') return undefined
  const decided = asApprovalDecided(data)
  if (decided === undefined) return undefined
  const asked = state.approvals[decided.id]
  if (asked === undefined) return undefined

  if (decided.outcome === 'allowed-once') {
    // A granted retry closes the blocked/pending item it supersedes.
    const closed = closeBlockedRetry(state, asked, decided.id, event, session, source)
    const approvals = { ...closed.state.approvals }
    delete approvals[decided.id]
    // An ask with no callId can still have a live pending row keyed by id.
    const drafts = [...closed.drafts]
    let next = closed.state
    if (asked.callId === undefined) {
      const pending = next.items[`approval:${decided.id}`]
      if (pending !== undefined) {
        next = removeArtifact(next, pending.artifactId)
        drafts.push(closeDraft(pending, { session, source }, event.time, 'approval/decided:allowed-once'))
      }
    }
    return { state: withMap(next, 'approvals', approvals), drafts }
  }

  // Keep the decision only as a *blocked marker* (never as a pending ask when
  // the outcome is unrelated): a later granted retry of the same tool must be
  // able to find and close this item.
  const approvals = { ...state.approvals }
  delete approvals[decided.id]
  if (!BLOCKED_OUTCOMES.has(decided.outcome)) {
    return { state: withMap(state, 'approvals', approvals), drafts: [] }
  }
  approvals[decided.id] = { ...asked, seq: event.seq }

  const tool = asked.toolName.trim() === '' ? 'a tool' : asked.toolName
  const artifact: OpenArtifact = {
    artifactId: blockedArtifactId(asked, decided.id),
    kind: 'approval',
    severity: 1,
    seq: event.seq,
    title: titleFrom(asked.reason ?? `Approval blocked for ${tool}`),
    body: bodyFrom(
      `The harness asked the user to approve \`${tool}\` and the request settled \`${decided.outcome}\`; `
      + 'the action did not run.'
      + (asked.reason === undefined ? '' : `\n\nThe agent's reason: ${asked.reason}`),
    ),
    detectorCode: `approval/decided:${decided.outcome}`,
    blocking: true,
    raisedAt: event.time,
    ...asked.reason === undefined ? {} : { quote: quoteFrom(asked.reason) },
    ...asked.callId === undefined ? {} : { callId: asked.callId },
    approvalId: decided.id,
    reply: { controls: ['approve', 'deny'], freeText: false, requiresConfirm: true },
  }
  return {
    state: putArtifact(withMap(state, 'approvals', approvals), artifact),
    drafts: [openDraft(artifact, { session, source })],
  }
}

/**
 * Close every blocked approval a granted retry proves resolved.
 *
 * The same-callId join is tried first (the retried ask kept the blocked call's
 * identity). Otherwise the retry is joined by tool name: each blocked marker
 * for that tool resolves the artifact it raised, and the marker is dropped.
 * A granted retry of a tool supersedes every earlier blocked item for that
 * tool, exactly like the interrupted-turn fold closing all interrupted calls of
 * a retried tool.
 * @param state - ledger state at the decision event.
 * @param asked - the retried ask that was granted.
 * @param decidedId - approval id of the granted retry (its own entry).
 * @param event - the closing `approval/decided` event.
 * @param session - owning session metadata.
 * @param source - detector source.
 * @returns the next state and the closure drafts.
 */
function closeBlockedRetry(
  state: LedgerState,
  asked: PendingApproval,
  decidedId: string,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
): FoldStep {
  let next = state
  const drafts = []
  const approvals = { ...state.approvals }
  const closed = new Set<string>()
  // The granted ask's own row (its live pending raise, or a blocked row under
  // the same call id) is resolved by this grant.
  if (asked.callId !== undefined) {
    const own = next.items[`approval:${asked.callId}`]
    if (own !== undefined) {
      closed.add(own.artifactId)
      next = removeArtifact(next, own.artifactId)
      drafts.push(closeDraft(own, { session, source }, event.time, 'approval/decided:allowed-once'))
    }
  }
  // Every blocked marker for the same tool is superseded: the action ran. The
  // join is by tool name because a retry often gets a fresh call id.
  for (const [blockedId, blocked] of Object.entries(state.approvals)) {
    if (blockedId === decidedId || blocked.toolName !== asked.toolName) continue
    const artifactId = `approval:${blocked.callId ?? blockedId}`
    const artifact = next.items[artifactId]
    if (artifact === undefined || artifact.kind !== 'approval' || closed.has(artifactId)) {
      delete approvals[blockedId]
      continue
    }
    delete approvals[blockedId]
    closed.add(artifactId)
    next = removeArtifact(next, artifactId)
    drafts.push(closeDraft(artifact, { session, source }, event.time, 'approval/decided:allowed-once'))
  }
  return { state: withMap(next, 'approvals', approvals), drafts }
}

/**
 * Build the pending-ask artifact for one `approval/asked` (REVIEW-rc1 P0-04a).
 *
 * Truthful while the ask is live: the harness put the question to the user and
 * nothing has decided it yet. Marked `liveOnly` so a historical log read never
 * resurrects an old ask whose card is long gone.
 */
function pendingApprovalArtifact(
  event: CaptureEvent,
  asked: PendingApproval,
  approvalId: string,
): OpenArtifact {
  const tool = asked.toolName.trim() === '' ? 'a tool' : asked.toolName
  return {
    artifactId: `approval:${asked.callId ?? approvalId}`,
    kind: 'approval',
    severity: 1,
    seq: event.seq,
    title: titleFrom(`Approval needed: ${tool}`),
    body: bodyFrom(
      `The harness is waiting for the user to approve \`${tool}\` before it can continue.`
      + (asked.reason === undefined ? '' : `\n\nThe agent's reason: ${asked.reason}`),
    ),
    detectorCode: 'approval/asked:awaiting-decision',
    blocking: true,
    raisedAt: event.time,
    ...asked.reason === undefined ? {} : { quote: quoteFrom(asked.reason) },
    ...asked.callId === undefined ? {} : { callId: asked.callId },
    approvalId,
    reply: { controls: ['approve', 'deny'], freeText: false, requiresConfirm: true },
    liveOnly: true,
  }
}

/** Read one `approval/asked` payload from its real event shape. */
function asApprovalAsked(data: unknown): { id: string; approval: PendingApproval } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Record<string, unknown>
  const id = typeof record['id'] === 'string' && record['id'] !== '' ? record['id'] : undefined
  const toolName = typeof record['toolName'] === 'string' ? record['toolName'] : undefined
  if (id === undefined || toolName === undefined) return undefined
  return {
    id,
    approval: {
      toolName,
      seq: -1,
      ...typeof record['callId'] === 'string' && record['callId'] !== '' ? { callId: record['callId'] } : {},
      ...typeof record['reason'] === 'string' && record['reason'] !== '' ? { reason: record['reason'] } : {},
    },
  }
}

/** Read one `approval/decided` payload from its real event shape. */
function asApprovalDecided(data: unknown): { id: string; outcome: string } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Record<string, unknown>
  const id = typeof record['id'] === 'string' && record['id'] !== '' ? record['id'] : undefined
  const outcome = typeof record['outcome'] === 'string' ? record['outcome'] : undefined
  if (id === undefined || outcome === undefined) return undefined
  return { id, outcome }
}
