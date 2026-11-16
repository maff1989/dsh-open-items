/**
 * Presentation helpers of the Resolved register: the words a row and the
 * read-only detail render, derived from the structured record.
 *
 * The rules are intentionally split from the components so the copy is testable
 * without a DOM, and so the row and the detail can never phrase the same fact
 * differently: both call these functions.
 *
 * Design authority: UI.md §4.6 (row anatomy, source indicator) and §5.1
 * (resolved read-only detail); DESIGN §7.4.1 (verbatim payload) and §7.4.2
 * (acknowledgement honesty).
 *
 * @module dsh-open-items/client/ui/register/present
 */
import type { OpenItemRecord, Resolution } from '../../../shared/schema'
import { absoluteLabel, relativeLabel, type PageTranslate } from '../../format'
import {
  acknowledgementOf,
  decisionOf,
  detectorCodeOf,
  detectorFamilyOf,
  firstLineOf,
  registerTimestampOf,
  resolutionKindOf,
  sourceIndicatorOf,
  type DetectorFamily,
  type SourceIndicator,
} from '../../derive/register-view'

/** One-line decision summary of a row ("what was decided"). */
export function decisionHeadlineOf(t: PageTranslate, record: OpenItemRecord): string {
  const decision = decisionOf(record)
  switch (decision.kind) {
    case 'option':
      return decision.text
    case 'text':
      return `“${firstLineOf(decision.text)}”`
    case 'approval':
      return withNote(
        t,
        t(decision.outcome === 'allow-once' ? 'register.decision.allowedOnce' : 'register.decision.denied'),
        decision.note,
      )
    case 'task-action':
      return withNote(t, decision.action, decision.note)
    case 'dismiss':
      return withNote(t, t('register.decision.notAnItem'), decision.reason)
    case 'detector':
      return `${t('register.decision.closedAutomatically')} · ${detectorPhraseOf(t, decision.code)}`
    case 'none':
      return '—'
  }
}

/** Append a note to a fixed decision phrase. */
function withNote(t: PageTranslate, text: string, note: string | undefined): string {
  return note === undefined ? text : t('register.decision.withNote', { text, note })
}

/** Full, verbatim decision text for the detail ("what you decided"). */
export function decisionBodyOf(t: PageTranslate, record: OpenItemRecord): string {
  const decision = decisionOf(record)
  switch (decision.kind) {
    case 'option':
    case 'text':
      return decision.text
    case 'approval':
      return withNote(
        t,
        t(decision.outcome === 'allow-once' ? 'register.decision.allowedOnce' : 'register.decision.denied'),
        decision.note,
      )
    case 'task-action':
      return withNote(t, decision.action, decision.note)
    case 'dismiss':
      return withNote(t, t('register.decision.notAnItem'), decision.reason)
    case 'detector':
      return t('register.decision.closedAutomatically')
    case 'none':
      return '—'
  }
}

/** Source word of one row (the second, non-colour channel of the indicator). */
export function sourceWordOf(t: PageTranslate, indicator: SourceIndicator): string {
  switch (indicator) {
    case 'answered':
    case 'dismissed':
      return t('register.sourceWord.you')
    case 'in-flight':
      return t('register.sourceWord.inFlight')
    case 'automatic':
      return t('register.sourceWord.automatic')
  }
}

/** Source word of one record. */
export function sourceWordOfRecord(t: PageTranslate, record: OpenItemRecord): string {
  return sourceWordOf(t, sourceIndicatorOf(record))
}

/** Detector family phrase, e.g. `goal changed`; the raw code is shown beside it. */
export function detectorPhraseOf(t: PageTranslate, code: string | undefined): string {
  const family: DetectorFamily = detectorFamilyOf(code)
  switch (family) {
    case 'approval':
      return t('register.detector.approval')
    case 'goal':
      return t('register.detector.goal')
    case 'task':
      return t('register.detector.task')
    case 'question':
      return t('register.detector.question')
    case 'session':
      return t('register.detector.session')
    case 'other':
      return t('register.detector.other')
  }
}

/** The detector code shown beside the phrase (auditability, never hidden). */
export function detectorCodeLabel(record: OpenItemRecord): string | undefined {
  return detectorCodeOf(record)
}

