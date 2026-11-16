// @vitest-environment jsdom
/**
 * The prose projection layer: transcript markdown must never reach a title,
 * an aria string or a toast raw, and prose that keeps its shape renders as React
 * nodes (never HTML).
 */
import { afterEach, describe, expect, it } from 'vitest'

import { cleanup, render } from '@testing-library/react'

import { renderProseOf, sameProse, toPlainText } from '../../src/client/ui/prose-text'

afterEach(cleanup)

/** The exact stored candidate title/quote (research/prose-audit scratch fixture). */
const STORED_TITLE = '- **E** — Ship together as one PR/branch or two (host semantics vs card client)?'

describe('toPlainText', () => {
  it('projects the stored candidate row to one clean line', () => {
    expect(toPlainText(STORED_TITLE)).toBe('E — Ship together as one PR/branch or two (host semantics vs card client)?')
  })

  it('strips heading markers, bullet markers and ordered-list markers', () => {
    expect(toPlainText('## Decisions I need from you')).toBe('Decisions I need from you')
    expect(toPlainText('- keep the five colours')).toBe('keep the five colours')
    expect(toPlainText('1. `git reflog expire` first')).toBe('git reflog expire first')
    expect(toPlainText('(b) two PRs')).toBe('(b) two PRs')
  })

  it('keeps inline-code inner text and drops the backticks', () => {
    expect(toPlainText('Run `npx vitest` before pushing')).toBe('Run npx vitest before pushing')
  })

  it('projects nested emphasis and links/images to their labels', () => {
    expect(toPlainText('**bold *em* text**')).toBe('bold em text')
    expect(toPlainText('See the [design spec](https://example.com/spec) first')).toBe('See the design spec first')
    expect(toPlainText('![the diagram](./diagram.png) shows the flow')).toBe('the diagram shows the flow')
  })

  it('drops HTML tags but keeps their text (there is no HTML surface)', () => {
    expect(toPlainText('<b>allow</b> once')).toBe('allow once')
    expect(toPlainText('<script>alert(1)</script>')).toBe('alert(1)')
  })

  it('removes fenced blocks, including an unterminated trailing fence', () => {
    expect(toPlainText('before\n```ts\nconst x = 1\n```\nafter')).toBe('before after')
    expect(toPlainText('before\n```ts\nconst x = 1')).toBe('before')
  })

  it('keeps an identifier underscore intact and leaves an unmatched marker visible', () => {
    expect(toPlainText('ship file_name now')).toBe('ship file_name now')
    expect(toPlainText('a stray ` tick')).toBe('a stray ` tick')
  })

  it('collapses whitespace, trims, and is idempotent', () => {
    const once = toPlainText('  - **E** —   Ship\n  together?  ')
    expect(once).toBe('E — Ship together?')
    expect(toPlainText(once)).toBe(once)
  })

  it('returns an empty string for empty prose', () => {
    expect(toPlainText('')).toBe('')
  })
})

describe('sameProse', () => {
  it('treats a candidate title and its own quote as the same sentence', () => {
    expect(sameProse(STORED_TITLE, STORED_TITLE)).toBe(true)
    expect(sameProse('**E** — Ship?', 'E — Ship?')).toBe(true)
  })

  it('keeps genuinely different prose apart', () => {
    expect(sameProse('Also update the docs?', 'Want me to also update the docs?')).toBe(false)
    expect(sameProse(undefined, 'x')).toBe(false)
  })
})

describe('renderProseOf', () => {
  it('renders inline emphasis and code as React nodes', () => {
    const { container } = render(<div>{renderProseOf('**bold** _em_ and `code`')}</div>)
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    expect(container.querySelector('em')?.textContent).toBe('em')
    expect(container.querySelector('code')?.textContent).toBe('code')
  })

  it('renders bullet lines as a list, keeping labels', () => {
    const { container } = render(<div>{renderProseOf('- **A** — one\n- **B** — two')}</div>)
    const items = [...container.querySelectorAll('li')]
    expect(items.map(item => item.textContent)).toEqual(['A — one', 'B — two'])
  })

  it('never injects HTML: markup arrives as escaped text, not elements', () => {
    const { container } = render(<div>{renderProseOf('<script>alert(1)</script> <img src=x onerror=alert(2)>')}</div>)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent ?? '').toContain('alert(1)')
  })

  it('marks model prose with dir="auto" for bidi safety', () => {
    const { container } = render(<div>{renderProseOf('mixed עברית prose')}</div>)
    expect(container.querySelector('[dir="auto"]')).toBeTruthy()
  })

  it('renders nothing for empty prose', () => {
    expect(renderProseOf('')).toBeNull()
  })
})
