/**
 * The answer feedback model: the claim each `SettleResult` may make, the copy of
 * every refusal, the retry / explicit-wake offers, the live announcement and the
 * app-scoped notice store.
 *
 * These are the honesty rules of WP-05 in isolation: a `recorded` outcome can
 * never be presented as sent, a refusal keeps its own reason, and only a settled
 * outcome is ever toasted.
 */
import { describe, expect, it, vi } from 'vitest'

import type { AnswerPlan, SettleResult } from '../../src/client/data/settle'
import type { ReplyPayload } from '../../src/shared/schema'
import type { ReplyValue } from '../../src/shared/protocol'
import {
  actionLabelOf,
  announcementOf,
  attemptOf,
  refusalKeyOf,
  sendingAttempt,
  wakeLineOf,
  type ResultInput,
} from '../../src/client/ui/answer/feedback'
import { createAnswerNoticeStore, noticeOf } from '../../src/client/ui/answer/notices'
import { t } from './fixtures'

/** A route reply stub; the feedback model only reads the outcome. */
const reply = {} as ReplyValue

/** A message-track plan that must warn before it spends a turn. */
const messagePlan: AnswerPlan = { track: 'message', settles: false, steers: false, requiresWakeConfirmation: true }

/** A settle plan (track 1) with no wake cost. */
const settlePlan: AnswerPlan = { track: 'client-settle', settles: true, steers: false, requiresWakeConfirmation: false }

/** One result input around a payload. */
function inputOf(result: SettleResult, plan: AnswerPlan = messagePlan, confirmedWake = false): ResultInput {
  const payload: ReplyPayload = { type: 'text', text: 'Keep the five colours' }
  return { itemId: 'item-1', sessionTitle: 'Hookshot review', plan, payload, confirmedWake, result }
}

describe('result claims', () => {
  it('never renders a recorded outcome as sent', () => {
    const attempt = attemptOf(t, inputOf({ kind: 'recorded', reply, deliveryId: 'd-1', note: 'host note' }))
    expect(attempt.claim).toBe('recorded')
    expect(attempt.status).toBe('done')
    expect(attempt.message).toContain('Saved, not sent')
    expect(attempt.message).not.toBe(t('answer.result.sent', { title: 'Hookshot review' }))
    // The honest next step is the explicit, warned wake.
    expect(attempt.offersWake).toBe(true)
  })

  it('does not offer a wake after a confirmed send was still only recorded', () => {
    const attempt = attemptOf(t, inputOf({ kind: 'recorded', reply, deliveryId: 'd-1' }, messagePlan, true))
    expect(attempt.claim).toBe('recorded')
    expect(attempt.offersWake).toBe(false)
  })

  it('claims sent only for a delivered or steered message', () => {
    const attempt = attemptOf(t, inputOf({ kind: 'sent', reply, deliveryId: 'd-2' }))
    expect(attempt.claim).toBe('sent')
    expect(attempt.message).toContain('Hookshot review')
    expect(attempt.retryable).toBe(false)
  })

  it('claims applied for both settle tracks', () => {
    expect(attemptOf(t, inputOf({ kind: 'settled', reply, deliveryId: 'd-3' }, settlePlan)).claim).toBe('applied')
    expect(attemptOf(t, inputOf({ kind: 'host-settled', reply, deliveryId: 'd-3' }, settlePlan)).claim).toBe('applied')
  })
})

describe('failures', () => {
  it('keeps the reason and the retry key of a refused reply', () => {
    const attempt = attemptOf(t, inputOf({ kind: 'refused', code: 'conflict', message: 'stale', deliveryId: 'd-4' }))
    expect(attempt.status).toBe('failed')
    expect(attempt.claim).toBe('failed')
    expect(attempt.retryable).toBe(true)
    expect(attempt.deliveryId).toBe('d-4')
    expect(attempt.message).toContain(t('answer.refusal.conflict'))
  })

  it('offers a retry for a settle that could not be recorded', () => {
    const attempt = attemptOf(t, inputOf({ kind: 'unrecorded', deliveryId: 'd-5', message: 'route down' }))
    expect(attempt.retryable).toBe(true)
    expect(attempt.deliveryId).toBe('d-5')
    expect(attempt.message).toContain(t('answer.result.unrecorded'))
  })

  it('does not pretend a surface refusal is retryable', () => {
    const attempt = attemptOf(t, inputOf({ kind: 'unavailable', reason: 'no-live-ask' }))
    expect(attempt.claim).toBe('failed')
    expect(attempt.retryable).toBe(false)
    expect(attempt.message).toContain(t('answer.refusal.no-live-ask'))
  })

  it('maps every refusal code to human copy', () => {
    const codes = [
      'no-carrier', 'no-live-ask', 'not-answerable', 'needs-batch', 'bad-payload',
      'no-host-settle', 'host-cannot-record', 'bad-request', 'not-found', 'conflict',
      'forbidden', 'limit-reached', 'session-archived', 'agent-unavailable',
      'unknown-outcome', 'not-configured', 'transport',
    ]
    for (const code of codes) {
      expect(refusalKeyOf(code)).not.toBe('answer.refusal.unknown')
    }
    expect(refusalKeyOf('who-knows')).toBe('answer.refusal.unknown')
  })
})

