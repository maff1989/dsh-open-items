/**
 * The in-session open-items card: `tool.call.toolview`, keyed `open_items`.
 *
 * A transcript row is the only conversation seat that is per-call, additive and
 * arbitrarily interactive (`research/in-session-surfaces.md` §3), so this is
 * where an item the agent raises *while the user is looking at the chat* appears
 * and can be answered. The card renders from `tool/result.meta` (the durable
 * raise snapshot), hydrates the live record by item id, and settles through the
 * single `reply` route (DESIGN §6.7) — never through the composer and never
 * through a second pending-interaction surface.
 *
 * Hard rules encoded here:
 * - only this call's items are answerable (`meta.callId` vs the row's `callId`);
 * - no Allow/Deny control ever renders — an approval is answered in Open Items
 *   (an authored sign-off travels as a message; a mirrored one at its shipped
 *   card), and a plan review keeps the pointer to the session's card;
 * - no Session switch: "Open in Open Items" only selects the inbox panel;
 * - subagent Sessions and read-only peers get an explanation, not controls;
 * - the renderer never throws: parsing is defensive and a class boundary wraps
 *   the card, degrading to the recorded generic row.
 *
 * @module dsh-open-items/client/ui/card/OpenItemsCard
 */
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, InlineEditor, Tag } from '@deepseek-ai/dsh-client-ui-primitives'

import { LIMITS } from '../../../shared/protocol'
import type { DeliveryId, OpenItemRecord, ReplyPayload } from '../../../shared/schema'
import type { PageTranslate } from '../../format'
import { AnswerOptions } from '../answer/AnswerOptions'
import { KindChip } from '../kind'
import type { OpenItemsCardKey } from './card-locales'
import {
  clockLabel,
  effectiveItem,
  indexRecords,
  isAnswerableState,
  resolutionAnswerText,
  resolvedElsewhere,
  type EffectiveItem,
} from './items'
import { CARD_KIND_LABEL, parseCardMeta, recordedErrorText, recordedSummary } from './meta'
import {
  answerTextOf,
  FAILURE_COPY,
  failureOf,
  hydrationRequest,
  newDeliveryId,
  outcomeCopyKey,
  recoveryOf,
  replyRequest,
  type CardFailure,
  type CardOutcome,
} from './requests'
import type { OpenItemsCardProps, OpenItemsToolBlock, SessionCatalogue } from './slot-contracts'

/** An empty catalogue for a composition (or a test) without the session hook. */
const EMPTY_CATALOGUE: SessionCatalogue = { byId: {} }

/** Fallback selector for a composition without the session catalogue hook. */
function fallbackSessions<Selected>(selector: (state: SessionCatalogue) => Selected): Selected {
  return selector(EMPTY_CATALOGUE)
}

/** Fallback access probe: a composition without it may write. */
function allowAllAccess(): boolean {
  return true
}

/** One item's transient interaction state (never the durable truth). */
interface ItemUi {
  readonly sending?: boolean
  readonly settled?: {
    readonly outcome: CardOutcome
    readonly at: number
    readonly answer?: string
    readonly note?: string
    /** True when the write was a dismissal, which has no answered receipt. */
    readonly dismissed?: boolean
  }
  readonly conflict?: { readonly show: boolean }
  readonly failure?: {
    readonly kind: Exclude<CardFailure, 'conflict'>
    readonly message?: string
  }
}

/** Props shared by the item blocks. */
interface RowContext {
  readonly t: (key: OpenItemsCardKey, params?: Record<string, string | number>) => string
  readonly callId: string
  readonly readOnly: boolean
  readonly subagent: boolean
  readonly openInbox: (itemId?: string) => void
  readonly onAnswer: (item: EffectiveItem, payload: ReplyPayload) => void
  readonly onRetry: (item: EffectiveItem) => void
  readonly onToggleConflict: (item: EffectiveItem) => void
}

/** Counted "N items raised" line. */
function raisedLabel(t: RowContext['t'], count: number): string {
  return t(count === 1 ? 'card.raised.one' : 'card.raised.other', { count })
}

