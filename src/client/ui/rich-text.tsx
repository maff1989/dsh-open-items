/**
 * Minimal inline-code rendering for item prose.
 *
 * Item bodies are plain text captured from a transcript: a command such as
 * `git reflog expire` is stored with its backticks. Register rows already render
 * those as `<code>`; the detail pane printed the backticks literally. This
 * splitter wraps balanced backtick spans in a code element and leaves everything
 * else as text, so React escapes the content (no HTML injection surface).
 *
 * @module dsh-open-items/client/ui/rich-text
 */
import { Fragment, type ReactNode } from 'react'

/** One backtick-delimited span, capturing the inner text. */
const INLINE_CODE = /(`[^`]+`)/g

/**
 * Split plain text into text and inline-code nodes.
 * @param text - the stored prose.
 * @returns React nodes, honest backticks still visible in unmatched pairs.
 */
export function renderRichText(text: string): ReactNode {
  if (!text.includes('`')) return text
  const parts = text.split(INLINE_CODE)
  return parts.map((part, index) => (
    part.startsWith('`') && part.endsWith('`') && part.length > 2
      ? <code key={index} className="dsh-oi-inlineCode">{part.slice(1, -1)}</code>
      : <Fragment key={index}>{part}</Fragment>
  ))
}
