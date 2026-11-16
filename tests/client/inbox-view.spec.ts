/**
 * Pure derivations of the inbox page: section filtering, grouping, the
 * workspace facet and the count invariant the design requires.
 */
import { describe, expect, it } from 'vitest'

import {
  compareItems,
  deriveInboxView,
  deriveWorkspaceFacets,
  groupBySession,
  groupByWorkspace,
  isFyi,
  itemsForTab,
  tabCounts,
  workspaceCountInvariant,
  workspaceKeyOf,
} from '../../src/client/derive/inbox-view'
import { ALL_WORKSPACES, UNGROUPED_WORKSPACE, type PageFilters } from '../../src/client/data/page-store'
import { makeItem, makeSessionRow, makeSnapshot, makeWorkspaceRow } from './fixtures'

/** Filters of the default view. */
const FILTERS: PageFilters = { tab: 'needs-you', groupBy: 'session', workspace: ALL_WORKSPACES, search: '' }

describe('section classification', () => {
  it('splits items into the four sections and drops tombstones', () => {
    const items = [
      makeItem({ id: 'open', state: 'open' }),
      makeItem({ id: 'stale', state: 'stale' }),
      makeItem({ id: 'awaiting', state: 'awaiting' }),
      makeItem({ id: 'candidate', tier: 'candidate', severity: 3 }),
      makeItem({ id: 'snoozed', state: 'snoozed' }),
      makeItem({ id: 'resolved', state: 'resolved' }),
      makeItem({ id: 'archived', state: 'archived' }),
      makeItem({ id: 'deleted', deletedAt: 9_000 }),
    ]
    // Locked predicate: awaiting items are not in Needs you (they are in the
    // register's in-flight band), candidates/snoozed/resolved have their own tabs.
    expect(itemsForTab(items, 'needs-you').map(item => item.id)).toEqual(['open', 'stale'])
    expect(itemsForTab(items, 'candidates').map(item => item.id)).toEqual(['candidate'])
    expect(itemsForTab(items, 'snoozed').map(item => item.id)).toEqual(['snoozed'])
    expect(itemsForTab(items, 'resolved').map(item => item.id)).toEqual(['resolved', 'archived'])
    expect(tabCounts(items)).toEqual({ needsYou: 2, candidates: 1, snoozed: 1, resolved: 2 })
  })
})

describe('low-priority FYI items (severity 3)', () => {
  const fyi = makeItem({ id: 'fyi-1', severity: 3, title: 'Follow-up: rotate the tokens', firstSeenAt: 1 })
  const needs = makeItem({ id: 'needs-1', severity: 2, title: 'Ship it', firstSeenAt: 2 })
  const snapshot = makeSnapshot([fyi, needs])

  it('classifies them as FYI and keeps them out of Needs you and its counts', () => {
    expect(isFyi(fyi)).toBe(true)
    expect(itemsForTab([fyi, needs], 'needs-you').map(item => item.id)).toEqual(['needs-1'])
    expect(tabCounts([fyi, needs]).needsYou).toBe(1)
  })

  it('surfaces them as a collapsed FYI list on the Needs-you tab only', () => {
    const view = deriveInboxView(snapshot, { tab: 'needs-you', groupBy: 'session', workspace: ALL_WORKSPACES, search: '' })
    expect(view.fyi.map(item => item.id)).toEqual(['fyi-1'])
    expect(view.items.map(item => item.id)).toEqual(['needs-1'])
    const candidatesTab = deriveInboxView(snapshot, { tab: 'candidates', groupBy: 'session', workspace: ALL_WORKSPACES, search: '' })
    expect(candidatesTab.fyi).toEqual([])
  })

  it('honours search and workspace narrowing in the FYI list', () => {
    const narrowed = deriveInboxView(
      makeSnapshot([fyi]),
      { tab: 'needs-you', groupBy: 'session', workspace: ALL_WORKSPACES, search: 'rotate' },
    )
    expect(narrowed.fyi).toHaveLength(1)
    const missed = deriveInboxView(
      makeSnapshot([fyi]),
      { tab: 'needs-you', groupBy: 'session', workspace: ALL_WORKSPACES, search: 'nothing-matches' },
    )
    expect(missed.fyi).toEqual([])
  })

  it('exposes the awaiting count for the Needs-you status line', () => {
    const awaiting = makeItem({ id: 'waiting-1', state: 'awaiting' })
    const view = deriveInboxView(makeSnapshot([awaiting]), { tab: 'needs-you', groupBy: 'session', workspace: ALL_WORKSPACES, search: '' })
    expect(view.awaiting).toBe(1)
  })
})

