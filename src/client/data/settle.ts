/**
 * Track 1 and track 2 from the browser: settle a live ask in place, then record
 * the outcome durably; otherwise fall back to the delivery matrix.
 *
 * Track 1 (DESIGN §6.2) settles the *shipped* card: the same browser client
 * already holds the live request object that the composer card answers
 * (`SessionStatus.pendingInteraction`, published by the shipped
 * `ui-approval`/`ui-user-questions` clients), so the inbox need not race or
 * duplicate it — it answers that exact request and then posts the durable
 * `client-settle` record to the route. Track 2 asks the Host to settle a
 * `continued` timed question it can still answer out-of-band.
 *
 * Everything is feature-detected. The carrier is an internal client contract of
 * the shipped UI (not a documented third-party extension point), so its absence
 * is a first-class state: the controller reports `no-carrier` and the row keeps
 * its approval controls disabled rather than offering a button that cannot work.
 *
 * Approvals split on origin (`shared/item-origin`), and the split decides the
 * track (DESIGN §6.1/§6.4/§6.8). A **mirrored** approval is a capture of a
 * shipped `approval/request`, so the only place it can be decided is the live
 * card the browser already holds (track 1, `allowed-once`/deny). An **authored**
 * approval was declared by `open_items` and has no request to settle: its
 * decision travels as a session message on the track-3 delivery matrix — never a
 * retroactive grant, and never `client-settle`.
 *
 * No surface here mutates item state directly: the Host route owns the durable
 * record, and every refusal is a returned value.
 *
 * The page owns the two things a click must not hide: `planFor` reports when a
 * message would resume an idle session and spend a turn (the surface warns
 * before the click and offers "Send & resume now"), and `answer` accepts the
 * idempotency key of the previous attempt so Retry reuses it.
 *
 * @module dsh-open-items/client/data/settle
 */
import type { OpenItemRecord, ReplyPayload } from '../../shared/schema'
import type { HelloValue, ReplyValue } from '../../shared/protocol'
import { isAuthoredApproval } from '../../shared/item-origin'
import type { InboxTransport } from './transport'

/** The client context slice the controller reads; the real Context satisfies it. */
export interface SettleContext {
  /** Read a client service by name; absent services return `undefined`. */
  get(name: string): unknown
}

/** How answering one item would travel. */
export type SettleMode = 'client-settle' | 'host-settle' | 'message'

/** Why an item cannot be answered on the expected track. */
export type SettleRefusal =
  /** The shipped pending-interaction carrier is not reachable in this browser. */
  | 'no-carrier'
  /** The item's live request is no longer present (settled elsewhere, session closed). */
  | 'no-live-ask'
  /** The live request reports it can no longer accept a decision. */
  | 'not-answerable'
  /** A multi-question ask; the inbox row names only one choice. */
  | 'needs-batch'
  /** The chosen option is not one of the ask's options. */
  | 'bad-payload'
  /** Track 2 was requested but the Host does not advertise it. */
  | 'no-host-settle'
  /** The live card exists, but the Host cannot persist its decision. */
  | 'host-cannot-record'

/** One answer attempt's outcome. Never throws. */
export type SettleResult =
  /** Track 1: the shipped card settled and the Host recorded it. */
  | { readonly kind: 'settled'; readonly reply: ReplyValue; readonly deliveryId: string }
  /** Track 2: the Host settled the continued question and recorded it. */
  | { readonly kind: 'host-settled'; readonly reply: ReplyValue; readonly deliveryId: string }
  /** The Host delivered/queued a message for the agent. */
  | { readonly kind: 'sent'; readonly reply: ReplyValue; readonly deliveryId: string; readonly note?: string }
  /** The Host recorded the answer without sending it (honest note explains). */
  | { readonly kind: 'recorded'; readonly reply: ReplyValue; readonly deliveryId: string; readonly note?: string }
  /** Nothing was attempted; the surface must stay disabled or degrade. */
  | { readonly kind: 'unavailable'; readonly reason: SettleRefusal }
  /** The live card rejected the decision: nothing was recorded. */
  | { readonly kind: 'not-applied'; readonly reason: SettleRefusal; readonly message: string }
  /** The card settled, but the durable record write failed (retry with `deliveryId`). */
  | { readonly kind: 'unrecorded'; readonly deliveryId: string; readonly message: string }
  /** The Host refused the reply with a typed wire code (retry may reuse `deliveryId`). */
  | { readonly kind: 'refused'; readonly code: string; readonly message: string; readonly deliveryId: string }

