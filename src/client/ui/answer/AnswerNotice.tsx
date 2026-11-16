/**
 * The in-place answer notice shared by the row and the detail pane.
 *
 * A surface-owned failure stays on the surface (it must remain re-readable);
 * the app-wide Toast is additive for transient outcomes only. The same
 * component renders "sending", the honest outcome line, and the two explicit
 * follow-ups a failure can offer: Retry (same `deliveryId`) and the warned
 * "Send & resume now" for a recorded-not-sent attempt.
 *
 * @module dsh-open-items/client/ui/answer/AnswerNotice
 */
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { PageTranslate } from '../../format'
import type { AnswerAttempt } from './feedback'

/** Props of one in-place notice. */
export interface AnswerNoticeProps {
  readonly t: PageTranslate
  readonly attempt: AnswerAttempt
  /** Re-send the exact attempt; absent when the surface cannot retry. */
  readonly onRetry?: () => void
  /** Explicit "Send & resume now"; absent when the surface cannot wake. */
  readonly onWake?: () => void
}

/**
 * Render the notice of the last attempt for one item.
 * @param props - copy, the attempt and its follow-up callbacks.
 * @returns the notice line and actions.
 */
export function AnswerNotice({ t, attempt, onRetry, onWake }: AnswerNoticeProps): ReactNode {
  if (attempt.status === 'sending') {
    return <p className="dsh-oi-detailMeta" role="status">{t('answer.sending')}</p>
  }
  const failed = attempt.claim === 'failed'
  return (
    <div className="dsh-oi-detailSection" role={failed ? 'alert' : 'status'}>
      <p className={failed ? 'dsh-oi-detailFailure' : 'dsh-oi-detailMeta'}>{attempt.message}</p>
      {(attempt.retryable && onRetry !== undefined) || (attempt.offersWake && onWake !== undefined)
        ? (
          <div className="dsh-oi-detailActions">
            {attempt.retryable && onRetry !== undefined && (
              <Button size="sm" variant="outline" onClick={onRetry}>{t('answer.retry')}</Button>
            )}
            {attempt.offersWake && onWake !== undefined && (
              <Button size="sm" variant="primary" onClick={onWake}>{t('answer.wake.confirm')}</Button>
            )}
          </div>
        )
        : null}
    </div>
  )
}