describe('narrowing', () => {
  const items = [
    makeItem({ id: 'a', title: 'Registry approval', source: { sessionId: 's1', sessionTitle: 'Hookshot review', workspace: { workspaceId: 'w1', title: 'Hookshot' } } }),
    makeItem({ id: 'b', title: 'Colour count', source: { sessionId: 's2', sessionTitle: 'Design pass', workspace: { workspaceId: 'w2', title: 'NX2navi' } } }),
    makeItem({ id: 'c', title: 'Legacy scratch', source: { sessionId: 's3', sessionTitle: 'Legacy', cwd: '/tmp/x' } }),
  ]

  it('matches the search against title, session title and workspace title', () => {
    const view = deriveInboxView(makeSnapshot(items), { ...FILTERS, search: 'hookshot' })
    expect(view.items.map(item => item.id)).toEqual(['a'])
    expect(deriveInboxView(makeSnapshot(items), { ...FILTERS, search: 'legacy' }).items.map(item => item.id)).toEqual(['c'])
    expect(deriveInboxView(makeSnapshot(items), { ...FILTERS, search: 'design' }).items.map(item => item.id)).toEqual(['b'])
  })

  it('narrows by workspace id and by the Ungrouped bucket', () => {
    const snapshot = makeSnapshot(items)
    expect(deriveInboxView(snapshot, { ...FILTERS, workspace: 'w2' }).items.map(item => item.id)).toEqual(['b'])
    expect(deriveInboxView(snapshot, { ...FILTERS, workspace: UNGROUPED_WORKSPACE }).items.map(item => item.id)).toEqual(['c'])
    expect(deriveInboxView(snapshot, { ...FILTERS, workspace: ALL_WORKSPACES }).items).toHaveLength(3)
  })

  it('reports narrowing only when a filter is active', () => {
    expect(deriveInboxView(makeSnapshot(items), FILTERS).narrowed).toBe(false)
    expect(deriveInboxView(makeSnapshot(items), { ...FILTERS, search: 'x' }).narrowed).toBe(true)
    expect(deriveInboxView(makeSnapshot(items), { ...FILTERS, workspace: 'w1' }).narrowed).toBe(true)
  })
})

describe('session grouping', () => {
  it('orders sessions by newest activity and items by severity then longest waiting', () => {
    const items = [
      makeItem({ id: 's1-low', source: { sessionId: 's1' }, severity: 2, firstSeenAt: 10, updatedAt: 200 }),
      makeItem({ id: 's1-high', source: { sessionId: 's1' }, severity: 1, firstSeenAt: 900, updatedAt: 100 }),
      makeItem({ id: 's2', source: { sessionId: 's2' }, severity: 2, firstSeenAt: 5, updatedAt: 900 }),
    ]
    const groups = groupBySession(items, undefined)
    expect(groups.map(group => group.sessionId)).toEqual(['s2', 's1'])
    expect(groups[1]?.items.map(item => item.id)).toEqual(['s1-high', 's1-low'])
    expect(groups[1]?.updatedAt).toBe(200)
  })

  it('falls back to the session row title when the item snapshot has none', () => {
    const snapshot = makeSnapshot(
      [makeItem({ source: { sessionId: 'session-1' } })],
      { sessions: [makeSessionRow({ sessionId: 'session-1', title: 'Live title' })] },
    )
    expect(groupBySession(snapshot.items, snapshot)[0]?.title).toBe('Live title')
  })

  it('sorts identical severity by first observation, then id', () => {
    const earlier = makeItem({ id: 'b', firstSeenAt: 10 })
    const later = makeItem({ id: 'a', firstSeenAt: 20 })
    expect([later, earlier].sort(compareItems).map(item => item.id)).toEqual(['b', 'a'])
  })
})

