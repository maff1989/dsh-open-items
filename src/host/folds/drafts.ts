/**
 * Draft constructors shared by every fold.
 *
 * A fold reports two shapes to the sink: an item that is open now, and a
 * closure for an artifact that resolved (the sink turns a closure into a
 * resolution rather than a new item). Both carry the same evidence so the
 * store can dedupe, attribute and audit without consulting the fold state.
 *
 * @module dsh-open-items/host/folds/drafts
 */

import type { CaptureEvidence, CaptureSessionInfo, DerivedItemDraft } from '../capture-contract'
import type { DetectionSource } from '../../shared/schema'
import type { LedgerState, OpenArtifact } from './state'

/**
 * A draft that carries capture-internal routing data beyond the shared
 * contract. `DerivedItemDraft` itself is unchanged: the extra field is a
 * structural superset consumed only by this package's capture wiring.
 */
export interface OwnedDraft extends DerivedItemDraft {
  /** Owning Session of a team task, used for the "not running" orphan gate. */
  readonly ownerSessionId?: string
  /**
   * True for an artifact that is only truthful while it is observed live (a
   * pending ask). A historical log read must not raise it: an old unanswered
   * ask has no live card and no one waiting on it.
   */
  readonly liveOnly?: boolean
}

/** Common evidence every draft carries. */
interface DraftEvidence {
  readonly session: CaptureSessionInfo
  readonly source: DetectionSource
}

/**
 * Project one open artifact onto a draft.
 * @param artifact - the open artifact recorded in fold state.
 * @param evidence - owning session and detector source.
 * @returns the draft the sink opens or refreshes.
 */
export function openDraft(
  artifact: OpenArtifact,
  evidence: DraftEvidence,
  ownerSessionId: string | undefined = artifact.ownerSessionId,
): OwnedDraft {
  const { session, source } = evidence
  return {
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    // Every detector family is structural unless it explicitly says otherwise;
    // the prose/todo candidate families carry their own tier on the artifact.
    tier: artifact.tier ?? 'structural',
    severity: artifact.severity,
    title: artifact.title,
    body: artifact.body,
    sessionId: session.sessionId,
    detectorCode: artifact.detectorCode,
    // A detector that names its own provenance (the prose regex gate) keeps it;
    // everything else is stamped with the emitting driver's source.
    detectedBy: artifact.detectedBy ?? [source],
    blocking: artifact.blocking,
    seq: artifact.seq,
    ...artifact.quote === undefined ? {} : { quote: artifact.quote },
    ...artifact.turn === undefined ? {} : { turn: artifact.turn },
    ...artifact.callId === undefined ? {} : { callId: artifact.callId },
    ...artifact.approvalId === undefined ? {} : { approvalId: artifact.approvalId },
    ...artifact.goalId === undefined ? {} : { goalId: artifact.goalId },
    ...artifact.goalRevision === undefined ? {} : { goalRevision: artifact.goalRevision },
    ...artifact.taskId === undefined ? {} : { taskId: artifact.taskId },
    ...artifact.jobId === undefined ? {} : { jobId: artifact.jobId },
    ...artifact.reply === undefined ? {} : { reply: artifact.reply },
    ...session.title === undefined ? {} : { sessionTitle: session.title },
    ...session.cwd === undefined ? {} : { cwd: session.cwd },
    ...ownerSessionId === undefined ? {} : { ownerSessionId },
    ...artifact.liveOnly === true ? { liveOnly: true } : {},
  }
}

/**
 * Project one closure onto a draft.
 * @param artifact - the artifact that was open and has now resolved.
 * @param evidence - owning session and detector source.
 * @param at - event time of the closing evidence.
 * @param code - detector code that closed it, e.g. `tool/result`.
 * @returns the draft the sink records as a `detected-closed` resolution.
 */
export function closeDraft(
  artifact: OpenArtifact,
  evidence: DraftEvidence,
  at: number,
  code: string,
): DerivedItemDraft {
  const { session, source } = evidence
  return {
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    tier: 'structural',
    severity: artifact.severity,
    title: artifact.title,
    body: artifact.body,
    sessionId: session.sessionId,
    detectorCode: code,
    detectedBy: [source],
    blocking: artifact.blocking,
    seq: artifact.seq,
    ...session.title === undefined ? {} : { sessionTitle: session.title },
    ...session.cwd === undefined ? {} : { cwd: session.cwd },
    closes: {
      artifactId: artifact.artifactId,
      kind: 'detected-closed',
      code,
      at,
    },
  }
}

/** One fold handler's output: the next state, the drafts and the evidence it produced. */
export interface FoldStep {
  readonly state: LedgerState
  readonly drafts: readonly DerivedItemDraft[]
  /** Delivery/acknowledgement evidence this event proves (never an item). */
  readonly evidence?: readonly CaptureEvidence[]
}
