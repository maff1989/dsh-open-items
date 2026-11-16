/**
 * Reply engine: the answer matrix, the guard order and one persisted delivery
 * attempt per reply (DESIGN §6.3, §6.4, §6.7, §6.8).
 *
 * The engine is transport-free and runtime-free. The route passes a
 * `ReplyStorePort`, the Host passes a `SessionBridge`, and this module owns the
 * decision, the durable message and the honest result. Two rules shape it:
 *
 * - **Never wake a session that is not already running** unless the request is
 *   an explicit track-3 send the user confirmed (`confirmedWake`). The engine's
 *   probe is therefore the bridge's non-waking `resolveAgent`; only the
 *   optional `resumeAgent` extension resumes a cold Session, and only for a
 *   confirmed send. Waking is permanent residency plus one model turn
 *   (`research/session-delivery.md` §3.2).
 * - **Never claim more than was evidenced.** A recorded answer whose message
 *   was not sent says so; a queue write whose durability barrier failed says
 *   so; an archived session, a moved item or a missing agent is a typed error
 *   (`ReplyEngineError`), never a silent drop.
 *
 * Two-phase delivery is inherited from the harness (DESIGN §6.3): `followup`
 * returns after the durable `agent/inbox/spliced` commit, but the reply only
 * becomes a `user/message` when a step claims it. This engine persists exactly
 * one terminal attempt record — `settled`, `queued` or `failed` — and never a
 * `sending` marker: the `deliveryId` on the message source is what lets the
 * projection fold evidence `delivered`/`acknowledged` later from the log. The
 * one window that leaves is a store write failing after a successful queue
 * write; the reply is then in the session log with its id, and the engine
 * reports that as a `conflict` that names the queued delivery instead of
 * hiding it.
 *
 * Idempotency ordering note: a repeated `deliveryId` is answered from its
 * recorded attempt *before* the item-state and version guards, because it is
 * the same answer, not a new one — a client retrying after a lost response
 * must not see a spurious conflict. A new `deliveryId` on a moved item still
 * fails the state guard.
 *
 * Approval parity (DESIGN §6.4, §6.8) is item-aware rather than track-only. A
 * **mirrored** approval (`source.approvalId` present) is the shipped request
 * the browser's live card settles: only track 1 may carry that decision, and it
 * is never a message and never retroactive (OI-08). An **authored** approval —
 * raised through `open_items`, with no harness request behind it — has no card
 * to settle, so its decision is delivered on track 3 as an ordinary notice:
 * the agent reads it at its next step and may retry the action. That fallback
 * must actually send; recording a decision we never delivered would claim the
 * agent saw an answer it never received.
 *
 * @module dsh-open-items/host/delivery
 */

import { assertNever } from '@deepseek-ai/dsh-util-values'

import { isAuthoredApproval } from '../shared/item-origin'
import { MAX_BODY_CHARS } from '../shared/records'
import type {
  DeliveryFailureCode,
  DeliveryRecord,
  DeliveryTrack,
  OpenItemRecord,
  ReplyPayload,
  Resolution,
} from '../shared/schema'
import type { ReplyRequest, ReplyValue } from '../shared/protocol'
import {
  ReplyEngineError,
  type OutboundMessage,
  type RecordAttemptInput,
  type HostSettleRefusal,
  type ReplyCapabilities,
  type ReplyEngine,
  type ReplyEngineDeps,
  type ReplyTrack,
  type SessionBridge,
} from './delivery-contract'

/** Longest accepted `deliveryId`; matches the durable record validator (`records.ts`). */
const MAX_DELIVERY_ID_CHARS = 128

/**
 * Reply payloads that can become a message.
 *
 * `option`/`text` are the ordinary track-3 content. `approval` joins them only
 * for an *authored* approval: with no live request to settle, the decision has
 * to reach the agent as a message (DESIGN §6.4/§6.8). The item-aware guard in
 * `reply` admits that shape; a mirrored approval never becomes a message.
 */
export type ReplyMessagePayload = Extract<ReplyPayload, { readonly type: 'option' | 'text' | 'approval' }>

/** Why an answer was recorded instead of delivered. Selects the honest copy. */
export type RecordReason =
  | 'turn-ended'
  | 'idle-unconfirmed'
  | 'candidate-unconfirmed'
  | 'not-running'
  | 'advisory'
  | 'host-settle-unavailable'