describe('workspace grouping', () => {
  it('resolves ownership from the item workspace snapshot and Ungrouped otherwise', () => {
    expect(workspaceKeyOf(makeItem({ source: { sessionId: 's', workspace: { workspaceId: 'w1' } } }))).toBe('w1')
    expect(workspaceKeyOf(makeItem({ source: { sessionId: 's' } }))).toBe(UNGROUPED_WORKSPACE)
  })

  it('orders workspaces by newest activity, puts Ungrouped last and nests sessions', () => {
    const items = [
      makeItem({ id: 'a', source: { sessionId: 's1', workspace: { workspaceId: 'w1', title: 'Hookshot' } }, updatedAt: 100, severity: 1 }),
      makeItem({ id: 'b', source: { sessionId: 's2', workspace: { workspaceId: 'w1', title: 'Hookshot' } }, updatedAt: 200 }),
      makeItem({ id: 'c', source: { sessionId: 's3', workspace: { workspaceId: 'w2', title: 'NX2navi' } }, updatedAt: 300 }),
      makeItem({ id: 'd', source: { sessionId: 's4' }, updatedAt: 400 }),
    ]
    const groups = groupByWorkspace(items, makeSnapshot(items))
    expect(groups.map(group => group.key)).toEqual(['w2', 'w1', UNGROUPED_WORKSPACE])
    const hookshot = groups[1]
    expect(hookshot?.itemCount).toBe(2)
    expect(hookshot?.sessionCount).toBe(2)
    expect(hookshot?.sessions.map(session => session.sessionId)).toEqual(['s2', 's1'])
    expect(groups[2]?.ungrouped).toBe(true)
  })

  it('keeps a deleted workspace under its remembered title, flagged removed', () => {
    const item = makeItem({
      source: { sessionId: 's1', workspace: { workspaceId: 'gone', title: 'Old project', path: '/old' } },
    })
    const snapshot = makeSnapshot([item], {
      workspaces: [makeWorkspaceRow({ workspaceId: 'gone', title: 'Old project', removed: true })],
    })
    const [group] = groupByWorkspace(snapshot.items, snapshot)
    expect(group?.title).toBe('Old project')
    expect(group?.removed).toBe(true)
  })

  it('omits zero-item workspaces from the groups (they stay in the facet)', () => {
    const items = [makeItem({ source: { sessionId: 's1', workspace: { workspaceId: 'w1' } } })]
    const snapshot = makeSnapshot(items, {
      workspaces: [
        makeWorkspaceRow({ workspaceId: 'w1', title: 'Hookshot' }),
        makeWorkspaceRow({ workspaceId: 'w2', title: 'NX2navi', itemCount: 0 }),
      ],
    })
    expect(groupByWorkspace(snapshot.items, snapshot).map(group => group.key)).toEqual(['w1'])
  })
})

