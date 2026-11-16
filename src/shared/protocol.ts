/**
 * Wire protocol v1 between the browser half and the Host's exact Fetch route.
 *
 * One route, one envelope, JSON in and out: `POST /api/open-items` with
 * `{ endpoint, payload }` and a reply of `{ ok: true, value }` or
 * `{ ok: false, error }`. Connection owns authentication and the owner-Peer
 * fence; this module owns the payload vocabulary.
 *
 * Source of truth: DESIGN.md §5.3 (transport), §6.3 (delivery states),
 * §7.4 (register), §5.10 (workspace lens). Every branch imports these types.
 */

/** Envelope version. A client may be newer than the Host (HMR), so both must tolerate skew. */
export const PROTOCOL_VERSION = 1

/** Route path below the shared `/api` carrier. */
export const OPEN_ITEMS_ROUTE_PATH = '/api/open-items'

/** Endpoints of the single route. */
export type OpenItemsEndpoint =
  | 'hello'
  | 'list'
  | 'reply'
  | 'delivery'
  | 'dismiss'
  | 'snooze'
  | 'settings'
  | 'register'
  | 'reopen'
  | 'delete'
  | 'promote'
  | 'suppress'

/** Variable request payload; typed per endpoint below. */
export interface RequestEnvelope {
  readonly endpoint: OpenItemsEndpoint
  readonly payload?: unknown
}

/** Stable error codes the UI maps to copy. Business failures are values, not throws. */
export type OpenItemsErrorCode =
  | 'bad-request'
  | 'not-found'
  | 'conflict'
  | 'forbidden'
  | 'limit-reached'
  | 'session-archived'
  | 'agent-unavailable'
  | 'unknown-outcome'
  /** The deployment does not have this capability wired (e.g. `reply` before the delivery layer mounts). */
  | 'not-configured'
  | 'unknown'

/** Success or failure of one request. */
export type RouteReply<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: OpenItemsErrorCode; readonly message: string } }

/** Capability flags so the client degrades instead of guessing. */
export interface OpenItemsCapabilities {
  /**
   * The Host accepts the durable record of a settle the shipped browser card
   * already performed (track 1). The browser must independently detect that the
   * card carrier exists before offering the control.
   */
  readonly canSettleClient: boolean
  /** The Host can settle a continued timed question itself (track 2). */
  readonly canHostSettle: boolean
  /** The Host can deliver a message into a session. */
  readonly canDeliver: boolean
  /** The register can be queried and exported. */
  readonly canRegister: boolean
  /** A plugin-owned runtime-context line exists (opt-in feature). */
  readonly hasContextLine: boolean
}

/**
 * Capture (log backfill) status reported by `hello`.
 *
 * The backfill is automatic and has no UI trigger, so this is how a client or a
 * human can tell why an inbox is empty: whether the capture engine mounted at
 * all, and what the last bounded pass actually scanned.
 */
export interface CaptureStatus {
  /** Whether the capture engine mounted on this Host. */
  readonly mounted: boolean
  /** Whether the session-projection unit registered (live capture). */
  readonly projection: boolean
  /** Whether the live session drive attached. */
  readonly live: boolean
  /** Whether a cold-session backfill context was available. */
  readonly backfill: boolean
  /** Durable detection cursors stored (roughly: sessions already scanned). */
  readonly cursors: number
  /** Sessions the last catalog read saw (the backfill's candidate pool). */
  readonly catalogSessions?: number
  /** The last capture/catalog error, when one happened (diagnostics only). */
  readonly lastError?: string
  /** The most recent bounded backfill pass, when one has completed. */
  readonly lastBackfill?: {
    readonly eligible: number
    readonly folded: number
    readonly skipped: number
    readonly failed: number
    readonly drafts: number
    readonly durationMs: number
    /** Unix epoch milliseconds when the pass finished. */
    readonly at: number
  }
}

/** `hello` — capability and identity probe; never requires a session. */
export interface HelloValue {
  readonly protocol: number
  readonly domainVersion: number
  readonly schemaVersion: number
  readonly installId: string
  readonly capabilities: OpenItemsCapabilities
  readonly counts: {
    readonly needsYou: number
    readonly candidates: number
    readonly awaiting: number
  }
  /** True when a retention cap pruned rows; surfaced in every export header. */
  readonly earlierRecordsPruned: boolean
  /** Whether the deployment runs `ask_user_question` in timed mode (optional enhancement). */
  readonly timedMode?: boolean
  /** Capture/backfill status, when the Host mounted the capture wiring. */
  readonly capture?: CaptureStatus
}

/** `list` — the inbox / register page. */
export interface ListRequest {
  readonly query?: import('./schema').InboxQuery
}
export interface ListValue {
  readonly snapshot: import('./schema').InboxSnapshot
}