/**
 * How one click would travel right now: the claim the button may make and
 * whether the click must be warned about spending a turn.
 */
export interface AnswerPlan {
  /** The track the click would take. */
  readonly track: SettleMode
  /** True when the click settles the ask in place (tracks 1-2). */
  readonly settles: boolean
  /** True when a message is steered into a turn that is already running. */
  readonly steers: boolean
  /**
   * True when sending would resume an idle session and spend a turn, so the
   * surface must confirm the explicit "Send & resume now" first.
   */
  readonly requiresWakeConfirmation: boolean
}

/** Per-click options the answer surface owns. */
export interface AnswerOptions {
  /** The user explicitly confirmed that a message may wake the session. */
  readonly confirmedWake?: boolean
  /** Reuse the idempotency key of an earlier attempt (Retry). */
  readonly deliveryId?: string
}

/** What this browser can do right now. */
export interface SettleCapabilities {
  /** A live card carrier is reachable (track 1). */
  readonly clientSettle: boolean
  /** The Host advertises track 2. */
  readonly hostSettle: boolean
  /** The delivery matrix is available (track 3). */
  readonly message: boolean
}

/** The answer surface the page wires into its row/detail handlers. */
export interface SettleController {
  /** Capability snapshot, read per call so a late-mounted carrier is visible. */
  capabilities(): SettleCapabilities
  /** Which track answering this item would take right now. */
  routeFor(item: OpenItemRecord, payload: ReplyPayload): SettleMode
  /**
   * The full click plan (track and wake cost). Optional so a surface composed
   * against an older controller still renders; a missing plan is treated as a
   * warned message send.
   */
  planFor?(item: OpenItemRecord, payload: ReplyPayload): AnswerPlan
  /** Whether the row/detail answer control should be enabled. */
  canAnswer(item: OpenItemRecord): boolean
  /**
   * Whether the Allow/Deny controls should be enabled: an authored approval is
   * decided on the message track, a mirrored one only through its live card.
   */
  canDecideApproval(item: OpenItemRecord): boolean
  /** Answer one item; resolves with the outcome and never throws. */
  answer(item: OpenItemRecord, payload: ReplyPayload, options?: AnswerOptions): Promise<SettleResult>
}

/** Dependencies the controller is built with. */
export interface SettleDeps {
  /** Client context (carrier discovery only). */
  readonly context: SettleContext
  /** The Host route client. */
  readonly transport: InboxTransport
  /** Latest capability probe, when the inbox has one. */
  readonly hello: () => HelloValue | undefined
  /** Idempotency identity for one durable record write. */
  readonly newDeliveryId?: () => string
}

/** One live pending-interaction object, read defensively (internal contract). */
interface LiveInteraction {
  readonly kind: string
  readonly callId: string | undefined
  readonly answerable: boolean | undefined
  readonly questions: readonly unknown[]
  readonly answer: (input: unknown) => Promise<unknown>
}

/** The live request behind one item, or why this browser cannot see it. */
type LiveLookup =
  | { readonly ok: true; readonly interaction: LiveInteraction }
  | { readonly ok: false; readonly reason: 'no-carrier' | 'no-live-ask' }

/** The answer batch one single-question ask takes, or why none can be built. */
type AnswerBatch =
  | { readonly ok: true; readonly answer: { readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[] } }
  | { readonly ok: false; readonly reason: SettleRefusal }

/** Loose record test for feature-detected runtime values. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Read one string member without assuming the runtime shape. */
function stringOf(target: unknown, name: string): string | undefined {
  const value = isRecord(target) ? target[name] : undefined
  return typeof value === 'string' ? value : undefined
}

/** Read one callable member without assuming the runtime shape. */
function methodOf(target: unknown, name: string): ((...args: unknown[]) => unknown) | undefined {
  const value = isRecord(target) ? target[name] : undefined
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown) : undefined
}

