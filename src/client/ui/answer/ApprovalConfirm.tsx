/**
 * The approval confirmation (OI-08, S-05): one decision, made explicitly.
 *
 * Allow goes through the shipped `RiskConfirmation`, whose acknowledge checkbox
 * is the friction the design requires. Deny goes through the shipped `Modal`
 * with a shipped `InlineEditor` reason field, because `RiskConfirmation` has no
 * content slot of its own; both directions are catalogue primitives and neither
 * is a one-click grant.
 *
 * The confirmation owns the origin split (`shared/item-origin`), because the
 * user must consent to what actually happens next (DESIGN §6.1/§6.4): a
 * **mirrored** approval settles the shipped request through the live card and
 * grants one run; an **authored** approval has no request — the decision is sent
 * to the session as a message, which may resume it and spend a turn. The
 * visible labels stay "Allow once"/"Deny" for both; only the consent copy and
 * the acknowledge label differ.
 *
 * @module dsh-open-items/client/ui/answer/ApprovalConfirm
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, InlineEditor, Modal, RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'

import type { OpenItemRecord, ReplyPayload } from '../../../shared/schema'
import { isAuthoredApproval } from '../../../shared/item-origin'
import { sessionLabelOf, type PageTranslate } from '../../format'
import { toPlainText } from '../prose-text'

/** Props of one approval confirmation. */
export interface ApprovalConfirmProps {
  readonly t: PageTranslate
  readonly item: OpenItemRecord
  readonly mode: 'allow' | 'deny'
  /** Whether the confirmation is showing (the caller owns the trigger). */
  readonly open: boolean
  readonly onCancel: () => void
  /** Called with the exact approval payload once the user confirms. */
  readonly onConfirm: (payload: ReplyPayload) => void
  /** Note already drafted in the detail pane; prefills the denial reason. */
  readonly initialReason?: string
  /**
   * Already-resolved Session label from the parent (item snapshot, catalogue,
   * or the untitled fallback). Omitted, the item's own snapshot is used.
   */
  readonly sessionTitle?: string
}

/** Provenance line: the session and turn the approval belongs to. */
function targetLine(t: PageTranslate, item: OpenItemRecord, session: string): string {
  return item.source.turn === undefined
    ? t('answer.approval.targetNoTurn', { session })
    : t('answer.approval.target', { session, turn: item.source.turn })
}

/**
 * Render the confirmation for one approval direction.
 * @param props - copy, the record, the direction and the decision callbacks.
 * @returns the confirmation, or null when closed.
 */
export function ApprovalConfirm({ t, item, mode, open, onCancel, onConfirm, initialReason, sessionTitle }: ApprovalConfirmProps): ReactNode {
  const [acknowledged, setAcknowledged] = useState(false)
  const [reason, setReason] = useState('')

  // A fresh confirmation always starts unacknowledged and with no draft.
  useEffect(() => {
    if (!open) return
    setAcknowledged(false)
    setReason(initialReason ?? '')
  }, [open, mode, initialReason])

  if (!open) return null

  const session = sessionTitle ?? sessionLabelOf(t, item)
  const authored = isAuthoredApproval(item)

  if (mode === 'allow') {
    // The consent copy names the real consequence: a message to the Session for
    // an authored sign-off, a one-run grant for a mirrored live request.
    const allowBody = authored ? t('answer.approval.allowBodyToSession') : t('answer.approval.allowBody')
    const acknowledgeLabel = authored ? t('answer.approval.acknowledgeToSession') : t('answer.approval.acknowledge')
    return (
      <RiskConfirmation
        open
        title={t('answer.approval.allowTitle')}
        description={`${toPlainText(item.title)} — ${targetLine(t, item, session)}. ${allowBody}`}
        acknowledgeLabel={acknowledgeLabel}
        cancelLabel={t('answer.approval.cancel')}
        closeLabel={t('answer.approval.close')}
        confirmLabel={t('answer.approval.allowConfirm')}
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
        onCancel={onCancel}
        onConfirm={() => {
          onConfirm({ type: 'approval', outcome: 'allow-once' })
        }}
      />
    )
  }

  const submit = (): void => {
    const trimmed = reason.trim()
    onConfirm({ type: 'approval', outcome: 'deny', ...(trimmed === '' ? {} : { note: trimmed }) })
  }

  return (
    <Modal
      open
      onClose={onCancel}
      title={t('answer.approval.denyTitle')}
      closeLabel={t('answer.approval.close')}
      description={`${toPlainText(item.title)} — ${targetLine(t, item, session)}. ${t('answer.approval.denyBody')}`}
      footer={(
        <>
          <Button size="sm" variant="outline" onClick={onCancel}>{t('answer.approval.cancel')}</Button>
          <Button size="sm" variant="primary" onClick={submit}>{t('answer.approval.denyConfirm')}</Button>
        </>
      )}
    >
      <p className="dsh-oi-detailLabel">{t('answer.approval.denyReason')}</p>
      <InlineEditor
        value={reason}
        label={t('answer.approval.denyReason')}
        onChange={setReason}
        onSave={submit}
        onCancel={() => {
          setReason('')
        }}
        className="dsh-oi-detailNote"
      />
      <p className="dsh-oi-detailMeta">{t('answer.draft.hint')}</p>
    </Modal>
  )
}
