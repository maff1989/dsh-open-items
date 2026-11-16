/**
 * Contract between the Host capture engine (projection folds + backfill) and the
 * Host store. The capture branch implements folds and produces drafts; the store
 * branch implements the sink. Neither imports the other's internals.
 *
 * Source of truth: DESIGN.md §3.2 (projection capture), §4 step 1 (fold rules),
 * §4 step 8 (closure detectors), §5.10 (workspace resolution).
 */

import type {
  AcknowledgementEvidence,
  DetectionSource,
  OpenItemKind,
  OpenItemRecord,
  OpenItemTier,
  ReplyDescriptor,
  Severity,
  SessionId,
  WorkspaceRef,
} from '../shared/schema'

/**
 * One item derived from a committed Session event (or from a backfill pass over
 * an existing log). The store turns this into a record with identity, dedupe and
 * lifecycle; the capture engine never writes records directly.
 */
export interface DerivedItemDraft {
  /** Stable identity of the artifact, e.g. `approval:call_123`, `question:call_9`. */
  readonly artifactId: string
  /** Product-facing kind (DESIGN §2.1). */
  readonly kind: OpenItemKind
  readonly tier: OpenItemTier
  readonly severity: Severity
  readonly title: string
  readonly body: string
  /** Verbatim evidence excerpt, already truncated by the fold. */
  readonly quote?: string
  readonly sessionId: SessionId
  readonly sessionTitle?: string
  readonly workspace?: WorkspaceRef
  readonly cwd?: string
  readonly seq?: number
  readonly turn?: number
  readonly callId?: string
  readonly approvalId?: string
  readonly goalId?: string
  readonly goalRevision?: number
  readonly taskId?: string
  readonly jobId?: string
  /** Detector code, e.g. `approval/decided:unavailable`, `goal/change:blocked`. */
  readonly detectorCode: string
  readonly detectedBy: readonly DetectionSource[]
  /** False for artifacts that are informational rather than blocking. */
  readonly blocking: boolean
  /** Optional pre-computed reply surface; the store fills sane defaults. */
  readonly reply?: Partial<ReplyDescriptor>
  /** When the artifact closed the item, the closure to record instead of an open item. */
  readonly closes?: {
    readonly artifactId: string
    readonly kind: 'detected-closed'
    readonly code: string
    readonly at: number
  }
}

/** Where a capture engine reports what it derived. Implemented by the store/service. */
export interface CaptureSink {
  /**
   * Apply a batch of drafts atomically enough for a UI read: open/re-raise items,
   * close the ones whose artifacts resolved, and update dedupe/occurrence data.
   * @returns how many items were created, updated or closed.
   */
  upsertDerived(drafts: readonly DerivedItemDraft[]): Promise<number>
  /**
   * Apply delivery/acknowledgement evidence read from the session log
   * (DESIGN §6.3/§7.4.2). Optional: a sink that only stores item drafts still
   * renders truthfully, it just never moves a delivery out of `queued` and never
   * observes the acknowledgement.
   * @param evidence - evidenced transitions, in log order.
   * @returns how many item records the evidence changed.
   */
  applyEvidence?(evidence: readonly CaptureEvidence[]): Promise<number>
  /** The install identity stamped on derived records. */
  readonly installId: string
}

/**
 * One evidenced delivery/acknowledgement fact folded from the session log.
 *
 * Capture never invents a state: the log proves it. `delivered` comes from our
 * own `user/message` (its source carries the `deliveryId`); an acknowledgement
 * comes from the session acting afterwards (tool result, next turn, retry).
 */
export type CaptureEvidence =
  | {
    /** The durable reply message with our `deliveryId` is committed. */
    readonly type: 'delivered'
    readonly sessionId: SessionId
    readonly itemId: string
    readonly deliveryId: string
    readonly seq?: number
    readonly messageId?: string
    readonly at: number
  }
  | {
    /** The session acted after the answer: evidenced acknowledgement. */
    readonly type: 'acknowledged'
    readonly sessionId: SessionId
    readonly kind: AcknowledgementEvidence
    readonly seq?: number
    readonly at: number
    /**
     * Artifact identity when the evidence names one ask (`tool-result`,
     * `approval/decided`); absent for session-scoped evidence (`next-turn`).
     */
    readonly artifactId?: string
  }