/** The shared answer control's lookup keys, mapped onto the card dictionary. */
const SHARED_ANSWER_COPY: Readonly<Record<string, OpenItemsCardKey>> = {
  'answer.options.aria': 'card.optionsAria',
  'answer.options.recommended': 'card.options.recommended',
}

/**
 * Adapter from the card dictionary to the shared native-radio control.
 *
 * `AnswerOptions` is typed against the inbox namespace because the page and the
 * panel bind it directly and it is the one owner of the answer-choice control.
 * The card owns its own dictionary, so only the two keys the control resolves
 * are mapped here rather than registering a second translator for the surface.
 * @param t - the card's translator.
 * @returns the translator shape the shared control expects.
 */
function answerOptionsT(t: RowContext['t']): PageTranslate {
  const translate = (key: string, params?: Record<string, string | number>): string =>
    t(SHARED_ANSWER_COPY[key] ?? (key as OpenItemsCardKey), params)
  return translate as unknown as PageTranslate
}

/** Kind badge; an unrecognized wire kind gets a plain "Item" chip. */
function KindBadge({ kind, t }: { readonly kind: EffectiveItem['kind']; readonly t: RowContext['t'] }): ReactNode {
  if (kind === 'unknown') return <Tag tone="neutral" className="dsh-oi-kindTag">{t('card.unknownKind')}</Tag>
  return <KindChip kind={kind} label={t(CARD_KIND_LABEL[kind])} />
}

/** One recorded row that cannot be rendered as a card (legacy meta or error). */
function FallbackRow(props: {
  readonly t: RowContext['t']
  readonly title: string
  readonly summary?: string
  readonly note: string
  readonly tone?: 'warn' | 'failed'
  readonly openInbox: (itemId?: string) => void
}): ReactNode {
  const tone = props.tone === undefined ? '' : ` dsh-oi-cardNote--${props.tone}`
  return (
    <section className="dsh-oi-card dsh-oi-card--fallback" aria-label={props.title} data-tool="open_items">
      <header className="dsh-oi-cardHead">
        <span className="dsh-oi-cardTool">{props.title}</span>
      </header>
      {props.summary !== undefined && <p className="dsh-oi-cardSummary">{props.summary}</p>}
      <p className={`dsh-oi-cardNote${tone}`}>{props.note}</p>
      <div className="dsh-oi-cardActions">
        <Button size="sm" variant="outline" onClick={() => { props.openInbox() }}>{props.t('card.openInbox')}</Button>
      </div>
    </section>
  )
}

/** Receipt line shown once an item is settled, whichever read settled it. */
function Receipt(props: {
  readonly t: RowContext['t']
  readonly text: string
  readonly answer?: string
  readonly openInbox: (itemId?: string) => void
}): ReactNode {
  return (
    <div className="dsh-oi-cardReceipt">
      <span className="dsh-oi-cardReceiptText">{props.text}</span>
      {props.answer !== undefined && <span className="dsh-oi-cardReceiptAnswer">“{props.answer}”</span>}
      <Button
        size="sm"
        variant="ghost"
        className="dsh-oi-cardReceiptOpen"
        onClick={() => { props.openInbox() }}
      >
        {props.t('card.openInbox')}
      </Button>
    </div>
  )
}

/** Receipt copy for a durable record that is no longer answerable. */
function recordReceipt(item: EffectiveItem, t: RowContext['t']): { text: string; answer?: string } | undefined {
  if (isAnswerableState(item.state)) return undefined
  const resolution = item.resolution
  const time = clockLabel(resolution?.at ?? item.updatedAt)
  const answer = resolutionAnswerText(resolution)
  if (resolution === undefined) {
    return { text: item.state === 'awaiting' ? t('card.receipt.answered', { time }) : t('card.receipt.noLongerOpen') }
  }
  switch (resolution.kind) {
    case 'answered':
      return {
        text: answer === undefined
          ? t('card.receipt.answered', { time })
          : t(resolvedElsewhere(resolution) ? 'card.receipt.answeredInInbox' : 'card.receipt.answered', { time }),
        ...(answer === undefined ? {} : { answer }),
      }
    case 'dismissed':
      return { text: t('card.receipt.dismissed', { time }) }
    case 'superseded':
      return { text: t('card.receipt.superseded', { time }) }
    case 'detected-closed':
      return { text: t('card.receipt.closed', { time }) }
    default:
      return { text: t('card.receipt.noLongerOpen') }
  }
}

