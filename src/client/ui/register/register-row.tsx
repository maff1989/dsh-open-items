/**
 * One register row (UI.md §4.6 row anatomy): source glyph + source word +
 * resolution time, kind chip, what was decided, the item title, provenance and
 * the acknowledgement phrase.
 *
 * The source indicator is never colour-only: the row always carries the word
 * (`by you`, `in flight`, `automatic`), and a detector close also names the
 * detector with its raw code. Dismissed rows are `by you` with a muted glyph —
 * the decision text says `not an item`.
 *
 * @module dsh-open-items/client/ui/register/register-row
 */
import type { ReactNode } from 'react'
import {
  IconCheckCircleOutlineRegular,
  IconChecklistOutlineRegular,
  IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'

import type { OpenItemRecord } from '../../../shared/schema'
import { sessionLabelOf, type PageTranslate, type SessionTitleResolver } from '../../format'
import { sourceIndicatorOf } from '../../derive/register-view'
import { KindChip } from '../kind'
import { toPlainText } from '../prose-text'
import {
  acknowledgementPhraseOf,
  decisionHeadlineOf,
  detectorCodeLabel,
  resolvedLabelOf,
  resolvedTitleOf,
  sourceWordOf,
} from './present'

/** Props of one register row. */
export interface RegisterRowProps {
  readonly record: OpenItemRecord
  readonly t: PageTranslate
  readonly now: number
  readonly selected: boolean
  readonly onSelect: (itemId: string) => void
  /** Applies the per-session decision history filter (UI.md §4.7). */
  readonly onSessionFilter: (sessionId: string) => void
  /** Opens the raising session, when navigation is injected. */
  readonly openSession?: (sessionId: string) => void
  /** Live catalogue lookup for a Session label the record's snapshot lacks. */
  readonly sessionTitle?: SessionTitleResolver
  /** Detail body rendered inside the row on the medium/narrow layouts. */
  readonly detail?: ReactNode
}

/** Source glyph; decorative because the word beside it carries the meaning. */
function SourceGlyph({ indicator }: { readonly indicator: ReturnType<typeof sourceIndicatorOf> }): ReactNode {
  switch (indicator) {
    case 'answered':
    case 'dismissed':
      return <IconCheckCircleOutlineRegular size={13} />
    case 'in-flight':
      return <IconRefreshOutlineRegular size={13} />
    case 'automatic':
      return <IconChecklistOutlineRegular size={13} />
  }
}

/** Tone of the acknowledgement line: pending, none, or ok. */
function acknowledgementTone(t: PageTranslate, record: OpenItemRecord, unresolved: boolean): 'pending' | 'none' | 'ok' {
  if (unresolved) return 'pending'
  const phrase = acknowledgementPhraseOf(t, record)
  if (phrase === t('register.ack.none')) return 'none'
  if (phrase === t('register.ack.pending')) return 'pending'
  return 'ok'
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

/**
 * Render one resolved (or in-flight) register row.
 * @param props - record, copy, clock, selection and navigation seams.
 * @returns the list item.
 */
export function RegisterRow({ record, t, now, selected, onSelect, onSessionFilter, openSession, sessionTitle: resolveSessionTitle, detail }: RegisterRowProps): ReactNode {
  const indicator = sourceIndicatorOf(record)
  const detectorCode = detectorCodeLabel(record)
  const sessionTitle = sessionLabelOf(t, record, resolveSessionTitle)
  const workspace = record.source.workspace?.title ?? record.source.workspace?.path
  const unresolved = record.state === 'awaiting'
  return (
    <li
      className="dsh-oi-regRow"
      role="listitem"
      data-row-key={record.id}
      data-item-id={record.id}
      data-source={indicator}
      data-selected={selected ? 'true' : 'false'}
      data-state={record.state}
      onClick={() => onSelect(record.id)}
    >
      <div className="dsh-oi-regRowTop">
        <span className="dsh-oi-regGlyph" aria-hidden="true" data-tone={indicator}>
          <SourceGlyph indicator={indicator} />
        </span>
        <span className="dsh-oi-regSource">{sourceWordOf(t, indicator)}</span>
        <time
          className="dsh-oi-regTime"
          dateTime={resolvedTitleOf(record)}
          title={resolvedTitleOf(record)}
        >
          {resolvedLabelOf(t, record, now)}
        </time>
        <KindChip kind={record.kind} label={t(KIND_LABEL[record.kind])} />
      </div>
      <button
        type="button"
        className="dsh-oi-regSelect"
        aria-label={t('a11y.selectItem', { title: record.title })}
        aria-current={selected ? 'true' : undefined}
        onClick={(event) => {
          event.stopPropagation()
          onSelect(record.id)
        }}
      >
        <span className="dsh-oi-regDecision">{decisionHeadlineOf(t, record)}</span>
        <span className="dsh-oi-regTitle" dir="auto">{toPlainText(record.title)}</span>
      </button>
      <p className="dsh-oi-regMeta">
        <button
          type="button"
          className="dsh-oi-regSession"
          title={t('register.filter.sessionValue', { title: sessionTitle })}
          onClick={(event) => {
            event.stopPropagation()
            onSessionFilter(record.source.sessionId)
          }}
        >
          {sessionTitle}
        </button>
        {workspace !== undefined && workspace !== '' && <span> · {workspace}</span>}
        {record.source.turn !== undefined && <span> · {t('detail.turn', { turn: record.source.turn })}</span>}
        {openSession !== undefined && (
          <>
            {' · '}
            <button
              type="button"
              className="dsh-oi-regOpen"
              onClick={(event) => {
                event.stopPropagation()
                openSession(record.source.sessionId)
              }}
            >
              {t('detail.openSession')}
            </button>
          </>
        )}
      </p>
      {detectorCode !== undefined && (
        <p className="dsh-oi-regDetector">
          {t('register.detail.detector')} <code>{detectorCode}</code>
        </p>
      )}
      <p className={`dsh-oi-regAck dsh-oi-regAck--${acknowledgementTone(t, record, unresolved)}`}>
        {acknowledgementPhraseOf(t, record)}
      </p>
      {detail}
    </li>
  )
}
