/**
 * Pure text projection and structure helpers for the additive prose gate.
 *
 * The prose gate has to answer a different question than the shipped tail test
 * did: *which* items of a trailing ask section are real asks, and what does each
 * one say? That needs block/list structure and Markdown projection, which must
 * be table-testable without any fold state, clock or log. Every helper here is a
 * pure `string → value` function; the gate (`prose.ts`) composes them.
 *
 * Markdown is **untrusted model output**: every projection here is a
 * conservative text rewrite (strip markers, keep the author's words); no HTML is
 * ever produced, and no content is invented.
 *
 * @module dsh-open-items/host/folds/prose-text
 */

/** Collapse every whitespace run to one space and trim. */
function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** One projected list item: its raw joined text and its Markdown-clean text. */
export interface ProseListBlock {
  /** Verbatim item text (block marker removed), continuation lines joined. */
  readonly raw: string
  /** {@link markdownToText} projection of {@link raw}. */
  readonly text: string
}

/** The author's label split off a list item (`A — …`, `(b) …`, `1) …`). */
export interface ProseLabelSplit {
  /** Single letter or number the author used as the item label, if any. */
  readonly label?: string
  /** The item text after the label, trimmed. */
  readonly body: string
}

/** One trailing ask section: its heading and the lines below it. */
export interface ProseAskSection {
  /** Heading text with `#`s, emphasis, numbering and punctuation stripped. */
  readonly heading: string
  /** Markdown heading level (`##` ⇒ 2). */
  readonly level: number
  /** Every line after the heading, in order (the section body). */
  readonly lines: readonly string[]
}

/** Questions-like heading: such a section carries questions, not decisions. */
const QUESTIONS_HEADING = /\b(?:questions?|asks?)\b/iu

/** Decisions-like heading: every listed item in it is a decision. */
const DECISIONS_HEADING = /\b(?:decisions?|confirmations?)\b|\bsign.?off\b|\byour call\b/iu

/** Ask/permission/choice cues that make one sentence ask-shaped. */
const STRONG_ASK = /\b(?:want me to|should (?:i|we|it|this|that)|shall (?:i|we)|would you like|do you want|let me know|your call|which (?:one|option|approach|of)|confirm|approve|pick|choose)\b/iu

/** Baseline verbs that make a *labelled* item under an ask heading an ask. */
const DECISION_VERB = /\b(?:recommend|propose|suggest|prefer|keep|add|reuse|introduce|ship|implement|refuse|allow|drop|leave|move|rename|choose|pick|should|want|or|vs\.?|versus)\b/iu

/** Auxiliary/wh words that open an interrogative sentence. */
const INTERROGATIVE_START = /^(?:is|are|was|were|do|does|did|should|shall|can|could|would|will|may|might|must|have|has|what|when|where|which|who|whom|whose|why|how)\b/iu

/** Question punctuation, incl. the full-width form. */
const QUESTION_END = /[?？]/u

/**
 * Remove fenced code blocks, including an unterminated trailing fence.
 *
 * A `?` inside a fence is sample code, not prose the agent is asking about, so
 * the fence is removed before any gate test. Backtick and tilde fences are both
 * recognised.
 * @param raw - assistant message text.
 * @returns the text with fenced regions replaced by one space.
 */
export function stripFencedBlocks(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/```[\s\S]*$/u, ' ')
    .replace(/~~~[\s\S]*?~~~/gu, ' ')
    .replace(/~~~[\s\S]*$/u, ' ')
}

/**
 * Project Markdown to plain text.
 *
 * Strips heading `#`s, list/quote markers, `**`/`*`/`_` emphasis, HTML tags and
 * link syntax (keeping the label), and inline-code backticks (keeping the
 * inner text), then collapses whitespace to one line. The author's words are
 * preserved verbatim apart from those markers.
 * @param text - Markdown (or plain) text.
 * @returns one-line plain text.
 */
export function markdownToText(text: string): string {
  let out = text.replace(/\r\n?/gu, '\n')
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gmu, '')
  out = out.replace(/^[ \t]*>[ \t]?/gmu, '')
  out = out.replace(/^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+/gmu, '')
  out = out.replace(/<!--[\s\S]*?-->/gu, ' ')
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
  out = out.replace(/\[([^\]]*)\]\[[^\]]*\]/gu, '$1')
  out = out.replace(/`+([^`]*)`+/gu, '$1')
  out = out.replace(/`/gu, '')
  out = out.replace(/<\/?[A-Za-z][^>]*>/gu, ' ')
  out = out.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/gu, '$1')
  out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/gu, '$1')
  out = out.replace(/(?<![A-Za-z0-9_])__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9_])/gu, '$1')
  out = out.replace(/(?<![A-Za-z0-9_*])\*(?=\S)([^*\n]*?\S)\*(?![A-Za-z0-9_*])/gu, '$1')
  out = out.replace(/(?<![A-Za-z0-9_])_(?=\S)([^_\n]*?\S)_(?![A-Za-z0-9_])/gu, '$1')
  out = out.replace(/\*\*+/gu, '')
  // A stripped inline tag can leave a space before the punctuation it preceded.
  return collapse(out).replace(/[ \t]+([,.;:!?])/gu, '$1')
}

