/**
 * Contract between the reply engine (Host) and the read/reply route.
 *
 * The route owns transport and validation; the engine owns the answer matrix
 * (DESIGN §6.8), the guard order (DESIGN §6.7) and the choice between settling a
 * live ask and delivering a message into the session. Neither imports the
 * other's internals: the route passes a port the store backs, the engine uses a
 * bridge the Host services back.
 *
 * Source of truth: DESIGN.md §6.3 (states), §6.4 (safety), §6.7 (guards),
 * §6.8 (answer matrix), protocol.ts (ReplyRequest/ReplyValue).
 */

import type {
  Acknowledgement,
  DeliveryRecord,
  OpenItemRecord,
  ReplyPayload,
  Resolution,
} from '../shared/schema'
import type { ReplyRequest, ReplyValue } from '../shared/protocol'

/** The answer tracks of DESIGN §6.2. */
export type ReplyTrack = 'client-settle' | 'host-settle' | 'session-message'

/**
 * Service name of the observe-only live-ask carrier.
 *
 * The capture registration provides it (when the profile both composes the
 * ask waterfalls and this plugin); the reply bridge reads it to answer "was this
 * ask still live when the browser settled it?". No listener ever claims,
 * prepends or holds the request: observing never changes the outcome.
 */
export const LIVE_ASKS_SERVICE = 'openItemsLiveAsks'

/** One live ask as this Host observed it (never persisted). */
export interface LiveAskObservation {
  readonly kind: 'approval' | 'question'
  readonly sessionId: string
  readonly callId: string
  readonly toolName?: string
  readonly observedAt: number
  readonly state: 'pending' | 'settled'
  /** The waterfall outcome, when it settled while this Host was observing. */
  readonly outcome?: string
}

/** What the reply bridge may read from the live-ask carrier. */
export interface LiveAskCarrier {
  /** Current observation of one ask, if this Host saw it. */
  get(sessionId: string, callId: string): LiveAskObservation | undefined
  /** How many ask observations are held (diagnostics/tests). */
  readonly observed: number
}

/** A durable message the Host hands to the agent loop. */
export interface OutboundMessage {
  readonly text: string
  /** Attribution carried on the durable `user/message` source. */
  readonly source: {
    readonly kind: 'open-items'
    readonly form: 'notice'
    readonly itemId: string
    readonly deliveryId: string
  }
}

/** A Host capability the route advertises through `hello` (DESIGN §6.2). */
export interface ReplyCapabilities {
  /** The Host can record a settle the shipped browser card already performed. */
  readonly clientSettle: boolean
  /** The Host can settle a continued timed question itself. */
  readonly hostSettle: boolean
}

/** One host-side settle request for a continued timed question. */
export interface HostSettleRequest {
  /** Session whose projection holds the continued question. */
  readonly sessionId: string
  /** The ask's tool call, from the item's source. */
  readonly callId: string
  /** Exactly what the user chose; `option` and `text` are the supported payloads. */
  readonly payload: ReplyPayload
}

/**
 * Why the Host could not settle the ask. Every value is a business outcome the
 * inbox can explain; none of them implies the answer was applied.
 */
export type HostSettleRefusal =
  /** No continued pending call under that id (already settled, timed out, or still awaiting a live card). */
  | 'not-answerable'
  /** A reply is already queued for that call; this answer was not applied. */
  | 'reply-queued'
  /** The ask has several questions and the inbox row names only one choice. */
  | 'needs-batch'
  /** The chosen option is not one of the ask's options. */
  | 'bad-answer'
  /** The session has no live Agent to settle through. */
  | 'agent-unavailable'
  /** The service threw in a way this Host cannot classify. */
  | 'unknown-outcome'

/** Result of one host-side settle attempt. */
export type HostSettleResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: HostSettleRefusal }