/** `reply` — the single answer write path (matrix in DESIGN §6.8). */
export interface ReplyRequest {
  readonly itemId: import('./schema').OpenItemId
  /** CAS token from the item the user acted on. */
  readonly expectedVersion: number
  /** Client-generated; makes a double-click exactly one delivery. */
  readonly deliveryId: import('./schema').DeliveryId
  readonly payload: import('./schema').ReplyPayload
  /**
   * The track the client believes applies. The Host validates it and may
   * downgrade (`steer` when the turn already ended becomes `record`).
   *
   * A `{ type: 'approval' }` payload is accepted on two tracks, and the item's
   * origin decides which one is legal (DESIGN §6.4/§6.8). A **mirrored**
   * approval (`source.approvalId` present) is settled only through the live
   * card: `client-settle`, which persists the one `allowed-once`/deny decision
   * and nothing else. An **authored** approval (raised by `open_items`, no
   * shipped request behind it) has no card, so its decision travels on
   * `session-message` as a notice the agent may retry from. Neither can grant
   * retroactively, and an approval is never carried by `host-settle` or by an
   * unqualified request.
   */
  readonly requestedTrack?: 'client-settle' | 'host-settle' | 'session-message'
  /** Set for a track-3 send the user explicitly confirmed against a cold session. */
  readonly confirmedWake?: boolean
}

/** Outcome of one reply attempt. */
export interface ReplyValue {
  readonly item: import('./schema').OpenItemRecord
  readonly delivery: import('./schema').DeliveryRecord
  /** `applied` for a settle, `sent` for a delivered message, `recorded` when no wake happened. */
  readonly outcome: 'applied' | 'sent' | 'recorded'
  /** Present when the agent was not reached and the answer waits for its next run. */
  readonly note?: string
}

/** `delivery` — re-read one delivery by id (idempotent recovery after a lost response). */
export interface DeliveryRequest {
  readonly deliveryId: import('./schema').DeliveryId
}
export interface DeliveryValue {
  readonly delivery?: import('./schema').DeliveryRecord
  readonly item?: import('./schema').OpenItemRecord
}

/** `dismiss` / `snooze` — user actions that never reach the agent. */
export interface DismissRequest {
  readonly itemId: import('./schema').OpenItemId
  readonly expectedVersion: number
  readonly reason?: string
}
export interface SnoozeRequest {
  readonly itemId: import('./schema').OpenItemId
  readonly expectedVersion: number
  readonly until: number
}

/** `reopen` — return a resolved/awaiting/archived item to the open list (§7.4.3). */
export interface ReopenRequest {
  readonly itemId: import('./schema').OpenItemId
  readonly expectedVersion: number
}
export interface ReopenValue {
  readonly item: import('./schema').OpenItemRecord
}

/**
 * `delete` — the explicit, confirmed "delete forever" (DESIGN §7.4.3).
 *
 * The record is not removed from the domain: it becomes a tombstone
 * (`deletedAt` set) with its transcript-derived text dropped, so no later fold,
 * export or read can resurrect it. It is absent from `list`, from the register
 * and from every export; the register's `earlierRecordsPruned` flag is
 * unaffected (a confirmed deletion is not a cap prune).
 */
export interface DeleteRequest {
  readonly itemId: import('./schema').OpenItemId
  /**
   * CAS token from the row the user acted on. A stale token is a `conflict`; a
   * repeat of the same token after a lost response returns the tombstone
   * unchanged (the action is idempotent, not a second delete).
   */
  readonly expectedVersion: number
}
export interface DeleteValue {
  /** The tombstone record (`deletedAt` set); it is gone from every read surface. */
  readonly item: import('./schema').OpenItemRecord
}

/** `dismiss` / `snooze` return the updated record so every surface can re-render from it. */
export interface DismissValue {
  readonly item: import('./schema').OpenItemRecord
}
export interface SnoozeValue {
  readonly item: import('./schema').OpenItemRecord
}

/** `register` — resolutions only, paged, newest first. */
export interface RegisterRequest {
  readonly query?: import('./schema').InboxQuery
}
export interface RegisterValue {
  readonly items: readonly import('./schema').OpenItemRecord[]
  readonly total: number
  readonly earlierRecordsPruned: boolean
  readonly nextCursor?: string
}

/**
 * The correctable fields of an inferred candidate, applied while confirming it.
 *
 * The detector's kind is a guess (the gate cannot ask the user), so confirmation
 * is also the moment to correct it. Every field is optional and only the fields
 * present are written; the Host bounds each one exactly like a stored record.
 * `kind` is identity (it is part of the derived dedupe key), so changing it
 * rekeys the row instead of duplicating it.
 */
export interface PromotePatch {
  readonly kind?: import('./schema').OpenItemKind
  readonly title?: string
  readonly body?: string
  readonly quote?: string
  readonly options?: readonly string[]
}

/**
 * `promote` — confirm one candidate, turning it into a structural item.
 *
 * Promotion is the one-click confirmation the candidate tier exists for: the
 * inferred prose item did happen, so it becomes a real open item with the
 * structural defaults (needs-you severity, blocking) before any answer is
 * recorded. Only a live candidate can be promoted; the optional patch corrects
 * the inference in the same compare-and-set write.
 */
