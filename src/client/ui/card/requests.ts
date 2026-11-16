/**
 * The card's two route calls, as pure builders so the exact request shapes are
 * testable without a DOM, plus the failure mapping the renderer switches on.
 *
 * - Hydration reads the durable records for this session so the raise-time
 *   `meta` snapshot can never win over a newer answer. `status: 'all'` is
 *   deliberate: an item that settled elsewhere is still in the read, and the
 *   card needs its receipt rather than a vanished row.
 * - The reply is the single write path (DESIGN §6.7): the card requests the
 *   `session-message` track, because a transcript card is a post-hoc raise and
 *   cannot own a live waterfall. The Host validates and may downgrade the track
 *   to a record with a note.
 *
 * The `deliveryId` is generated once per item attempt and reused for every
 * retry: a double-click, a lost response and an offline retry all collapse into
 * one delivery on the Host.
 *
 * @module dsh-open-items/client/ui/card/requests
 */
import { LIMITS, type ListRequest, type ReplyRequest, type ReplyValue } from '../../../shared/protocol'
import type {
  DeliveryFailureCode,
  DeliveryId,
  DeliveryRecord,
  ReplyPayload,
} from '../../../shared/schema'
import { OpenItemsRpcError, type InboxErrorCode } from '../../data/transport'
import type { OpenItemsCardKey } from './card-locales'
import type { EffectiveItem } from './items'

/** Failure kinds the card distinguishes in copy and behaviour. */
export type CardFailure =
  | 'offline'
  | 'conflict'
  | 'forbidden'
  | 'not-found'
  | 'bad-request'
  | 'session-archived'
  | 'agent-unavailable'
  | 'outcome-unknown'
  | 'limit-reached'
  | 'unknown'

/** The reply outcome the receipt copy keys off (mirrors `ReplyValue.outcome`). */
export type CardOutcome = ReplyValue['outcome']

/** Copy key of one non-conflict failure. */
export const FAILURE_COPY: Record<Exclude<CardFailure, 'conflict'>, OpenItemsCardKey> = {
  offline: 'card.offline',
  forbidden: 'card.failure.forbidden',
  'not-found': 'card.failure.not-found',
  'bad-request': 'card.failure.bad-request',
  'session-archived': 'card.failure.session-archived',
  'agent-unavailable': 'card.failure.agent-unavailable',
  'outcome-unknown': 'card.failure.outcome-unknown',
  'limit-reached': 'card.failure.limit-reached',
  unknown: 'card.failure.unknown',
}

/**
 * Hydration read for one session: every state, bounded page.
 * @param sessionId - Session the rendered row belongs to.
 * @returns the exact list request.
 */
export function hydrationRequest(sessionId: string): ListRequest {
  return { query: { scope: { sessionId }, status: 'all', limit: LIMITS.listPageMax } }
}

/**
 * One reply request for one item.
 * @param item - the item as rendered (its `version` is the CAS token).
 * @param payload - the user's answer, exactly as submitted.
 * @param deliveryId - stable idempotency key for this attempt.
 * @returns the exact reply request.
 */
export function replyRequest(item: Pick<EffectiveItem, 'id' | 'version'>, payload: ReplyPayload, deliveryId: DeliveryId): ReplyRequest {
  return {
    itemId: item.id,
    expectedVersion: item.version,
    deliveryId,
    payload,
    requestedTrack: 'session-message',
  }
}

/** Confirmation copy for a delivered/answered card action. */
export const CONFIRM_COPY: Record<'option' | 'text' | 'dismiss', OpenItemsCardKey> = {
  option: 'card.action.answer',
  text: 'card.action.send',
  dismiss: 'card.action.dismiss',
}

/** Read the answer text a receipt echoes back, when the payload carries one. */
export function answerTextOf(payload: ReplyPayload): string | undefined {
  if (payload.type === 'option') return payload.option
  if (payload.type === 'text') return payload.text === '' ? undefined : payload.text
  return undefined
}

/** Receipt copy key for a successful reply outcome. */
export function outcomeCopyKey(outcome: CardOutcome): OpenItemsCardKey {
  return outcome === 'recorded' ? 'card.receipt.recorded' : 'card.receipt.applied'
}

/** Map one route error to the failure kind the card renders. */
export function failureOf(error: unknown): CardFailure {
  if (!(error instanceof OpenItemsRpcError)) return 'unknown'
  const code: InboxErrorCode = error.code
  switch (code) {
    case 'transport':
      return 'offline'
    case 'conflict':
      return 'conflict'
    case 'forbidden':
      return 'forbidden'
    case 'not-found':
      return 'not-found'
    case 'bad-request':
      return 'bad-request'
    case 'session-archived':
      return 'session-archived'
    case 'agent-unavailable':
      return 'agent-unavailable'
    case 'unknown-outcome':
      return 'outcome-unknown'
    case 'limit-reached':
      return 'limit-reached'
    default:
      return 'unknown'
  }
}

/** Map one evidenced delivery failure code to the card's failure kind. */
export function failureOfDelivery(code: DeliveryFailureCode | undefined): Exclude<CardFailure, 'conflict' | 'offline' | 'forbidden'> {
  switch (code) {
    case 'session-archived':
      return 'session-archived'
    case 'agent-unavailable':
      return 'agent-unavailable'
    case 'unknown-outcome':
      return 'outcome-unknown'
    case 'cannot-apply':
    case 'was-not-applied':
      return 'bad-request'
    default:
      return 'unknown'
  }
}

/** What a lost response turns out to have done, once the Host is asked. */
export type CardRecovery =
  | { readonly kind: 'settled'; readonly outcome: CardOutcome }
  | { readonly kind: 'failed'; readonly failure: Exclude<CardFailure, 'conflict' | 'offline' | 'forbidden'> }

/**
 * Recover the outcome of an attempt whose response was lost.
 *
 * A `sending` delivery (or none at all) means the Host has not settled it yet,
 * so the card re-sends the same `deliveryId` and lets Host idempotency decide.
 * @param delivery - the recorded delivery, when the Host already saw the attempt.
 * @returns the recovered receipt state, or undefined to send again.
 */
export function recoveryOf(delivery: DeliveryRecord | undefined): CardRecovery | undefined {
  switch (delivery?.state) {
    case 'settled':
      return { kind: 'settled', outcome: 'applied' }
    case 'queued':
    case 'delivered':
    case 'acknowledged':
      return { kind: 'settled', outcome: 'sent' }
    case 'failed':
      return { kind: 'failed', failure: failureOfDelivery(delivery.failure?.code) }
    default:
      return undefined
  }
}

/**
 * Generate one delivery idempotency key.
 * @returns a UUID when the platform provides one, else a random hex id.
 */
export function newDeliveryId(): DeliveryId {
  const cryptoImpl = (globalThis as { crypto?: Crypto }).crypto
  if (typeof cryptoImpl?.randomUUID === 'function') return cryptoImpl.randomUUID()
  if (typeof cryptoImpl?.getRandomValues === 'function') {
    const bytes = cryptoImpl.getRandomValues(new Uint8Array(16))
    return `d-${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
  }
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}
