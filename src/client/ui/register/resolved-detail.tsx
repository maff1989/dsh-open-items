/**
 * The read-only resolved detail (UI.md §5.1): what you decided, how it
 * travelled, what happened next, with Reopen and a History disclosure.
 *
 * Read-only by construction: the decision is rendered from the stored payload
 * verbatim and is never re-generated. Reopen and delete-forever are the writes,
 * both through the register store's typed endpoints; a refusal is shown as copy,
 * not as a silent failure. Delete is a shipped `Menu` row → `RiskConfirmation`
 * (an acknowledge checkbox, S-05); without the seam the row stays focusable and
 * disabled with its reason, so the control is never a dead click.
 *
 * @module dsh-open-items/client/ui/register/resolved-detail
 */
import { useState, type ReactNode } from 'react'
import {
  Button,
  DisclosureRow,
  IconClockOutlineRegular,
  IconEllipsisOutlineRegular,
  IconTrashOutlineRegular,
  Menu,
  MenuItemButton,
  RiskConfirmation,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'

import type { OpenItemRecord } from '../../../shared/schema'
import type { RegisterNotice } from '../../data/register-store'
import { absoluteLabel, relativeLabel, sessionLabelOf, type PageTranslate, type SessionTitleResolver } from '../../format'
import { reopenEligibilityOf, registerTimestampOf } from '../../derive/register-view'
import { KindChip } from '../kind'
import { toPlainText } from '../prose-text'
import { deliveryViewOf } from '../row'
import {
  acknowledgementLineOf,
  decisionBodyOf,
  detectorCodeLabel,
  detectorPhraseOf,
  hasHistory,
  historyLinesOf,
  isCompacted,
  outcomeWordOf,
  reopenedCountOf,
  sourceWordOfRecord,
} from './present'

/** Props of the resolved detail. */
export interface ResolvedDetailProps {
  readonly record: OpenItemRecord
  readonly t: PageTranslate
  readonly now: number
  /** Applies the per-session history filter (UI.md §4.7). */
  readonly onSessionFilter?: (sessionId: string) => void
  readonly openSession?: (sessionId: string) => void
  /** Live catalogue lookup for a Session label the record's snapshot lacks. */
  readonly sessionTitle?: SessionTitleResolver
  /** Back to the list on the narrow layout. */
  readonly onBack: () => void
  /** Reopen seam; absent when the register transport is unavailable. */
  readonly onReopen?: (itemId: string) => void
  /**
   * Delete-forever seam (OD-06). Absent until the Host endpoint is wired, which
   * keeps the menu row disabled-with-reason instead of a dead click.
   * @param itemId - record to tombstone.
   * @param expectedVersion - CAS token from the row the user acted on.
   * @returns true when the tombstone was recorded.
   */
  readonly onDelete?: (itemId: string, expectedVersion: number) => Promise<boolean>
  /** True while the item's reopen request is in flight. */
  readonly busy: boolean
  readonly notice?: RegisterNotice
  readonly onDismissNotice?: () => void
  /** Clipboard seam; defaults to `navigator.clipboard` when available. */
  readonly copy?: (text: string) => Promise<boolean>
}

/** Copy text with the browser clipboard, reporting success honestly. */
async function copyToClipboard(text: string): Promise<boolean> {
  const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } } })
    .navigator?.clipboard
  if (clipboard?.writeText === undefined) return false
  try {
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** One labelled fact row of the "how it travelled" section. */
function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return (
    <div className="dsh-oi-regFact">
      <span className="dsh-oi-regFactLabel">{label}</span>
      <span className="dsh-oi-regFactValue">{children}</span>
    </div>
  )
}

/**
 * Render the read-only detail of one resolved item.
 * @param props - record, copy, clock and the reopen/navigation seams.
 * @returns the detail element.
 */