/** Why this item cannot be answered here, if it cannot. */
function disabledReasonOf(item: EffectiveItem, context: RowContext): string | undefined {
  if (item.callId !== undefined && item.callId !== context.callId) return context.t('card.notOwned')
  if (item.kind === 'approval') return context.t('card.approvalsInInbox')
  if (item.kind === 'plan-review') return context.t('card.planPointer')
  if (context.subagent) return context.t('card.subagent')
  if (context.readOnly) return context.t('card.readOnly')
  return undefined
}

/** The option/text controls of one answerable item. */
function ItemControls(props: {
  readonly item: EffectiveItem
  readonly ui: ItemUi
  readonly context: RowContext
}): ReactNode {
  const { item, ui, context } = props
  const { t } = context
  const declared = item.reply.options
  const options = declared !== undefined && declared.length > 0 ? declared : item.options
  const offersOptions = options.length > 0 && (item.reply.controls.includes('option') || item.reply.controls.length === 0)
  const offersText = item.reply.freeText || item.reply.controls.includes('text')
  const [choice, setChoice] = useState<string | null>(null)
  const [text, setText] = useState('')
  const sending = ui.sending === true
  const textReady = text.trim() !== ''

  // One control line, refined order: the quiet decision on the left, the two
  // navigation/write actions right-aligned with the primary last — the same
  // order the page's answer form uses.
  return (
    <div className="dsh-oi-cardControls">
      {offersOptions && (
        <AnswerOptions
          t={answerOptionsT(t)}
          options={options}
          value={choice}
          onChange={setChoice}
          disabled={sending}
        />
      )}
      {offersText && (
        <InlineEditor
          value={text}
          label={t('card.text.aria')}
          onChange={setText}
          onSave={() => {
            if (!textReady || sending) return
            context.onAnswer(item, { type: 'text', text: text.trim() })
          }}
          onCancel={() => { setText('') }}
          className="dsh-oi-cardTextField"
        />
      )}
      {item.reply.note !== undefined && <span className="dsh-oi-cardNote">{item.reply.note}</span>}
      <div className="dsh-oi-cardActions">
        <Button size="sm" variant="ghost" disabled={sending} onClick={() => { context.onAnswer(item, { type: 'dismiss' }) }}>
          {t('card.action.dismiss')}
        </Button>
        <div className="dsh-oi-cardActionsPrimary">
          <Button size="sm" variant="outline" onClick={() => { context.openInbox(item.id) }}>
            {t('card.openInbox')}
          </Button>
          {offersOptions && (
            <Button
              size="sm"
              variant="primary"
              disabled={sending || choice === null}
              onClick={() => {
                if (choice === null) return
                context.onAnswer(item, { type: 'option', option: choice })
              }}
            >
              {sending ? t('card.sending') : t('card.action.answer')}
            </Button>
          )}
          {offersText && (
            <Button
              size="sm"
              variant="primary"
              disabled={sending || !textReady}
              onClick={() => { context.onAnswer(item, { type: 'text', text: text.trim() }) }}
            >
              {sending ? t('card.sending') : t('card.action.send')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/** One item block inside the card: receipt, conflict, disabled explanation or controls. */
function CardItem(props: { readonly item: EffectiveItem; readonly ui: ItemUi; readonly context: RowContext }): ReactNode {
  const { item, ui, context } = props
  const { t } = context

  const settled = ui.settled
  const settledReceipt = settled === undefined
    ? undefined
    : settled.dismissed === true
      ? { text: t('card.receipt.dismissed', { time: clockLabel(settled.at) }) }
      : settled.answer === undefined
        ? { text: t('card.receipt.answered', { time: clockLabel(settled.at) }) }
        : { text: t(outcomeCopyKey(settled.outcome), { time: clockLabel(settled.at), answer: settled.answer }), answer: settled.answer }
  const receipt = settledReceipt ?? recordReceipt(item, t)

  const conflictAnswer = resolutionAnswerText(item.resolution)
  const reason = receipt === undefined && ui.conflict === undefined ? disabledReasonOf(item, context) : undefined

  let body: ReactNode
  if (item.tier === 'candidate') {
    // Candidates are review-only: the card never shows reply controls for an
    // inferred row. It names the inference and hands off to the Candidates tab,
    // where the kind/title can be corrected before confirming.
    body = (
      <div className="dsh-oi-cardDisabled">
        <p className="dsh-oi-cardNote">{t('card.inferredNote')}</p>
        <div className="dsh-oi-cardActions">
          <Button size="sm" variant="outline" onClick={() => { context.openInbox(item.id) }}>
            {t('card.openCandidates')}
          </Button>
        </div>
      </div>
    )
  } else if (ui.conflict !== undefined) {
    body = (
      <div className="dsh-oi-cardConflict">
        <p className="dsh-oi-cardNote dsh-oi-cardNote--warn">{t('card.conflict')}</p>
        {ui.conflict.show && conflictAnswer !== undefined && (
          <p className="dsh-oi-cardReceiptAnswer">“{conflictAnswer}”</p>
        )}
        <div className="dsh-oi-cardActions">
          {conflictAnswer !== undefined && (
            <Button
              size="sm"
              variant="outline"
              aria-expanded={ui.conflict.show}
              onClick={() => { context.onToggleConflict(item) }}
            >
              {t(ui.conflict.show ? 'card.action.hideAnswer' : 'card.action.showAnswer')}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => { context.openInbox(item.id) }}>
            {t('card.openInbox')}
          </Button>
        </div>
      </div>
    )
  } else if (receipt !== undefined) {
    body = <Receipt t={t} text={receipt.text} {...(receipt.answer === undefined ? {} : { answer: receipt.answer })} openInbox={context.openInbox} />
  } else if (reason !== undefined) {
    body = (
      <div className="dsh-oi-cardDisabled">
        <p className="dsh-oi-cardNote">{reason}</p>
        <div className="dsh-oi-cardActions">
          <Button size="sm" variant="outline" onClick={() => { context.openInbox(item.id) }}>
            {t('card.openInbox')}
          </Button>
        </div>
      </div>
    )
  } else {
    body = (
      <>
        <ItemControls item={item} ui={ui} context={context} />
        {ui.failure !== undefined && (
          <p className="dsh-oi-cardNote dsh-oi-cardNote--failed">{t(FAILURE_COPY[ui.failure.kind])}</p>
        )}
        {ui.failure !== undefined && (
          <div className="dsh-oi-cardActions">
            <Button size="sm" variant="outline" onClick={() => { context.onRetry(item) }}>
              {t('card.action.retry')}
            </Button>
          </div>
        )}
      </>
    )
  }

  return (
    <li className="dsh-oi-cardItem" data-item-id={item.id} data-item-state={item.state}>
      <div className="dsh-oi-cardItemHead">
        <KindBadge kind={item.kind} t={t} />
        <span className="dsh-oi-cardTitle" dir="auto">{item.title}</span>
        {item.tier === 'candidate' && <Tag tone="info">{t('card.inferred')}</Tag>}
      </div>
      {item.detailPreview !== undefined && <p className="dsh-oi-cardDetail">{item.detailPreview}</p>}
      {body}
    </li>
  )
}

/**
 * Render the open-items card for one tool result.
 * @param props - slot props plus the injected route face and clock.
 * @returns the card, a fallback row, or null before the result commits.
 */
export function OpenItemsCard(props: OpenItemsCardProps): ReactNode {
  const { t, transport, sessionId, openInbox, now } = props
  const phase = props.phase
  const block: OpenItemsToolBlock | undefined = phase === 'result' ? props.block : undefined
  const callId = props.callId

  const [records, setRecords] = useState<ReadonlyMap<string, OpenItemRecord>>(() => new Map())
  const [ui, setUi] = useState<ReadonlyMap<string, ItemUi>>(() => new Map())
  const [refused, setRefused] = useState(false)
  const inflight = useRef(new Set<string>())
  const deliveryIds = useRef(new Map<string, DeliveryId>())
  const attempts = useRef(new Map<string, { readonly payload: ReplyPayload; readonly deliveryId: DeliveryId }>())

  const parsed = useMemo(() => (block === undefined ? undefined : parseCardMeta(block.meta)), [block])

  const hydrate = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const value = await transport.list(hydrationRequest(sessionId), signal)
      setRecords(indexRecords(value.snapshot.items))
    } catch {
      // A failed read leaves the raise snapshot readable; the card is not an error surface.
    }
  }, [transport, sessionId])

  useEffect(() => {
    if (phase !== 'result') return undefined
    const controller = new AbortController()
    void hydrate(controller.signal)
    return () => { controller.abort() }
  }, [phase, hydrate])

  const patch = useCallback((itemId: string, next: ItemUi): void => {
    setUi((previous) => {
      const map = new Map(previous)
      map.set(itemId, next)
      return map
    })
  }, [])

  /** Send one attempt (the caller already claimed the item). */
  const runAttempt = async (item: EffectiveItem, payload: ReplyPayload, deliveryId: DeliveryId): Promise<void> => {
    patch(item.id, { sending: true })
    try {
      const value = await transport.reply(replyRequest(item, payload, deliveryId))
      setRecords((previous) => {
        const map = new Map(previous)
        map.set(item.id, value.item)
        return map
      })
      const answer = answerTextOf(payload)
      patch(item.id, {
        settled: {
          outcome: value.outcome,
          at: now(),
          ...(answer === undefined ? {} : { answer }),
          ...(value.note === undefined ? {} : { note: value.note }),
          ...(payload.type === 'dismiss' ? { dismissed: true } : {}),
        },
      })
      void hydrate()
    } catch (error) {
      const failure = failureOf(error)
      if (failure === 'conflict') {
        patch(item.id, { conflict: { show: false } })
        void hydrate()
      } else if (failure === 'forbidden') {
        setRefused(true)
        patch(item.id, { failure: { kind: 'forbidden' } })
      } else {
        patch(item.id, { failure: { kind: failure, ...(error instanceof Error ? { message: error.message } : {}) } })
      }
    } finally {
      inflight.current.delete(item.id)
    }
  }

  const answer = (item: EffectiveItem, payload: ReplyPayload): void => {
    if (inflight.current.has(item.id)) return
    if (refused || props.peerReadOnly()) return
    inflight.current.add(item.id)
    const existing = deliveryIds.current.get(item.id)
    const deliveryId = existing ?? newDeliveryId()
    if (existing === undefined) deliveryIds.current.set(item.id, deliveryId)
    attempts.current.set(item.id, { payload, deliveryId })
    void runAttempt(item, payload, deliveryId)
  }

  const retry = (item: EffectiveItem): void => {
    if (inflight.current.has(item.id)) return
    const attempt = attempts.current.get(item.id)
    if (attempt === undefined) return
    inflight.current.add(item.id)
    void (async () => {
      try {
        const recovered = await transport.delivery({ deliveryId: attempt.deliveryId })
        const recovery = recoveryOf(recovered.delivery)
        if (recovery !== undefined) {
          if (recovery.kind === 'settled') {
            if (recovered.item !== undefined) {
              setRecords((previous) => {
                const map = new Map(previous)
                map.set(item.id, recovered.item as OpenItemRecord)
                return map
              })
            }
            patch(item.id, { settled: { outcome: recovery.outcome, at: now() } })
          } else {
            patch(item.id, { failure: { kind: recovery.failure } })
          }
          inflight.current.delete(item.id)
          return
        }
      } catch {
        // The recovery read is best-effort; fall through to re-sending the same id.
      }
      await runAttempt(item, attempt.payload, attempt.deliveryId)
    })()
  }

  /** Show/hide the settled answer of a conflict block. */
  const toggleConflict = (item: EffectiveItem): void => {
    const current = ui.get(item.id)?.conflict
    if (current === undefined) return
    patch(item.id, { conflict: { show: !current.show } })
  }

  if (phase !== 'result' || block === undefined) return null

  if (block.isError === true) {
    const summary = recordedErrorText(block)
    return (
      <FallbackRow
        t={t}
        title={t('card.toolTitle')}
        {...(summary === undefined ? {} : { summary })}
        note={t('card.errorDetail')}
        tone="failed"
        openInbox={openInbox}
      />
    )
  }

  if (parsed === undefined || parsed.kind === 'legacy') {
    const summary = recordedSummary(block)
    return (
      <FallbackRow
        t={t}
        title={t('card.toolTitle')}
        {...(summary === undefined ? {} : { summary })}
        note={t('card.legacy')}
        tone="warn"
        openInbox={openInbox}
      />
    )
  }

  // Session-scoped standard facts, read at render: the access probe is the
  // honest "may this Peer write?" answer, and the catalogue is the lazy
  // subagent check (no apply-time `ctx.get`, so a cold boot cannot skip it).
  // The live standard hook is typed by the session package; normalise to the
  // structural catalogue this component reads.
  const byId = (props.useSessions ?? fallbackSessions)(state => state.byId) as
    Readonly<Record<string, { readonly origin?: string; readonly parentId?: string } | undefined>>
  const summary = byId[String(sessionId)]
  const subagent = props.isSubagent()
    || summary?.origin === 'subagent'
    || summary?.parentId !== undefined
  const canPrompt = (props.useAccess ?? allowAllAccess)('session/prompt')
  const readOnly = refused || !canPrompt || props.peerReadOnly()
  const context: RowContext = {
    t,
    callId,
    readOnly,
    subagent,
    openInbox,
    onAnswer: answer,
    onRetry: retry,
    onToggleConflict: toggleConflict,
  }
  const items = parsed.items.map(view => effectiveItem(view, records.get(view.id)))

  return (
    <section className="dsh-oi-card" aria-label={t('card.aria')} data-call-id={callId} data-tool={props.toolName}>
      <header className="dsh-oi-cardHead">
        <span className="dsh-oi-cardTool">{t('card.toolTitle')}</span>
        <span className="dsh-oi-cardCount">{raisedLabel(t, parsed.total)}</span>
      </header>
      <ul className="dsh-oi-cardItems">
        {items.slice(0, LIMITS.cardMaxItems).map(item => (
          <CardItem key={item.id} item={item} ui={ui.get(item.id) ?? {}} context={context} />
        ))}
      </ul>
      {parsed.hidden > 0 && (
        <div className="dsh-oi-cardFooter">
          <span className="dsh-oi-cardFooterText">{t('card.andMore', { count: parsed.hidden })}</span>
          <div className="dsh-oi-cardFooterActions">
            <Button size="sm" variant="outline" onClick={() => { openInbox() }}>
              {t('card.reviewAll', { count: parsed.total })}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * Contain a card render failure so the tool call cannot appear to vanish.
 *
 * The slot renderer has its own per-entry boundary, but a keyed cell with no
 * survivor renders nothing at all; this inner boundary keeps a readable row
 * (the recorded summary plus a note) in the transcript.
 */
export class OpenItemsCardBoundary extends Component<OpenItemsCardProps, { readonly failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    console.error('open-items card failed to render:', error)
  }

  override render(): ReactNode {
    if (!this.state.failed) return <OpenItemsCard {...this.props} />
    return (
      <FallbackRow
        t={this.props.t}
        title={this.props.t('card.toolTitle')}
        note={this.props.t('card.legacy')}
        tone="warn"
        openInbox={this.props.openInbox}
      />
    )
  }
}

/**
 * Slot component registered for `tool.call.toolview`: the boundary around the
 * card. The slot registry takes a function component, so this is the one
 * address the registration names.
 * @param props - composed slot props.
 * @returns the card, contained by the error boundary.
 */
export function OpenItemsCardSlot(props: OpenItemsCardProps): ReactNode {
  return <OpenItemsCardBoundary {...props} />
}
