/**
 * Page view store: the state that must survive navigation away and back.
 *
 * Pure store — no DOM and no transport.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  ALL_WORKSPACES,
  UNGROUPED_WORKSPACE,
  createPageStore,
  sessionGroupKey,
  workspaceGroupKey,
} from '../../src/client/data/page-store'

describe('page store', () => {
  it('starts on Needs you grouped by session with no narrowing', () => {
    const store = createPageStore()
    const state = store.getSnapshot()
    expect(state.filters).toEqual({
      tab: 'needs-you',
      groupBy: 'session',
      workspace: ALL_WORKSPACES,
      search: '',
    })
    expect(state.selectedId).toBeNull()
    expect(state.collapsed.size).toBe(0)
  })

  it('accepts an initial lens without losing the other defaults', () => {
    const store = createPageStore({ workspace: 'workspace-1', groupBy: 'workspace' })
    expect(store.getSnapshot().filters.workspace).toBe('workspace-1')
    expect(store.getSnapshot().filters.groupBy).toBe('workspace')
    expect(store.getSnapshot().filters.tab).toBe('needs-you')
  })

  it('keeps the workspace lens when the section changes but clears the selection', () => {
    const store = createPageStore({ workspace: 'workspace-1' })
    store.actions.select('item-1')
    store.actions.setTab('resolved')
    expect(store.getSnapshot().filters.workspace).toBe('workspace-1')
    expect(store.getSnapshot().filters.tab).toBe('resolved')
    expect(store.getSnapshot().selectedId).toBeNull()
  })

  it('clears the selection when the workspace facet changes', () => {
    const store = createPageStore()
    store.actions.select('item-1')
    store.actions.setWorkspace(UNGROUPED_WORKSPACE)
    expect(store.getSnapshot().selectedId).toBeNull()
    expect(store.getSnapshot().filters.workspace).toBe(UNGROUPED_WORKSPACE)
  })

  it('toggles disclosure keys independently', () => {
    const store = createPageStore()
    store.actions.toggleCollapsed(workspaceGroupKey('workspace-1'))
    store.actions.toggleCollapsed(sessionGroupKey('session-1'))
    expect([...store.getSnapshot().collapsed].sort()).toEqual([
      'session:session-1',
      'workspace:workspace-1',
    ])
    store.actions.toggleCollapsed(sessionGroupKey('session-1'))
    expect([...store.getSnapshot().collapsed]).toEqual(['workspace:workspace-1'])
  })

  it('notifies subscribers on visible state changes only', () => {
    const store = createPageStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.actions.setSearch('registry')
    store.actions.select('item-1')
    expect(listener).toHaveBeenCalledTimes(2)
    // Scroll memory is deliberately silent: writing it must not re-render the list.
    store.actions.rememberScroll(320)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().scrollTop).toBe(320)
    // Re-setting the same search is a no-op; re-selecting the same item is the
    // close gesture (medium layout has no visible Back control).
    store.actions.setSearch('registry')
    expect(listener).toHaveBeenCalledTimes(2)
    store.actions.select('item-1')
    expect(listener).toHaveBeenCalledTimes(3)
    expect(store.getSnapshot().selectedId).toBeNull()
  })

  it('keeps every filter when the page store is reused (navigation away and back)', () => {
    const store = createPageStore()
    store.actions.setFilters({ tab: 'candidates', groupBy: 'workspace', workspace: 'workspace-2', search: 'migration' })
    store.actions.select('item-9')
    store.actions.rememberScroll(120)
    // A remount reads the same store instance; nothing resets it.
    const snapshot = store.getSnapshot()
    expect(snapshot.filters).toEqual({
      tab: 'candidates',
      groupBy: 'workspace',
      workspace: 'workspace-2',
      search: 'migration',
    })
    expect(snapshot.selectedId).toBe('item-9')
    expect(snapshot.scrollTop).toBe(120)
  })

  it('resets to the initial view on demand', () => {
    const store = createPageStore({ workspace: 'workspace-1' })
    store.actions.setTab('snoozed')
    store.actions.select('item-1')
    store.actions.rememberScroll(10)
    store.actions.reset()
    expect(store.getSnapshot().filters).toEqual({
      tab: 'needs-you',
      groupBy: 'session',
      workspace: ALL_WORKSPACES,
      search: '',
    })
    expect(store.getSnapshot().selectedId).toBeNull()
    expect(store.getSnapshot().scrollTop).toBe(0)
  })
})


describe('session narrowing', () => {
  it('narrows to one session without touching the other filters and clears it', () => {
    const store = createPageStore()
    store.actions.setTab('candidates')
    store.actions.setSession('s-1')
    expect(store.getSnapshot().filters).toMatchObject({ tab: 'candidates', sessionId: 's-1' })
    expect(store.getSnapshot().selectedId).toBeNull()
    store.actions.setSession(undefined)
    expect(store.getSnapshot().filters.sessionId).toBeUndefined()
  })
})

describe('bulk candidate selection', () => {
  it('prunes ticks the visible list no longer contains and counts them', () => {
    const store = createPageStore({ tab: 'candidates' })
    store.actions.toggleCandidate('candidate-1')
    store.actions.toggleCandidate('candidate-2')
    store.actions.toggleCandidate('candidate-3')
    expect(store.getSnapshot().candidateSelection.size).toBe(3)
    // A search/workspace/session narrowing hides candidate-2: its tick is
    // pruned, and the count says one was dropped (never silently).
    expect(store.actions.pruneCandidates(['candidate-1', 'candidate-3'])).toBe(1)
    expect([...store.getSnapshot().candidateSelection].sort()).toEqual(['candidate-1', 'candidate-3'])
    // Pruning again is a no-op and does not notify.
    const listener = vi.fn()
    store.subscribe(listener)
    expect(store.actions.pruneCandidates(['candidate-1', 'candidate-3'])).toBe(0)
    expect(listener).not.toHaveBeenCalled()
  })

  it('clears every tick when the section changes', () => {
    const store = createPageStore({ tab: 'candidates' })
    store.actions.toggleCandidate('candidate-1')
    store.actions.setTab('needs-you')
    expect(store.getSnapshot().candidateSelection.size).toBe(0)
  })
})
