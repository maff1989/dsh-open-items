/**
 * Defensive reader for the card contract carried in `tool/result.meta`
 * (`CardMeta` v1, see `src/shared/schema.ts`).
 *
 * The value arrives from the durable Session log, so it can be older than this
 * build, hand-edited, or truncated by an editor. Every field is therefore read
 * as unknown and narrowed; an unreadable payload is a *legacy* result (render
 * the generic row plus a note), never an exception. The renderer must not throw
 * inside the transcript: a thrown component leaves an empty cell that reads as
 * "the tool call vanished".
 *
 * @module dsh-open-items/client/ui/card/meta
 */
import { LIMITS } from '../../../shared/protocol'
import type { OpenItemKind, OpenItemState, ReplyDescriptor } from '../../../shared/schema'
import type { OpenItemsCardKey } from './card-locales'
import type { OpenItemsToolBlock } from './slot-contracts'

/** Reply control names the inbox contract defines (mirrored from schema.ts). */
const REPLY_CONTROLS = ['option', 'text', 'approve', 'deny', 'task-action'] as const

/** One reply control name. */
export type ReplyControlName = (typeof REPLY_CONTROLS)[number]

/** Every item kind, in schema order; used to validate a wire value. */
const KINDS: readonly OpenItemKind[] = [
  'decision',
  'approval',
  'question',
  'plan-review',
  'blocker',
  'risk',
  'follow-up',
  'task',
]

/** Every item lifecycle state, in schema order. */
const STATES: readonly OpenItemState[] = ['open', 'snoozed', 'awaiting', 'stale', 'archived', 'resolved']

/** Kind label key per known kind (the card owns its own copy namespace). */
export const CARD_KIND_LABEL: Record<OpenItemKind, OpenItemsCardKey> = {
  decision: 'card.kind.decision',
  approval: 'card.kind.approval',
  question: 'card.kind.question',
  'plan-review': 'card.kind.plan-review',
  blocker: 'card.kind.blocker',
  risk: 'card.kind.risk',
  'follow-up': 'card.kind.follow-up',
  task: 'card.kind.task',
}

/** One normalized item row of the card. */
export interface CardItemView {
  readonly id: string
  readonly kind: OpenItemKind | 'unknown'
  readonly state: OpenItemState
  readonly title: string
  readonly detailPreview?: string
  readonly options: readonly string[]
  readonly blocking: boolean
  readonly version: number
  readonly sessionId: string
  readonly callId?: string
  readonly reply: ReplyDescriptor
}

/** Parsed card payload, or the reason the row must fall back. */
export type CardMetaView =
  | {
    readonly kind: 'card'
    readonly items: readonly CardItemView[]
    readonly total: number
    /** Rows the card does not print (`total` − printed), never negative. */
    readonly hidden: number
    /** True when the raise payload itself was capped below its total. */
    readonly truncated: boolean
  }
  | { readonly kind: 'legacy'; readonly reason: 'absent' | 'version' | 'shape' }

