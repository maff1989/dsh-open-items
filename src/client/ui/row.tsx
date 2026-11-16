/**
 * One inbox row: a scan line, not a form.
 *
 * The round-3 refinement collapsed the row from a five-band card to a uniform
 * two-line summary: identification first (title), then one quiet meta line
 * (kind · turn · delivery state). Answering moved to the detail pane, which is
 * the only surface that owns a draft; the row keeps only the decisions that are
 * genuinely one click — approvals (through the shipped confirmation), candidate
 * confirm/refuse, and the task/failed session hand-off.
 *
 * Variants: approval, question with options, question needing text, candidate,
 * task, delivered/awaiting, failed delivery, resolved/register, plain decision.
 *
 * @module dsh-open-items/client/ui/row
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  Checkbox,
  IconChevronRightOutlineRegular,
  StateDot,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'

import type { OpenItemRecord, ReplyPayload } from '../../shared/schema'
import { isAuthoredApproval } from '../../shared/item-origin'
import type { CandidateFailure, CandidatePromotePatch } from '../data/candidate-actions'
import type { AnswerPlan } from '../data/settle'
import { absoluteLabel, relativeLabel, sessionLabelOf, type PageTranslate, type SessionTitleResolver } from '../format'
import { AnswerNotice } from './answer/AnswerNotice'
import { ApprovalConfirm } from './answer/ApprovalConfirm'
import { SuppressConfirm } from './answer/SuppressConfirm'
import type { AnswerAttempt } from './answer/feedback'
import { distinctQuoteOf, isProseOrigin } from './candidate'
import { KIND_META } from './kind'
import { renderProseOf, toPlainText } from './prose-text'

/** Row variants the spec distinguishes. */
export type RowVariant =
  | 'approval'
  | 'options'
  | 'text'
  | 'candidate'
  | 'task'
  | 'awaiting'
  | 'failed'
  | 'resolved'
  | 'plain'

/** Interaction seam: selection always works; `answer` arrives with delivery. */
export interface RowHandlers {
  readonly select: (itemId: string) => void
  /** Reply hook; absent when no delivery layer is mounted. */
  readonly answer?: (item: OpenItemRecord, payload: ReplyPayload) => void
  /** Per-item answer enablement (the detail pane's primary action). */
  readonly canAnswer?: (item: OpenItemRecord) => boolean
  /** The click plan of one payload, so the detail labels its route. */
  readonly planFor?: (item: OpenItemRecord, payload: ReplyPayload) => AnswerPlan
  /** Approval-decision enablement; false when no live card can decide it. */
  readonly canAnswerApproval?: (item: OpenItemRecord) => boolean
  /** Opens the raising session (navigation only; enabled when injected). */
  readonly openSession?: (sessionId: string) => void
  /** Re-send this item's last failed attempt (same deliveryId). */
  readonly retry?: (item: OpenItemRecord) => void
  /** Explicitly send and resume now for this item. */
  readonly wake?: (item: OpenItemRecord) => void
  /**
   * Resolve a Session display title from the client catalogue, when the page
   * injects one; the approval confirmation names the session it would affect.
   */
  readonly sessionTitle?: SessionTitleResolver
  /**
   * Confirm a candidate as a structural item ("It's an item"). The detail pane
   * passes the corrected kind/title; the row's quick confirm passes none.
   */
  readonly promote?: (item: OpenItemRecord, patch?: CandidatePromotePatch) => void
  /** Dismiss a candidate and remember it is not an item ("Not an item"). */
  readonly suppress?: (item: OpenItemRecord) => void
  /** True while this candidate's promote/suppress write is in flight. */
  readonly candidatePending?: (item: OpenItemRecord) => boolean
  /** The message a refused candidate write left beside this row, if any. */
  readonly candidateFailure?: (item: OpenItemRecord) => CandidateFailure | undefined
}

/** Delivery presentation of one row. */
interface DeliveryView {
  readonly text: string
  readonly tone: 'ok' | 'pending' | 'failed'
}

/**
 * Classify one record into a row variant.
 * @param item - the durable record.
 * @returns the variant the row renders.
 */