/**
 * Split the author's leading item label off one list item.
 *
 * Recognises `**A** — body`, `A — body`, `A: body`, `(b) body`, `1) body`,
 * `1. body` and `- A — body`. Only a single letter or short number counts as a
 * label; a real word at the start of the item stays part of the body.
 * @param text - one projected item text.
 * @returns the label (when the author wrote one) and the remaining body.
 */
export function splitLabel(text: string): ProseLabelSplit {
  // A raw item may still carry its block marker (the contract names `- A — `);
  // listBlocks normally removes it, but splitLabel is also table-tested alone.
  const raw = text.trim().replace(/^[-*+][ \t]+/u, '')
  const patterns: readonly RegExp[] = [
    /^\*\*[ \t]*([A-Za-z0-9]{1,2})[ \t]*\*\*[ \t]*(?:[—–:-]+[ \t]*)?([\s\S]*)$/u,
    /^\([ \t]*([A-Za-z0-9]{1,2})[ \t]*\)[ \t]*(?:[—–:-]+[ \t]*)?([\s\S]*)$/u,
    /^([A-Za-z])[ \t]*[—–:][ \t]*([\s\S]*)$/u,
    /^([A-Za-z0-9]{1,2})[.)][ \t]+([\s\S]*)$/u,
    /^([A-Za-z0-9]{1,2})[ \t]+[—–-][ \t]+([\s\S]*)$/u,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(raw)
    const label = match?.[1]
    const body = match?.[2]?.trim()
    if (label === undefined || body === undefined || body === '') continue
    return { label, body }
  }
  return { body: raw }
}

/** A line starts a top-level list item; group 1 is its indentation, group 2 its text. */
const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,3}[.)])[ \t]+(.*)$/u

/**
 * Split lines into top-level list items with their continuations attached.
 *
 * The unit is the author's own list item: nested sub-bullets (more-indented than
 * the item that owns them) stay part of the parent and are never promoted to
 * their own item. A blank line ends the current item. Items are bounded to
 * {@link ProseListBlock.raw} 600 characters (word-bound).
 * @param lines - section body lines.
 * @returns the top-level blocks, in order.
 */
export function listBlocks(lines: readonly string[]): readonly ProseListBlock[] {
  const blocks: ProseListBlock[] = []
  let current: { readonly indent: number; readonly raw: string[] } | undefined
  const flush = (): void => {
    if (current === undefined) return
    const raw = truncateWords(current.raw.join('\n').trim(), 600)
    current = undefined
    if (raw === '') return
    blocks.push({ raw, text: markdownToText(raw) })
  }
  for (const line of lines) {
    const match = LIST_ITEM.exec(line)
    if (match !== null) {
      const indent = (match[1] ?? '').replace(/\t/gu, '    ').length
      if (current === undefined || indent <= current.indent) {
        flush()
        current = { indent, raw: [match[2] ?? ''] }
        continue
      }
      // A nested sub-bullet stays inside the parent item.
      current.raw.push(`${match[1] ?? ''}${match[2] ?? ''}`)
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    if (current === undefined) continue
    current.raw.push(line.trim())
  }
  flush()
  return blocks
}

/**
 * Strip a heading line's leading `#`s, emphasis, numbering and punctuation.
 * @param raw - heading text as written.
 * @returns the plain heading text.
 */
function headingTextOf(raw: string): string {
  let text = raw.trim()
  text = text.replace(/^[*_`\s]+/u, '')
  text = text.replace(/^\d{1,3}[.)][ \t]*/u, '')
  text = text.replace(/^[-–—:•*).\]]+[ \t]*/u, '')
  text = text.replace(/^[*_`\s]+/u, '')
  return text.trim()
}

/** One recognised markdown heading. */
interface ProseHeading {
  readonly index: number
  readonly level: number
  readonly text: string
}

/** The last markdown heading among the final 80 non-empty lines. */
function lastHeading(lines: readonly string[]): ProseHeading | undefined {
  const nonEmpty: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() !== '') nonEmpty.push(index)
  }
  const window = nonEmpty.slice(-80)
  let last: ProseHeading | undefined
  for (const index of window) {
    const match = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/u.exec(lines[index] ?? '')
    if (match === null) continue
    last = { index, level: (match[1] ?? '#').length, text: match[2] ?? '' }
  }
  return last
}