export interface PromoteRequest {
  readonly itemId: import('./schema').OpenItemId
  /** CAS token from the candidate row the user acted on. */
  readonly expectedVersion: number
  /** Correct the inferred item while confirming it; absent leaves it untouched. */
  readonly patch?: PromotePatch
}
export interface PromoteValue {
  readonly item: import('./schema').OpenItemRecord
  /** True when the patch changed the item's kind (its identity was rekeyed). */
  readonly reclassified?: boolean
}

/**
 * `suppress` — dismiss one candidate *and* remember why.
 *
 * Suppressing records the ordinary `dismissed` resolution (actor user) **and**
 * writes a suppressor for the item's own dedupe key, so a later fold of the same
 * artifact cannot raise the fingerprint again. Only a live candidate can be
 * suppressed.
 */
export interface SuppressRequest {
  readonly itemId: import('./schema').OpenItemId
  /** CAS token from the candidate row the user acted on. */
  readonly expectedVersion: number
  readonly reason?: string
}
export interface SuppressValue {
  readonly item: import('./schema').OpenItemRecord
}

/* ------------------------------------------------------------------ *
 * Settings (DESIGN §7, frozen contract PLAN-remediation §1)
 * ------------------------------------------------------------------ */

/**
 * The durable settings record: one per install, stored under the `meta`
 * table's `settings` key (the domain's install row keeps the same table).
 *
 * `version` is the compare-and-set counter. `version: 0` is the unstored
 * default record: reads serve it without materialising a row, so an install
 * that never opens Settings writes nothing.
 */
export interface SettingsRecord {
  readonly schemaVersion: 1
  /** Monotonically increasing CAS token; 0 while serving the defaults. */
  readonly version: number
  /** Opt-in model nudge (default false, user decision D4). */
  readonly modelNudge: boolean
  /** Prose candidate gate (default true, user decisions D1/D2). */
  readonly proseCandidates: boolean
  /**
   * Opt-in model-assisted extraction (default false). Only effective when the
   * deployment also configures an extraction provider+model; absent on rows
   * written before the field existed, which parse as `false`.
   */
  readonly llmExtraction: boolean
}

/** `settings` read result. */
export interface SettingsValue {
  readonly settings: SettingsRecord
}

/** Fields a caller may change; the Host fills the rest. */
export interface SettingsPatch {
  readonly modelNudge?: boolean
  readonly proseCandidates?: boolean
  readonly llmExtraction?: boolean
}

/** `settings` write input: the version the caller read plus its patch. */
export interface SettingsWriteInput {
  readonly expectedVersion: number
  readonly patch: SettingsPatch
}

/**
 * `settings` write result. A lost race is a **value**, not an error: the live
 * record comes back with `status: 'conflict'` so the client can re-render from
 * Host truth without a retry loop.
 */
export type SettingsWriteValue =
  | { readonly status: 'written'; readonly settings: SettingsRecord }
  | { readonly status: 'conflict'; readonly settings: SettingsRecord }

/** `settings` request: a read or a compare-and-set patch. */
export type SettingsRequest =
  | { readonly op: 'read' }
  | ({ readonly op: 'write' } & SettingsWriteInput)

/** The settings record served before the first write (frozen: served by value). */
export const DEFAULT_SETTINGS: SettingsRecord = Object.freeze({
  schemaVersion: 1,
  version: 0,
  modelNudge: false,
  proseCandidates: true,
  llmExtraction: false,
})

/**
 * One durable completion report of a bounded cold-log backfill pass
 * (contract §12.5).
 *
 * The live driver cannot see a session that ended before the process started,
 * and a periodic re-scan covers that gap; this record is what makes the last
 * pass survive a restart, so `hello.capture.lastBackfill` never resets to
 * "nothing ran" on every boot. It carries counts only — never session ids,
 * titles or content.
 */
export interface BackfillReportRecord {
  readonly schemaVersion: 1
  /** Unix epoch milliseconds when the pass finished. */
  readonly at: number
  /** What armed the pass: the activation run or the periodic re-scan timer. */
  readonly trigger: 'activation' | 'rescan'
  readonly eligible: number
  readonly folded: number
  readonly skipped: number
  readonly failed: number
  readonly drafts: number
  readonly batches: number
  readonly deferred: number
  readonly durationMs: number
}

/** Fixed limits shared by Host and client so copy and caps agree. */
export const LIMITS = {
  /** Unacknowledged deliveries become "no acknowledgement observed" after this long. */
  acknowledgementWindowHours: 24,
  /** Resolutions stay in the active register this long, then archive (text dropped). */
  activeResolveDays: 365,
  /** Safety cap on stored resolutions; oldest archived rows prune first. */
  maxResolvedRecords: 5000,
  /** Cap on open/stale items before the oldest archive. */
  maxLiveItems: 500,
  /** First-run backfill: sessions and age. */
  backfillMaxSessions: 200,
  backfillMaxAgeDays: 90,
  /** Card and model-facing render bounds. */
  cardMaxItems: 5,
  cardDetailPreviewChars: 280,
  toolMaxRows: 5,
  listPageDefault: 50,
  listPageMax: 200,
  /** Default undelivered-since window in the register. */
  registerPageDefault: 50,
} as const
