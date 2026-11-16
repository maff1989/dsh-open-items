/**
 * One row of the session panel.
 *
 * Anatomy (refined in the round-4 consistency pass, matching the page row):
 * severity dot + title (≤2 lines) first, one quiet meta line second — kind mark ·
 * labelled waiting time · delivery state — then the row's one control line. The
 * kind glyph left the title line so the title is the first thing the eye lands
 * on, exactly as on the page. The row is a *view* of the same record the inbox
 * and the card render; what it may do comes from `derive.ts`, never from local
 * judgement:
 *
 * - `answerable` — raised by the `open_items` tool, so the panel is a second full
 *   surface for it: options (the shared native-radio `AnswerOptions`, a shipped
 *   `Menu` above three), free text, or an approval through the shipped
 *   `ApprovalConfirm` (acknowledge checkbox; never a one-click grant) — all
 *   through the same `reply` route the card uses. An approval decision is sent
 *   with `confirmedWake`: the panel has no separate "Send & resume" step, and
 *   the shipped confirmation (whose authored copy states the turn cost) is the
 *   user's explicit consent — an approval decision is never recorded unsent.
 * - `handoff` — a live shipped ask that the composer card owns. The row renders
 *   **no Allow/Deny**; its action reveals that card (or opens the inbox detail
 *   when this build has no seam for the kind).
 * - `readonly` — waiting on the agent, resolved, candidate or task rows: reveal
 *   in context or open in the inbox, never a write. Candidates and task actions
 *   are honestly review-only in this build (OD-02/OD-03).
 *
 * @module dsh-open-items/client/ui/panel/PanelRow
 */
import { useState, type ReactNode } from 'react'
import { Button, Input, Menu, StateDot, Tooltip, type MenuItem } from '@deepseek-ai/dsh-client-ui-primitives'

import type { OpenItemRecord, ReplyPayload } from '../../../shared/schema'
import type { PageTranslate } from '../../format'
import { absoluteLabel, relativeLabel } from '../../format'
import { KIND_META } from '../kind'
import { toPlainText } from '../prose-text'
import { AnswerOptions } from '../answer/AnswerOptions'
import { ApprovalConfirm } from '../answer/ApprovalConfirm'
import { refusalTextOf } from '../answer/feedback'
import { deliveryViewOf } from '../row'
import type { PanelOutcome } from './panel-store'
import {
  dotStateOf,
  isResolved,
  rowActionKeyOf,
  type PanelChoice,
  type PanelControl,
} from './derive'

/** Everything one row renders from and reports to. */
export interface PanelRowProps {
  readonly item: OpenItemRecord
  readonly t: PageTranslate
  readonly now: number
  readonly control: PanelControl
  readonly choice: PanelChoice
  /** True while this item's reply is in flight. */
  readonly pending: boolean
  /** True while the navigation target flash is on this row. */
  readonly flash: boolean
  /** The most recent reply outcome, when it belongs to this item. */
  readonly outcome: PanelOutcome | undefined
  /** Whether the shipped question card's reveal seam exists in this build. */
  readonly canRevealAsk: boolean
  readonly onReply: (payload: ReplyPayload, options?: { readonly confirmedWake?: boolean }) => void
  readonly onReveal: () => void
  readonly onHandoff: () => void
  readonly onOpenInbox: () => void
}

/** One line of feedback under a row, or null when there is nothing to say. */
function outcomeLine(props: PanelRowProps): ReactNode {
  const { outcome, item, t } = props
  // The item's delivery state is part of the meta line now; only a reply
  // outcome needs its own line.
  if (outcome === undefined || outcome.itemId !== item.id) return null
  if (outcome.kind === 'conflict') {
    return <p className="dsh-oi-panelRowNote" role="status">{t('panel.delivery.conflict')}</p>
  }
  if (outcome.kind === 'failed') {
    return (
      <p className="dsh-oi-panelRowNote dsh-oi-panelRowNote--failed" role="alert">
        {t('detail.failure', { reason: refusalTextOf(t, outcome.code) })}
      </p>
    )
  }
  return null
}

