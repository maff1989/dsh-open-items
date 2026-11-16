/**
 * The card's view of one item: the raise-time `meta` snapshot merged with the
 * live record hydration returns.
 *
 * `meta` is what the transcript row can always render (durable, replayable);
 * the durable record is the current truth (a row remounted after an answer
 * elsewhere must not offer controls again). The rule from DESIGN §5.8 is
 * "projection wins when present": the newer `version` wins, and a settled
 * record renders a receipt even when its card snapshot still says `open`.
 *
 * @module dsh-open-items/client/ui/card/items
 */
import { LIMITS } from '../../../shared/protocol'
import type {
  OpenItemKind,
  OpenItemRecord,
  OpenItemState,
  Resolution,
  ReplyDescriptor,
} from '../../../shared/schema'
import type { CardItemView } from './meta'
import { toPlainText } from '../prose-text'

/** One render-ready item, whichever read supplied it. */
export interface EffectiveItem {
  readonly id: string
  readonly kind: OpenItemKind | 'unknown'
  readonly state: OpenItemState
  /**
   * Candidate rows are review-only: the card never offers reply controls for
   * them (they are not items until the reader confirms them on the page).
   */
  readonly tier: 'candidate' | 'structural'
  readonly title: string
  readonly detailPreview?: string
  readonly options: readonly string[]
  readonly blocking: boolean
  /** CAS token the reply must carry. */
  readonly version: number
  readonly sessionId: string
  readonly callId?: string
  readonly reply: ReplyDescriptor
  /** Present once the record settled (answered / dismissed / superseded / closed). */
  readonly resolution?: Resolution
  /** True when the durable record supplied this view. */
  readonly fromRecord: boolean
  /** Epoch ms of the last durable change, for receipts. */
  readonly updatedAt: number
}

/** Collapse whitespace and bound one preview string. */
function preview(value: string, max: number): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** Index a list read by item id (last write wins; ids are unique). */
export function indexRecords(records: readonly OpenItemRecord[]): ReadonlyMap<string, OpenItemRecord> {
  const index = new Map<string, OpenItemRecord>()
  for (const record of records) index.set(record.id, record)
  return index
}

/** The options the record advertises, preferring the record over the descriptor. */
function optionsOf(record: OpenItemRecord): readonly string[] {
  return record.options ?? record.reply.options ?? []
}

/** Render-ready view built from the durable record (the newer read). */
function fromRecord(record: OpenItemRecord, fallback: CardItemView): EffectiveItem {
  return {
    id: record.id,
    kind: record.kind,
    state: record.state,
    tier: record.tier,
    title: toPlainText(record.title),
    ...(record.body === '' ? {} : { detailPreview: preview(record.body, LIMITS.cardDetailPreviewChars) }),
    options: optionsOf(record),
    blocking: record.blocking,
    version: record.version,
    sessionId: record.source.sessionId,
    ...(record.source.callId === undefined ? {} : { callId: record.source.callId }),
    reply: record.reply,
    ...(record.resolution === undefined ? {} : { resolution: record.resolution }),
    fromRecord: true,
    updatedAt: record.updatedAt,
  }
}

/** Render-ready view built from the raise-time snapshot. */
function fromView(view: CardItemView, record: OpenItemRecord | undefined): EffectiveItem {
  return {
    id: view.id,
    kind: view.kind,
    state: view.state,
    // A raise-time snapshot only exists for tool-raised (structural) items; a
    // hydrated candidate is rendered from the record branch above.
    tier: record?.tier ?? 'structural',
    title: toPlainText(view.title),
    ...(view.detailPreview === undefined ? {} : { detailPreview: view.detailPreview }),
    options: view.options,
    blocking: view.blocking,
    version: view.version,
    sessionId: view.sessionId,
    ...(view.callId === undefined ? {} : { callId: view.callId }),
    reply: view.reply,
    ...(record?.resolution === undefined ? {} : { resolution: record.resolution }),
    fromRecord: false,
    updatedAt: record?.updatedAt ?? 0,
  }
}

/**
 * Merge the raise snapshot with the hydrated record.
 * @param view - normalized card row from `meta`.
 * @param record - durable record read for the same id, when the read found one.
 * @returns the item to render (newer version wins).
 */
export function effectiveItem(view: CardItemView, record: OpenItemRecord | undefined): EffectiveItem {
  if (record !== undefined && record.version >= view.version) return fromRecord(record, view)
  return fromView(view, record)
}

/** Whether a lifecycle state still offers an answer here. */
export function isAnswerableState(state: OpenItemState): boolean {
  return state === 'open' || state === 'snoozed'
}

/**
 * The verbatim answer text of one resolution, when the payload carries one.
 * @param resolution - recorded resolution.
 * @returns the user's words for an option/text answer; undefined otherwise.
 */
export function resolutionAnswerText(resolution: Resolution | undefined): string | undefined {
  if (resolution === undefined) return undefined
  const payload = resolution.payload
  if (payload.type === 'option') return payload.option
  if (payload.type === 'text') return payload.text === '' ? undefined : payload.text
  return undefined
}

/**
 * Whether a resolution was made through the inbox (not this card).
 * @param resolution - recorded resolution.
 * @returns true when no delivery id ties it to a card attempt.
 */
export function resolvedElsewhere(resolution: Resolution | undefined): boolean {
  return resolution !== undefined && resolution.deliveryId === undefined
}

/**
 * Short clock label for receipts ("14:02"), in the reader's locale.
 * @param at - epoch milliseconds; undefined yields an empty string.
 * @returns the local time label.
 */
export function clockLabel(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at) || at <= 0) return ''
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(at)
}
