/**
 * Shared record vocabulary of the Open Items plugin — schema v3.
 *
 * This module is the contract every branch builds against: the durable store,
 * the projection folds, the read/reply route, the tool card and the client
 * surfaces all import these types and nothing else. It is deliberately free of
 * harness imports so a client bundle and a Host module can both use it.
 *
 * Source of truth for the semantics: DESIGN.md §3.5 (record), §5.8/§6.7 (card
 * and answer matrix), §7.4 (resolution register), §5.10 (workspace lens).
 */

/** On-disk schema version of the store document / domain. A reader rejects newer. */
export const STORE_SCHEMA_VERSION = 3

/** Identity: uuidv7 text, so ids sort by creation time. */
export type OpenItemId = string
/** A DSH Session id, mirrored verbatim. */
export type SessionId = string
/** A DSH workspace id (a uuid over a canonical directory). */
export type WorkspaceId = string
/** One reply attempt; also carried in the session message source. */
export type DeliveryId = string

/** What the user sees. Detector detail lives in `detectedBy` / `detectorCode`. */
export type OpenItemKind =
  | 'decision'
  | 'approval'
  | 'question'
  | 'plan-review'
  | 'blocker'
  | 'risk'
  | 'follow-up'
  | 'task'

/**
 * Lifecycle. `awaiting` = you answered and the session has not acknowledged it
 * yet; `archived` = decayed or older than the active window, still tracked;
 * `resolved` = terminal outcome and the register entry.
 */
export type OpenItemState = 'open' | 'snoozed' | 'awaiting' | 'stale' | 'archived' | 'resolved'

/** Policy tier: structural items need you now; candidates wait for confirmation. */
export type OpenItemTier = 'structural' | 'candidate'

/** 1 = needs you now, 2 = decision, 3 = FYI. From the artifact, never raised by a model. */
export type Severity = 1 | 2 | 3

/** Which detector produced (or later confirmed) the item. */
export type DetectionSource = 'projection' | 'log-fold' | 'regex-gate' | 'llm' | 'tool' | 'user'

/** How an item left the open list. */
export type ResolutionKind = 'answered' | 'dismissed' | 'superseded' | 'detected-closed'

/** How a reply travelled. */
export type DeliveryTrack = 'client-settle' | 'host-settle' | 'session-message'

/** Delivery state machine (DESIGN §6.3). */
export type DeliveryState =
  | 'sending'
  | 'settled'
  | 'queued'
  | 'delivered'
  | 'acknowledged'
  | 'failed'

/** Evidenced failure reasons. Never a bare boolean. */
export type DeliveryFailureCode =
  | 'was-not-applied'
  | 'cannot-apply'
  | 'session-archived'
  | 'agent-unavailable'
  | 'operator-cancelled'
  | 'unknown-outcome'
  | 'parked'

/** What proved an acknowledgement. */
export type AcknowledgementEvidence =
  | 'tool-result'
  | 'turn-continued'
  | 'call-retried'
  | 'goal-resumed'
  | 'task-completed'
  | 'next-turn'

/** A workspace snapshot taken when the item was raised. */
export interface WorkspaceRef {
  /** Durable grouping identity; survives rename and reorder. */
  readonly workspaceId?: WorkspaceId
  /** Display snapshot; still readable if the workspace is deleted. */
  readonly title?: string
  /** Display/disambiguation only. NEVER a grouping identity. */
  readonly path?: string
}

/** Where the item came from — pointers, not foreign keys. */
export interface ItemSourceRef {
  readonly sessionId: SessionId
  readonly sessionTitle?: string
  readonly workspace?: WorkspaceRef
  /** Fallback label for Ungrouped history. */
  readonly cwd?: string
  readonly seq?: number
  readonly turn?: number
  /** Join key back to the transcript row that raised the tool item. */
  readonly callId?: string
  readonly messageId?: string
  readonly approvalId?: string
  readonly goalId?: string
  readonly goalRevision?: number
  readonly taskId?: string
  readonly jobId?: string
  /** Set when a subagent raised it and it rolled up to the root session. */
  readonly raisedBy?: { readonly sessionId: SessionId; readonly title?: string }
}

/** What the inbox must render to answer an item in place. */
export interface ReplyDescriptor {
  readonly controls: readonly ('option' | 'text' | 'approve' | 'deny' | 'task-action')[]
  /** Verbatim choices for option/approve/deny controls. */
  readonly options?: readonly string[]
  readonly freeText: boolean
  /** True when the chosen track will wake a session and spend a turn. */
  readonly requiresConfirm: boolean
  /** Short copy such as "answering resumes <session title>". */
  readonly note?: string
}