/** "What happened next" phrase of one record (DESIGN §7.4.2). */
export function acknowledgementPhraseOf(t: PageTranslate, record: OpenItemRecord): string {
  const acknowledgement = acknowledgementOf(record)
  switch (acknowledgement.state) {
    case 'observed':
      return acknowledgement.evidence === undefined
        ? t('register.ack.observedPlain')
        : t('register.ack.observed', { evidence: t(`register.ack.evidence.${acknowledgement.evidence}`) })
    case 'pending':
      return t('register.ack.pending')
    case 'none':
      return t('register.ack.none')
    case 'not-applicable':
      return t('register.ack.na')
  }
}

/** Acknowledgement phrase with its time, when one was recorded. */
export function acknowledgementLineOf(t: PageTranslate, record: OpenItemRecord, now: number): string {
  const acknowledgement = acknowledgementOf(record)
  const phrase = acknowledgementPhraseOf(t, record)
  if (acknowledgement.at === undefined) return phrase
  return t('register.detail.ackedAt', {
    phrase,
    time: `${absoluteLabel(acknowledgement.at)} (${relativeLabel(t, acknowledgement.at, now)})`,
  })
}

/** Resolution time label of one row, with an absolute tooltip title. */
export function resolvedLabelOf(t: PageTranslate, record: OpenItemRecord, now: number): string {
  return relativeLabel(t, registerTimestampOf(record), now)
}

/** Absolute resolution time for `title`/`<time>` attributes. */
export function resolvedTitleOf(record: OpenItemRecord): string {
  return new Date(registerTimestampOf(record)).toISOString()
}

/** Localized label of one history resolution kind. */
export function historyKindLabelOf(t: PageTranslate, resolution: Resolution): string {
  switch (resolution.kind) {
    case 'answered':
      return t('register.history.answered')
    case 'dismissed':
      return t('register.history.dismissed')
    case 'superseded':
      return t('register.history.superseded')
    case 'detected-closed':
      return t('register.history.detectedClosed')
  }
}

/** One history row: earlier resolutions plus the recorded audit actions. */
export interface HistoryLine {
  readonly key: string
  readonly at: number
  readonly label: string
  readonly detail?: string
}

/**
 * The history disclosure content: earlier resolutions of the same item (the
 * register is append-only, DESIGN §7.4.3) followed by the audit trail.
 * @param t - translator.
 * @param record - one register record.
 * @param now - current epoch milliseconds.
 * @returns the lines to render, newest first is not required; callers show order.
 */
export function historyLinesOf(t: PageTranslate, record: OpenItemRecord, now: number): readonly HistoryLine[] {
  const lines: HistoryLine[] = []
  const earlier = record.resolutionLog ?? []
  earlier.forEach((resolution, index) => {
    lines.push({
      key: `resolution-${String(index)}`,
      at: resolution.at,
      label: t('register.history.entry', {
        kind: historyKindLabelOf(t, resolution),
        time: `${absoluteLabel(resolution.at)} (${relativeLabel(t, resolution.at, now)})`,
      }),
    })
  })
  for (const [index, entry] of record.history.entries()) {
    lines.push({
      key: `history-${String(index)}`,
      at: entry.at,
      label: t('register.history.entry', {
        kind: entry.action,
        time: `${absoluteLabel(entry.at)} (${relativeLabel(t, entry.at, now)})`,
      }),
      ...(entry.detail === undefined || entry.detail === '' ? {} : { detail: entry.detail }),
    })
  }
  return lines
}

/** Whether the item has any earlier cycle worth a History disclosure. */
export function hasHistory(record: OpenItemRecord): boolean {
  return record.reopenCount > 0
    || (record.resolutionLog?.length ?? 0) > 0
    || record.history.length > 1
}

/** Reopened-count sentence, or an empty string when it never happened. */
export function reopenedCountOf(t: PageTranslate, record: OpenItemRecord): string {
  if (record.reopenCount === 0) return ''
  return t(record.reopenCount === 1 ? 'register.history.reopenedCount.one' : 'register.history.reopenedCount.other', {
    count: record.reopenCount,
  })
}

/** Whether the record is closed but still has its transcript text (active register). */
export function isCompacted(record: OpenItemRecord): boolean {
  return record.retention.class === 'archived'
}

/** Resolution kind of one record, for the detail header word. */
export function outcomeWordOf(t: PageTranslate, record: OpenItemRecord): string {
  const kind = resolutionKindOf(record)
  switch (kind) {
    case 'answered':
      return t('register.outcome.acknowledged')
    case 'dismissed':
      return t('register.outcome.dismissed')
    case 'superseded':
      return t('register.outcome.superseded')
    case 'detected-closed':
      return t('register.decision.closedAutomatically')
    case undefined:
      return t('register.band.note')
  }
}
