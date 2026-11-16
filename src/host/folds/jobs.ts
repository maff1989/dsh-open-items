/**
 * Background-job fold: a `job/registered` that never settled.
 *
 * Jobs outlive the turn that started them by design, so registration alone is
 * not interesting. The artifact is raised when the owning turn ends with the
 * job still unsettled (severity 3, FYI: "this job never reported back"), and on
 * a crash tail where the turn never ended.
 *
 * Closing detector: `job/settled` for the same `jobId` (any status).
 *
 * @module dsh-open-items/host/folds/jobs
 */

import type { CaptureEvent, CaptureSessionInfo } from '../capture-contract'
import type { DetectionSource } from '../../shared/schema'
import { type FoldStep, closeDraft, openDraft } from './drafts'
import { bodyFrom, recordOf, textOf, titleFrom } from './limits'
import { type LedgerState, type OpenArtifact, type OpenJob, putArtifact, removeArtifact, withMap } from './state'

/** Artifact identity for one job. */
export function jobArtifactId(jobId: string): string {
  return `job:${jobId}`
}

/**
 * Fold one event for the background-job artifact family.
 * @param state - current ledger state.
 * @param event - next committed event.
 * @param session - owning session metadata.
 * @param source - detector source to stamp on drafts.
 * @returns the next state and drafts, or undefined when the event is unrelated.
 */
export function foldJobs(
  state: LedgerState,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
): FoldStep | undefined {
  if (event.type === 'job/registered') {
    const job = jobOf(event.data)
    if (job === undefined) return undefined
    return {
      state: withMap(state, 'jobs', {
        ...state.jobs,
        [job.jobId]: { label: job.label, kind: job.kind, seq: event.seq, raised: false },
      }),
      drafts: [],
    }
  }
  if (event.type === 'job/settled') {
    const job = jobOf(event.data)
    if (job === undefined || state.jobs[job.jobId] === undefined) return undefined
    const jobs = { ...state.jobs }
    delete jobs[job.jobId]
    const artifact = state.items[jobArtifactId(job.jobId)]
    const next = withMap(state, 'jobs', jobs)
    if (artifact === undefined) return { state: next, drafts: [] }
    return {
      state: removeArtifact(next, artifact.artifactId),
      drafts: [closeDraft(artifact, { session, source }, event.time, 'job/settled')],
    }
  }
  if (event.type === 'turn/end') return raiseUnsettled(state, session, source, event.time, 'job/registered:unsettled-after-turn')
  return undefined
}

/**
 * Raise items for every job still unsettled when the log ends.
 *
 * Used by the backfill pass and by the projection's cold read: a log that ends
 * mid-turn (crash tail) never appended the `turn/end` that normally raises them.
 * @param state - current ledger state.
 * @param session - owning session metadata.
 * @param source - detector source to stamp on drafts.
 * @param at - closing time for the raised drafts.
 * @returns the next state and drafts.
 */
export function finalizeJobs(
  state: LedgerState,
  session: CaptureSessionInfo,
  source: DetectionSource,
  at: number,
): FoldStep | undefined {
  return raiseUnsettled(state, session, source, at, 'job/registered:unsettled-at-log-end')
}

/** Raise every job not yet raised; shared by turn end and log end. */
function raiseUnsettled(
  state: LedgerState,
  session: CaptureSessionInfo,
  source: DetectionSource,
  at: number,
  detectorCode: string,
): FoldStep | undefined {
  const pending = Object.keys(state.jobs).filter(jobId => state.jobs[jobId]?.raised !== true)
  if (pending.length === 0) return undefined
  const jobs = { ...state.jobs }
  const drafts = []
  let next = state
  for (const jobId of pending) {
    const job = jobs[jobId]
    if (job === undefined) continue
    jobs[jobId] = { ...job, raised: true }
    const artifact: OpenArtifact = {
      artifactId: jobArtifactId(jobId),
      kind: 'follow-up',
      severity: 3,
      seq: job.seq,
      title: titleFrom(`Background job unsettled: ${job.label}`),
      body: bodyFrom(
        `A ${job.kind} job was registered by this session and has not reported a result.\n\n`
        + `Job: ${job.label}\nJob id: ${jobId}`,
      ),
      detectorCode,
      blocking: false,
      raisedAt: at,
      jobId,
      reply: { controls: ['text'], freeText: true, requiresConfirm: false },
    }
    next = putArtifact(next, artifact)
    drafts.push(openDraft(artifact, { session, source }))
  }
  return { state: withMap(next, 'jobs', jobs as Record<string, OpenJob>), drafts }
}

/** Read the real `job/registered` / `job/settled` payload. */
function jobOf(data: unknown): { jobId: string; label: string; kind: string } | undefined {
  const record = recordOf(data)
  if (record === undefined) return undefined
  const jobId = textOf(record['jobId'])
  if (jobId === undefined) return undefined
  return {
    jobId,
    label: textOf(record['label']) ?? jobId,
    kind: textOf(record['kind']) ?? 'background',
  }
}
