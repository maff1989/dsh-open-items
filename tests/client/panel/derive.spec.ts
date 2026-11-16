/**
 * Section, filter, count and control-model derivations of the panel.
 *
 * Pure functions only: no DOM, no transport. These are the rules UI.md §7.2-§7.3
 * states, and every DOM assertion in `panel.spec.tsx` leans on them.
 */
import { describe, expect, it } from 'vitest'

import {
  PANEL_ROW_LIMIT,
  choiceModelOf,
  compareNeedsYou,
  derivePanelSections,
  derivePanelView,
  dotStateOf,
  isHandoffOnly,
  isToolRaised,
  panelControlOf,
  rowActionKeyOf,
} from '../../../src/client/ui/panel/derive'
import { makeItem } from '../fixtures'
import {
  candidateItem,
  liveAsk,
  optionReply,
  resolvedItem,
  textReply,
  toolItem,
  waitingItem,
} from './helpers'

describe('panel section derivation', () => {
  it('splits needs-you, waiting and leaves snoozed to the inbox', () => {
    const sections = derivePanelSections(
      [toolItem({ id: 'a' }), waitingItem({ id: 'b' }), makeItem({ id: 'c', state: 'snoozed' }), resolvedItem({ id: 'd' })],
      'all',
    )
    expect(sections.needsYou.map(item => item.id)).toEqual(['a'])
    expect(sections.waiting.map(item => item.id)).toEqual(['b'])
    expect(sections.counts).toEqual({ needsYou: 1, waiting: 1, open: 2, candidates: 0 })
  })

  it('keeps one meaning of Needs you: severity 1|2 structural only, by severity then oldest', () => {
    const lowSeverityOld = toolItem({ id: 'old-3', severity: 3, firstSeenAt: 1 })
    const urgent = toolItem({ id: 'urgent-1', severity: 1, firstSeenAt: 9 })
    const candidate = candidateItem({ id: 'candidate', firstSeenAt: 0 })
    const sections = derivePanelSections([lowSeverityOld, candidate, urgent], 'all')
    // Severity-3 FYI and candidates are not the panel's "Needs you" — the page
    // owns the FYI group and the Candidates tab (round-3 decision). The
    // candidate is still counted for the "Inferred (N)" handoff row.
    expect(sections.needsYou.map(item => item.id)).toEqual(['urgent-1'])
    expect(sections.counts).toEqual({ needsYou: 1, waiting: 0, open: 1, candidates: 1 })
    expect(sections.candidateCount).toBe(1)
  })

  it('keeps the comparator stable for equal rows', () => {
    const left = toolItem({ id: 'a' })
    const right = toolItem({ id: 'b' })
    expect(compareNeedsYou(left, right)).toBeLessThan(0)
    expect(compareNeedsYou(right, left)).toBeGreaterThan(0)
  })

  it('filters a single section without changing the counts', () => {
    const items = [toolItem({ id: 'a' }), waitingItem({ id: 'b' }), candidateItem({ id: 'c' })]
    const onlyWaiting = derivePanelSections(items, 'waiting')
    expect(onlyWaiting.showWaiting).toBe(true)
    expect(onlyWaiting.showNeedsYou).toBe(false)
    expect(onlyWaiting.counts).toEqual({ needsYou: 1, waiting: 1, open: 2, candidates: 1 })
    const onlyNeedsYou = derivePanelSections(items, 'needs-you')
    expect(onlyNeedsYou.showNeedsYou).toBe(true)
    expect(onlyNeedsYou.showWaiting).toBe(false)
  })

  it('caps each list and reports truncation', () => {
    const many = Array.from({ length: PANEL_ROW_LIMIT + 5 }, (_, index) => toolItem({ id: `i-${String(index)}` }))
    const sections = derivePanelSections(many, 'all')
    expect(sections.needsYou).toHaveLength(PANEL_ROW_LIMIT)
    expect(sections.truncated).toBe(true)
  })

  it('merges the register page into the view with its own total', () => {
    const view = derivePanelView([toolItem()], [resolvedItem(), resolvedItem({ id: 'r2' })], 7, 'all')
    expect(view.resolved.map(item => item.id)).toEqual(['item-resolved', 'r2'])
    expect(view.resolvedTotal).toBe(7)
  })
})

