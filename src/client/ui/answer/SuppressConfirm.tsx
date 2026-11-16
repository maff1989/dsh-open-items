/**
 * Confirmation for the one permanent candidate action.
 *
 * "Not an item" writes a durable suppressor: the candidate is hidden and will
 * never be raised again, yet it used to be a single outline click next to the
 * benign "It's an item". It now goes through the shipped Modal like the other
 * sensitive decisions, with the permanence stated in the body.
 *
 * @module dsh-open-items/client/ui/answer/SuppressConfirm
 */
import { useState, type ReactNode } from 'react'
import { RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'

import type { PageTranslate } from '../../format'

/** Props of one suppression confirmation. */
export interface SuppressConfirmProps {
  readonly t: PageTranslate
  readonly open: boolean
  readonly onCancel: () => void
  readonly onConfirm: () => void
}

/**
 * Render the suppression confirmation.
 * @param props - copy, open state and the two outcomes.
 * @returns the dialog, or null while closed.
 */
export function SuppressConfirm({ t, open, onCancel, onConfirm }: SuppressConfirmProps): ReactNode {
  const [acknowledged, setAcknowledged] = useState(false)
  return (
    <RiskConfirmation
      open={open}
      title={t('candidate.suppress.title')}
      description={t('candidate.suppress.body')}
      acknowledgeLabel={t('candidate.suppress.acknowledge')}
      cancelLabel={t('answer.approval.cancel')}
      closeLabel={t('answer.approval.close')}
      confirmLabel={t('candidate.action.suppress')}
      acknowledged={acknowledged}
      onAcknowledgedChange={setAcknowledged}
      onCancel={() => {
        setAcknowledged(false)
        onCancel()
      }}
      onConfirm={() => {
        setAcknowledged(false)
        onConfirm()
      }}
    />
  )
}