/** The user's answer, exactly as submitted. */
export type ReplyPayload =
  | { readonly type: 'option'; readonly option: string }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'approval'; readonly outcome: 'allow-once' | 'deny'; readonly note?: string }
  | { readonly type: 'task-action'; readonly action: string; readonly note?: string }
  | { readonly type: 'dismiss'; readonly reason?: string }

/** Log coordinates that prove a delivery landed. */
export interface DeliveryEvidence {
  readonly seq?: number
  readonly messageId?: string
  readonly callId?: string
  readonly inboxId?: string
}

/** One reply attempt, append-only. */
export interface DeliveryRecord {
  readonly deliveryId: DeliveryId
  readonly at: number
  readonly track: DeliveryTrack
  readonly payload: ReplyPayload
  readonly state: DeliveryState
  readonly evidence?: DeliveryEvidence
  readonly failure?: { readonly code: DeliveryFailureCode; readonly message: string }
}

/** One resolution of an item (current or earlier). */
export interface Resolution {
  readonly kind: ResolutionKind
  readonly at: number
  /**
   * Who produced the resolution: the human (`user`), the model recording the
   * human's answer from the conversation (`model`), or a detector closure.
   */
  readonly actor: 'user' | 'model' | 'detector'
  readonly payload: ReplyPayload | { readonly type: 'detector'; readonly code: string }
  readonly deliveryId?: DeliveryId
  readonly evidence?: DeliveryEvidence
}

/** Did the session act on it? */
export interface Acknowledgement {
  readonly state: 'pending' | 'observed' | 'none'
  readonly at?: number
  readonly evidence?: { readonly seq?: number; readonly kind: AcknowledgementEvidence }
}

/** Retention class. `archived` drops transcript-derived text (DESIGN §7.4.4). */
export interface Retention {
  readonly class: 'active' | 'archived'
  readonly archivedAt?: number
}

/** One audit entry inside the store. */
export interface HistoryEntry {
  readonly at: number
  readonly action: string
  readonly detail?: string
}

/** The durable item record — the total truth for one open loop. */
export interface OpenItemRecord {
  readonly schemaVersion: typeof STORE_SCHEMA_VERSION
  readonly id: OpenItemId
  /** Install identity that raised it. */
  readonly origin: string
  readonly kind: OpenItemKind
  readonly state: OpenItemState
  readonly tier: OpenItemTier
  readonly severity: Severity
  readonly title: string
  readonly body: string
  readonly quote?: string
  readonly options?: readonly string[]
  readonly source: ItemSourceRef
  /** True when the agent said it is waiting on this to continue (answer matrix input). */
  readonly blocking: boolean
  readonly reply: ReplyDescriptor
  readonly deliveries: readonly DeliveryRecord[]
  readonly occurrences: readonly { readonly sessionId: SessionId; readonly seq?: number; readonly seenAt: number }[]
  readonly dedupeKey: string
  readonly detectedBy: readonly DetectionSource[]
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  readonly updatedAt: number
  /** CAS token; every write increments. */
  readonly version: number
  readonly snoozedUntil?: number
  readonly resolution?: Resolution
  readonly resolutionLog?: readonly Resolution[]
  readonly acknowledgement?: Acknowledgement
  readonly resolvedAt?: number
  readonly reopenCount: number
  readonly retention: Retention
  readonly history: readonly HistoryEntry[]
  readonly deletedAt?: number
}

/** Per-session fold cursor. */
export interface DetectionCursor {
  readonly sessionId: SessionId
  readonly lastScannedSeq: number
  readonly lastEventTime: number
  readonly lastScanAt: number
  readonly cacheWatermark?: number
  readonly foldVersion: number
}

/** "The user said this is not an item" — consulted before creating candidates. */
export interface SuppressorRecord {
  readonly dedupePrefix: string
  readonly kindFamily: OpenItemKind
  readonly createdAt: number
  readonly expiresAt?: number
}

/** One meta row per install. */
export interface InstallRecord {
  readonly installId: string
  readonly createdAt: number
}

// ---------------------------------------------------------------------------
// Tool wire contract (model-facing result + card metadata)
// ---------------------------------------------------------------------------