export function rowVariantOf(item: OpenItemRecord): RowVariant {
  if (item.state === 'resolved' || item.state === 'archived') return 'resolved'
  if (item.state === 'awaiting') return 'awaiting'
  const lastDelivery = item.deliveries.at(-1)
  if (lastDelivery?.state === 'failed') return 'failed'
  if (item.tier === 'candidate') return 'candidate'
  if (item.kind === 'approval') return 'approval'
  if (item.kind === 'task') return 'task'
  if ((item.reply.options?.length ?? 0) > 0 && item.reply.controls.includes('option')) return 'options'
  if (item.reply.freeText || item.reply.controls.length > 0) return 'text'
  return 'plain'
}

/** Failure-code copy key for a delivery failure. */
function failureKey(code: NonNullable<OpenItemRecord['deliveries'][number]['failure']>['code']) {
  return `failure.${code}` as const
}

/**
 * Delivery label of one record, when it has left the open list.
 * @param item - the durable record.
 * @param t - translator.
 * @returns the label and tone, or undefined for an untouched item.
 */
export function deliveryViewOf(item: OpenItemRecord, t: PageTranslate): DeliveryView | undefined {
  const last = item.deliveries.at(-1)
  if (last === undefined) return undefined
  switch (last.state) {
    case 'sending':
      return { text: t('delivery.sending'), tone: 'pending' }
    case 'settled':
      return { text: t('delivery.settled'), tone: 'ok' }
    case 'queued':
      return { text: t('delivery.queued'), tone: 'pending' }
    case 'delivered':
      return { text: t('delivery.delivered'), tone: 'ok' }
    case 'acknowledged':
      return { text: t('delivery.acknowledged'), tone: 'ok' }
    case 'failed':
      return {
        text: t('delivery.failed', { reason: t(failureKey(last.failure?.code ?? 'unknown-outcome')) }),
        tone: 'failed',
      }
  }
}

/** Props of one row. */
export interface ItemRowProps {
  readonly item: OpenItemRecord
  readonly t: PageTranslate
  readonly now: number
  readonly selected: boolean
  readonly handlers: RowHandlers
  /** This item's last answer attempt, when one exists. */
  readonly attempt?: AnswerAttempt
  /** True when the page is moving focus here after the previous row cleared. */
  readonly focusRequested?: boolean
  /** First observed at/after the last visit: the row's dot marks newness. */
  readonly isNew?: boolean
  /** Offer the bulk-confirm checkbox (Candidates tab only). */
  readonly selectable?: boolean
  /** This candidate is ticked for the bulk confirm. */
  readonly bulkSelected?: boolean
  /** Tick/untick this row without selecting it for the detail. */
  readonly onToggleBulk?: (itemId: string) => void
  /** Disable the checkbox while a bulk write runs. */
  readonly bulkBusy?: boolean
  /** How many candidates this session+turn produced (same-turn annotation). */
  readonly sameTurnCount?: number
}

/**
 * Render one inbox row.
 * @param props - record, copy, clock, selection state, the action seam and the attempt.
 * @returns the list item.
 */