describe('panel non-duplication rule', () => {
  it('marks a tool-raised item answerable', () => {
    expect(isToolRaised(toolItem())).toBe(true)
    expect(panelControlOf(toolItem())).toEqual('answerable')
    expect(choiceModelOf(toolItem())).toEqual({ kind: 'options', options: ['Corporate registry', 'Public registry'] })
  })

  it('never renders an answer surface for a live shipped ask', () => {
    expect(isHandoffOnly(liveAsk())).toBe(true)
    expect(panelControlOf(liveAsk())).toEqual('handoff')
    expect(choiceModelOf(liveAsk())).toEqual({ kind: 'none' })
  })

  it('keeps candidates, waiting rows and task rows read-only', () => {
    expect(panelControlOf(candidateItem())).toEqual('readonly')
    expect(panelControlOf(waitingItem())).toEqual('readonly')
    const task = toolItem({ kind: 'task', reply: { controls: [], freeText: false, requiresConfirm: false } })
    expect(panelControlOf(task) === 'readonly' || panelControlOf(task) === 'answerable').toBe(true)
    const terse = makeItem({ kind: 'task', detectedBy: ['projection'], source: { sessionId: 'session-1' } })
    expect(panelControlOf(terse)).toEqual('readonly')
  })

  it('treats a tool item with no controls as read-only', () => {
    const bare = toolItem({ reply: { controls: [], freeText: false, requiresConfirm: false } })
    expect(panelControlOf(bare)).toEqual('readonly')
  })

  it('maps choices: approval, options, text', () => {
    const approval = toolItem({
      kind: 'approval',
      reply: { controls: ['approve', 'deny'], freeText: false, requiresConfirm: false },
    })
    expect(choiceModelOf(approval)).toEqual({ kind: 'approval' })
    expect(choiceModelOf(toolItem({ reply: textReply() }))).toEqual({ kind: 'text' })
    const many = toolItem({ reply: optionReply(['a', 'b', 'c', 'd']) })
    expect(choiceModelOf(many)).toEqual({ kind: 'options', options: ['a', 'b', 'c', 'd'] })
  })

  it('labels the context action per row class and seam availability', () => {
    expect(rowActionKeyOf('handoff', liveAsk(), true)).toEqual('panel.action.answerInChat')
    expect(rowActionKeyOf('handoff', liveAsk(), false)).toEqual('panel.action.openInbox')
    expect(rowActionKeyOf('answerable', toolItem(), false)).toEqual('panel.action.showInChat')
    expect(rowActionKeyOf('readonly', resolvedItem(), false)).toEqual('panel.action.openInbox')
  })

  it('tones the dot by state and tier', () => {
    expect(dotStateOf(toolItem({ severity: 1 }))).toEqual('warning')
    expect(dotStateOf(toolItem({ severity: 2 }))).toEqual('idle')
    expect(dotStateOf(waitingItem())).toEqual('ongoing')
    expect(dotStateOf(resolvedItem())).toEqual('done')
    expect(dotStateOf(candidateItem())).toEqual('idle')
  })
})


describe('show more cap', () => {
  it('honours an explicit section cap for Show more', () => {
    const items = [toolItem(), toolItem({ id: 'b' }), toolItem({ id: 'c' })]
    const capped = derivePanelSections(items, 'all', 2)
    expect(capped.needsYou).toHaveLength(2)
    expect(capped.truncated).toBe(true)
    const full = derivePanelSections(items, 'all')
    expect(full.needsYou).toHaveLength(3)
    expect(full.truncated).toBe(false)
  })
})
