/**
 * Shared bounds, runtime guards and text helpers for the capture folds.
 *
 * Every fold consumes a committed Session event whose payload is `unknown`:
 * the capture engine must never throw on an event it does not recognise, so all
 * payload access goes through these guards and a malformed payload degrades to
 * "this fold does not apply" rather than an exception.
 *
 * @module dsh-open-items/host/folds/limits
 */

/**
 * Version of the fold semantics. A bump replays old detection cursors.
 *
 * **Must move together with `OPEN_ITEMS_PROJECTION_VERSION`** (`projection.ts`):
 * the cursor replay (`backfill.ts`) and the projection unit's `stateVersion` are
 * two counters over the same semantics, and bumping one alone leaves a stale
 * checkpoint or cursor interpreting new state with old rules (GAP-ANALYSIS
 * G-13). Version 3 reworks the prose candidate gate into an additive
 * multi-item detector: one artifact per ask (per-item `prose:t<turn>:<hash>`
 * ids), a raw newline-preserving turn-text tail, batch-aware bounds and
 * `finalizeProse` for a log that ends inside a turn.
 */
export const OPEN_ITEMS_FOLD_VERSION = 3

/** Capture-side bounds shared by the folds and the backfill job. */
export const OPEN_ITEMS_LIMITS = {
  /** Session cap for one backfill run (DESIGN §4 step 2, OI-10). */
  maxBackfillSessions: 200,
  /** Age cap for one backfill run, in days (DESIGN §4 step 2, OI-10). */
  maxBackfillAgeDays: 90,
  /** Drafts sent to the sink in one batch. */
  sinkBatch: 50,
  /** Sessions folded between event-loop yields, so a backfill never blocks a session. */
  sessionsPerYield: 1,
  /**
   * A team task left `in_progress` is only an open loop while its session is
   * recent: leftovers from a finished team run are history, not something the
   * user must act on (measured: 89 historical orphans in this corpus).
   */
  orphanFreshnessDays: 14,
  /** Max characters of a model-facing title. */
  titleChars: 120,
  /** Max characters of an item body. */
  bodyChars: 2000,
  /** Max characters of verbatim evidence. */
  quoteChars: 2000,
} as const

/** Narrow one unknown value to a plain record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a nested record, or undefined when the value is not one. */
export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/** Read a non-empty string property. */
export function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Read a finite number property. */
export function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read an array, or an empty array when the value is not one. */
export function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** Parse a JSON argument string into a plain record, or undefined. */
export function parseJsonObject(text: unknown): Record<string, unknown> | undefined {
  if (typeof text !== 'string' || text === '') return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    // Model-produced arguments can be malformed; they never reached a tool and
    // carry no card, so the fold simply has no structured payload to read.
    return undefined
  }
}

/** Collapse all whitespace runs to single spaces and trim. */
export function singleLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** Truncate with an ellipsis, never returning more than `max` characters. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 1) return text.slice(0, Math.max(0, max))
  return `${text.slice(0, max - 1)}…`
}

/**
 * Keep the last `max` characters of `text`, cut on a line boundary.
 *
 * Used for the raw assistant text kept in fold state: dropping the partial
 * first line guarantees the prose parser never starts in the middle of a list
 * item or heading, and a newline-less (legacy) value still parses as one line.
 * @param text - raw newline-preserving text.
 * @param max - character bound.
 * @returns the line-bound tail.
 */
export function tailBoundLines(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  const start = text.length - max
  const tail = text.slice(start)
  // The bound happened to land exactly on a line boundary: keep it whole.
  if (text.charCodeAt(start - 1) === 0x0a) return tail
  const firstBreak = tail.indexOf('\n')
  if (firstBreak === -1) return tail
  const lineBound = tail.slice(firstBreak + 1)
  return lineBound === '' ? tail : lineBound
}

/** A one-line title bounded by {@link OPEN_ITEMS_LIMITS.titleChars}. */
export function titleFrom(text: string): string {
  const line = singleLine(text)
  return line === '' ? 'Open item' : truncate(line, OPEN_ITEMS_LIMITS.titleChars)
}

/** A body bounded by {@link OPEN_ITEMS_LIMITS.bodyChars}. */
export function bodyFrom(text: string): string {
  return truncate(text.trim(), OPEN_ITEMS_LIMITS.bodyChars)
}

/** Verbatim evidence bounded by {@link OPEN_ITEMS_LIMITS.quoteChars}. */
export function quoteFrom(text: string): string {
  const trimmed = text.trim()
  return truncate(trimmed, OPEN_ITEMS_LIMITS.quoteChars)
}

/**
 * Join the text blocks of a message content array.
 * @param content - `Message.content` of a user, assistant or tool message.
 * @returns the visible text, or an empty string when there is none.
 */
export function contentText(content: unknown): string {
  const blocks = arrayOf(content)
  const parts: string[] = []
  for (const block of blocks) {
    const record = recordOf(block)
    if (record === undefined || record['type'] !== 'text') continue
    const text = textOf(record['text'])
    if (text !== undefined) parts.push(text)
  }
  return parts.join('\n')
}

/**
 * Read the `tools` schemas of one `request/header` event.
 * @param data - the event payload.
 * @returns the schema array, or an empty array.
 */
export function headerTools(data: unknown): readonly unknown[] {
  const header = recordOf(recordOf(data)?.['header'])
  return arrayOf(header?.['tools'])
}
