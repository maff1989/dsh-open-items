/**
 * Prose-candidate read helpers shared by the row, the detail pane, the page and
 * the card.
 *
 * A prose candidate's provenance is already durable on the record — no new wire
 * field is needed: `detectedBy` carries `regex-gate` and the first history entry
 * carries the detector code (`prose-gate:decision-request`). These helpers name
 * that provenance once so every surface labels the same thing the same way.
 *
 * @module dsh-open-items/client/ui/candidate
 */
import type { OpenItemRecord } from '../../shared/schema'
import { sameProse, toPlainText } from './prose-text'

/** The detector code the prose gate stamps into `history[].detail`. */
const PROSE_DETECTOR = 'prose-gate:decision-request'

/** Detection sources that mean "the end-of-turn prose check inferred it". */
const PROSE_SOURCES: readonly string[] = ['regex-gate']

/**
 * Whether this record came from the end-of-turn prose check (or still carries
 * that provenance after promotion).
 * @param item - the durable record.
 * @returns true for a prose-gate artifact, candidate or promoted.
 */
export function isProseOrigin(item: Pick<OpenItemRecord, 'detectedBy' | 'history'>): boolean {
  return item.detectedBy.some(source => PROSE_SOURCES.includes(source))
    || item.history.some(entry => entry.detail?.startsWith('prose-gate:') === true)
}

/**
 * The detector code this record carries, for the provenance line.
 * @param item - the durable record.
 * @returns the code, or the gate's own constant when history was pruned.
 */
export function proseDetectorCodeOf(item: Pick<OpenItemRecord, 'detectedBy' | 'history'>): string | undefined {
  return item.history.find(entry => entry.detail?.startsWith('prose-gate:') === true)?.detail
    ?? (isProseOrigin(item) ? PROSE_DETECTOR : undefined)
}

/**
 * The projected title of one item: no block/emphasis markers.
 * @param item - the durable record.
 * @returns the display title.
 */
export function titleOf(item: Pick<OpenItemRecord, 'title'>): string {
  return toPlainText(item.title)
}

/**
 * The projected quote of one item, when it adds information the title does not.
 * A prose candidate's title is derived from its quote, so rendering both would
 * echo the same sentence (D3); this returns undefined in that case.
 * @param item - the durable record.
 * @returns the distinct display quote, or undefined.
 */
export function distinctQuoteOf(item: Pick<OpenItemRecord, 'title' | 'quote'>): string | undefined {
  const quote = item.quote === undefined ? '' : toPlainText(item.quote)
  if (quote === '') return undefined
  if (sameProse(item.title, item.quote)) return undefined
  return quote
}

/**
 * The choices the record carries, preferring the record-level array.
 * @param item - the durable record.
 * @returns the option labels (possibly empty).
 */
export function candidateOptionsOf(
  item: Pick<OpenItemRecord, 'options'> & { readonly reply: Pick<OpenItemRecord['reply'], 'options'> },
): readonly string[] {
  const options = item.options ?? item.reply.options ?? []
  return options.filter(option => toPlainText(option) !== '')
}
