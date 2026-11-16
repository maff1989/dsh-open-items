/**
 * Projection of untrusted prose (transcript markdown) into what the client may
 * show and say.
 *
 * The end-of-turn prose gate stores the matched sentence verbatim, which means a
 * candidate title/quote can carry the transcript's own markdown: a leading
 * `- ` bullet, `**A**` label emphasis, inline-code backticks, a `>` quote bar.
 * Printing that raw string is what made the Candidates tab read
 * `- **E** — Ship together …?` (D1) and what made a screen reader read the
 * metacharacters aloud (D12).
 *
 * Two pure functions own the projection:
 * - {@link toPlainText} returns one clean line for titles, `aria-label`s,
 *   tooltips, toasts and search keys.
 * - {@link renderProseOf} returns React nodes (strong/em/code, bullet lists) for
 *   prose that keeps its shape (a quote or a body), never HTML: React escapes
 *   the text, so there is no injection surface and no `dangerouslySetInnerHTML`.
 *
 * It deliberately mirrors the Host's `markdownToText` projection in spirit (one
 * implementation per half; no shared import across the client/host boundary is
 * possible here). Unmatched markers are kept visible, the same honesty rule the
 * shipped inline-code renderer follows.
 *
 * @module dsh-open-items/client/ui/prose-text
 */
import { Fragment, type ReactNode } from 'react'

/** Fenced code blocks, including an unterminated trailing fence. */
const FENCED = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu
/** HTML tags: the transcript may contain literal markup the prose layer must not honour. */
const HTML_TAG = /<\/?[a-z][^<>]*>/giu
/** Markdown images: keep the alt text, drop the URL. */
const IMAGE = /!\[([^\]]*)\]\([^)\s]*\)/gu
/** Markdown links: keep the label, drop the URL. */
const LINK = /\[([^\]]+)\]\([^)\s]*\)/gu
/** ATX heading marker at the start of a line. */
const HEADING = /^\s{0,3}#{1,6}\s+/u
/** Bullet or ordered-list marker at the start of a line. */
const BULLET = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/u
/** Blockquote marker at the start of a line. */
const BLOCKQUOTE = /^\s{0,3}>\s?/u
/** Balanced inline-code span, capturing the inner text. */
const INLINE_CODE = /`([^`]+)`/gu
/** Balanced emphasis (`*` or `_`) at word boundaries, so `file_name` survives. */
const EM = /(?<!\w)\*([^*\s](?:[^*]*[^*\s])?)\*(?!\w)|(?<!\w)_([^_\s](?:[^_]*[^_\s])?)_(?!\w)/gu

/** Collapse every run of whitespace to one space and trim. */
function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * Project transcript markdown into one plain-text line.
 *
 * Safe for `aria-label`, `title`, toast copy and search keys: no block markers,
 * no emphasis markers, no backticks, no HTML. Pure and idempotent.
 * @param markdown - the stored prose (possibly containing markdown).
 * @returns the display/announcement text.
 */
export function toPlainText(markdown: string): string {
  if (markdown === '') return ''
  let text = markdown.replace(/\r\n?/gu, '\n')
  text = text.replace(FENCED, ' ')
  text = text.replace(HTML_TAG, ' ')
  text = text.replace(IMAGE, '$1')
  text = text.replace(LINK, '$1')
  // Line-anchored markers first: a title may be a single bullet/heading/quote.
  text = text
    .split('\n')
    .map(line => line.replace(HEADING, '').replace(BULLET, '').replace(BLOCKQUOTE, ''))
    .join(' ')
  text = text.replace(INLINE_CODE, '$1')
  // Strong before emphasis so `**a**` does not leave a stray `*`; the inner
  // group may itself carry emphasis (`**bold *em* text**`), which the next pass
  // projects away.
  text = text.replace(/\*\*([\s\S]+?)\*\*/gu, '$1')
  text = text.replace(/__([\s\S]+?)__/gu, '$1')
  text = text.replace(EM, (_match, star: string | undefined, underscore: string | undefined) => star ?? underscore ?? '')
  return collapse(text)
}

/**
 * Compare two pieces of prose by their projected content.
 *
 * The gate derives a candidate's title from its own quote, so the two are
 * usually the same sentence; the client suppresses the duplicate render when
 * this returns true.
 * @param left - one prose string.
 * @param right - another prose string.
 * @returns true when both project to the same display text.
 */
export function sameProse(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false
  return toPlainText(left).toLocaleLowerCase() === toPlainText(right).toLocaleLowerCase()
}

/** One block of projected prose: a bullet list item or a paragraph line. */
interface ProseBlock {
  readonly bullet: boolean
  readonly text: string
}

/** Split markdown into display blocks, honouring fences and list markers. */
function blocksOf(markdown: string): ProseBlock[] {
  const blocks: ProseBlock[] = []
  let fenced = false
  for (const rawLine of markdown.replace(/\r\n?/gu, '\n').split('\n')) {
    if (/^\s{0,3}(?:```|~~~)/u.test(rawLine)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const withoutHtml = rawLine.replace(HTML_TAG, ' ')
    const bullet = BULLET.test(withoutHtml)
    const text = withoutHtml.replace(HEADING, '').replace(BULLET, '').replace(BLOCKQUOTE, '')
    if (collapse(text) === '') continue
    blocks.push({ bullet, text })
  }
  return blocks
}

