/**
 * Snapshot/record merge: which read wins, what a settled record renders, and
 * the answerability rules the card reads before offering controls.
 */
import { describe, expect, it } from 'vitest'

import type { CardItemView } from '../../../src/client/ui/card/meta'
import {
  clockLabel,
  effectiveItem,
  indexRecords,
  isAnswerableState,
  resolutionAnswerText,
  resolvedElsewhere,
} from '../../../src/client/ui/card/items'
import { makeItem } from '../fixtures'

/** One normalized card row at the raise snapshot's version. */
function view(overrides: Partial<CardItemView> = {}): CardItemView {
  return {
    id: 'item-1',
    kind: 'decision',
    state: 'open',
    title: 'Which registry?',
    detailPreview: 'Snapshot body.',
    options: ['Corporate'],
    blocking: true,
    version: 1,
    sessionId: 'session-1',
    callId: 'call-1',
    reply: { controls: ['option'], options: ['Corporate'], freeText: false, requiresConfirm: false },
    ...overrides,
  }
}

describe('effectiveItem', () => {
  it('keeps the raise snapshot when nothing hydrated', () => {
    const item = effectiveItem(view(), undefined)
    expect(item.fromRecord).toBe(false)
    expect(item.version).toBe(1)
    expect(item.state).toBe('open')
    expect(item.title).toBe('Which registry?')
  })

  it('prefers the newer durable record', () => {
    const record = makeItem({ version: 4, state: 'resolved', title: 'Which registry (settled)?' })
    const item = effectiveItem(view(), record)
    expect(item.fromRecord).toBe(true)
    expect(item.version).toBe(4)
    expect(item.state).toBe('resolved')
    expect(item.title).toBe('Which registry (settled)?')
  })

  it('ignores a record older than the snapshot', () => {
    const record = makeItem({ version: 0 })
    const item = effectiveItem(view({ version: 2 }), record)
    expect(item.fromRecord).toBe(false)
    expect(item.version).toBe(2)
  })

  it('carries a newer record resolution but not an older one', () => {
    const resolution = {
      kind: 'answered' as const,
      at: 9_000,
      actor: 'user' as const,
      payload: { type: 'option' as const, option: 'Corporate' },
      deliveryId: 'd-1',
    }
    const newer = makeItem({ version: 5, state: 'resolved', resolution })
    expect(effectiveItem(view(), newer).resolution).toEqual(resolution)
    const older = makeItem({ version: 0, resolution })
    // A stale record must not override the snapshot's state; the snapshot wins.
    expect(effectiveItem(view({ version: 3 }), older).fromRecord).toBe(false)
  })

  it('reads the record body as the detail preview', () => {
    const record = makeItem({ version: 2, body: 'Line one\nline two' })
    expect(effectiveItem(view(), record).detailPreview).toBe('Line one line two')
  })
})

describe('record reads', () => {
  it('indexes records by id', () => {
    const index = indexRecords([makeItem(), makeItem({ id: 'item-2' })])
    expect(index.get('item-1')?.id).toBe('item-1')
    expect(index.get('item-2')?.id).toBe('item-2')
    expect(index.get('missing')).toBeUndefined()
  })

  it('decides answerability from the lifecycle state', () => {
    expect(isAnswerableState('open')).toBe(true)
    expect(isAnswerableState('snoozed')).toBe(true)
    for (const state of ['awaiting', 'stale', 'archived', 'resolved'] as const) {
      expect(isAnswerableState(state)).toBe(false)
    }
  })

  it('reads the verbatim answer of option and text resolutions only', () => {
    expect(resolutionAnswerText(undefined)).toBeUndefined()
    expect(resolutionAnswerText({
      kind: 'answered', at: 1, actor: 'user', payload: { type: 'option', option: 'Corporate' },
    })).toBe('Corporate')
    expect(resolutionAnswerText({
      kind: 'answered', at: 1, actor: 'user', payload: { type: 'text', text: ' Typed answer ' },
    })).toBe(' Typed answer ')
    expect(resolutionAnswerText({
      kind: 'answered', at: 1, actor: 'user', payload: { type: 'approval', outcome: 'allow-once' },
    })).toBeUndefined()
    expect(resolutionAnswerText({
      kind: 'dismissed', at: 1, actor: 'user', payload: { type: 'dismiss' },
    })).toBeUndefined()
    expect(resolutionAnswerText({
      kind: 'detected-closed', at: 1, actor: 'detector', payload: { type: 'detector', code: 'tool-result' },
    })).toBeUndefined()
  })

  it('distinguishes an inbox resolution from a card resolution by delivery id', () => {
    expect(resolvedElsewhere({
      kind: 'answered', at: 1, actor: 'user', payload: { type: 'text', text: 'x' }, deliveryId: 'd-1',
    })).toBe(false)
    expect(resolvedElsewhere({
      kind: 'answered', at: 1, actor: 'user', payload: { type: 'text', text: 'x' },
    })).toBe(true)
    expect(resolvedElsewhere(undefined)).toBe(false)
  })
})

describe('clockLabel', () => {
  it('renders a short clock label and nothing for absent values', () => {
    expect(clockLabel(undefined)).toBe('')
    expect(clockLabel(0)).toBe('')
    expect(clockLabel(Number.NaN)).toBe('')
    expect(clockLabel(1_000)).toMatch(/\d/u)
  })
})