describe('workspace facet', () => {
  const items = [
    makeItem({ id: 'a', source: { sessionId: 's1', workspace: { workspaceId: 'w1', title: 'Hookshot' } } }),
    makeItem({ id: 'b', source: { sessionId: 's2', workspace: { workspaceId: 'w1', title: 'Hookshot' } } }),
    makeItem({ id: 'c', source: { sessionId: 's3' } }),
  ]

  it('lists host workspaces in registry order, then removed ones, then Ungrouped', () => {
    const snapshot = makeSnapshot(items, {
      workspaces: [
        makeWorkspaceRow({ workspaceId: 'w1', title: 'Hookshot', itemCount: 2 }),
        makeWorkspaceRow({ workspaceId: 'w2', title: 'NX2navi', itemCount: 0 }),
      ],
    })
    const facets = deriveWorkspaceFacets(snapshot.items, snapshot)
    expect(facets.map(facet => facet.key)).toEqual(['w1', 'w2', UNGROUPED_WORKSPACE])
    expect(facets[0]?.count).toBe(2)
    expect(facets[1]?.count).toBe(0)
    expect(facets[2]?.count).toBe(1)
  })

  it('counts only items in the current section (facet counts match the list)', () => {
    const resolved = makeItem({ id: 'r', state: 'resolved', source: { sessionId: 's9', workspace: { workspaceId: 'w1' } } })
    const snapshot = makeSnapshot([...items, resolved], {
      workspaces: [makeWorkspaceRow({ workspaceId: 'w1', title: 'Hookshot' })],
    })
    const needsYou = deriveWorkspaceFacets(items, snapshot)
    const resolvedFacets = deriveWorkspaceFacets([resolved], snapshot)
    expect(needsYou.find(facet => facet.key === 'w1')?.count).toBe(2)
    expect(resolvedFacets.find(facet => facet.key === 'w1')?.count).toBe(1)
  })
})

describe('count invariant', () => {
  it('sums workspace facet counts plus Ungrouped to the section total', () => {
    const items = [
      makeItem({ id: 'a', source: { sessionId: 's1', workspace: { workspaceId: 'w1', title: 'Hookshot' } } }),
      makeItem({ id: 'b', source: { sessionId: 's2', workspace: { workspaceId: 'w2', title: 'NX2navi' } } }),
      makeItem({ id: 'c', source: { sessionId: 's3' } }),
    ]
    const snapshot = makeSnapshot(items, {
      workspaces: [
        makeWorkspaceRow({ workspaceId: 'w1', title: 'Hookshot' }),
        makeWorkspaceRow({ workspaceId: 'w2', title: 'NX2navi' }),
        makeWorkspaceRow({ workspaceId: 'w3', title: 'Empty', itemCount: 0, sessionCount: 0 }),
      ],
    })
    const view = deriveInboxView(snapshot, FILTERS)
    expect(workspaceCountInvariant(view)).toEqual({ facets: 3, items: 3 })
  })

  it('holds for the workspace grouping mode too', () => {
    const items = [makeItem({ id: 'a' }), makeItem({ id: 'b', source: { sessionId: 's2', workspace: { workspaceId: 'w1' } } })]
    const view = deriveInboxView(makeSnapshot(items), { ...FILTERS, groupBy: 'workspace' })
    expect(view.workspaceGroups).toHaveLength(2)
    expect(view.workspaceGroups.reduce((total, group) => total + group.itemCount, 0)).toBe(2)
  })
})

describe('view assembly', () => {
  it('groups by session by default and leaves workspace groups empty', () => {
    const view = deriveInboxView(makeSnapshot([makeItem({ source: { sessionId: 's1' } })]), FILTERS)
    expect(view.sessionGroups).toHaveLength(1)
    expect(view.workspaceGroups).toHaveLength(0)
    expect(view.counts.needsYou).toBe(1)
  })

  it('renders an empty view before the first snapshot arrives', () => {
    const view = deriveInboxView(undefined, FILTERS)
    expect(view.items).toHaveLength(0)
    expect(view.facets.map(facet => facet.key)).toEqual([UNGROUPED_WORKSPACE])
    expect(view.counts).toEqual({ needsYou: 0, candidates: 0, snoozed: 0, resolved: 0 })
  })
})


describe('session scoping', () => {
  it('scopes the section and its facets to one session when the filter is set', () => {
    const a = makeItem({ id: 'a', source: { sessionId: 's1', workspace: { workspaceId: 'w1', title: 'Hookshot' } } })
    const b = makeItem({ id: 'b', source: { sessionId: 's2', workspace: { workspaceId: 'w2', title: 'NX2navi' } } })
    const snapshot = makeSnapshot([a, b])
    const view = deriveInboxView(snapshot, { ...FILTERS, sessionId: 's1' })
    expect(view.items.map(item => item.id)).toEqual(['a'])
    expect(view.sectionTotal).toBe(1)
    expect(view.narrowed).toBe(true)
  })
})