/** Delivery state of one record, labelled by meaning (the page row's vocabulary). */
function deliveryOf(item: OpenItemRecord, t: PageTranslate): { readonly text: string; readonly tone: 'ok' | 'failed' | 'pending' } | undefined {
  return deliveryViewOf(item, t)
    ?? (item.state === 'awaiting' ? { text: t('delivery.awaiting'), tone: 'pending' as const } : undefined)
}

/** Options as the shared native-radio list, then the one Answer control. */
function OptionControls(props: PanelRowProps & { readonly options: readonly string[] }): ReactNode {
  const { t, pending, options, onReply } = props
  const [choice, setChoice] = useState<string | null>(null)
  return (
    <div className="dsh-oi-panelOptions">
      <AnswerOptions
        t={t}
        options={options}
        value={choice}
        onChange={setChoice}
        disabled={pending}
      />
      <Button
        size="sm"
        variant="primary"
        disabled={choice === null || pending}
        title={choice === null ? t('row.action.answerDisabled') : undefined}
        onClick={() => {
          if (choice !== null) onReply({ type: 'option', option: choice })
        }}
      >
        {t('row.action.answer')}
      </Button>
    </div>
  )
}

/** More than three options in a 300px seat: a shipped `Menu` anchored on the choice (S-02). */
function MenuControls(props: PanelRowProps & { readonly options: readonly string[] }): ReactNode {
  const { item, t, pending, options, onReply } = props
  const [choice, setChoice] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const items: readonly MenuItem[] = options.map(option => ({ id: option, label: option }))
  return (
    <div className="dsh-oi-panelActions">
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        selectedId={choice ?? undefined}
        items={items}
        onSelect={(id) => {
          setOpen(false)
          setChoice(id)
        }}
        anchor={(
          <Button
            size="sm"
            variant="outline"
            aria-label={t('panel.answer.aria', { title: item.title })}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={pending}
            onClick={() => { setOpen(previous => !previous) }}
          >
            {choice ?? t('panel.action.choose')}
          </Button>
        )}
      />
      <Button
        size="sm"
        variant="primary"
        disabled={choice === null || pending}
        onClick={() => {
          if (choice !== null) onReply({ type: 'option', option: choice })
        }}
      >
        {t('row.action.answer')}
      </Button>
    </div>
  )
}

/** Free-text answer, with the explicit wake confirmation when the host asks. */
function TextControl(props: PanelRowProps): ReactNode {
  const { item, t, pending, onReply } = props
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState(false)
  const requiresConfirm = item.reply.requiresConfirm
  return (
    <div className="dsh-oi-panelReply">
      <Input
        className="dsh-oi-panelInput"
        aria-label={t('panel.reply.aria', { title: item.title })}
        placeholder={t('detail.replyPlaceholder')}
        value={draft}
        disabled={pending}
        onChange={event => {
          setDraft(event.target.value)
          if (confirming) setConfirming(false)
        }}
      />
      {confirming && (
        <p className="dsh-oi-panelRowNote" role="status">{t('panel.wakeNote')}</p>
      )}
      <div className="dsh-oi-panelReplyActions">
        {confirming
          ? (
            <>
              <Button
                size="sm"
                variant="primary"
                disabled={pending || draft.trim() === ''}
                onClick={() => {
                  onReply({ type: 'text', text: draft.trim() }, { confirmedWake: true })
                  setConfirming(false)
                }}
              >
                {t('panel.action.confirm')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setConfirming(false) }}>
                {t('panel.action.cancel')}
              </Button>
            </>
          )
          : (
            <Button
              size="sm"
              variant="primary"
              disabled={pending || draft.trim() === ''}
              onClick={() => {
                if (requiresConfirm) {
                  setConfirming(true)
                  return
                }
                onReply({ type: 'text', text: draft.trim() })
              }}
            >
              {t('panel.action.send')}
            </Button>
          )}
      </div>
    </div>
  )
}

