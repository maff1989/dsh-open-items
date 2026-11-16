/**
 * The explicit "Send & resume now" step (DESIGN §6.8, P0-05).
 *
 * A message send wakes an idle session and spends a turn. The surface never
 * does that on the first click: it renders this warned block first, and only the
 * explicit confirm sends `confirmedWake: true`.
 *
 * @module dsh-open-items/client/ui/answer/SendConfirm
 */
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { PageTranslate } from '../../format'

/** Props of the warned send step. */
export interface SendConfirmProps {
  readonly t: PageTranslate
  /** Session title the send would resume. */
  readonly sessionTitle: string
  readonly onCancel: () => void
  readonly onConfirm: () => void
}

/**
 * Render the warned send confirmation.
 * @param props - copy, the target session and the two decisions.
 * @returns the inline confirmation block.
 */
// style-justification: hand-rolled-control — the warned wake step is the inline confirm DESIGN §6.8 requires for a send that spends a turn; it is a notice with an explicit confirm, not an acknowledge-gated permission, so RiskConfirmation (a modal) would be a UX regression.
export function SendConfirm({ t, sessionTitle, onCancel, onConfirm }: SendConfirmProps): ReactNode {
  return (
    <div className="dsh-oi-detailSection" role="group" aria-label={t('answer.wake.confirmTitle')}>
      <h3 className="dsh-oi-detailLabel">{t('answer.wake.confirmTitle')}</h3>
      <p className="dsh-oi-detailBody">{t('answer.wake.confirmBody', { title: sessionTitle })}</p>
      <div className="dsh-oi-detailActions">
        <Button size="sm" variant="primary" onClick={onConfirm}>{t('answer.wake.confirm')}</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>{t('answer.wake.cancel')}</Button>
      </div>
    </div>
  )
}