/** What the engine decided for one reply, before anything is persisted. */
export type ReplyPlan =
  | { readonly kind: 'client-settle' }
  | { readonly kind: 'host-settle'; readonly note: string }
  | { readonly kind: 'record'; readonly reason: RecordReason; readonly note: string }
  | {
    readonly kind: 'send'
    readonly mode: 'steer' | 'followup'
    readonly message: OutboundMessage
    readonly note: string
  }

/** What the Host observed about the target session without waking it. */
export type SessionProbe =
  | { readonly live: true; readonly running: boolean; readonly turnOpen: boolean }
  | { readonly live: false }

/** Inputs to the answer matrix, kept explicit so the matrix is table-testable. */
export interface ReplyPlanInput {
  readonly item: OpenItemRecord
  readonly payload: ReplyMessagePayload
  /** `deliveryId` rides the durable message source, never the visible text. */
  readonly deliveryId: string
  readonly requestedTrack?: ReplyTrack | undefined
  readonly confirmedWake?: boolean | undefined
  readonly session: SessionProbe
  /** Whether this Host can settle a continued timed question (track 2). */
  readonly hostSettle?: boolean | undefined
}

/** Honest copy for every recorded/sent outcome. One home, asserted by tests. */
export const REPLY_NOTES = {
  turnEnded: 'Saved. The agent will see this the next time it runs in that session.',
  idleUnconfirmed:
    'Saved, not sent: that session is idle, and sending would start a turn. Confirm "Send and resume now" to deliver it.',
  candidateUnconfirmed:
    'Saved, not sent: this item reaches the agent only as a message. Confirm "Send and resume now" to deliver it.',
  notRunning: 'Saved. That session is not running. Confirm "Send and resume now" to deliver it and spend a turn.',
  advisory: 'Recorded. The agent has already moved past this, so it is not interrupted; the answer stays on the item.',
  hostSettled: 'Answer applied. The question is settled and the agent continues.',
  hostSettle:
    'Saved. This Host cannot settle the ask in place, so the answer is recorded for the agent to read on its next run.',
  hostSettleDowngraded:
    'This Host cannot settle the ask in place; the answer was steered into the running turn instead.',
  sentSteer: 'The agent will see this at its next step.',
  sentFollowup: 'Sent. The session is resuming to read it.',
  alreadyRecorded: 'This reply was already recorded; no second delivery was made.',
  durabilityWarning: 'The message was queued, but the durability barrier failed, so a restart may lose it.',
} as const

/**
 * Decide the track for one reply (DESIGN §6.2 router, §6.8 matrix).
 *
 * Precedence: an explicit client settle is recorded as settled; track 2 is not
 * available in this build, so a `host-settle` request degrades (steer while the
 * turn runs, otherwise record) and says which channel it used; everything else
 * follows the blocking × turn-state matrix, with the candidate row delivering
 * because a prose item has no live ask to settle against. An authored approval
 * is planned like any other explicit track-3 send: it has no live ask either, so
 * the same matrix decides between steer, followup and record.
 * @param input - item, payload, session probe and request flags.
 * @returns the plan; pure, so the matrix is tested without fakes.
 */