/** What a capture engine needs from the Host to fold sessions. */
export interface CaptureContext {
  /** Sessions that exist, oldest activity first, with the metadata folds need. */
  listSessions(): Promise<readonly CaptureSessionInfo[]>
  /** Read a session's committed events for a backfill window. */
  readSession(sessionId: SessionId): Promise<readonly CaptureEvent[]>
  /** Workspace membership resolution (DESIGN §5.10): first workspace whose `sessionIds` contains the id. */
  workspaceOf(sessionId: SessionId): Promise<WorkspaceRef | undefined>
}

/**
 * Runtime toggles the capture engine consults while emitting drafts
 * (PLAN-remediation §8). The Host re-reads them through a getter so a settings
 * change applies without remounting capture.
 */
export interface CaptureRuntimeSettings {
  /** Whether the prose candidate gate may emit candidate drafts (default on). */
  readonly proseCandidates: boolean
}

/**
 * One bounded model-assisted extraction request for a prose candidate
 * (PLAN-remediation §12.3/§12.4).
 *
 * The capture engine owns when extraction runs (only for a prose draft that the
 * gate just produced, only on the live path) and what evidence is sent; the
 * extraction module owns the model call, the budget/deadline and the sanitising
 * of the verdict.
 */
export interface ProseExtractionInput {
  /** Session the candidate belongs to. */
  readonly sessionId: string
  /** Title the gate produced for the candidate (already bounded by the fold). */
  readonly title: string
  /** Verbatim marker sentence the gate quoted; empty when there was none. */
  readonly quote: string
  /** Final assistant text tail of the turn (already bounded by the fold). */
  readonly text: string
}

/**
 * The extractor's verdict for one prose candidate.
 *
 * `undefined` (rather than a verdict) means "no opinion, keep the gate's
 * candidate unchanged" — that is the shape a disabled, over-budget, timed-out
 * or unparseable extraction returns, so capture never has to distinguish those
 * cases here.
 */
export interface ProseExtractionVerdict {
  /** false ⇒ drop this candidate; true ⇒ keep it (optionally refined). */
  readonly keep: boolean
  /** Refined kind, when the extraction confirms or corrects the gate's guess. */
  readonly kind?: 'question' | 'decision'
  /** Refined title (≤120 chars, sanitized by the extractor). */
  readonly title?: string
}

/** Minimal session metadata a backfill needs. */
export interface CaptureSessionInfo {
  readonly sessionId: SessionId
  readonly title?: string
  /**
   * Sort/eligibility activity time: the roster's last-activity time when known,
   * otherwise the persisted header's creation time. **Never** use this value to
   * infer that a log is unchanged — a creation-time fallback proves nothing.
   */
  readonly updatedAt: number
  /**
   * Last known *log activity* time, when the Host can prove it as an upper bound
   * on the newest committed event. Only then may a cursor covering it skip a
   * session without reading the log.
   *
   * The installed `sessionController` roster does **not** provide this: its
   * `updatedAt` is `max(createdAt, lastPromptAt)` (the last *user prompt*), a
   * lower bound on activity — using it would hide tool/approval events that
   * arrive after the last prompt. `createHostCaptureSeams` therefore omits this
   * field; the seam stays available for a Host that can prove activity, and a
   * session without it is re-read and judged by cursor coverage.
   */
  readonly lastActivityAt?: number
  readonly archived: boolean
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly cwd?: string
}

/** The event shape folds consume: a committed Session event with its seq. */
export interface CaptureEvent {
  readonly seq: number
  readonly type: string
  readonly time: number
  /** Opaque payload; folds narrow it with their own guards. */
  readonly data: unknown
}

/** A fold's result for one event. */
export interface FoldResult {
  readonly drafts: readonly DerivedItemDraft[]
  /** Highest seq successfully folded; the cursor advances to this. */
  readonly throughSeq: number
}

/** Fold identity and versioning; a bump replays old cursors. */
export interface FoldDefinition {
  readonly foldVersion: number
  /** Pure: same state + event ⇒ same result. Must never throw on unknown events. */
  fold(state: FoldState, event: CaptureEvent, session: CaptureSessionInfo): { readonly state: FoldState; readonly result: FoldResult }
}

/** Fold state is plain JSON so it can persist beside the cursor. */
export type FoldState = Record<string, unknown>

/** Everything an item's originating event can be, for tests and fixtures. */
export interface CaptureDraftSummary {
  readonly record: OpenItemRecord
}