/** Inline token pattern; strong/em bodies are projected recursively below. */
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\[([^\]]+)\]\([^)\s]*\)|(?<!\w)\*([^*\s](?:[^*]*[^*\s])?)\*(?!\w)|(?<!\w)_([^_\s](?:[^_]*[^_\s])?)_(?!\w)/gu

/**
 * Project one line of inline markdown to React nodes.
 * @param text - line content with block markers already stripped.
 * @param keyPrefix - stable key prefix for the produced nodes.
 * @returns nodes; React escapes every text child.
 */
function inlineNodes(text: string, keyPrefix: string): ReactNode {
  const nodes: ReactNode[] = []
  let last = 0
  let index = 0
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0
    if (at > last) nodes.push(<Fragment key={`${keyPrefix}-t${String(index)}`}>{text.slice(last, at)}</Fragment>)
    const key = `${keyPrefix}-i${String(index)}`
    const code = match[1]
    const strong = match[2] ?? match[3]
    const link = match[4]
    const em = match[5] ?? match[6]
    if (code !== undefined) {
      nodes.push(<code key={key} className="dsh-oi-inlineCode">{code}</code>)
    } else if (strong !== undefined) {
      nodes.push(<strong key={key}>{inlineNodes(strong, key)}</strong>)
    } else if (link !== undefined) {
      // A link keeps its label but is not made clickable: the URL is transcript
      // data, not a navigation the client vouches for.
      nodes.push(<Fragment key={key}>{link}</Fragment>)
    } else if (em !== undefined) {
      nodes.push(<em key={key}>{inlineNodes(em, key)}</em>)
    }
    last = at + match[0].length
    index += 1
  }
  if (last < text.length) nodes.push(<Fragment key={`${keyPrefix}-tail`}>{text.slice(last)}</Fragment>)
  return nodes.length === 1 ? nodes[0] : nodes
}

/**
 * Render prose with its inline shape (strong/em/code) and bullet lines.
 *
 * Degrades to plain text for a single line with no list markers, so simple
 * titles cost one text node. Never injects HTML.
 * @param markdown - the stored prose.
 * @returns React nodes for the prose.
 */
export function renderProseOf(markdown: string): ReactNode {
  if (markdown === '') return null
  const blocks = blocksOf(markdown)
  if (blocks.length === 0) return null
  if (blocks.length === 1 && blocks[0]?.bullet !== true) {
    return <span className="dsh-oi-prose" dir="auto">{inlineNodes(blocks[0]?.text ?? '', 'p')}</span>
  }
  const rendered: ReactNode[] = []
  let list: ReactNode[] = []
  let listIndex = 0
  const flushList = (): void => {
    if (list.length === 0) return
    rendered.push(
      <ul key={`ul-${String(listIndex)}`} className="dsh-oi-proseList">
        {list}
      </ul>,
    )
    list = []
    listIndex += 1
  }
  for (const [index, block] of blocks.entries()) {
    if (block.bullet) {
      list.push(<li key={`li-${String(index)}`}>{inlineNodes(block.text, `l${String(index)}`)}</li>)
      continue
    }
    flushList()
    rendered.push(<p key={`p-${String(index)}`} className="dsh-oi-prose">{inlineNodes(block.text, `p${String(index)}`)}</p>)
  }
  flushList()
  return <div className="dsh-oi-proseBlock" dir="auto">{rendered}</div>
}