export function ResolvedDetail(props: ResolvedDetailProps): ReactNode {
  const { record, t, now, busy, notice } = props
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle')
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const deleteAvailable = props.onDelete !== undefined && !busy
  const decision = decisionBodyOf(t, record)
  const detectorCode = detectorCodeLabel(record)
  const eligibility = reopenEligibilityOf(record)
  const sessionTitle = sessionLabelOf(t, record, props.sessionTitle)
  const workspace = record.source.workspace?.title ?? record.source.workspace?.path
  const delivery = deliveryViewOf(record, t)
  const latestDelivery = record.deliveries.at(-1)
  const resolution = record.resolution
  const archived = isCompacted(record) || record.state === 'archived'
  const inFlight = record.state === 'awaiting'
  const history = hasHistory(record) ? historyLinesOf(t, record, now) : []
  const reopenBlocked = !eligibility.ok
    ? t('register.detail.reopen.blockedApproval')
    : undefined

  const copyDecision = (): void => {
    const copy = props.copy ?? copyToClipboard
    void copy(decision).then((ok) => {
      setCopied(ok ? 'ok' : 'failed')
    })
  }

  return (
    <section
      className="dsh-oi-detail dsh-oi-regDetail"
      aria-label={t('register.detail.aria')}
      data-item-id={record.id}
      data-state={record.state}
    >
      <Button size="sm" variant="ghost" className="dsh-oi-back" onClick={props.onBack}>
        {t('detail.back')}
      </Button>
      <div className="dsh-oi-detailHead">
        <KindChip kind={record.kind} label={t(KIND_LABEL[record.kind])} iconSize={14} />
        <Tag tone={record.severity === 1 ? 'warning' : 'neutral'}>{t('detail.severity', { severity: record.severity })}</Tag>
        <span className="dsh-oi-regOutcome">{outcomeWordOf(t, record)}</span>
        <span className="dsh-oi-regDetailSource">{sourceWordOfRecord(t, record)}</span>
      </div>
      <h2 className="dsh-oi-detailTitle" dir="auto">{toPlainText(record.title)}</h2>
      <div className="dsh-oi-detailMeta">
        {props.onSessionFilter === undefined
          ? <span>{sessionTitle}</span>
          : (
            <button
              type="button"
              className="dsh-oi-regSession"
              title={t('register.filter.sessionValue', { title: sessionTitle })}
              onClick={() => props.onSessionFilter?.(record.source.sessionId)}
            >
              {sessionTitle}
            </button>
          )}
        {workspace !== undefined && workspace !== '' && <span>{workspace}</span>}
        {record.source.turn !== undefined && <span>{t('detail.turn', { turn: record.source.turn })}</span>}
        <span title={absoluteLabel(registerTimestampOf(record))}>
          {record.state === 'awaiting'
            ? t('register.detail.inFlightBanner')
            : t('detail.resolved', { time: relativeLabel(t, registerTimestampOf(record), now) })}
        </span>
      </div>
      {archived && <p className="dsh-oi-regBanner dsh-oi-regBanner--archived">{t('register.detail.archivedBanner')}</p>}
      {inFlight && <p className="dsh-oi-regBanner dsh-oi-regBanner--inFlight">{t('register.detail.inFlightBanner')}</p>}

      <div className="dsh-oi-detailSection">
        <h3 className="dsh-oi-detailLabel">{t('register.detail.decided')}</h3>
        <p className="dsh-oi-regDecisionText">{decision}</p>
        {detectorCode !== undefined && (
          <Fact label={t('register.detail.detector')}>
            {detectorPhraseOf(t, detectorCode)} · <code>{detectorCode}</code>
          </Fact>
        )}
        {record.body !== '' && !archived && <p className="dsh-oi-detailBody">{record.body}</p>}
        {record.quote !== undefined && record.quote !== '' && !archived && (
          <blockquote className="dsh-oi-detailQuote">{record.quote}</blockquote>
        )}
      </div>

      <div className="dsh-oi-detailSection">
        <h3 className="dsh-oi-detailLabel">{t('register.detail.travelled')}</h3>
        {latestDelivery === undefined && resolution?.deliveryId === undefined
          ? <p className="dsh-oi-detailMeta">{t('register.detail.noDelivery')}</p>
          : (
            <>
              {latestDelivery !== undefined && (
                <Fact label={t('register.detail.track')}>
                  {t('register.detail.trackValue', { track: latestDelivery.track, state: delivery?.text ?? latestDelivery.state })}
                  {' · '}
                  <code>{latestDelivery.deliveryId}</code>
                </Fact>
              )}
              {latestDelivery === undefined && resolution?.deliveryId !== undefined && (
                <Fact label={t('register.detail.deliveryId')}><code>{resolution.deliveryId}</code></Fact>
              )}
              <Fact label={t('register.detail.evidence')}>
                <Evidence record={record} t={t} />
              </Fact>
            </>
          )}
      </div>

      <div className="dsh-oi-detailSection">
        <h3 className="dsh-oi-detailLabel">{t('register.detail.next')}</h3>
        <p className="dsh-oi-regAckLine">{acknowledgementLineOf(t, record, now)}</p>
        {record.acknowledgement?.evidence?.seq !== undefined && (
          <p className="dsh-oi-detailMeta"><code>seq {record.acknowledgement.evidence.seq}</code></p>
        )}
      </div>

      {notice !== undefined && (
        <p
          className={`dsh-oi-regNotice dsh-oi-regNotice--${notice.tone}`}
          role="status"
          onClick={props.onDismissNotice}
        >
          {noticeText(t, notice)}
        </p>
      )}

      <div className="dsh-oi-detailActions">
        <Button
          size="sm"
          variant="primary"
          onClick={() => props.onReopen?.(record.id)}
          disabled={busy || reopenBlocked !== undefined || props.onReopen === undefined}
          title={reopenBlocked ?? (props.onReopen === undefined ? t('register.detail.reopen.unavailable') : undefined)}
        >
          {busy ? t('register.detail.reopen.busy') : t('register.detail.reopen')}
        </Button>
        <Button size="sm" variant="outline" onClick={copyDecision}>
          {copied === 'ok' ? t('register.detail.copied') : t('register.detail.copy')}
        </Button>
        {copied === 'failed' && <span className="dsh-oi-detailMeta">{t('register.detail.copyFailed')}</span>}
        {props.openSession !== undefined && (
          <Button size="sm" variant="outline" onClick={() => props.openSession?.(record.source.sessionId)}>
            {t('detail.openSession')}
          </Button>
        )}
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          align="end"
          selectedId={undefined}
          anchor={(
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('register.detail.more')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              icon={<IconEllipsisOutlineRegular size={14} />}
              onClick={() => { setMenuOpen(previous => !previous) }}
            />
          )}
        >
          <MenuItemButton
            danger
            disabled={!deleteAvailable}
            disabledReason={deleteAvailable ? undefined : t('register.detail.delete.note')}
            icon={<IconTrashOutlineRegular size={14} />}
            onSelect={() => {
              setMenuOpen(false)
              setAcknowledged(false)
              setConfirmOpen(true)
            }}
          >
            {t('register.detail.delete')}
          </MenuItemButton>
        </Menu>
      </div>
      <RiskConfirmation
        open={confirmOpen}
        title={t('register.detail.delete.confirmTitle')}
        description={t('register.detail.delete.confirmBody')}
        acknowledgeLabel={t('register.detail.delete.acknowledge')}
        cancelLabel={t('register.detail.delete.cancel')}
        closeLabel={t('register.detail.delete.close')}
        confirmLabel={t('register.detail.delete.confirm')}
        acknowledged={acknowledged}
        disabled={busy}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => { setConfirmOpen(false) }}
        onConfirm={() => {
          setConfirmOpen(false)
          void props.onDelete?.(record.id, record.version)
        }}
      />
      {history.length > 0 && (
        <DisclosureRow
          className="dsh-oi-regHistory"
          icon={<IconClockOutlineRegular size={14} />}
          title={`${t('register.detail.history')}${reopenedCountOf(t, record) === '' ? '' : ` · ${reopenedCountOf(t, record)}`}`}
          open={historyOpen}
          expandable
          onToggle={() => { setHistoryOpen(open => !open) }}
        >
          <ul className="dsh-oi-regHistoryList">
            {history.map(line => (
              <li key={line.key}>
                {line.label}
                {line.detail !== undefined && <span className="dsh-oi-regHistoryDetail"> — {line.detail}</span>}
              </li>
            ))}
          </ul>
        </DisclosureRow>
      )}
    </section>
  )
}