export function planReply(input: ReplyPlanInput): ReplyPlan {
  const { item, session } = input

  // Track 1: the browser already settled the live card; the engine records it.
  if (input.requestedTrack === 'client-settle') return { kind: 'client-settle' }

  const hostSettle = input.requestedTrack === 'host-settle'
  const explicitSend = input.requestedTrack === 'session-message'
  const candidate = item.tier === 'candidate'
  const message = outboundMessage(item, input.payload, input.deliveryId)

  // Track 2 settles a continued timed question where the Host can reach the
  // service (DESIGN §6.2). A cold session may only be resumed for a confirmed
  // settle; without the port the previous degraded path is preserved.
  if (hostSettle) {
    if (input.hostSettle === true && hostSettleItem(item) && (session.live || input.confirmedWake === true)) {
      return { kind: 'host-settle', note: REPLY_NOTES.hostSettled }
    }
    if (session.live && (session.running || session.turnOpen)) {
      return { kind: 'send', mode: 'steer', message, note: REPLY_NOTES.hostSettleDowngraded }
    }
    return { kind: 'record', reason: 'host-settle-unavailable', note: REPLY_NOTES.hostSettle }
  }

  if (!session.live) {
    // A cold session is only woken by an explicit, confirmed send.
    if ((explicitSend || candidate) && input.confirmedWake === true) {
      return { kind: 'send', mode: 'followup', message, note: REPLY_NOTES.sentFollowup }
    }
    if (candidate) return { kind: 'record', reason: 'candidate-unconfirmed', note: REPLY_NOTES.candidateUnconfirmed }
    if (explicitSend) return { kind: 'record', reason: 'idle-unconfirmed', note: REPLY_NOTES.idleUnconfirmed }
    return { kind: 'record', reason: 'not-running', note: REPLY_NOTES.notRunning }
  }

  const active = session.running || session.turnOpen

  if (active) {
    // Steering joins the live turn: no wake and no extra turn, which is why the
    // matrix prefers it for a blocking ask and why no confirmation is needed.
    if (explicitSend || candidate || item.blocking) {
      return { kind: 'send', mode: 'steer', message, note: REPLY_NOTES.sentSteer }
    }
    return { kind: 'record', reason: 'advisory', note: REPLY_NOTES.advisory }
  }

  // Live and idle: a follow-up would wake it, so only a confirmed send may.
  if (explicitSend || candidate) {
    if (input.confirmedWake === true) {
      return { kind: 'send', mode: 'followup', message, note: REPLY_NOTES.sentFollowup }
    }
    return candidate
      ? { kind: 'record', reason: 'candidate-unconfirmed', note: REPLY_NOTES.candidateUnconfirmed }
      : { kind: 'record', reason: 'idle-unconfirmed', note: REPLY_NOTES.idleUnconfirmed }
  }
  if (item.blocking) return { kind: 'record', reason: 'turn-ended', note: REPLY_NOTES.turnEnded }
  return { kind: 'record', reason: 'advisory', note: REPLY_NOTES.advisory }
}

/**
 * Whether track 2 can settle this item: a question raised by a tool call whose
 * identity the Host can settle against (`source.callId`).
 * @param item - item being answered.
 * @returns true for a continued-question candidate.
 */
export function hostSettleItem(item: OpenItemRecord): boolean {
  return item.kind === 'question' && item.source.callId !== undefined && item.source.callId !== ''
}

/**
 * Build the durable message handed to the bridge (DESIGN §6.4 provenance).
 *
 * The visible text is the user's words verbatim behind one attribution line:
 * the model never sees `source`, so the line names the channel and the item
 * without turning item prose into instructions. An authored approval has no
 * words to quote — the decision *is* the answer — so the body states it in the
 * plugin's own voice and appends the user's note verbatim. The item title is
 * never interpolated: the model must not read model-authored prose as a user
 * instruction.
 * @param item - item being answered.
 * @param payload - validated message payload.
 * @param deliveryId - idempotency identity carried on the source.
 * @returns the message the bridge turns into a durable `user/message`.
 */
export function outboundMessage(
  item: OpenItemRecord,
  payload: ReplyMessagePayload,
  deliveryId: string,
): OutboundMessage {
  const label = `Reply from the user via Open Items (item ${item.id}, ${item.kind}):`
  return {
    text: `${label}\n${messageBody(payload)}`,
    source: { kind: 'open-items', form: 'notice', itemId: item.id, deliveryId },
  }
}

/**
 * The body of one outbound message.
 *
 * An approval message is an instruction to retry, never a grant: the session
 * message cannot settle the shipped waterfall, so the deterministic phrasing
 * says "approved, one-off" rather than implying a still-open request was
 * settled.
 * @param payload - validated message payload.
 * @returns the decision sentence, or the user's text verbatim.
 */
function messageBody(payload: ReplyMessagePayload): string {
  switch (payload.type) {
    case 'option':
      return payload.option
    case 'text':
      return payload.text
    case 'approval': {
      const decision = payload.outcome === 'allow-once' ? 'Approved (one-off).' : 'Denied.'
      return payload.note === undefined ? decision : `${decision}\nNote: ${payload.note}`
    }
    default:
      return assertNever(payload, 'ReplyMessagePayload')
  }
}

/**
 * Create the engine the route calls.
 * @param deps - store port, session bridge and the injected clock.
 * @returns the reply engine.
 */