/** What the engine needs from a live Agent, without importing the runtime. */
export interface SessionBridge {
  /** True when the workspace registry lists the session as archived. */
  archived(sessionId: string): boolean | Promise<boolean>
  /** Resolve a cold session to a live Agent, or explain why not. */
  resolveAgent(sessionId: string): Promise<
    | { readonly ok: true; readonly agent: unknown; readonly running: boolean; readonly turnOpen: boolean }
    | { readonly ok: false; readonly reason: 'agent-unavailable' | 'unknown-outcome' }
  >
  /** Queue a message that lands at the agent's next step (running turn). */
  steer(agent: unknown, message: OutboundMessage): void
  /** Queue an ordinary follow-up turn and wake the driver (idle session). */
  followup(agent: unknown, message: OutboundMessage): void
  /** Durability barrier after a queue write. */
  flush(agent: unknown): Promise<void>
  /**
   * Settle a continued timed question in place (DESIGN §6.2 track 2).
   * Absent when the profile cannot answer questions out-of-band; the engine
   * then keeps its degraded steer-or-record path.
   */
  hostSettle?(agent: unknown, request: HostSettleRequest): Promise<HostSettleResult>
  /**
   * Re-read whether the ask behind a derived item is still live before a track-1
   * settle is recorded (DESIGN §6.2 track 1; REVIEW-rc1 P1).
   *
   * `'not-live'` is positive evidence the ask can no longer be settled through
   * the live card; `'live'` is positive evidence it still can; `'unknown'` means
   * this profile cannot prove either way (authored items, or no projection
   * carrier). Absent, the guard is skipped.
   */
  askLiveness?(item: OpenItemRecord): Promise<'live' | 'not-live' | 'unknown'>
  /**
   * Capability snapshot for `hello`, read per request so a service that mounts
   * later becomes visible. Omitted members are treated as `false`.
   */
  capabilities?(): ReplyCapabilities
}

/** Store operations the engine performs, backed by the Host service. */
export interface ReplyStorePort {
  /** Current item, or undefined when it is gone. */
  get(itemId: string): OpenItemRecord | undefined
  /**
   * Apply one delivery attempt atomically: version check, append the delivery,
   * record the resolution (when the attempt settles), the acknowledgement (when
   * the track supports it) and the next item state.
   * @throws on a version conflict so the route can map it to `conflict`.
   */
  recordAttempt(input: RecordAttemptInput): Promise<OpenItemRecord>
}

/** One delivery attempt to persist. */
export interface RecordAttemptInput {
  readonly itemId: string
  /** CAS token the user acted on. */
  readonly expectedVersion: number
  readonly delivery: DeliveryRecord
  /** Present when the attempt settles an ask in place (tracks 1-2). */
  readonly resolution?: Resolution
  /** Preserved for a message delivery that is still waiting for evidence. */
  readonly acknowledgement?: Acknowledgement
}

/** The engine surface the route calls. */
export interface ReplyEngine {
  /**
   * Validate, guard, plan the track and persist one reply attempt.
   * Business failures are returned in the result's `outcome`/`note`, or thrown
   * as `ReplyEngineError` so the route can map them to wire codes.
   */
  reply(request: ReplyRequest, requestId: string): Promise<ReplyValue>
  /**
   * What this engine can actually do, for `hello`. The route advertises
   * `canHostSettle` only when this reports a working settle port, so a client
   * never offers a control the Host cannot carry out.
   */
  capabilities?(): ReplyCapabilities
}

/** Typed failure the route maps to an `OpenItemsErrorCode`. */
export class ReplyEngineError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not-found'
      | 'conflict'
      | 'session-archived'
      | 'agent-unavailable'
      | 'unknown-outcome'
      | 'bad-request',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ReplyEngineError'
  }
}

/** Dependencies the engine is constructed with by the Host plugin. */
export interface ReplyEngineDeps {
  readonly store: ReplyStorePort
  readonly sessions: SessionBridge
  /** Injected clock so the matrix and guard tests are deterministic. */
  readonly now: () => number
}