/**
 * Find the trailing ask section of one assistant message.
 *
 * Precision-first: the **last** heading in the final 80 non-empty lines must
 * itself be an ask heading. A heading word merely *containing* `decision`
 * (`### 10. A decision framework …`, `### From the tag/version decision …`) is
 * rejected, and so is any ask heading that a later section supersedes: the list
 * it introduces is then not presented as the turn's final answer.
 * @param lines - the message lines, in order.
 * @returns the section (heading text, level and all following lines) or undefined.
 */
export function findTrailingAskSection(lines: readonly string[]): ProseAskSection | undefined {
  const heading = lastHeading(lines)
  if (heading === undefined) return undefined
  const text = headingTextOf(heading.text)
  if (!/^(?:decisions?|questions?|asks?|open questions|your call|confirmations?|sign.?off)\b/iu.test(text)) {
    return undefined
  }
  return { heading: text, level: heading.level, lines: lines.slice(heading.index + 1) }
}

/** Find every `(a)`/`(1)`-style option marker with substantive following text. */
function optionMarkers(text: string): readonly { readonly label: string; readonly start: number; readonly end: number }[] {
  const markers: { label: string; start: number; end: number }[] = []
  const pattern = /\([ \t]*([a-dA-D]|\d)[ \t]*\)[ \t]*/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const label = match[1] ?? ''
    // A repeated label is a reference ("I recommend (a)"), not another option.
    if (markers.some(marker => marker.label.toLowerCase() === label.toLowerCase())) continue
    const after = text.slice(pattern.lastIndex)
    // "(1) + (2)" is cumulative work, not an alternative: the marker must
    // introduce prose, not punctuation.
    if (!/^[A-Za-z0-9"'`(]/u.test(after)) continue
    markers.push({ label, start: match.index, end: pattern.lastIndex })
    if (markers.length >= 4) break
  }
  return markers
}

/** Strip a trailing meta recommendation clause from one option's text. */
function stripRecommendation(text: string): string {
  let out = text.trim()
  out = out.replace(
    /\s+(?:I (?:recommend|lean|suggest|prefer|would recommend|would lean)\b|my recommendation\b|recommendation\b)[\s\S]*$/iu,
    '',
  )
  out = out.replace(/[,\s]+or$/iu, '')
  return out.trim().replace(/^[,\s]+|[,\s]+$/gu, '')
}

/** The explicit labelled alternatives of one item (`(a) … (b) …`). */
function labeledAlternatives(text: string): readonly string[] {
  const markers = optionMarkers(text)
  if (markers.length < 2) return []
  const options: string[] = []
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index]
    if (marker === undefined) break
    const end = markers[index + 1]?.start ?? text.length
    const body = stripRecommendation(text.slice(marker.end, end))
    // `(1) + (2)` leaves a one-character body; that is a reference, not an option.
    if (body.length < 2) return []
    options.push(truncateWords(`(${marker.label}) ${body}`, 200))
  }
  return options.length >= 2 ? options : []
}

/** A clean `either A or B` split, when both sides are short and single-clause. */
function eitherOrOptions(text: string): readonly string[] {
  const match = /\beither\s+([^.;!?]{3,120}?)\s+or\s+([^.;!?]{3,120})/iu.exec(text)
  if (match === null) return []
  const left = collapse(match[1] ?? '').replace(/[,\s]+$/u, '')
  const right = collapse(match[2] ?? '').replace(/[,\s]+$/u, '')
  if (left === '' || right === '') return []
  return [truncateWords(left, 200), truncateWords(right, 200)]
}

/**
 * Extract the explicit alternatives an ask presents, never fabricated ones.
 *
 * Only two shapes count: labelled options (`(a) … (b) …`, at most four) and one
 * clean `either A or B`. A yes/no question has no options here — the UI must
 * never show invented "Yes"/"No" buttons the author did not write.
 * @param rawItem - one projected item text.
 * @returns the options, or undefined when the item presents none.
 */
export function extractOptions(rawItem: string): readonly string[] | undefined {
  const text = collapse(rawItem)
  const labeled = labeledAlternatives(text)
  if (labeled.length >= 2) return labeled
  const either = eitherOrOptions(text)
  return either.length === 2 ? either : undefined
}

