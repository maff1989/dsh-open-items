import { describe, expect, it } from 'vitest'

import {
  deriveInboxView,
  isNeedsYou,
  needsYouCountInvariant,
} from '../../src/client/derive/inbox-view'
import { INITIAL_FILTERS } from '../../src/client/data/page-store'
import { makeItem, makeSnapshot, makeWorkspaceRow } from './fixtures'

/** An item shaped by explicit state/tier/severity overrides. */
function item(overrides: Parameters<typeof makeItem>[0]): ReturnType<typeof makeItem> {
  return makeItem({ source: { sessionId: 's1' }, ...overrides })
}

describe('locked counts predicate', () => {
  it('counts only structural open/stale severity 1-2 items that are not deleted', () => {
    expect(isNeedsYou(item({ id: 'open', state: 'open', tier: 'structural', severity: 1 }))).toBe(true)
    expect(isNeedsYou(item({ id: 'stale', state: 'stale', tier: 'structural', severity: 2 }))).toBe(true)
    expect(isNeedsYou(item({ id: 'awaiting', state: 'awaiting', tier: 'structural', severity: 1 }))).toBe(false)
    expect(isNeedsYou(item({ id: 'candidate', state: 'open', tier: 'candidate', severity: 1 }))).toBe(false)
    expect(isNeedsYou(item({ id: 'sev3', state: 'open', tier: 'structural', severity: 3 }))).toBe(false)
    expect(isNeedsYou(item({ id: 'snoozed', state: 'snoozed', tier: 'structural', severity: 1 }))).toBe(false)
    expect(isNeedsYou(item({ id: 'deleted', state: 'open', tier: 'structural', severity: 1, deletedAt: 1 }))).toBe(false)
  })

  it('makes the pill equal the workspace facet sum plus Ungrouped', () => {
    const items = [
      item({ id: 'a', source: { sessionId: 's1', workspace: { workspaceId: 'w1', title: 'Hookshot' } } }),
      item({ id: 'b', source: { sessionId: 's2', workspace: { workspaceId: 'w2', title: 'NX2navi' } } }),
      item({ id: 'c', source: { sessionId: 's3' } }),
      item({ id: 'candidate', tier: 'candidate' }),
      item({ id: 'awaiting', state: 'awaiting' }),
    ]
    const snapshot = makeSnapshot(items, {
      counts: { needsYou: 3, candidates: 1, awaiting: 1, snoozed: 0, resolved: 0, newSinceLastVisit: 0, earlierRecordsPruned: false },
      workspaces: [
        makeWorkspaceRow({ workspaceId: 'w1', title: 'Hookshot', itemCount: 1 }),
        makeWorkspaceRow({ workspaceId: 'w2', title: 'NX2navi', itemCount: 1 }),
        makeWorkspaceRow({ workspaceId: undefined, title: 'Ungrouped', itemCount: 1 }),
      ],
    })
    const view = deriveInboxView(snapshot, INITIAL_FILTERS)
    expect(needsYouCountInvariant(snapshot, view)).toEqual({ pill: 3, facets: 3 })
    expect(view.items.map(entry => entry.id)).toEqual(['a', 'b', 'c'])
  })
})
