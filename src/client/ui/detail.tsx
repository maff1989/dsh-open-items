/**
 * The item detail: context, the one answer form, and a pinned action footer.
 *
 * Round 3 restructured the pane into four visual groups (header / content /
 * answer form / sticky footer) instead of one flat 12px-gap list, and moved the
 * answer choices to a native radio list. The footer keeps the primary action and
 * the quiet item-level actions (Snooze/Dismiss) reachable while the body
 * scrolls, and the wake-cost line now sits above the buttons it describes.
 *
 * One component for the wide column, the medium in-row expansion and the narrow
 * pushed page; CSS decides which of those is visible, so the content never
 * diverges. Approval decisions keep their shipped confirmation; a candidate is
 * confirmed or refused in place instead of being answered.
 *
 * Prose candidates (contract §3) are a review surface, not an answer form:
 * - the title and quote are projected from transcript markdown, and the duplicate
 *   blockquote is suppressed when the title *is* the quote;
 * - the kind is labelled as inferred and correctable through `KindPicker`, and
 *   the title is editable before it becomes durable;
 * - the chosen options stay visible ("What you're deciding") and the source
 *   sentence is kept as evidence;
 * - the confirm write carries the corrections (`promote(item, {kind, title})`);
 * - after promotion the candidate section and the detector's boilerplate body
 *   are gone: the chosen kind/title, the answer form and the source quote are
 *   what remain.
 *
 * @module dsh-open-items/client/ui/detail
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, InlineEditor, Menu, StateDot, Tag, type MenuItem } from '@deepseek-ai/dsh-client-ui-primitives'

import type { OpenItemKind, OpenItemRecord, ReplyPayload } from '../../shared/schema'
import { isAuthoredApproval } from '../../shared/item-origin'
import type { CandidatePromotePatch } from '../data/candidate-actions'
import type { AnswerPlan } from '../data/settle'
import { absoluteLabel, relativeLabel, sessionLabelOf, type PageTranslate } from '../format'
import { AnswerNotice } from './answer/AnswerNotice'
import { AnswerOptions } from './answer/AnswerOptions'
import { ApprovalConfirm } from './answer/ApprovalConfirm'
import { SendConfirm } from './answer/SendConfirm'
import { SuppressConfirm } from './answer/SuppressConfirm'
import { actionLabelOf, wakeLineOf, type AnswerAttempt } from './answer/feedback'
import { candidateOptionsOf, distinctQuoteOf, isProseOrigin, proseDetectorCodeOf, titleOf } from './candidate'
import { deliveryViewOf, type RowHandlers } from './row'
import { KindChip, KindPicker } from './kind'
import { renderProseOf, toPlainText } from './prose-text'

/** Props of the detail pane. */
export interface ItemDetailProps {
  readonly item: OpenItemRecord
  readonly t: PageTranslate
  readonly now: number
  readonly handlers: RowHandlers
  /** Navigates back to the list on the narrow layout. */
  readonly onBack: () => void
  /** This item's last answer attempt, when one exists. */
  readonly attempt?: AnswerAttempt
  /** True while the page waits for the explicit "Send & resume now". */
  readonly awaitingWake?: boolean
  /** Re-send this item's failed attempt. */
  readonly onRetry?: () => void
  /** Confirm the warned wake. */
  readonly onWake?: () => void
  /** Dismiss the warned wake without sending. */
  readonly onCancelWake?: () => void
  /** Footer actions (UI.md §5 footer): dismiss and snooze never reach the agent. */
  readonly onDismiss?: () => void
  readonly onSnooze?: (until: number) => void
  /** Bumped by ⌘/Ctrl+Enter; a change submits the drafted answer. */
  readonly submitSignal?: number
}

/** Shipped severity mark (OD-13): 1 = warning, 2 = business, 3 = tertiary. */
const gradeState = (severity: number): 'warning' | 'idle' => (severity === 1 ? 'warning' : 'idle')

