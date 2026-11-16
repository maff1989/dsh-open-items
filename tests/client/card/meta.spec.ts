/**
 * Card-contract parser: every shape the durable log can replay must either
 * produce a bounded card or a *legacy* result — never an exception.
 */
import { describe, expect, it } from 'vitest'

import { LIMITS } from '../../../src/shared/protocol'
import { cardEn } from '../../../src/client/ui/card/card-locales'
import {
  parseCardMeta,
  recordedErrorText,
  recordedSummary,
  CARD_KIND_LABEL,
  type CardItemView,
} from '../../../src/client/ui/card/meta'

/** One valid wire card item (the host's `toCardItems` shape). */
function wireItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'item-1',
    kind: 'decision',
    state: 'open',
    title: 'Which registry?',
    detailPreview: 'The agent needs a choice.',
    options: ['Corporate', 'Public npm'],
    blocking: true,
    version: 3,
    sessionId: 'session-1',
    callId: 'call-1',
    reply: { controls: ['option'], options: ['Corporate', 'Public npm'], freeText: false, requiresConfirm: false },
    ...overrides,
  }
}

/** One valid v1 card payload. */
function wireMeta(items: readonly unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, items, total: items.length, truncated: false, ...overrides }
}

describe('parseCardMeta', () => {
  it('reads a v1 payload into one card row', () => {
    const parsed = parseCardMeta(wireMeta([wireItem()]))
    expect(parsed.kind).toBe('card')
    if (parsed.kind !== 'card') return
    expect(parsed.total).toBe(1)
    expect(parsed.hidden).toBe(0)
    expect(parsed.items).toHaveLength(1)
    const item = parsed.items[0] as CardItemView
    expect(item).toMatchObject({
      id: 'item-1',
      kind: 'decision',
      state: 'open',
      title: 'Which registry?',
      version: 3,
      sessionId: 'session-1',
      callId: 'call-1',
      blocking: true,
    })
    expect(item.reply.controls).toEqual(['option'])
    expect(item.reply.options).toEqual(['Corporate', 'Public npm'])
  })

  it('treats absent, unreadable, older and malformed payloads as legacy', () => {
    expect(parseCardMeta(undefined)).toEqual({ kind: 'legacy', reason: 'absent' })
    expect(parseCardMeta(null)).toEqual({ kind: 'legacy', reason: 'absent' })
    expect(parseCardMeta('card')).toEqual({ kind: 'legacy', reason: 'shape' })
    expect(parseCardMeta({ v: 0, items: [] })).toEqual({ kind: 'legacy', reason: 'version' })
    expect(parseCardMeta({ v: 2, items: [] })).toEqual({ kind: 'legacy', reason: 'version' })
    expect(parseCardMeta({ v: 1 })).toEqual({ kind: 'legacy', reason: 'shape' })
    expect(parseCardMeta({ v: 1, items: 'nope' })).toEqual({ kind: 'legacy', reason: 'shape' })
    expect(parseCardMeta(wireMeta([]))).toEqual({ kind: 'legacy', reason: 'shape' })
    expect(parseCardMeta(wireMeta([null, 42, { id: 1 }]))).toEqual({ kind: 'legacy', reason: 'shape' })
  })

  it('caps the printed rows at five and reports the hidden remainder', () => {
    const items = Array.from({ length: 8 }, (_, index) => wireItem({ id: `item-${index}`, title: `Item ${index}` }))
    const parsed = parseCardMeta(wireMeta(items, { total: 8, truncated: true }))
    expect(parsed.kind).toBe('card')
    if (parsed.kind !== 'card') return
    expect(parsed.items).toHaveLength(LIMITS.cardMaxItems)
    expect(parsed.total).toBe(8)
    expect(parsed.hidden).toBe(8 - LIMITS.cardMaxItems)
    expect(parsed.truncated).toBe(true)
  })

  it('never reports fewer printed rows than it has', () => {
    const parsed = parseCardMeta(wireMeta([wireItem(), wireItem({ id: 'item-2' })], { total: 1 }))
    expect(parsed.kind).toBe('card')
    if (parsed.kind !== 'card') return
    expect(parsed.total).toBe(2)
    expect(parsed.hidden).toBe(0)
  })

  it('narrows hostile field values instead of trusting them', () => {
    const parsed = parseCardMeta(wireMeta([wireItem({
      kind: 'nonsense',
      state: 'exploded',
      version: -4,
      detailPreview: 42,
      options: ['ok', 7, '', 'fine'],
      callId: 0,
      reply: { controls: ['option', 'bogus', 'approve'], options: [''], freeText: 'yes', requiresConfirm: true, note: '' },
    })]))
    expect(parsed.kind).toBe('card')
    if (parsed.kind !== 'card') return
    const item = parsed.items[0] as CardItemView
    expect(item.kind).toBe('unknown')
    expect(item.state).toBe('open')
    expect(item.version).toBe(0)
    expect(item.detailPreview).toBeUndefined()
    expect(item.options).toEqual(['ok', 'fine'])
    expect(item.callId).toBeUndefined()
    expect(item.reply.controls).toEqual(['option', 'approve'])
    expect(item.reply.options).toEqual(['ok', 'fine'])
    expect(item.reply.freeText).toBe(false)
    expect(item.reply.requiresConfirm).toBe(true)
    expect(item.reply.note).toBeUndefined()
  })

  it('bounds titles and detail previews without splitting them mid-word artefact', () => {
    const long = 'x'.repeat(LIMITS.cardDetailPreviewChars * 2)
    const parsed = parseCardMeta(wireMeta([wireItem({ title: `  ${long}  `, detailPreview: long })]))
    if (parsed.kind !== 'card') throw new Error('expected a card')
    expect(parsed.items[0]?.detailPreview?.length).toBeLessThanOrEqual(LIMITS.cardDetailPreviewChars)
    expect(parsed.items[0]?.detailPreview?.endsWith('…')).toBe(true)
  })
})

describe('recorded fallback material', () => {
  it('summarizes the first text block and collapses whitespace', () => {
    const block = { content: [{ type: 'reasoning', text: 'skip' }, { type: 'text', text: '  Raised one item.\nmore  ' }] }
    expect(recordedSummary(block)).toBe('Raised one item. more')
  })

  it('prefers the error reason for a failed result', () => {
    expect(recordedErrorText({ isError: true, error: { reason: '  the store refused  ' } })).toBe('the store refused')
    expect(recordedErrorText({ isError: true, content: [{ type: 'text', text: 'fallback text' }] })).toBe('fallback text')
    expect(recordedErrorText({ isError: true })).toBeUndefined()
  })
})

describe('card copy coverage', () => {
  it('labels every known kind and the unknown bucket', () => {
    const keys = Object.values(CARD_KIND_LABEL)
    for (const key of keys) expect(cardEn[key]).toBeTruthy()
    expect(new Set(keys).size).toBe(keys.length)
  })
})