/** Evidence coordinates of one record, as one line of `<code>` fragments. */
function Evidence({ record, t }: { readonly record: OpenItemRecord; readonly t: PageTranslate }): ReactNode {
  const evidence = record.resolution?.evidence
  if (evidence === undefined) return <span>{t('register.detail.noEvidence')}</span>
  const parts: string[] = []
  if (evidence.seq !== undefined) parts.push(`seq ${String(evidence.seq)}`)
  if (evidence.callId !== undefined) parts.push(evidence.callId)
  if (evidence.messageId !== undefined) parts.push(evidence.messageId)
  if (evidence.inboxId !== undefined) parts.push(evidence.inboxId)
  if (parts.length === 0) return <span>{t('register.detail.noEvidence')}</span>
  return <code>{parts.join(' · ')}</code>
}

/** Localized copy of one store notice. */
function noticeText(t: PageTranslate, notice: RegisterNotice): string {
  if (notice.tone === 'ok') {
    if (notice.code === 'reopened') return t('register.detail.reopen.ok')
    if (notice.code === 'deleted') return t('register.detail.delete.ok')
    return t('export.ok', {
      filename: notice.filename ?? '',
      size: notice.byteLength === undefined ? '0' : String(Math.max(1, Math.round(notice.byteLength / 1024))),
    })
  }
  switch (notice.code) {
    case 'reopen-failed':
      return t('register.detail.reopen.error', { message: notice.message })
    case 'delete-failed':
      return t('register.detail.delete.error', { message: notice.message })
    case 'unavailable':
      return notice.message === 'delete-unavailable'
        ? t('register.detail.delete.unavailable')
        : t('register.detail.reopen.unavailable')
    case 'export-failed':
      return t('export.error', { message: notice.message })
  }
}

/** Kind label key per kind (typed translator keys). */
const KIND_LABEL = {
  decision: 'kind.decision',
  approval: 'kind.approval',
  question: 'kind.question',
  'plan-review': 'kind.plan-review',
  blocker: 'kind.blocker',
  risk: 'kind.risk',
  'follow-up': 'kind.follow-up',
  task: 'kind.task',
} as const