/** Fallback plan when the controller is absent: a warned message send. */
const WARNED_MESSAGE_PLAN: AnswerPlan = { track: 'message', settles: false, steers: false, requiresWakeConfirmation: true }

/** Snooze horizons offered in the footer menu. */
const SNOOZE_HORIZONS = [
  { id: '1h', label: 'detail.snooze.1h', offset: 3_600_000 },
  { id: 'tomorrow', label: 'detail.snooze.tomorrow', offset: 86_400_000 },
  { id: 'week', label: 'detail.snooze.week', offset: 7 * 86_400_000 },
] as const

/**
 * Render the detail of one item.
 * @param props - record, copy, clock, action seams and the attempt state.
 * @returns the detail element.
 */
export function ItemDetail(props: ItemDetailProps): ReactNode {
  const { item, t, now, handlers, onBack, attempt, awaitingWake, onRetry, onWake, onCancelWake } = props
  const [choice, setChoice] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [note, setNote] = useState('')
  const [confirmMode, setConfirmMode] = useState<'allow' | 'deny' | null>(null)
  const [footerMenu, setFooterMenu] = useState<'snooze' | null>(null)
  const [confirmSuppress, setConfirmSuppress] = useState(false)
  // A prose candidate's kind and title are correctable until the confirm write;
  // the page keys this component by item id, so a selection change resets them.
  const [candidateKind, setCandidateKind] = useState<OpenItemKind>(item.kind)
  const [editedTitle, setEditedTitle] = useState(() => toPlainText(item.title))

  const variant = item.state === 'resolved' || item.state === 'archived' ? 'resolved' : 'live'
  const delivery = deliveryViewOf(item, t)
    ?? (item.state === 'awaiting' ? { text: t('delivery.awaiting'), tone: 'pending' as const } : undefined)
  const options = item.reply.options ?? item.options ?? []
  const answer = handlers.answer
  const answerable = answer !== undefined && (handlers.canAnswer?.(item) ?? true)
  const approvalReady = answerable && (handlers.canAnswerApproval?.(item) ?? true)
  const workspaceTitle = item.source.workspace?.title ?? item.source.workspace?.path
  const sessionTitle = sessionLabelOf(t, item, handlers.sessionTitle)
  const busy = attempt?.status === 'sending'
  const isApproval = item.kind === 'approval'
  // Authored approvals are sent to the session; mirrored ones grant one run.
  const authoredApproval = isAuthoredApproval(item)
  const isCandidate = item.tier === 'candidate'
  const isTask = item.kind === 'task'
  const candidatePending = isCandidate && (handlers.candidatePending?.(item) ?? false)
  const candidateFailure = isCandidate ? handlers.candidateFailure?.(item) : undefined
  const proseOrigin = isProseOrigin(item)
  // Prose candidates are reviewed, not answered; a promoted one is a normal item.
  const proseCandidate = isCandidate && proseOrigin
  const displayTitle = titleOf(item)
  const shownTitle = isCandidate && editedTitle.trim() !== '' ? editedTitle.trim() : displayTitle
  const quote = distinctQuoteOf(item)
  // The promoted item's source is explicit context, so it is shown even when it
  // reads the same as the (human) title: it is labelled as the source, not
  // printed as a second title.
  const rawQuote = item.quote === undefined || item.quote === '' ? undefined : toPlainText(item.quote)
  const detectorCode = isCandidate || proseOrigin ? proseDetectorCodeOf(item) : undefined
  const promotedFromProse = !isCandidate && proseOrigin
  // The prose detector's body ("confirm to turn it into an item") is boilerplate,
  // never item content: an inferred candidate shows context copy and a promoted
  // prose item shows the source sentence instead (D4/R9 of the client audit).
  // Other candidate detectors (for example the unfinished-plan aggregate) carry
  // real content in the body, so only prose candidates hide theirs.
  const showBody = item.body !== '' && !proseCandidate && !promotedFromProse
  const proseOptions = candidateOptionsOf(item)
  const turnLabel = item.source.turn === undefined
    ? t('candidate.evidence.gate')
    : t('candidate.evidence.gateTurn', { turn: item.source.turn })

  // A representative payload so the route label and the wake line exist before
  // the user has typed anything.
  const representative: ReplyPayload = isApproval
    ? { type: 'approval', outcome: 'allow-once' }
    : options.length > 0
      ? { type: 'option', option: choice ?? options[0] ?? '' }
      : { type: 'text', text: text.trim() === '' ? ' ' : text.trim() }
  const plan: AnswerPlan = handlers.planFor?.(item, representative) ?? WARNED_MESSAGE_PLAN
  const actionLabel = actionLabelOf(t, plan)
  const wakeLine = wakeLineOf(t, plan, sessionTitle)

  const draftPayload = (): ReplyPayload | undefined => {
    if (isApproval) return undefined
    if (choice !== null) return { type: 'option', option: choice }
    const trimmed = text.trim()
    return trimmed === '' ? undefined : { type: 'text', text: trimmed }
  }
  const canSubmit = answerable && draftPayload() !== undefined && !busy

  const submit = (): void => {
    const payload = draftPayload()
    if (payload === undefined || answer === undefined) return
    answer(item, payload)
  }

  /**
   * The correction a confirm carries: the chosen kind, the edited title and —
   * when the gate captured labeled alternatives — the options, so the promoted
   * item stays answerable as a choice instead of collapsing to free text.
   */
  const promotePatch = (): CandidatePromotePatch => {
    const title = editedTitle.trim()
    return {
      kind: candidateKind,
      title: title === '' ? displayTitle : title,
      ...(proseOptions.length === 0 ? {} : { options: proseOptions }),
    }
  }
  const confirmCandidate = (): void => {
    handlers.promote?.(item, promotePatch())
  }

  // ⌘/Ctrl+Enter from the page keyboard seam submits the drafted answer.
  useEffect(() => {
    if (props.submitSignal === undefined || props.submitSignal === 0) return
    submit()
    // The signal is a monotonically increasing event token; `submit` reads the
    // latest draft through the render closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.submitSignal])

  /**
   * One confirmed decision: the modal reason wins when it has text, otherwise
   * the draft note in the pane rides along (UI.md §6.2 optional note).
   */
  const decide = (payload: ReplyPayload): void => {
    setConfirmMode(null)
    if (answer === undefined) return
    const merged: ReplyPayload = payload.type === 'approval' && payload.note === undefined && note.trim() !== ''
      ? { ...payload, note: note.trim() }
      : payload
    answer(item, merged)
  }

  const showAnswerSection = variant === 'live' && !isCandidate && !isTask
  const showFooter = variant === 'live' && !isCandidate
  const hasQuietActions = props.onSnooze !== undefined || props.onDismiss !== undefined
  const disabledReason = !answerable
    ? t('detail.pending')
    : options.length > 0
      ? t('row.action.answerDisabled')
      : t('answer.draft.none')

  return (
    <section className="dsh-oi-detail" aria-label={t('detail.aria')} data-item-id={item.id}>
      <div className="dsh-oi-detailScroll">
      <Button size="sm" variant="ghost" className="dsh-oi-back" onClick={onBack}>
        {t('detail.back')}
      </Button>

      <div className="dsh-oi-detailHeader">
        <div className="dsh-oi-detailHead">
          <span className="dsh-oi-grade" data-severity={item.severity}>
            <StateDot state={gradeState(item.severity)} size={6} className="dsh-oi-gradeDot" appearance={isCandidate ? 'step' : 'dot'} />
            <span className="dsh-oi-visually-hidden">{t('detail.severity', { severity: item.severity })}</span>
          </span>
          <KindChip
            kind={isCandidate ? candidateKind : item.kind}
            label={t(KIND_LABEL[isCandidate ? candidateKind : item.kind])}
            iconSize={14}
            inferred={proseCandidate}
            {...(proseCandidate ? { inferredLabel: t('candidate.kind.inferred') } : {})}
          />
          {item.severity === 1 && <Tag tone="warning">{t('detail.urgent')}</Tag>}
          {isCandidate && <Tag tone="info">{t('detail.candidate')}</Tag>}
        </div>
        <h2 className="dsh-oi-detailTitle" dir="auto">{shownTitle}</h2>
        <div className="dsh-oi-detailMeta">
          <span>{sessionTitle}</span>
          {workspaceTitle !== undefined && workspaceTitle !== '' && <span>{workspaceTitle}</span>}
          {item.source.turn !== undefined && <span>{t('detail.turn', { turn: item.source.turn })}</span>}
          <span title={absoluteLabel(item.firstSeenAt)}>{t('detail.source', { time: relativeLabel(t, item.firstSeenAt, now) })}</span>
          {item.source.raisedBy !== undefined && (
            <span>{item.source.raisedBy.title ?? item.source.raisedBy.sessionId}</span>
          )}
          {delivery !== undefined && <span>{delivery.text}</span>}
        </div>
      </div>

      {showBody && <div className="dsh-oi-detailBody">{renderProseOf(item.body)}</div>}
      {quote !== undefined && !isCandidate && !promotedFromProse && (
        <blockquote className="dsh-oi-detailQuote">{renderProseOf(quote)}</blockquote>
      )}
      {item.acknowledgement !== undefined && item.acknowledgement.state === 'none' && (
        <p className="dsh-oi-detailFailure">{t('delivery.noAcknowledgement')}</p>
      )}

      {variant === 'live' && isCandidate && (
        <div className="dsh-oi-detailSection dsh-oi-candidate">
          <h3 className="dsh-oi-detailLabel">{t('candidate.heading')}</h3>
          <p className="dsh-oi-detailBody">
            {candidateKind === 'decision'
              ? t('candidate.context.decision')
              : candidateKind === 'question'
                ? t('candidate.context.question')
                : t('answer.candidate.note')}
          </p>
          {proseCandidate && <p className="dsh-oi-detailMeta">{t('candidate.evidence.detail')}</p>}

          <div className="dsh-oi-candidateField">
            {proseCandidate && <span className="dsh-oi-detailLabel">{t('candidate.kind.hint')}</span>}
            <KindPicker
              kind={candidateKind}
              t={t}
              ariaLabel={t('candidate.kind.choose', { title: displayTitle })}
              disabled={candidatePending}
              onSelect={setCandidateKind}
            />
          </div>

          <div className="dsh-oi-candidateField">
            <span className="dsh-oi-detailLabel">{t('candidate.title.label')}</span>
            <InlineEditor
              value={editedTitle}
              label={t('candidate.title.label')}
              onChange={setEditedTitle}
              onSave={() => undefined}
              onCancel={() => { setEditedTitle(displayTitle) }}
              className="dsh-oi-detailNote"
            />
            <p className="dsh-oi-detailMeta">{t('candidate.title.hint')}</p>
          </div>

          {proseOptions.length > 0 && (
            <div className="dsh-oi-candidateField">
              <h3 className="dsh-oi-detailLabel">{t('candidate.options.title')}</h3>
              <ul className="dsh-oi-candidateOptions">
                {proseOptions.map(option => (
                  <li key={option}>{renderProseOf(option)}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="dsh-oi-candidateField dsh-oi-candidateSource">
            <h3 className="dsh-oi-detailLabel">{t('candidate.source.title')}</h3>
            {quote !== undefined
              ? <blockquote className="dsh-oi-detailQuote">{renderProseOf(quote)}</blockquote>
              : <p className="dsh-oi-detailMeta">{t('candidate.source.matched')}</p>}
            <p className="dsh-oi-detailMeta">
              {turnLabel}
              {detectorCode === undefined ? null : ` · ${detectorCode}`}
            </p>
            {handlers.openSession !== undefined && (
              <Button size="sm" variant="ghost" onClick={() => handlers.openSession?.(item.source.sessionId)}>
                {t('candidate.source.open')}
              </Button>
            )}
          </div>

          {handlers.promote !== undefined && handlers.suppress !== undefined
            ? (
              <div className="dsh-oi-detailActions" aria-busy={candidatePending || undefined}>
                {candidatePending && (
                  <span className="dsh-oi-visually-hidden" role="status">{t('candidate.action.pending')}</span>
                )}
                <Button
                  size="sm"
                  variant="primary"
                  disabled={candidatePending}
                  onClick={confirmCandidate}
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
              </div>
            )
            : <p className="dsh-oi-detailMeta">{t('candidate.unavailable')}</p>}
          {candidateFailure !== undefined && (
            <p className="dsh-oi-detailFailure" role="status">
              {candidateFailure.message}{' '}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (candidateFailure.retry === 'promote') confirmCandidate()
                  else handlers.suppress?.(item)
                }}
              >
                {t('answer.retry')}
              </Button>
            </p>
          )}
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
      )}

      {variant === 'live' && promotedFromProse && (
        <div className="dsh-oi-detailSection dsh-oi-candidateSource">
          <h3 className="dsh-oi-detailLabel">{t('candidate.promoted.source')}</h3>
          {rawQuote !== undefined
            ? <blockquote className="dsh-oi-detailQuote">{renderProseOf(rawQuote)}</blockquote>
            : <p className="dsh-oi-detailMeta">{t('candidate.source.matched')}</p>}
          <p className="dsh-oi-detailMeta">
            {turnLabel}
            {detectorCode === undefined ? null : ` · ${detectorCode}`}
          </p>
          {handlers.openSession !== undefined && (
            <Button size="sm" variant="ghost" onClick={() => handlers.openSession?.(item.source.sessionId)}>
              {t('candidate.source.open')}
            </Button>
          )}
        </div>
      )}

      {variant === 'live' && isTask && (
        <div className="dsh-oi-detailSection">
          <h3 className="dsh-oi-detailLabel">{t('detail.reply')}</h3>
          <p className="dsh-oi-detailBody">{t('answer.task.note')}</p>
        </div>
      )}

      {showAnswerSection && (
        <div className="dsh-oi-detailSection">
          <h3 className="dsh-oi-detailLabel">
            {isApproval ? t('detail.reply') : options.length > 0 ? t('detail.choose') : t('detail.reply')}
          </h3>

          {isApproval && (
            <>
              <p className="dsh-oi-detailBody">
                {t(authoredApproval ? 'answer.approval.allowBodyToSession' : 'answer.approval.allowBody')}
              </p>
              <InlineEditor
                value={note}
                label={t('detail.note')}
                onChange={setNote}
                onSave={() => undefined}
                onCancel={() => {
                  setNote('')
                }}
                className="dsh-oi-detailNote"
              />
              <p className="dsh-oi-detailMeta">{t('answer.draft.hint')}</p>
            </>
          )}

          {!isApproval && options.length > 0 && (
            <AnswerOptions t={t} options={options} value={choice} onChange={setChoice} disabled={busy} />
          )}

          {!isApproval && item.reply.freeText && (
            <>
              {options.length > 0 && <p className="dsh-oi-detailLabel">{t('detail.reply')}</p>}
              <InlineEditor
                value={text}
                label={t('detail.reply')}
                onChange={setText}
                onSave={submit}
                onCancel={() => {
                  setText('')
                }}
                className="dsh-oi-detailNote"
              />
              <p className="dsh-oi-detailMeta">{t('answer.draft.hint')}</p>
            </>
          )}

          {awaitingWake === true && (
            <SendConfirm
              t={t}
              sessionTitle={sessionTitle}
              onCancel={() => {
                onCancelWake?.()
              }}
              onConfirm={() => {
                onWake?.()
              }}
            />
          )}

          {attempt !== undefined && (
            <AnswerNotice
              t={t}
              attempt={attempt}
              {...(onRetry === undefined ? {} : { onRetry })}
              {...(onWake === undefined ? {} : { onWake })}
            />
          )}

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
            {...(note.trim() === '' ? {} : { initialReason: note.trim() })}
          />
        </div>
      )}

      </div>

      {showFooter && (
        <div className="dsh-oi-detailFooter">
          {wakeLine !== undefined && <p className="dsh-oi-detailMeta dsh-oi-detailWake">{wakeLine}</p>}
          <div className="dsh-oi-detailFooterActions">
            <div className="dsh-oi-detailFooterQuiet">
              {hasQuietActions && props.onSnooze !== undefined && (
                <Menu
                  open={footerMenu === 'snooze'}
                  onClose={() => { setFooterMenu(null) }}
                  items={SNOOZE_HORIZONS.map(horizon => ({ id: horizon.id, label: t(horizon.label) })) satisfies readonly MenuItem[]}
                  onSelect={(id) => {
                    setFooterMenu(null)
                    const horizon = SNOOZE_HORIZONS.find(candidate => candidate.id === id)
                    if (horizon !== undefined) props.onSnooze?.(Date.now() + horizon.offset)
                  }}
                  anchor={(
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-haspopup="menu"
                      aria-expanded={footerMenu === 'snooze'}
                      onClick={() => { setFooterMenu(footerMenu === 'snooze' ? null : 'snooze') }}
                    >
                      {t('detail.snooze')}
                    </Button>
                  )}
                />
              )}
              {hasQuietActions && props.onDismiss !== undefined && (
                <Button size="sm" variant="ghost" onClick={() => { props.onDismiss?.() }}>{t('detail.dismiss')}</Button>
              )}
            </div>

            <div className="dsh-oi-detailActions">
              {isApproval && (
                <>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!approvalReady || busy}
                    title={approvalReady ? undefined : t(isAuthoredApproval(item) ? 'row.action.pending' : 'row.action.approvalNeedsSession')}
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
                    title={approvalReady ? undefined : t(isAuthoredApproval(item) ? 'row.action.pending' : 'row.action.approvalNeedsSession')}
                    onClick={() => {
                      setConfirmMode('deny')
                    }}
                  >
                    {t('row.action.deny')}
                  </Button>
                </>
              )}
              {isTask && handlers.openSession !== undefined && (
                <Button size="sm" variant="outline" onClick={() => handlers.openSession?.(item.source.sessionId)}>
                  {t('detail.openSession')}
                </Button>
              )}
              {!isApproval && !isTask && (
                <>
                  {handlers.openSession !== undefined && (
                    <Button size="sm" variant="outline" onClick={() => handlers.openSession?.(item.source.sessionId)}>
                      {t('detail.openSession')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!canSubmit}
                    onClick={submit}
                    title={answer === undefined ? t('detail.pending') : undefined}
                  >
                    {busy ? t('answer.sending') : actionLabel}
                  </Button>
                </>
              )}
            </div>
          </div>
          {!isApproval && !isTask && answerable && !canSubmit && (
            <p className="dsh-oi-detailMeta">{disabledReason}</p>
          )}
          {isApproval && !approvalReady && (
            <p className="dsh-oi-detailMeta">{t(authoredApproval ? 'row.action.pending' : 'row.action.approvalNeedsSession')}</p>
          )}
          {!isApproval && !isTask && !answerable && (
            <p className="dsh-oi-detailMeta">{t('detail.pending')}</p>
          )}
        </div>
      )}
    </section>
  )
}

/** Kind label key per kind (mirrors the row's table; typed for the translator). */
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