describe('route claims and the wake line', () => {
  it('labels a settle as Answer and a delivery as Send to session', () => {
    expect(actionLabelOf(t, settlePlan)).toBe('Answer')
    expect(actionLabelOf(t, messagePlan)).toBe('Send to session')
  })

  it('shows the wake cost of a send and nothing for a settle', () => {
    expect(wakeLineOf(t, settlePlan, 'Hookshot review')).toBeUndefined()
    expect(wakeLineOf(t, messagePlan, 'Hookshot review')).toBe('Sending resumes Hookshot review and spends a turn.')
    expect(wakeLineOf(t, { ...messagePlan, steers: true, requiresWakeConfirmation: false }, 'Hookshot review'))
      .toBe('The turn is running: this answer steers into it.')
  })
})

describe('sending state, announcement and notices', () => {
  it('reports the attempt as sending before a response', () => {
    const attempt = sendingAttempt(t, {
      itemId: 'item-1',
      plan: messagePlan,
      payload: { type: 'text', text: 'x' },
      confirmedWake: false,
    })
    expect(attempt.status).toBe('sending')
    expect(attempt.message).toBe(t('answer.sending'))
    expect(noticeOf(t, attempt, { retry: () => undefined, wake: () => undefined })).toBeUndefined()
  })

  it('announces the result with the remaining count', () => {
    const attempt = attemptOf(t, inputOf({ kind: 'settled', reply, deliveryId: 'd-6' }, settlePlan))
    expect(announcementOf(t, attempt, 2)).toBe(`${t('answer.result.applied')} ${t('answer.left.other', { count: 2 })}`)
    expect(announcementOf(t, attempt, 1)).toContain(t('answer.left.one', { count: 1 }))
    expect(announcementOf(t, attempt, 0)).toBe(t('answer.result.applied'))
    expect(announcementOf(t, undefined, 3)).toBe('')
  })

  it('toasts a success, an honest notice and a failure with the right follow-up', () => {
    const retry = vi.fn()
    const wake = vi.fn()
    const actions = { retry, wake }

    const recorded = noticeOf(t, attemptOf(t, inputOf({ kind: 'recorded', reply, deliveryId: 'd-7' })), actions)
    expect(recorded?.tone).toBe('notice')
    expect(recorded?.action?.label).toBe(t('answer.wake.confirm'))
    recorded?.action?.run()
    expect(wake).toHaveBeenCalled()

    const refused = noticeOf(t, attemptOf(t, inputOf({ kind: 'refused', code: 'conflict', message: 'x', deliveryId: 'd-8' })), actions)
    expect(refused?.tone).toBe('error')
    expect(refused?.action?.label).toBe(t('answer.retry'))
    refused?.action?.run()
    expect(retry).toHaveBeenCalled()

    const applied = noticeOf(t, attemptOf(t, inputOf({ kind: 'settled', reply, deliveryId: 'd-9' }, settlePlan)), actions)
    expect(applied?.tone).toBe('ok')
    expect(applied?.action).toBeUndefined()
  })

  it('keeps one current notice with monotonic ids and a scoped dismiss', () => {
    const store = createAnswerNoticeStore()
    const seen: number[] = []
    store.subscribe(() => {
      seen.push(store.getSnapshot()?.id ?? 0)
    })
    const first = store.show({ tone: 'ok', text: 'first' })
    const second = store.show({ tone: 'error', text: 'second' })
    expect(second).toBeGreaterThan(first)
    expect(store.getSnapshot()?.text).toBe('second')
    // A late dismissal of the older notice must not clear the newer one.
    store.dismiss(first)
    expect(store.getSnapshot()?.text).toBe('second')
    store.dismiss(second)
    expect(store.getSnapshot()).toBeUndefined()
    expect(seen.length).toBeGreaterThanOrEqual(3)
  })
})