export function createReplyEngine(deps: ReplyEngineDeps): ReplyEngine {
  const { store, sessions, now } = deps

  /** Persist one attempt, mapping a lost CAS or a moved item to `conflict`. */
  async function persist(
    request: ReplyRequest,
    delivery: DeliveryRecord,
    extra: { readonly resolution?: Resolution; readonly acknowledgement?: { readonly state: 'pending' } } = {},
  ): Promise<OpenItemRecord> {
    const attempt: RecordAttemptInput = {
      itemId: request.itemId,
      expectedVersion: request.expectedVersion,
      delivery,
      ...(extra.resolution === undefined ? {} : { resolution: extra.resolution }),
      ...(extra.acknowledgement === undefined ? {} : { acknowledgement: extra.acknowledgement }),
    }
    try {
      return await store.recordAttempt(attempt)
    } catch (error) {
      if (isItemMoved(error)) {
        throw new ReplyEngineError(
          `open item "${request.itemId}" changed while this reply was recorded; re-read it`,
          'conflict',
          { cause: error },
        )
      }
      throw error
    }
  }

  /** Keep the attempt the store returned, or the one we built when it was pruned. */
  function recorded(item: OpenItemRecord, delivery: DeliveryRecord): DeliveryRecord {
    return item.deliveries.find(entry => entry.deliveryId === delivery.deliveryId) ?? delivery
  }

  /** Record the user's answer without sending it anywhere (tracks 1-2 and record-only). */
  async function recordAnswer(
    request: ReplyRequest,
    payload: ReplyPayload,
    track: DeliveryTrack,
    note: string | undefined,
    outcome: 'applied' | 'recorded',
  ): Promise<ReplyValue> {
    const at = now()
    const delivery: DeliveryRecord = {
      deliveryId: request.deliveryId,
      at,
      track,
      payload,
      state: 'settled',
    }
    const resolution: Resolution = {
      kind: 'answered',
      at,
      actor: 'user',
      payload,
      deliveryId: request.deliveryId,
    }
    const written = await persist(request, delivery, {
      resolution,
      acknowledgement: { state: 'pending' },
    })
    return {
      item: written,
      delivery: recorded(written, delivery),
      outcome,
      ...(note === undefined ? {} : { note }),
    }
  }

  /** Queue the message for the agent, then record what the queue write proved. */
  async function sendToSession(
    request: ReplyRequest,
    payload: ReplyMessagePayload,
    plan: Extract<ReplyPlan, { readonly kind: 'send' }>,
    agent: unknown,
    sessionId: string,
  ): Promise<ReplyValue> {
    try {
      if (plan.mode === 'steer') sessions.steer(agent, plan.message)
      else sessions.followup(agent, plan.message)
    } catch (cause) {
      // The wire code is `agent-unavailable` (the route's retryable class); the
      // stored failure is `unknown-outcome` because a synchronous throw cannot
      // prove that nothing was queued before it.
      await persistFailure(request, payload, 'session-message', 'unknown-outcome', describe(cause))
      throw new ReplyEngineError(
        `session "${sessionId}" did not accept the reply: ${describe(cause)}`,
        'agent-unavailable',
        { cause },
      )
    }
    let note: string = plan.note
    try {
      await sessions.flush(agent)
    } catch {
      // The inbox splice committed, which is the evidenced accepted point; the
      // durability barrier failing only weakens the restart guarantee.
      note = joinNotes(note, REPLY_NOTES.durabilityWarning)
    }
    const delivery: DeliveryRecord = {
      deliveryId: request.deliveryId,
      at: now(),
      track: 'session-message',
      payload,
      state: 'queued',
    }
    let written: OpenItemRecord
    try {
      written = await persist(request, delivery, { acknowledgement: { state: 'pending' } })
    } catch (error) {
      // The message is already queued; a lost CAS must not hide that fact.
      if (error instanceof ReplyEngineError && error.code === 'conflict') {
        throw new ReplyEngineError(
          `the item changed after the message was queued (delivery "${request.deliveryId}"); re-read it`,
          'conflict',
          { cause: error },
        )
      }
      throw error
    }
    return { item: written, delivery: recorded(written, delivery), outcome: 'sent', note }
  }

  /** Settle a continued timed question in place, or report why it cannot be applied. */
  async function settleQuestion(
    request: ReplyRequest,
    payload: ReplyPayload,
    item: OpenItemRecord,
    agent: unknown,
  ): Promise<ReplyValue> {
    const callId = item.source.callId
    const settle = sessions.hostSettle
    // The plan only chooses this track when both are present; the guard keeps a
    // late service unmount from sending a message the user did not ask for.
    if (callId === undefined || settle === undefined) {
      return recordAnswer(request, payload, 'host-settle', REPLY_NOTES.hostSettle, 'recorded')
    }
    let result: Awaited<ReturnType<NonNullable<SessionBridge['hostSettle']>>>
    try {
      result = await settle.call(sessions, agent, {
        sessionId: item.source.sessionId,
        callId,
        payload,
      })
    } catch (cause) {
      result = { ok: false, reason: 'unknown-outcome' }
      void cause
    }
    if (result.ok) {
      return recordAnswer(request, payload, 'host-settle', REPLY_NOTES.hostSettled, 'applied')
    }
    const refusal = HOST_SETTLE_REFUSAL[result.reason]
    await persistFailure(request, payload, 'host-settle', refusal.failure, refusal.message)
    throw new ReplyEngineError(refusal.message, refusal.engine)
  }

  /** Best-effort evidence for an attempt that failed; the primary failure is rethrown. */
  async function persistFailure(
    request: ReplyRequest,
    payload: ReplyPayload,
    track: DeliveryTrack,
    code: DeliveryFailureCode,
    message: string,
  ): Promise<void> {
    const delivery: DeliveryRecord = {
      deliveryId: request.deliveryId,
      at: now(),
      track,
      payload,
      state: 'failed',
      failure: { code, message: message.slice(0, MAX_BODY_CHARS) },
    }
    try {
      await store.recordAttempt({
        itemId: request.itemId,
        expectedVersion: request.expectedVersion,
        delivery,
      })
    } catch (error) {
      // Contained on purpose: the send failure is the caller's failure. A
      // competing write means the item moved (the route re-reads it); any other
      // store failure is not worth masking the send failure that caused it.
      if (isItemMoved(error)) return
    }
  }

  /** Resolve a cold session for an explicitly confirmed send. */
  async function wake(
    sessionId: string,
  ): Promise<Extract<Awaited<ReturnType<SessionBridge['resolveAgent']>>, { readonly ok: true }>> {
    const resume = (sessions as WakingSessionBridge).resumeAgent
    if (typeof resume !== 'function') {
      throw new ReplyEngineError(
        `session "${sessionId}" is not running and this Host cannot resume it`,
        'agent-unavailable',
      )
    }
    const resolved = await resume.call(sessions, sessionId)
    if (!resolved.ok) {
      throw new ReplyEngineError(
        `session "${sessionId}" could not be resumed (${resolved.reason})`,
        'agent-unavailable',
      )
    }
    return resolved
  }

  return {
    async reply(request: ReplyRequest, requestId: string): Promise<ReplyValue> {
      // Guard order (DESIGN §6.7): request identity → item exists → the same
      // deliveryId already recorded → item is open → CAS on the acted-on
      // version → session not archived → (owner, at the route) → track.
      //
      // Idempotency is checked ahead of the state and version guards on purpose:
      // a repeat of one deliveryId is the same answer, not a new one, so a
      // client retrying after a lost response gets its recorded attempt instead
      // of a spurious conflict. A *new* deliveryId on a moved item still loses.
      assertRequest(request, requestId)
      const payload = parsePayload(request.payload, request.requestedTrack)
      const item = store.get(request.itemId)
      if (item === undefined || item.deletedAt !== undefined) {
        throw new ReplyEngineError(`open item "${request.itemId}" was not found`, 'not-found')
      }
      // Approval decisions are item-aware, not merely track-aware (DESIGN §6.4,
      // §6.8). A mirrored approval is the shipped request the live card settles:
      // track 1 may carry it, nothing else may. An authored approval has no
      // request at all, so a card settle would claim a grant that could not be
      // delivered; its decision may only travel as a track-3 message. Checked
      // before the duplicate and state guards because the track itself — not the
      // item's history — is what makes the combination impossible.
      if (payload.type === 'approval') {
        if (isAuthoredApproval(item)) {
          if (request.requestedTrack === 'client-settle') {
            throw new ReplyEngineError(
              `open item "${request.itemId}" is an authored approval with no live card; use the session-message track`,
              'bad-request',
            )
          }
        } else if (request.requestedTrack === 'session-message') {
          throw new ReplyEngineError(
            'only the live approval card can decide an approval; use Approve and retry to send a new instruction',
            'bad-request',
          )
        }
      }
      // Guard 3: a repeated deliveryId returns its recorded attempt.
      const duplicate = item.deliveries.find(entry => entry.deliveryId === request.deliveryId)
      if (duplicate !== undefined) return duplicateResult(item, duplicate)
      if (item.state !== 'open') {
        throw new ReplyEngineError(
          `open item "${request.itemId}" is ${item.state}, not open`,
          'conflict',
        )
      }
      // Guard 5: CAS on the version the user acted on. The store port repeats it
      // atomically inside `recordAttempt`, which is what makes a race lose cleanly.
      if (item.version !== request.expectedVersion) {
        throw new ReplyEngineError(
          `open item "${request.itemId}" changed since it was read (expected version ${request.expectedVersion}, found ${item.version})`,
          'conflict',
        )
      }
      // Guard 6: the session exists and is not archived. Delivering to an
      // archived session is silently destroyed (session-delivery.md §1.6).
      if (await sessions.archived(item.source.sessionId)) {
        throw new ReplyEngineError(
          `session "${item.source.sessionId}" is archived; restore it before replying`,
          'session-archived',
        )
      }
      // Guard 7 (owner) is the route's owner-Peer fence: this engine has no
      // peer identity and must not invent one.

      // Track 1: the browser settled the shipped card. Its decision is already
      // a fact (one request, one outcome), so the engine only records it; an
      // approval payload is accepted here only for a mirrored item, per the
      // item-aware guard above.
      if (request.requestedTrack === 'client-settle') {
        // Re-read the ask before claiming `applied`: a stale card (the ask
        // settled elsewhere, timed out, or its session is gone) must not become
        // a register misstatement. Positive evidence only — `unknown` proceeds.
        const liveness = await sessions.askLiveness?.(item)
        if (liveness === 'not-live') {
          await persistFailure(
            request,
            payload,
            'client-settle',
            'was-not-applied',
            'the ask was no longer live, so the answer was not applied',
          )
          throw new ReplyEngineError(
            `the ask behind open item "${request.itemId}" is no longer live; re-read it`,
            'conflict',
          )
        }
        return recordAnswer(request, payload, 'client-settle', undefined, 'applied')
      }
      const messagePayload = messagePayloadOf(payload)

      // The probe never wakes; only a confirmed send or settle may resume.
      const probe = await sessions.resolveAgent(item.source.sessionId)
      const planInput = {
        item,
        payload: messagePayload,
        deliveryId: request.deliveryId,
        requestedTrack: request.requestedTrack,
        confirmedWake: request.confirmedWake,
        hostSettle: sessions.capabilities?.().hostSettle === true,
      }
      let plan = planReply({ ...planInput, session: sessionProbe(probe) })
      let agent: unknown = probe.ok ? probe.agent : undefined

      // A follow-up opens a turn and a host settle needs a live root Agent;
      // both may resume a cold session, and only a confirmed request may.
      const wantsWake = plan.kind === 'host-settle'
        || (plan.kind === 'send' && plan.mode === 'followup')
      if (wantsWake && !probe.ok) {
        const resumed = await wake(item.source.sessionId)
        agent = resumed.agent
        plan = planReply({
          ...planInput,
          session: { live: true, running: resumed.running, turnOpen: resumed.turnOpen },
        })
      }

      switch (plan.kind) {
        case 'client-settle':
          return recordAnswer(request, payload, 'client-settle', undefined, 'applied')
        case 'host-settle':
          if (agent === undefined) {
            throw new ReplyEngineError(
              `session "${item.source.sessionId}" is not available to settle the ask`,
              'agent-unavailable',
            )
          }
          return settleQuestion(request, payload, item, agent)
        case 'record':
          // A decision is never merely recorded: the record branch means nothing
          // reached the session, and an item claiming the user decided while the
          // agent never saw it is a lie the inbox would keep. The honest outcome
          // is a refusal that asks for the explicit, confirmed send.
          if (payload.type === 'approval') {
            throw new ReplyEngineError(
              'the approval decision was not delivered: a decision is only ever sent to the session, '
              + 'so confirm "Send and resume now" to deliver it',
              'bad-request',
            )
          }
          return recordAnswer(request, payload, 'host-settle', plan.note, 'recorded')
        case 'send':
          if (agent === undefined) {
            throw new ReplyEngineError(
              `session "${item.source.sessionId}" is not available to receive the reply`,
              'agent-unavailable',
            )
          }
          return sendToSession(request, messagePayload, plan, agent, item.source.sessionId)
        default:
          return assertNever(plan, 'ReplyPlan')
      }
    },

    capabilities(): ReplyCapabilities {
      // Track 1 is always recordable by a mounted engine. Track 2 is advertised
      // only when the bridge reports a working settle port, so `hello` never
      // offers a control the Host cannot carry out.
      const bridge = sessions.capabilities?.()
      return {
        clientSettle: true,
        hostSettle: bridge?.hostSettle === true
          || (bridge === undefined && typeof sessions.hostSettle === 'function'),
      }
    },
  }
}