export function ItemRow(input: ItemRowProps): ReactNode {
  const { item, t, now, selected, handlers, attempt, focusRequested, isNew } = input
  const [confirmMode, setConfirmMode] = useState<'allow' | 'deny' | null>(null)
  const [confirmSuppress, setConfirmSuppress] = useState(false)
  const variant = rowVariantOf(item)
  const delivery = deliveryViewOf(item, t)
    ?? (item.state === 'awaiting' ? { text: t('delivery.awaiting'), tone: 'pending' as const } : undefined)
  const lastDelivery = item.deliveries.at(-1)
  const waiting = relativeLabel(t, item.firstSeenAt, now)
  const sessionTitle = sessionLabelOf(t, item, handlers.sessionTitle)
  // An authored approval is decided by sending to the session; only a mirrored
  // one has a shipped card to open, so the disabled hint must not claim a card
  // exists (the label stays "Allow once"/"Deny" for both kinds).
  const approvalHint = isAuthoredApproval(item) ? t('row.action.pending') : t('row.action.approvalNeedsSession')
  const answer = handlers.answer
  const approvalReady = answer !== undefined && (handlers.canAnswerApproval?.(item) ?? true)
  const busy = attempt?.status === 'sending'
  const candidatePending = variant === 'candidate' && (handlers.candidatePending?.(item) ?? false)
  const candidateFailure = variant === 'candidate' ? handlers.candidateFailure?.(item) : undefined
  const selectRef = useRef<HTMLButtonElement | null>(null)
  const kindLabel = t(KIND_LABEL[item.kind])
  // Titles/quotes are transcript prose: project the markdown away before any
  // display or announcement string uses them (D1/D12).
  const displayTitle = toPlainText(item.title)
  const quote = variant === 'candidate' ? distinctQuoteOf(item) : undefined
  const proseInferred = variant === 'candidate' && isProseOrigin(item)

  // Focus moves here after a cleared item leaves the list (UI.md §6.3).
  useEffect(() => {
    if (focusRequested !== true) return
    selectRef.current?.focus()
  }, [focusRequested])

  const select = (): void => handlers.select(item.id)
  const decide = (payload: ReplyPayload): void => {
    setConfirmMode(null)
    if (answer === undefined) return
    answer(item, payload)
  }

  /** The row's one-click decisions; approvals and candidates only. */
  const hasActions = variant === 'approval'
    || (variant === 'candidate' && handlers.promote !== undefined && handlers.suppress !== undefined)
    || (variant === 'task' && handlers.openSession !== undefined)
    || (variant === 'failed' && (handlers.retry !== undefined || handlers.openSession !== undefined))

  return (
    <li
      className="dsh-oi-row"
      role="listitem"
      data-row-key={item.id}
      data-selected={selected ? 'true' : 'false'}
      data-variant={variant}
      data-item-id={item.id}
      onClick={select}
    >
      <div className="dsh-oi-rowTop">
        {input.selectable === true && (
          <span className="dsh-oi-rowCheck" onClick={event => event.stopPropagation()}>
            <Checkbox
              checked={input.bulkSelected === true}
              disabled={input.bulkBusy === true}
              onChange={() => { input.onToggleBulk?.(item.id) }}
              label={t('candidate.bulk.select', { title: displayTitle })}
            />
          </span>
        )}
        <span className="dsh-oi-grade" data-new={isNew === true ? 'true' : 'false'}>
          {isNew === true && (
            <>
              <StateDot state="warning" size={6} className="dsh-oi-gradeDot" appearance={item.tier === 'candidate' ? 'step' : 'dot'} />
              <span className="dsh-oi-visually-hidden">{t('row.newAria')}</span>
            </>
          )}
        </span>
        <button
          type="button"
          ref={selectRef}
          className="dsh-oi-rowSelect"
          aria-label={t('a11y.selectItem', { title: displayTitle })}
          aria-current={selected ? 'true' : undefined}
          onClick={event => {
            event.stopPropagation()
            select()
          }}
        >
          <span className="dsh-oi-rowTitle" title={displayTitle} dir="auto">{displayTitle}</span>
        </button>
        <span
          className="dsh-oi-waiting"
          title={absoluteLabel(item.firstSeenAt)}
          aria-label={t('row.waitingAria', { time: waiting })}
        >
          {t('row.waiting', { time: waiting })}
        </span>
      </div>

      <div className="dsh-oi-rowBottom">
        <div className="dsh-oi-rowMeta">
          {item.severity === 1 && <Tag tone="warning">{t('detail.urgent')}</Tag>}
          <span className="dsh-oi-kindMark">
            <span className="dsh-oi-kindGlyph" aria-hidden="true">{KIND_META[item.kind].render(12)}</span>
            <span>{proseInferred ? t('candidate.kind.inferredLabel', { kind: kindLabel }) : kindLabel}</span>
          </span>
          {item.source.turn !== undefined && (
            <span className="dsh-oi-rowTurn">{t('row.turn', { turn: item.source.turn })}</span>
          )}
          {delivery !== undefined && (
            <span
              className={`dsh-oi-delivery dsh-oi-delivery--${delivery.tone === 'ok' ? 'ok' : delivery.tone === 'failed' ? 'failed' : 'pending'}`}
            >
              {delivery.text}
            </span>
          )}
          {variant === 'candidate' && handlers.promote === undefined && (
            <span>{t('candidate.unavailable')}</span>
          )}
        </div>

        {hasActions && (
          <div
            className="dsh-oi-rowActions"
            role="group"
            aria-label={t('row.actions.aria', { title: displayTitle })}
            onClick={event => event.stopPropagation()}
          >
            {variant === 'approval' && (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!approvalReady || busy}
                  title={approvalReady ? undefined : approvalHint}
                  onClick={() => {
                    setConfirmMode('allow')
                  }}
                >
                  {t('row.action.allow')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!approvalReady || busy}
                  title={approvalReady ? undefined : approvalHint}
                  onClick={() => {
                    setConfirmMode('deny')
                  }}
                >
                  {t('row.action.deny')}
                </Button>
              </>
            )}
            {variant === 'candidate' && (handlers.promote !== undefined && handlers.suppress !== undefined
              ? (
                <>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={candidatePending}
                    onClick={() => handlers.promote?.(item)}
                  >
                    {t('candidate.action.promote')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={candidatePending}
                    onClick={() => { setConfirmSuppress(true) }}
                  >
                    {t('candidate.action.suppress')}
                  </Button>
                </>
              )
              : null)}
            {variant === 'task' && handlers.openSession !== undefined && (
              <Button size="sm" variant="outline" onClick={() => handlers.openSession?.(item.source.sessionId)}>
                {t('row.action.openSession')}
              </Button>
            )}
            {variant === 'failed' && (
              <>
                {handlers.retry !== undefined && lastDelivery !== undefined && (
                  <Button size="sm" variant="outline" onClick={() => handlers.retry?.(item)}>
                    {t('answer.retry')}
                  </Button>
                )}
                {handlers.openSession !== undefined && (
                  <Button size="sm" variant="outline" onClick={() => handlers.openSession?.(item.source.sessionId)}>
                    {t('row.action.openSession')}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
        {!hasActions && (
          <span className="dsh-oi-rowChevron" aria-hidden="true"><IconChevronRightOutlineRegular size={12} /></span>
        )}
      </div>

      {variant === 'candidate' && (
        <div className="dsh-oi-rowEvidence">
          {quote !== undefined
            ? <blockquote className="dsh-oi-rowQuote">{renderProseOf(quote)}</blockquote>
            : <span className="dsh-oi-rowMeta">{t('candidate.source.matched')}</span>}
          <span className="dsh-oi-rowMeta">
            {item.source.turn === undefined
              ? t('candidate.evidence.gate')
              : t('candidate.evidence.gateTurn', { turn: item.source.turn })}
          </span>
          {item.source.turn !== undefined && (input.sameTurnCount ?? 0) > 1 && (
            <span className="dsh-oi-rowMeta">
              {t('candidate.evidence.siblings', { count: input.sameTurnCount ?? 0, turn: item.source.turn })}
            </span>
          )}
        </div>
      )}

      {/* In-row notices carry their own buttons; their clicks must not toggle
          the selection under them. */}
      <div onClick={event => event.stopPropagation()}>
        {candidateFailure !== undefined && (
          <p className="dsh-oi-detailFailure" role="status">
            {candidateFailure.message}{' '}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (candidateFailure.retry === 'promote') handlers.promote?.(item)
                else handlers.suppress?.(item)
              }}
            >
              {t('answer.retry')}
            </Button>
          </p>
        )}

        {attempt !== undefined && (
          <AnswerNotice
            t={t}
            attempt={attempt}
            {...(handlers.retry === undefined ? {} : { onRetry: () => { handlers.retry?.(item) } })}
            {...(handlers.wake === undefined ? {} : { onWake: () => { handlers.wake?.(item) } })}
          />
        )}
      </div>

      {/* The dialogs sit inside the clickable row; their clicks must not toggle
          the selection underneath them. */}
      <div onClick={event => event.stopPropagation()}>
        <ApprovalConfirm
          t={t}
          item={item}
          mode={confirmMode ?? 'allow'}
          open={confirmMode !== null}
          onCancel={() => {
            setConfirmMode(null)
          }}
          onConfirm={decide}
          sessionTitle={sessionTitle}
        />

        <SuppressConfirm
          t={t}
          open={confirmSuppress}
          onCancel={() => { setConfirmSuppress(false) }}
          onConfirm={() => {
            setConfirmSuppress(false)
            handlers.suppress?.(item)
          }}
        />
      </div>
    </li>
  )
}

/** Kind label key per kind; kept beside the row so the mark call stays typed. */
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