/** Default delivery identity: a random UUID, minted once per attempt. */
function defaultDeliveryId(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID()
  return `delivery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Create the settle controller.
 * @param deps - context, transport, capability probe and id source.
 * @returns the controller the page wires into its handlers.
 */
export function createSettleController(deps: SettleDeps): SettleController {
  const { context, transport } = deps
  const newDeliveryId = deps.newDeliveryId ?? defaultDeliveryId

  /** The shipped Session status observable, or undefined when this Client lacks it. */
  function statusMap(): { get(key: string): unknown } | undefined {
    const uiSession = context.get('uiSession')
    const status = isRecord(uiSession) ? uiSession['sessionStatus'] : undefined
    const getSnapshot = methodOf(status, 'getSnapshot')
    if (getSnapshot === undefined) return undefined
    const snapshot = getSnapshot.call(status)
    const get = methodOf(snapshot, 'get')
    return get === undefined ? undefined : { get: key => get.call(snapshot, key) }
  }

  /** Whether any pending-interaction carrier is reachable. */
  function carrierPresent(): boolean {
    return statusMap() !== undefined
  }

  /** Widen one interaction's kind into the ask family the row renders. */
  function interactionFamily(item: OpenItemRecord): readonly string[] {
    switch (item.kind) {
      case 'approval':
        return ['approval']
      case 'plan-review':
        return ['plan-review', 'question']
      case 'question':
        return ['question', 'plan-review']
      default:
        return []
    }
  }

  /** The live request behind this item, when the session currently exposes one. */
  function liveInteraction(item: OpenItemRecord): LiveLookup {
    const map = statusMap()
    if (map === undefined) return { ok: false, reason: 'no-carrier' }
    const status = map.get(item.source.sessionId)
    const pending = isRecord(status) ? status['pendingInteraction'] : undefined
    if (!isRecord(pending)) return { ok: false, reason: 'no-live-ask' }
    const kind = stringOf(pending, 'kind')
    if (kind === undefined || !interactionFamily(item).includes(kind)) {
      return { ok: false, reason: 'no-live-ask' }
    }
    // Identity: the tool call is the join key both sides carry. An item that
    // names no call cannot prove it owns the request, so it never settles one.
    const callId = stringOf(pending, 'callId')
    if (item.source.callId !== undefined && item.source.callId !== '') {
      if (callId !== item.source.callId) return { ok: false, reason: 'no-live-ask' }
    } else if (callId !== undefined) {
      return { ok: false, reason: 'no-live-ask' }
    }
    const answer = methodOf(pending, 'answer')
    if (answer === undefined) return { ok: false, reason: 'no-carrier' }
    const answerable = typeof pending['answerable'] === 'boolean' ? pending['answerable'] : undefined
    const questions = Array.isArray(pending['questions']) ? pending['questions'] : []
    return {
      ok: true,
      interaction: {
        kind,
        callId,
        answerable,
        questions,
        answer: (input: unknown) => Promise.resolve(answer.call(pending, input)),
      },
    }
  }

  /** Build the structured batch one single-question ask needs. */
  function answerBatch(
    questions: readonly unknown[],
    payload: ReplyPayload,
  ): AnswerBatch {
    if (payload.type !== 'option' && payload.type !== 'text') return { ok: false, reason: 'bad-payload' }
    if (questions.length !== 1) return { ok: false, reason: 'needs-batch' }
    const question = questions[0]
    const id = isRecord(question) ? stringOf(question, 'id') : undefined
    if (id === undefined || id === '') return { ok: false, reason: 'bad-payload' }
    if (payload.type === 'text') {
      return { ok: true, answer: { answers: [{ id, selected: [], custom: payload.text }] } }
    }
    const options = isRecord(question) && Array.isArray(question['options']) ? question['options'] : []
    const labels = options
      .map(option => (isRecord(option) ? stringOf(option, 'label') : undefined))
      .filter((label): label is string => label !== undefined)
    if (!labels.includes(payload.option)) return { ok: false, reason: 'bad-payload' }
    return { ok: true, answer: { answers: [{ id, selected: [payload.option] }] } }
  }

  /** Post the durable record of a card settle (idempotent by `deliveryId`). */
  async function recordClientSettle(
    item: OpenItemRecord,
    payload: ReplyPayload,
    deliveryId: string,
  ): Promise<SettleResult> {
    try {
      const reply = await transport.reply({
        itemId: item.id,
        expectedVersion: item.version,
        deliveryId,
        payload,
        requestedTrack: 'client-settle',
      })
      return { kind: 'settled', reply, deliveryId }
    } catch (error) {
      // The card decision already happened and cannot be repeated; the delivery
      // id makes a retry of this exact record idempotent.
      return {
        kind: 'unrecorded',
        deliveryId,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** Settle the live card (track 1), then record it. */
  async function settleThroughCard(
    item: OpenItemRecord,
    payload: ReplyPayload,
    live: LiveInteraction,
    deliveryId: string,
  ): Promise<SettleResult> {
    if (live.answerable === false) return { kind: 'unavailable', reason: 'not-answerable' }
    if (payload.type !== 'approval' && payload.type !== 'option' && payload.type !== 'text') {
      return { kind: 'unavailable', reason: 'bad-payload' }
    }
    try {
      if (live.kind === 'approval') {
        if (payload.type !== 'approval') return { kind: 'unavailable', reason: 'bad-payload' }
        // The shipped card's vocabulary is exact: `allowed-once`, never a
        // persistent grant, and the waterfall settles once.
        await live.answer(payload.outcome === 'allow-once' ? 'allowed-once' : 'rejected')
      } else {
        const batch = answerBatch(live.questions, payload)
        if (!batch.ok) return { kind: 'unavailable', reason: batch.reason }
        await live.answer(batch.answer)
      }
    } catch (error) {
      // The card refused: nothing reached the Host, so nothing is recorded.
      const message = error instanceof Error ? error.message : String(error)
      // A timed-out, cancelled or already-settled request is uniformly "no
      // longer answerable": nothing reached the Host, so nothing is recorded.
      return { kind: 'not-applied', reason: 'not-answerable', message }
    }
    return recordClientSettle(item, payload, deliveryId)
  }

  /** Ask the Host to settle a continued timed question (track 2). */
  async function settleOnHost(item: OpenItemRecord, payload: ReplyPayload, deliveryId: string): Promise<SettleResult> {
    try {
      const reply = await transport.reply({
        itemId: item.id,
        expectedVersion: item.version,
        deliveryId,
        payload,
        requestedTrack: 'host-settle',
        // The click is the confirmation for a settle: track 2 resumes a closed
        // session by design (DESIGN §6.2), and the row copy says so.
        confirmedWake: true,
      })
      return reply.outcome === 'applied'
        ? { kind: 'host-settled', reply, deliveryId }
        : reply.outcome === 'sent'
          ? { kind: 'sent', reply, deliveryId, ...(reply.note === undefined ? {} : { note: reply.note }) }
          : { kind: 'recorded', reply, deliveryId, ...(reply.note === undefined ? {} : { note: reply.note }) }
    } catch (error) {
      return refused(error, deliveryId)
    }
  }

  /**
   * Send the answer through the delivery matrix (track 3).
   *
   * This is the only track an authored approval can take: the decision is a
   * message into the session, not a grant for the agent to settle retroactively.
   *
   * `confirmedWake` is the user's explicit "Send & resume now": without it the
   * Host refuses to wake an idle session and records the answer instead, which
   * the surface must never present as sent (and an approval decision is never
   * recorded without being sent).
   */
  async function deliver(
    item: OpenItemRecord,
    payload: ReplyPayload,
    deliveryId: string,
    confirmedWake: boolean,
  ): Promise<SettleResult> {
    try {
      const reply = await transport.reply({
        itemId: item.id,
        expectedVersion: item.version,
        deliveryId,
        payload,
        requestedTrack: 'session-message',
        ...(confirmedWake ? { confirmedWake: true } : {}),
      })
      if (reply.outcome === 'sent') {
        return { kind: 'sent', reply, deliveryId, ...(reply.note === undefined ? {} : { note: reply.note }) }
      }
      if (reply.outcome === 'recorded') {
        return { kind: 'recorded', reply, deliveryId, ...(reply.note === undefined ? {} : { note: reply.note }) }
      }
      // A settle recorded on the message track is not a thing this client asks
      // for; report the durable outcome rather than inventing one.
      return { kind: 'recorded', reply, deliveryId, ...(reply.note === undefined ? {} : { note: reply.note }) }
    } catch (error) {
      return refused(error, deliveryId)
    }
  }

  /** Map one route failure to a typed outcome. */
  function refused(error: unknown, deliveryId: string): SettleResult {
    const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : 'unknown'
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'refused', code, message, deliveryId }
  }

  /** How the session behind one item is running right now. */
  type Liveness = 'running' | 'idle' | 'unknown'

  /**
   * Read one session's running state from the shipped status carrier.
   * Absence is `unknown`, which the surface treats as a warned wake.
   */
  function sessionLiveness(sessionId: string): Liveness {
    const status = statusMap()?.get(sessionId)
    if (!isRecord(status)) return 'unknown'
    return status['running'] === true ? 'running' : 'idle'
  }

  /** Capability snapshot shared by the returned methods. */
  function capabilitiesOf(): SettleCapabilities {
    const hello = deps.hello()
    // Track 1 needs both halves: the live card to decide, and a Host that will
    // persist the decision. Advertising it before the capability probe lands
    // would let a click settle a request that never becomes a record.
    return {
      clientSettle: carrierPresent() && hello?.capabilities.canSettleClient === true,
      hostSettle: hello?.capabilities.canHostSettle === true,
      message: true,
    }
  }

  /** Track for one payload, shared by `routeFor` and `answer`. */
  function routeOf(item: OpenItemRecord, payload: ReplyPayload): SettleMode {
    // An authored approval has no request to settle: its decision is a session
    // message. The branch is explicit and first so this item can never claim
    // the live-card track, even if a carrier still publishes some request.
    if (payload.type === 'approval' && isAuthoredApproval(item)) return 'message'
    const live = liveInteraction(item)
    if (capabilitiesOf().clientSettle && live.ok) {
      if (live.interaction.kind === 'approval') {
        if (payload.type === 'approval') return 'client-settle'
      } else if (payload.type !== 'approval') {
        return 'client-settle'
      }
    }
    const host = deps.hello()?.capabilities.canHostSettle === true
    if (host && item.kind === 'question' && item.source.callId !== undefined && item.source.callId !== '') {
      return 'host-settle'
    }
    return 'message'
  }

  /** The click plan of one payload, including its wake cost. */
  function planOf(item: OpenItemRecord, payload: ReplyPayload): AnswerPlan {
    const track = routeOf(item, payload)
    if (track !== 'message') {
      return { track, settles: true, steers: false, requiresWakeConfirmation: false }
    }
    const liveness = sessionLiveness(item.source.sessionId)
    return {
      track,
      settles: false,
      steers: liveness === 'running',
      requiresWakeConfirmation: liveness !== 'running',
    }
  }

  return {
    capabilities: capabilitiesOf,

    routeFor: routeOf,

    planFor: planOf,

    canAnswer(item: OpenItemRecord): boolean {
      if (item.state !== 'open') return false
      // Open items route to the delivery matrix at worst, so any open item is
      // answerable; track 1/2 only change which channel carries it.
      return true
    },

    canDecideApproval(item: OpenItemRecord): boolean {
      if (item.state !== 'open' || item.kind !== 'approval') return false
      // An authored sign-off is decided on the message track, which needs no
      // live card; the track-3 matrix is always available.
      if (isAuthoredApproval(item)) return true
      if (!capabilitiesOf().clientSettle) return false
      const live = liveInteraction(item)
      return live.ok
        && live.interaction.kind === 'approval'
        && live.interaction.answerable !== false
    },

    async answer(item: OpenItemRecord, payload: ReplyPayload, options: AnswerOptions = {}): Promise<SettleResult> {
      if (item.state !== 'open') return { kind: 'unavailable', reason: 'not-answerable' }
      // One attempt, one idempotency key: a Retry passes the previous key back.
      const deliveryId = options.deliveryId ?? newDeliveryId()
      const live = liveInteraction(item)
      if (payload.type === 'approval') {
        // Authored sign-off: no harness request exists, so the decision is the
        // ordinary track-3 send (DESIGN §6.4/§6.8) and is only ever a message.
        if (isAuthoredApproval(item)) {
          return deliver(item, payload, deliveryId, options.confirmedWake === true)
        }
        // Everything else is a mirrored live-card decision (track 1).
        if (!live.ok) return { kind: 'unavailable', reason: live.reason }
        if (!capabilitiesOf().clientSettle) {
          // The card could decide it, but this Host would not record it: refuse
          // before touching the waterfall so no decision exists without a record.
          return { kind: 'unavailable', reason: 'host-cannot-record' }
        }
        return settleThroughCard(item, payload, live.interaction, deliveryId)
      }
      if (live.ok && live.interaction.kind !== 'approval' && capabilitiesOf().clientSettle) {
        return settleThroughCard(item, payload, live.interaction, deliveryId)
      }
      if (routeOf(item, payload) === 'host-settle') return settleOnHost(item, payload, deliveryId)
      return deliver(item, payload, deliveryId, options.confirmedWake === true)
    },
  }
}