/**
 * Optional bridge extension. The engine uses it only for a confirmed wake; a
 * bridge without it degrades to a typed `agent-unavailable` instead of waking.
 */
interface WakingSessionBridge extends SessionBridge {
  resumeAgent?(sessionId: string): ReturnType<SessionBridge['resolveAgent']>
}

/**
 * Narrow a bridge probe to the planner's language.
 * @param probe - the bridge result.
 * @returns what the matrix may assume about the session.
 */
function sessionProbe(
  probe: Awaited<ReturnType<SessionBridge['resolveAgent']>>,
): SessionProbe {
  if (!probe.ok) return { live: false }
  return { live: true, running: probe.running, turnOpen: probe.turnOpen }
}

/**
 * Map one already-recorded delivery to its result (idempotent repeat).
 * @param item - current item.
 * @param delivery - the recorded attempt with this deliveryId.
 * @returns the same attempt, never a second send.
 * @throws {ReplyEngineError} `conflict` when the recorded attempt failed: the
 * user must start a new attempt, which is what a new deliveryId means.
 */
function duplicateResult(item: OpenItemRecord, delivery: DeliveryRecord): ReplyValue {
  if (delivery.state === 'failed') {
    throw new ReplyEngineError(
      `delivery "${delivery.deliveryId}" already failed (${delivery.failure?.code ?? 'failed'}); start a new attempt`,
      'conflict',
    )
  }
  return {
    item,
    delivery,
    outcome: delivery.state === 'settled' ? 'applied' : 'sent',
    note: REPLY_NOTES.alreadyRecorded,
  }
}