/** Collapse whitespace and bound one preview string without changing its words. */
function preview(value: string, max: number): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** Whether an unknown value is a plain object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a non-blank string field. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Read a finite, non-negative integer field. */
function countOf(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

/** Narrow one wire kind, keeping an explicit unknown bucket for forward skew. */
function kindOf(value: unknown): OpenItemKind | 'unknown' {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
    ? (value as OpenItemKind)
    : 'unknown'
}

/** Narrow one wire lifecycle state; an unreadable state is treated as still open. */
function stateOf(value: unknown): OpenItemState {
  return typeof value === 'string' && (STATES as readonly string[]).includes(value)
    ? (value as OpenItemState)
    : 'open'
}

/** Read a bounded list of non-blank option labels. */
function optionsOf(value: unknown, max = 24): readonly string[] {
  if (!Array.isArray(value)) return []
  const labels: string[] = []
  for (const candidate of value) {
    const label = textOf(candidate)
    if (label === undefined) continue
    labels.push(preview(label, 120))
    if (labels.length >= max) break
  }
  return labels
}

/** Narrow one reply descriptor, defaulting to "no controls". */
function replyOf(value: unknown, options: readonly string[]): ReplyDescriptor {
  const record = isRecord(value) ? value : {}
  const controls = Array.isArray(record.controls)
    ? record.controls.filter((control): control is ReplyControlName =>
      typeof control === 'string' && (REPLY_CONTROLS as readonly string[]).includes(control))
    : []
  const declaredOptions = optionsOf(record.options)
  const merged = declaredOptions.length > 0 ? declaredOptions : options
  const note = textOf(record.note)
  return {
    controls,
    ...(merged.length === 0 ? {} : { options: merged }),
    freeText: record.freeText === true,
    requiresConfirm: record.requiresConfirm === true,
    ...(note === undefined ? {} : { note }),
  }
}

/** Narrow one wire card item; undefined means "skip this row". */
function cardItemOf(value: unknown): CardItemView | undefined {
  if (!isRecord(value)) return undefined
  const id = textOf(value.id)
  const title = textOf(value.title)
  const sessionId = textOf(value.sessionId)
  if (id === undefined || title === undefined || sessionId === undefined) return undefined
  const options = optionsOf(value.options)
  const detail = textOf(value.detailPreview)
  const callId = textOf(value.callId)
  return {
    id,
    kind: kindOf(value.kind),
    state: stateOf(value.state),
    title: preview(title, 200),
    ...(detail === undefined ? {} : { detailPreview: preview(detail, LIMITS.cardDetailPreviewChars) }),
    options,
    blocking: value.blocking === true,
    version: countOf(value.version),
    sessionId,
    ...(callId === undefined ? {} : { callId }),
    reply: replyOf(value.reply, options),
  }
}

/**
 * Read one `tool/result.meta` value as the card contract.
 * @param meta - recorded metadata (unvalidated).
 * @returns the normalized card payload, or the legacy reason.
 */
export function parseCardMeta(meta: unknown): CardMetaView {
  if (meta === undefined || meta === null) return { kind: 'legacy', reason: 'absent' }
  if (!isRecord(meta)) return { kind: 'legacy', reason: 'shape' }
  if (meta.v !== 1) return { kind: 'legacy', reason: 'version' }
  if (!Array.isArray(meta.items)) return { kind: 'legacy', reason: 'shape' }
  const items: CardItemView[] = []
  for (const candidate of meta.items) {
    const item = cardItemOf(candidate)
    if (item !== undefined) items.push(item)
    if (items.length >= LIMITS.cardMaxItems) break
  }
  if (items.length === 0) return { kind: 'legacy', reason: 'shape' }
  const total = Math.max(countOf(meta.total, items.length), items.length)
  const hidden = Math.max(0, total - items.length)
  return {
    kind: 'card',
    items,
    total,
    hidden,
    truncated: meta.truncated === true || hidden > 0,
  }
}

/**
 * One-line summary of a recorded result's text blocks, for fallback rows.
 * @param block - recorded result material.
 * @param max - maximum characters.
 * @returns the collapsed first text block, when present.
 */
export function recordedSummary(block: OpenItemsToolBlock, max = 180): string | undefined {
  const first = block.content?.find(entry => entry.type === 'text' && typeof entry.text === 'string')
  const text = textOf(first?.text)
  return text === undefined ? undefined : preview(text, max)
}

/**
 * Failure text of a recorded `isError` result.
 * @param block - recorded result material.
 * @returns the user-facing reason, or undefined.
 */
export function recordedErrorText(block: OpenItemsToolBlock): string | undefined {
  const reason = textOf(block.error?.reason)
  if (reason !== undefined) return preview(reason, 200)
  return recordedSummary(block)
}

/**
 * Display text of one recorded content block (fallback body).
 * @param block - recorded result material.
 * @returns the first text block, uncollapsed and bounded.
 */
export function recordedText(block: OpenItemsToolBlock): string | undefined {
  return recordedSummary(block)
}