/** Whether the item presents explicit alternatives (the decision kind rule 1). */
function hasExplicitAlternatives(text: string): boolean {
  if (labeledAlternatives(text).length >= 2) return true
  if (eitherOrOptions(text).length === 2) return true
  if (/\b(?:choose|pick)\b/iu.test(text)) return true
  if (/\bwhich\s+(?:one|option|approach|of)\b/iu.test(text)) return true
  if (/(?:\bvs\.?\b|\bversus\b)/iu.test(text)) return true
  return /\S+\s+or\s+\S+/iu.test(text) && !/\bor not\b/iu.test(text)
}

/** Whether one text ends on a question mark (ASCII or full-width). */
export function endsWithQuestion(text: string): boolean {
  return QUESTION_END.test(text.trimEnd().slice(-1))
}

/** Whether one sentence is interrogative (question mark or aux/wh opening). */
function isInterrogative(text: string): boolean {
  const trimmed = text.trim()
  return endsWithQuestion(trimmed) || INTERROGATIVE_START.test(trimmed)
}

/**
 * Classify one ask into the phase-1 prose kinds.
 *
 * Precedence (contract §1.1): explicit alternatives ⇒ `decision`; a
 * questions-like heading ⇒ `question`; a decisions-like heading ⇒ `decision`;
 * an interrogative ⇒ `question`; anything else (imperative, `let me know …`) ⇒
 * `decision`. A yes/no permission ask stays `question` unless it presents
 * explicit alternatives — the prose gate never emits `approval` in phase 1.
 * @param body - the ask's own text.
 * @param heading - the ask section's heading text (`''` in the fallback path).
 * @returns the kind.
 */
export function classifyAsk(body: string, heading: string): 'decision' | 'question' {
  const text = collapse(body)
  if (hasExplicitAlternatives(text)) return 'decision'
  const headingText = collapse(heading)
  if (headingText !== '') {
    if (QUESTIONS_HEADING.test(headingText)) return 'question'
    if (DECISIONS_HEADING.test(headingText)) return 'decision'
  }
  if (isInterrogative(text)) return 'question'
  return 'decision'
}

/**
 * Whether one item inside a recognised ask section is itself an ask.
 *
 * Non-ask bullets ("Deliberately not done: …", context rows) are dropped from
 * the section. A labelled item that carries a decision/recommendation verb
 * counts too, so a terse "A — reuse settled." decision is not silently lost.
 * @param text - projected item text.
 * @param labelled - whether the author gave the item a label.
 * @returns true when the item is ask-like.
 */
export function isAskLike(text: string, labelled: boolean): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return false
  if (endsWithQuestion(trimmed)) return true
  if (STRONG_ASK.test(trimmed)) return true
  if (hasExplicitAlternatives(trimmed)) return true
  return labelled && DECISION_VERB.test(trimmed)
}

/**
 * Split text into sentences on terminal punctuation.
 * @param text - one line of prose.
 * @returns trimmed, non-empty sentences.
 */
export function sentencesOf(text: string): readonly string[] {
  return text
    .split(/(?<=[.!?。！？])\s+/u)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence !== '')
}

/**
 * The first sentence of one text (the whole text when it has no terminator).
 * @param text - one line of prose.
 * @returns the first sentence, trimmed.
 */
export function firstSentence(text: string): string {
  const normalized = collapse(text)
  if (normalized === '') return ''
  const match = /^([\s\S]*?[.!?。！？])(?:\s|$)/u.exec(normalized)
  const first = match?.[1] ?? normalized
  return first.trim()
}

/**
 * Truncate on a word/clause boundary with an ellipsis.
 *
 * Never splits a word, URL or inline-code span in half when a reasonable
 * boundary exists; falls back to a hard cut for one unbroken token.
 * @param text - source text.
 * @param max - maximum output length (including the ellipsis).
 * @returns the bounded text.
 */
export function truncateWords(text: string, max: number): string {
  const normalized = collapse(text)
  if (normalized.length <= max) return normalized
  if (max <= 1) return ''
  const slice = normalized.slice(0, max - 1)
  const boundary = Math.max(
    slice.lastIndexOf(' '),
    slice.lastIndexOf(','),
    slice.lastIndexOf(';'),
    slice.lastIndexOf(':'),
    slice.lastIndexOf('—'),
    slice.lastIndexOf('/'),
  )
  const cut = boundary > Math.floor(max * 0.5) ? slice.slice(0, boundary) : slice
  return `${cut.trimEnd()}…`
}