/**
 * Validate the request identity and caps (the route validates transport shape).
 * @param request - wire request.
 * @param requestId - route correlation id; required so a failure can be traced.
 * @throws {ReplyEngineError} `bad-request` for anything the engine cannot honour.
 */
function assertRequest(request: ReplyRequest, requestId: string): void {
  if (typeof requestId !== 'string' || requestId.trim() === '') {
    throw new ReplyEngineError('a request id is required', 'bad-request')
  }
  if (typeof request.itemId !== 'string' || request.itemId.trim() === '') {
    throw new ReplyEngineError('itemId must be a non-empty string', 'bad-request')
  }
  if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 0) {
    throw new ReplyEngineError('expectedVersion must be a non-negative integer', 'bad-request')
  }
  if (typeof request.deliveryId !== 'string' || request.deliveryId.trim() === '') {
    throw new ReplyEngineError('deliveryId must be a non-empty string', 'bad-request')
  }
  if (request.deliveryId.length > MAX_DELIVERY_ID_CHARS) {
    throw new ReplyEngineError(
      `deliveryId must be at most ${MAX_DELIVERY_ID_CHARS} characters`,
      'bad-request',
    )
  }
  if (request.requestedTrack !== undefined && !isReplyTrack(request.requestedTrack)) {
    throw new ReplyEngineError(`unknown reply track "${String(request.requestedTrack)}"`, 'bad-request')
  }
  if (request.confirmedWake !== undefined && typeof request.confirmedWake !== 'boolean') {
    throw new ReplyEngineError('confirmedWake must be a boolean', 'bad-request')
  }
}