export type OpenItemsToolAction = 'raise' | 'list' | 'resolve' | 'dismiss'

/** One item the agent asks to raise. */
export interface RaiseInput {
  readonly kind?: OpenItemKind
  readonly title: string
  readonly detail?: string
  readonly options?: readonly string[]
  /** "I am waiting on this to continue" (default true). Input to the answer matrix. */
  readonly blocking?: boolean
}

/** Terse row in the model-facing result. */
export interface ToolItemSummary {
  readonly id: OpenItemId
  readonly kind: OpenItemKind
  readonly state: OpenItemState
  readonly title: string
  /** ≤ CARD_DETAIL_PREVIEW chars; full text is behind the tool/card, not the transcript. */
  readonly detailPreview?: string
  readonly detailChars?: number
}

/** Model-facing result. Keep it small: it is permanently in the transcript. */
export interface OpenItemsToolResult {
  readonly summary: string
  readonly items: readonly ToolItemSummary[]
  readonly total: number
  readonly truncated: boolean
  readonly deduped?: boolean
  readonly reason?: 'already-answered'
}

/** Card contract carried in `output.presentationMeta` on the tool/result event. */
export interface CardItem {
  readonly id: OpenItemId
  readonly kind: OpenItemKind
  readonly state: OpenItemState
  readonly title: string
  readonly detailPreview?: string
  readonly options?: readonly string[]
  readonly blocking: boolean
  /** Item version at raise time; the card hydrates by id and prefers newer. */
  readonly version: number
  readonly sessionId: SessionId
  readonly callId?: string
  readonly reply: ReplyDescriptor
}

/** Versioned card payload. `v` must bump on a breaking change. */
export interface CardMeta {
  readonly v: 1
  readonly items: readonly CardItem[]
  readonly total: number
  readonly truncated: boolean
}

// ---------------------------------------------------------------------------
// Read views and queries shared by the Host service and the UI
// ---------------------------------------------------------------------------

export type ListStatusFilter = 'open' | 'awaiting' | 'resolved' | 'archived' | 'all'

/** One page request over the inbox or the register. */
export interface InboxQuery {
  readonly scope?: { readonly sessionId?: SessionId; readonly workspaceId?: WorkspaceId }
  readonly status?: ListStatusFilter
  readonly kinds?: readonly OpenItemKind[]
  readonly tiers?: readonly OpenItemTier[]
  /** Exact-state filter (the inbox reads one section's states per tab). */
  readonly states?: readonly OpenItemState[]
  readonly sources?: readonly ('user' | 'detector')[]
  /**
   * New-item watermark. Inbox reads use it only for `newSinceLastVisit`; the
   * register also uses it as the period lower bound (register mode).
   */
  readonly since?: number
  readonly until?: number
  /** Substring match over title, resolution text and session title. */
  readonly search?: string
  readonly limit?: number
  readonly cursor?: string
}

/** Counts carried by the nav pill, the badge and the page header. */
export interface CountSummary {
  readonly needsYou: number
  readonly candidates: number
  readonly awaiting: number
  readonly snoozed: number
  readonly resolved: number
  readonly newSinceLastVisit: number
  /** True when a cap pruned older rows; the UI must say so. */
  readonly earlierRecordsPruned: boolean
}

/** One session row for the page list and the session pip. */
export interface SessionInboxRow {
  readonly sessionId: SessionId
  readonly title?: string
  readonly workspaceId?: WorkspaceId
  readonly workspaceTitle?: string
  readonly updatedAt: number
  readonly running: boolean
  readonly archived: boolean
  readonly origin?: 'subagent'
  readonly counts: { readonly needsYou: number; readonly awaiting: number }
}

/** One workspace row for the workspace lens. */
export interface WorkspaceInboxRow {
  readonly workspaceId?: WorkspaceId
  readonly title: string
  readonly path?: string
  readonly removed: boolean
  readonly itemCount: number
  readonly sessionCount: number
}

/** The merged view every client surface renders from. */
export interface InboxSnapshot {
  /** Monotonic per-process revision; clients re-read, they never patch. */
  readonly revision: number
  readonly generatedAt: number
  readonly items: readonly OpenItemRecord[]
  readonly sessions: readonly SessionInboxRow[]
  readonly workspaces: readonly WorkspaceInboxRow[]
  readonly counts: CountSummary
  /** True while at least one session is queued for a refresh read. */
  readonly refreshing: boolean
  readonly nextCursor?: string
}