/** The row's action line, according to its control model. */
function RowActions(props: PanelRowProps): ReactNode {
  const { item, t, control, choice, pending, canRevealAsk, onReply, onHandoff, onOpenInbox, onReveal } = props
  /** Approval direction awaiting its shipped confirmation (OI-08). */
  const [confirm, setConfirm] = useState<'allow' | 'deny' | null>(null)
  if (control === 'answerable') {
    if (choice.kind === 'approval') {
      return (
        <>
          <div className="dsh-oi-panelActions">
            <Button size="sm" variant="primary" disabled={pending} onClick={() => { setConfirm('allow') }}>
              {t('row.action.allow')}
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => { setConfirm('deny') }}>
              {t('row.action.deny')}
            </Button>
          </div>
          <ApprovalConfirm
            t={t}
            item={item}
            mode={confirm ?? 'allow'}
            open={confirm !== null}
            onCancel={() => { setConfirm(null) }}
            onConfirm={(payload) => {
              setConfirm(null)
              // The acknowledgement checkbox is the user's explicit consent:
              // without the wake flag the Host would record (not deliver) the
              // decision, which is exactly what an approval must never do.
              onReply(payload, { confirmedWake: true })
            }}
          />
        </>
      )
    }
    if (choice.kind === 'options') {
      return choice.options.length > 3
        ? <MenuControls {...props} options={choice.options} />
        : <OptionControls {...props} options={choice.options} />
    }
    if (choice.kind === 'text') return <TextControl {...props} />
  }
  const label = t(rowActionKeyOf(control, item, canRevealAsk))
  const run = control === 'handoff'
    ? onHandoff
    : control === 'answerable'
      ? onReveal
      : isResolved(item) || item.tier === 'candidate'
        ? onOpenInbox
        : item.source.callId !== undefined
          ? onReveal
          : onOpenInbox
  return (
    <div className="dsh-oi-panelActions">
      <Button size="sm" variant={control === 'handoff' ? 'primary' : 'ghost'} onClick={run}>
        {label}
      </Button>
    </div>
  )
}

/**
 * Render one panel row.
 * @param props - record, copy, clock, control model and the action callbacks.
 * @returns the list item.
 */
export function PanelRow(props: PanelRowProps): ReactNode {
  const { item, t, now, control, pending, flash, canRevealAsk, onReveal, onHandoff, onOpenInbox } = props
  const meta = KIND_META[item.kind]
  const contextAction = control === 'handoff'
    ? onHandoff
    : control === 'answerable'
      ? onReveal
      : isResolved(item) || item.tier === 'candidate' || item.source.callId === undefined
        ? onOpenInbox
        : onReveal
  const age = relativeLabel(t, item.firstSeenAt, now)
  const contextLabel = rowActionKeyOf(control, item, canRevealAsk)
  // The row's display/announcement string is projected prose: a model-raised
  // title may carry markdown, and a screen reader must not read it aloud.
  const displayTitle = toPlainText(item.title)
  const delivery = deliveryOf(item, t)
  return (
    <li
      className="dsh-oi-panelRow"
      data-item-id={item.id}
      data-control={control}
      data-pending={pending ? 'true' : undefined}
      data-flash={flash ? 'true' : undefined}
      data-state={item.state}
    >
      <div className="dsh-oi-panelRowHead">
        <span className="dsh-oi-panelRowState">
          <StateDot state={dotStateOf(item)} size={6} className="dsh-oi-panelRowDot" />
        </span>
        <Tooltip label={displayTitle} side="bottom" onlyWhenClipped portal>
          <button
            type="button"
            className="dsh-oi-panelRowTitle"
            data-oi-row-focus=""
            aria-label={`${t(contextLabel)}: ${displayTitle}`}
            onClick={contextAction}
          >
            {displayTitle}
          </button>
        </Tooltip>
      </div>
      <p className="dsh-oi-panelRowMeta">
        <span className="dsh-oi-kindMark">
          <span className="dsh-oi-panelRowGlyph" aria-hidden="true">{meta.render(12)}</span>
          <span>{t(meta.label)}</span>
        </span>
        <span
          className="dsh-oi-panelRowTime"
          title={absoluteLabel(item.firstSeenAt)}
          aria-label={t('row.waitingAria', { time: age })}
        >
          {t('row.waiting', { time: age })}
        </span>
        {item.tier === 'candidate' && (
          <span className="dsh-oi-panelRowCandidate">
            {t('candidate.kind.inferredLabel', { kind: t(meta.label) })}
          </span>
        )}
        {delivery !== undefined && (
          <span className={`dsh-oi-delivery dsh-oi-delivery--${delivery.tone}`}>{delivery.text}</span>
        )}
      </p>
      <RowActions {...props} />
      {outcomeLine(props)}
    </li>
  )
}