/**
 * Validate the payload against the track that may act on it.
 *
 * An approval decision is only meaningful on two tracks: `client-settle` (a
 * mirrored item — the shipped card settled the one live request,
 * `allowed-once`, and the engine persists that fact) and `session-message` (an
 * authored item — no request exists, so the decision is delivered as a message).
 * This function gates the shape and the two tracks; the item-aware guard in
 * `reply` refuses the mismatched *combination*, so an approval can never be
 * granted retroactively and a mirrored one is never granted by a message.
 * Dismissals have their own endpoint; a board task action is applied by the task
 * service through the Lead Agent.
 * @param payload - wire payload.
 * @param requestedTrack - track the client asked for, when it named one.
 * @returns the validated payload.
 * @throws {ReplyEngineError} `bad-request` for a payload this track cannot carry.
 */
function parsePayload(payload: ReplyPayload, requestedTrack: ReplyTrack | undefined): ReplyPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new ReplyEngineError('a reply payload is required', 'bad-request')
  }
  switch (payload.type) {
    case 'option':
      return { type: 'option', option: assertText(payload.option, 'option') }
    case 'text':
      return { type: 'text', text: assertText(payload.text, 'text') }
    case 'approval': {
      if (requestedTrack !== 'client-settle' && requestedTrack !== 'session-message') {
        throw new ReplyEngineError(
          'only the live approval card can decide an approval; use Approve and retry to send a new instruction',
          'bad-request',
        )
      }
      // The card's vocabulary is closed: `allowed-once` or a rejection. An
      // unknown outcome is a bug, never a silent downgrade to deny.
      if (payload.outcome !== 'allow-once' && payload.outcome !== 'deny') {
        throw new ReplyEngineError('an approval decision is allow-once or deny', 'bad-request')
      }
      const note = payload.note === undefined ? undefined : assertText(payload.note, 'note')
      return {
        type: 'approval',
        outcome: payload.outcome,
        ...(note === undefined ? {} : { note }),
      }
    }
    case 'task-action':
      throw new ReplyEngineError(
        'task actions are applied by the task board, not by a reply message',
        'bad-request',
      )
    case 'dismiss':
      throw new ReplyEngineError('use the dismiss action, not reply', 'bad-request')
    default:
      return assertNever(payload, 'ReplyPayload')
  }
}

