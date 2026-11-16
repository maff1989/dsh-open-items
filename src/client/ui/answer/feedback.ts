/**
 * The answer lifecycle as pure state: what an attempt is doing, which claim the
 * surface may make about it, and the words for every outcome and refusal.
 *
 * Split from the components so the honesty rules (never call a recorded outcome
 * "sent", never invent a failure reason) are testable without a DOM, and so the
 * row, the detail and the page cannot phrase the same outcome differently.
 *
 * @module dsh-open-items/client/ui/answer/feedback
 */
import type { AnswerPlan, SettleResult } from '../../data/settle'
import type { PageTranslate } from '../../format'
import type { OpenItemsKey } from '../../locales'
import type { ReplyPayload } from '../../../shared/schema'

/** The claim one attempt is allowed to make. */
export type AnswerClaim = 'applied' | 'sent' | 'recorded' | 'failed'

/** What the surfaces render for one item's last answer attempt. */
export interface AnswerAttempt {
  readonly itemId: string
  readonly status: 'sending' | 'done' | 'failed'
  readonly claim: AnswerClaim
  readonly plan: AnswerPlan
  readonly payload: ReplyPayload
  /** The idempotency key of this attempt (a retry must reuse it). */
  readonly deliveryId?: string
  /** True when this attempt carried the explicit wake confirmation. */
  readonly confirmedWake: boolean
  /** Locale-owned words for the row notice, the detail notice and the live region. */
  readonly message: string
  /** True when the exact attempt can be retried (same deliveryId). */
  readonly retryable: boolean
  /** True when the honest next step is the explicit "Send & resume now". */
  readonly offersWake: boolean
}

/** Refusal reason → copy key. Every `SettleRefusal` and wire code is mapped. */
const REFUSAL_KEYS: Readonly<Record<string, OpenItemsKey>> = {
  'no-carrier': 'answer.refusal.no-carrier',
  'no-live-ask': 'answer.refusal.no-live-ask',
  'not-answerable': 'answer.refusal.not-answerable',
  'needs-batch': 'answer.refusal.needs-batch',
  'bad-payload': 'answer.refusal.bad-payload',
  'no-host-settle': 'answer.refusal.no-host-settle',
  'host-cannot-record': 'answer.refusal.host-cannot-record',
  'bad-request': 'answer.refusal.bad-request',
  'not-found': 'answer.refusal.not-found',
  conflict: 'answer.refusal.conflict',
  forbidden: 'answer.refusal.forbidden',
  'limit-reached': 'answer.refusal.limit-reached',
  'session-archived': 'answer.refusal.session-archived',
  'agent-unavailable': 'answer.refusal.agent-unavailable',
  'unknown-outcome': 'answer.refusal.unknown-outcome',
  'not-configured': 'answer.refusal.not-configured',
  transport: 'answer.refusal.transport',
}

/** Only the outcomes a retry can plausibly change. */
const RETRYABLE_RESULTS: ReadonlySet<SettleResult['kind']> = new Set(['refused', 'unrecorded'])

/** Copy key of one refusal reason. */
export function refusalKeyOf(reason: string): OpenItemsKey {
  return REFUSAL_KEYS[reason] ?? 'answer.refusal.unknown'
}

/** Resolved refusal copy. */
export function refusalTextOf(t: PageTranslate, reason: string): string {
  return t(refusalKeyOf(reason))
}

/** Copy of the primary action, per route: a settle answers, a message sends. */
export function actionLabelOf(t: PageTranslate, plan: AnswerPlan): string {
  return plan.settles ? t('answer.action.settle') : t('answer.action.send')
}

/**
 * The line shown before the click that says what the click will cost.
 * Settles have no wake cost; a message steers or resumes.
 */
export function wakeLineOf(t: PageTranslate, plan: AnswerPlan, sessionTitle: string): string | undefined {
  if (plan.settles) return undefined
  return plan.steers
    ? t('answer.wake.steers')
    : t('answer.wake.resumes', { title: sessionTitle })
}

/** The attempt state the page stores while the request is in flight. */
export function sendingAttempt(
  t: PageTranslate,
  input: {
    readonly itemId: string
    readonly plan: AnswerPlan
    readonly payload: ReplyPayload
    readonly confirmedWake: boolean
    readonly deliveryId?: string
  },
): AnswerAttempt {
  return {
    itemId: input.itemId,
    status: 'sending',
    claim: 'applied',
    plan: input.plan,
    payload: input.payload,
    confirmedWake: input.confirmedWake,
    message: t('answer.sending'),
    retryable: false,
    offersWake: false,
    ...(input.deliveryId === undefined ? {} : { deliveryId: input.deliveryId }),
  }
}

/** Everything one settled attempt is described by. */
export interface ResultInput {
  readonly itemId: string
  readonly sessionTitle: string
  readonly plan: AnswerPlan
  readonly payload: ReplyPayload
  readonly confirmedWake: boolean
  readonly result: SettleResult
}

/**
 * Resolve one `SettleResult` into the words and flags the surfaces render.
 * The claim comes from the outcome, never from the click: `recorded` is never
 * promoted to `sent`, and a refusal keeps its own reason.
 */
export function attemptOf(t: PageTranslate, input: ResultInput): AnswerAttempt {
  const { result } = input
  const base = {
    itemId: input.itemId,
    plan: input.plan,
    payload: input.payload,
    confirmedWake: input.confirmedWake,
    ...('deliveryId' in result ? { deliveryId: result.deliveryId } : {}),
    ...(RETRYABLE_RESULTS.has(result.kind) ? { retryable: true } : { retryable: false }),
  }
  switch (result.kind) {
    case 'settled':
    case 'host-settled':
      return { ...base, status: 'done', claim: 'applied', message: t('answer.result.applied'), offersWake: false }
    case 'sent':
      return {
        ...base,
        status: 'done',
        claim: 'sent',
        message: t('answer.result.sent', { title: input.sessionTitle }),
        offersWake: false,
      }
    case 'recorded':
      return {
        ...base,
        status: 'done',
        claim: 'recorded',
        message: t('answer.result.recorded', { title: input.sessionTitle }),
        retryable: false,
        offersWake: input.plan.track === 'message' && !input.confirmedWake,
      }
    case 'unavailable':
    case 'not-applied':
      return {
        ...base,
        status: 'failed',
        claim: 'failed',
        message: t('answer.result.failed', { reason: refusalTextOf(t, result.reason) }),
        offersWake: false,
      }
    case 'unrecorded':
      return {
        ...base,
        status: 'failed',
        claim: 'failed',
        message: t('answer.result.failed', { reason: t('answer.result.unrecorded') }),
        offersWake: false,
      }
    case 'refused':
      return {
        ...base,
        status: 'failed',
        claim: 'failed',
        message: t('answer.result.failed', { reason: refusalTextOf(t, result.code) }),
        offersWake: false,
      }
  }
}

/** The polite live-region line for one attempt, or an empty string. */
export function announcementOf(t: PageTranslate, attempt: AnswerAttempt | undefined, remaining: number): string {
  if (attempt === undefined) return ''
  if (attempt.status === 'sending') return t('answer.sending')
  const count = remaining > 0
    ? ` ${t(remaining === 1 ? 'answer.left.one' : 'answer.left.other', { count: remaining })}`
    : ''
  return `${attempt.message}${count}`
}