/**
 * Narrow a validated payload to the shapes a message can carry.
 *
 * `approval` is reachable here only after the item-aware guard proved the item
 * is an authored approval on the session-message track; the mirrored refusal has
 * already happened, so this narrowing cannot turn a live decision into a message.
 * @param payload - validated payload.
 * @returns the message payload.
 * @throws {ReplyEngineError} `bad-request` when the payload is not message content.
 */
function messagePayloadOf(payload: ReplyPayload): ReplyMessagePayload {
  switch (payload.type) {
    case 'option':
    case 'text':
    case 'approval':
      return payload
    case 'task-action':
      throw new ReplyEngineError(
        'task actions are applied by the task board, not by a reply message',
        'bad-request',
      )
    case 'dismiss':
      throw new ReplyEngineError('use the dismiss action, not reply', 'bad-request')
    default:
      return assertNever(payload, 'ReplyPayload')
  }
}

/** How each host-settle refusal is persisted and reported (DESIGN §6.3 codes). */
const HOST_SETTLE_REFUSAL: Readonly<Record<HostSettleRefusal, {
  readonly failure: DeliveryFailureCode
  readonly engine: 'conflict' | 'bad-request' | 'agent-unavailable' | 'unknown-outcome'
  readonly message: string
}>> = {
  'not-answerable': {
    failure: 'cannot-apply',
    engine: 'conflict',
    message: 'the ask is no longer answerable; answer it in the session or send the decision as a message',
  },
  'needs-batch': {
    failure: 'cannot-apply',
    engine: 'conflict',
    message: 'this ask has several questions; answer it in the session',
  },
  'reply-queued': {
    failure: 'was-not-applied',
    engine: 'conflict',
    message: 'another reply is already queued for that ask; re-read the item',
  },
  'bad-answer': {
    failure: 'cannot-apply',
    engine: 'bad-request',
    message: 'that choice is not one of the ask\'s options',
  },
  'agent-unavailable': {
    failure: 'agent-unavailable',
    engine: 'agent-unavailable',
    message: 'the session is not available to settle the ask',
  },
  'unknown-outcome': {
    failure: 'unknown-outcome',
    engine: 'unknown-outcome',
    message: 'the answer outcome is unknown; re-read the item',
  },
}

/**
 * Validate one reply string against the durable record bound.
 * @param value - candidate text.
 * @param field - field name for the failure message.
 * @returns the unchanged text.
 * @throws {ReplyEngineError} `bad-request` when empty or over `MAX_BODY_CHARS`.
 */
function assertText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ReplyEngineError(`reply ${field} must be a string`, 'bad-request')
  if (value.trim() === '') throw new ReplyEngineError(`reply ${field} must not be empty`, 'bad-request')
  if (value.length > MAX_BODY_CHARS) {
    throw new ReplyEngineError(`reply ${field} must be at most ${MAX_BODY_CHARS} characters`, 'bad-request')
  }
  return value
}

/** Whether the store-port failure means the item changed under us. */
function isItemMoved(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'ConflictError'
    || error.name === 'InvalidTransitionError'
    || /changed \(expected version/u.test(error.message)
}

/** Whether the wire string is one of the three tracks. */
function isReplyTrack(value: string): value is ReplyTrack {
  return value === 'client-settle' || value === 'host-settle' || value === 'session-message'
}

/** Human-readable one-line error text. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Join two copy fragments without losing either sentence. */
function joinNotes(first: string, second: string): string {
  return first.trim() === '' ? second : `${first} ${second}`
}
