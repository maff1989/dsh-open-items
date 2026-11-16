// @vitest-environment jsdom
/**
 * The page shell at the component level: loading/empty/offline states, the two
 * grouping modes, the workspace facet and selection → detail.
 *
 * Layout (wide/medium/narrow) is CSS-only, so these tests assert the DOM every
 * width shares. Behaviour that depends on width belongs to the visual review.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('./primitives-mock'))
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

import { InboxPage, type InboxPageInjected, type InboxPageProps } from '../../src/client/ui/page'
import type { AnswerPlan, SettleController } from '../../src/client/data/settle'
import type { ReplyValue } from '../../src/shared/protocol'
import { createPageStore } from '../../src/client/data/page-store'
import type { InboxState } from '../../src/client/data/inbox-store'
import type {
  CandidateActions,
  CandidateBulkResult,
  CandidatePromotePatch,
  CandidateResult,
  CandidateTarget,
} from '../../src/client/data/candidate-actions'
import type { InboxSnapshot, OpenItemRecord } from '../../src/shared/schema'
import { makeItem, makeSessionRow, makeSnapshot, makeWorkspaceRow, t } from './fixtures'

afterEach(cleanup)

/** Hand-writable inbox source so each case states exactly one load state. */
class FakeInbox {
  private state: InboxState
  private readonly listeners = new Set<() => void>()
  constructor(state: InboxState) {
    this.state = state
  }
  readonly source: ObservableSnapshot<InboxState> = {
    getSnapshot: () => this.state,
    subscribe: (listener: () => void) => {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    },
  }
  set(state: InboxState): void {
    this.state = state
    for (const listener of [...this.listeners]) listener()
  }
}

/** State for a ready snapshot; counts are recomputed by the fixture. */
function readyState(snapshot: InboxSnapshot, patch: Partial<InboxState> = {}): InboxState {
  return {
    status: 'ready',
    snapshot,
    hello: undefined,
    error: undefined,
    offline: false,
    lastReadAt: 4_000,
    refreshing: false,
    ...patch,
  }
}

/** Render the page over one fake inbox and one page store. */
function renderPage(
  inbox: FakeInbox,
  page = createPageStore(),
  extra: Partial<InboxPageInjected> = {},
): ReturnType<typeof render> {
  /** The registration's `hooks` compartment, bound for the test. */
  function useSnap<S>(selector: (state: InboxState) => S): S {
    return useSyncExternalStore(inbox.source.subscribe, () => selector(inbox.source.getSnapshot()))
  }
  const initial = inbox.source.getSnapshot()
  if (initial.snapshot !== undefined && initial.readKey === undefined) {
    inbox.set({ ...initial, readKey: page.getSnapshot().filters.tab })
  }
  const props = { t, page, refresh: vi.fn(), useSnap, ...extra } as unknown as InboxPageProps
  return render(<InboxPage {...props} />)
}

/** A settle plan: the action answers in place and costs no turn. */
const settlePlan: AnswerPlan = { track: 'client-settle', settles: true, steers: false, requiresWakeConfirmation: false }

/** A message plan: the action sends and would resume an idle session. */
const messagePlan: AnswerPlan = { track: 'message', settles: false, steers: false, requiresWakeConfirmation: true }

/** Route reply stub. */
const reply = {} as ReplyValue

/** One recorded controller call. */
interface AnswerCall {
  readonly itemId: string
  readonly payload: unknown
  readonly options: { readonly confirmedWake?: boolean; readonly deliveryId?: string } | undefined
}

/** An authored sign-off: raised through the tool, with no live request behind it. */
function authoredApproval(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    kind: 'approval',
    title: 'Registry access',
    reply: { controls: ['approve', 'deny'], freeText: false, requiresConfirm: false },
    source: { sessionId: 'session-1' },
    dedupeKey: 'authored|approval|session-1|raise-1',
    detectedBy: ['tool'],
    ...overrides,
  })
}

/** One settle controller double that records what the page asked it to do. */
function fakeSettle(overrides: Partial<SettleController> = {}): { readonly settle: SettleController; readonly answers: AnswerCall[] } {
  const answers: AnswerCall[] = []
  const settle: SettleController = {
    capabilities: () => ({ clientSettle: false, hostSettle: false, message: true }),
    routeFor: () => 'message',
    planFor: () => settlePlan,
    canAnswer: () => true,
    canDecideApproval: () => true,
    answer: async (item, payload, options) => {
      answers.push({ itemId: item.id, payload, options })
      return { kind: 'refused', code: 'conflict', message: 'stale item', deliveryId: 'test-delivery' }
    },
    ...overrides,
  }
  return { settle, answers }
}

describe('page states', () => {
  it('renders skeleton rows while the first read is in flight', () => {
    renderPage(new FakeInbox({
      status: 'loading',
      snapshot: undefined,
      hello: undefined,
      error: undefined,
      offline: false,
      lastReadAt: 0,
      refreshing: false,
    }))
    expect(screen.getByRole('status', { name: 'Loading open items' })).toBeTruthy()
    expect(screen.getByText('Loading open items…')).toBeTruthy()
  })

  it('renders the Needs you empty state with the product promise', () => {
    renderPage(new FakeInbox(readyState(makeSnapshot([]))))
    expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy()
    // The duplicate summary sentence is gone; a zero count renders no badge.
    expect(screen.queryByText('Nothing is waiting on you')).toBeNull()
  })

  it('renders the Candidates empty state copy on its own tab', () => {
    const page = createPageStore({ tab: 'candidates' })
    renderPage(new FakeInbox(readyState(makeSnapshot([]))), page)
    expect(screen.getByText('Nothing to confirm right now.')).toBeTruthy()
    // Truthful copy: the tab is not a promise of invisible prose capture.
    expect(screen.queryByText(/never answered/)).toBeNull()
  })

  it('does not promise prose questions in the Needs-you empty state', () => {
    renderPage(new FakeInbox(readyState(makeSnapshot([]))))
    expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy()
    expect(screen.queryByText(/end on a question/)).toBeNull()
  })

  it('keeps the last list on screen with an offline banner and a retry', () => {
    const page = createPageStore()
    const snapshot = makeSnapshot([makeItem({ title: 'Offline item' })])
    const inbox = new FakeInbox(readyState(snapshot, { offline: true, error: 'offline', lastReadAt: 5_000 - 120_000 }))
    renderPage(inbox, page)
    expect(screen.getByText(/Can't reach the harness/)).toBeTruthy()
    expect(screen.getByText('Offline item')).toBeTruthy()
    const retry = screen.getByRole('button', { name: 'Retry' })
    fireEvent.click(retry)
    // The component calls the injected refresh seam; the fake is a no-op spy.
    expect(screen.getByText('Offline item')).toBeTruthy()
  })

  it('never renders an empty claim while the section read is pending (D-2)', () => {
    const snapshot = makeSnapshot([makeItem({ title: 'Still waiting' })])
    // The page asked for Snoozed but the store has not answered that section
    // yet: the previous section's rows must not become the new section's truth.
    renderPage(
      new FakeInbox(readyState(snapshot, { requestedKey: 'snoozed', readKey: 'needs-you' })),
      createPageStore({ tab: 'snoozed' }),
    )
    expect(screen.queryByText('No snoozed items.')).toBeNull()
    expect(screen.queryByText('Still waiting')).toBeNull()
    expect(screen.getByRole('status', { name: 'Loading open items' })).toBeTruthy()
  })

  it('renders a paging failure beside Load more, not as a page failure (D-12)', () => {
    const snapshot = makeSnapshot([makeItem({ title: 'Loaded item' })], { nextCursor: 'c1' })
    renderPage(new FakeInbox(readyState(snapshot, { loadMoreError: 'offline page' })))
    expect(screen.getByText(/Could not load more items\. offline page/u)).toBeTruthy()
    // The list is intact and the page-level error copy is absent.
    expect(screen.getByText('Loaded item')).toBeTruthy()
    expect(screen.queryByText(/Could not load open items/u)).toBeNull()
  })

  it('shows a hard error when no snapshot ever arrived', () => {
    renderPage(new FakeInbox({
      status: 'error',
      snapshot: undefined,
      hello: undefined,
      error: 'route refused the request',
      offline: false,
      lastReadAt: 0,
      refreshing: false,
    }))
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText(/route refused the request/)).toBeTruthy()
  })
})

describe('needs-you surfaces (strict meaning)', () => {
  it('shows the awaiting status line and moves to Resolved on request', () => {
    const awaiting = makeItem({ id: 'waiting-1', state: 'awaiting', title: 'Sent answer' })
    const page = createPageStore()
    renderPage(new FakeInbox(readyState(makeSnapshot([awaiting]))), page)
    expect(screen.getByText('1 answer is waiting for the session')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show in Resolved' }))
    expect(page.getSnapshot().filters.tab).toBe('resolved')
  })

  it('marks rows first seen at/after the last visit as new (marker captured on mount)', () => {
    const fresh = makeItem({ id: 'fresh', title: 'Fresh decision', firstSeenAt: 9_000 })
    const old = makeItem({ id: 'old', title: 'Old decision', firstSeenAt: 1_000 })
    renderPage(new FakeInbox(readyState(makeSnapshot([fresh, old]))), createPageStore(), { lastVisit: () => 5_000 })
    expect(screen.getByText(t('row.newAria'))).toBeTruthy()
    const rows = [...document.querySelectorAll<HTMLElement>('.dsh-oi-row')]
    const freshRow = rows.find(row => row.textContent?.includes('Fresh decision'))
    const oldRow = rows.find(row => row.textContent?.includes('Old decision'))
    expect(freshRow?.querySelector('.dsh-oi-grade')?.getAttribute('data-new')).toBe('true')
    expect(oldRow?.querySelector('.dsh-oi-grade')?.getAttribute('data-new')).toBe('false')
  })

  it('opens the detail for a selected FYI row (selection cleanup accepts FYI)', () => {
    const fyi = makeItem({ id: 'fyi-1', severity: 3, title: 'Follow-up: rotate tokens' })
    renderPage(new FakeInbox(readyState(makeSnapshot([fyi]), { readKey: 'needs-you' })))
    fireEvent.click(screen.getByRole('button', { name: 'FYI · 1 low-priority item' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select Follow-up: rotate tokens' }))
    const detail = screen.getByRole('region', { name: 'Item detail' })
    expect(within(detail).getByRole('heading', { name: 'Follow-up: rotate tokens' })).toBeTruthy()
    expect(screen.queryByText('That item is no longer in this list.')).toBeNull()
  })

  it('keeps severity-3 items out of the list but reachable under FYI', () => {
    const fyi = makeItem({ id: 'fyi-1', severity: 3, title: 'Follow-up: rotate tokens' })
    const needs = makeItem({ id: 'needs-1', severity: 2, title: 'Ship the build' })
    renderPage(new FakeInbox(readyState(makeSnapshot([fyi, needs]))))
    expect(screen.getByText('Ship the build')).toBeTruthy()
    expect(screen.queryByText('Follow-up: rotate tokens')).toBeNull()
    // Collapsed by default, then expandable.
    fireEvent.click(screen.getByRole('button', { name: 'FYI · 1 low-priority item' }))
    expect(screen.getByText('Follow-up: rotate tokens')).toBeTruthy()
  })
})

describe('responsive section navigation', () => {
  class FakeResizeObserver {
    private readonly callback: (entries: { contentRect: { width: number } }[]) => void
    constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
      this.callback = callback
    }
    observe(): void {
      this.callback([{ contentRect: { width: 390 } }])
    }
    disconnect(): void {
      // no-op
    }
  }

  it('replaces the tab strip with a Section menu on a phone-width page', () => {
    const original = globalThis.ResizeObserver
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver
    try {
      renderPage(new FakeInbox(readyState(makeSnapshot([makeItem({ title: 'Phone item' })]))))
      expect(screen.queryAllByRole('tab')).toHaveLength(0)
      expect(screen.getByRole('button', { name: 'Open items sections' }).textContent).toContain('Needs you')
    } finally {
      ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = original
    }
  })
})

describe('session grouping (default)', () => {
  const items = [
    makeItem({ id: 'a', title: 'Registry approval', severity: 1, firstSeenAt: 1_000, source: { sessionId: 'session-1', sessionTitle: 'Hookshot review' } }),
    makeItem({ id: 'b', title: 'Colour count', severity: 2, firstSeenAt: 900, source: { sessionId: 'session-1', sessionTitle: 'Hookshot review' } }),
    makeItem({ id: 'c', title: 'Another chat', severity: 2, source: { sessionId: 'session-2', sessionTitle: 'Design pass' } }),
  ]
  const snapshot = makeSnapshot(items, {
    sessions: [
      makeSessionRow({ sessionId: 'session-1', title: 'Hookshot review' }),
      makeSessionRow({ sessionId: 'session-2', title: 'Design pass' }),
    ],
    workspaces: [makeWorkspaceRow({ workspaceId: 'workspace-1', title: 'Hookshot' })],
  })

  it('renders session headings with counts and rows beneath them', () => {
    renderPage(new FakeInbox(readyState(snapshot)))
    const hookshot = screen.getByRole('region', { name: 'Hookshot review · 2 items' })
    expect(within(hookshot).getByRole('button', { name: 'Hookshot review' })).toBeTruthy()
    expect(within(hookshot).getByText('2 items')).toBeTruthy()
    expect(within(hookshot).getByText(/updated /u)).toBeTruthy()
    // A single-item group does not repeat the count.
    const design = screen.getByRole('region', { name: 'Design pass · 1 item' })
    expect(within(design).queryByText('1 item')).toBeNull()
    expect(screen.getByText('Registry approval')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Needs you' })).toBeTruthy()
  })

  it('collapses a session group and folds its rows away', () => {
    const page = createPageStore()
    renderPage(new FakeInbox(readyState(snapshot)), page)
    fireEvent.click(screen.getByRole('button', { name: 'Hookshot review' }))
    expect(screen.queryByText('Registry approval')).toBeNull()
    expect(screen.getByRole('region', { name: 'Design pass · 1 item' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Hookshot review' }))
    expect(screen.getByText('Registry approval')).toBeTruthy()
  })

  it('re-selecting the open row closes the detail pane', () => {
    renderPage(new FakeInbox(readyState(snapshot)))
    fireEvent.click(screen.getByRole('button', { name: 'Select Registry approval' }))
    expect(screen.getByRole('region', { name: 'Item detail' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Select Registry approval' }))
    expect(screen.getByText('Select an item')).toBeTruthy()
  })

  it('renders inline code in the item body without leaking backticks (B-16)', () => {
    renderPage(new FakeInbox(readyState(makeSnapshot([
      makeItem({ title: 'Purge the repo', body: 'Run `git gc --prune=now` before sharing.' }),
    ]))))
    fireEvent.click(screen.getByRole('button', { name: 'Select Purge the repo' }))
    const detail = screen.getByRole('region', { name: 'Item detail' })
    const code = detail.querySelector('code')
    expect(code?.textContent).toBe('git gc --prune=now')
    expect(detail.textContent).not.toContain('`')
  })

  it('selects a row and shows the detail pane', () => {
    renderPage(new FakeInbox(readyState(snapshot)))
    fireEvent.click(screen.getByRole('button', { name: 'Select Registry approval' }))
    // One detail mount: jsdom has no ResizeObserver, so the page keeps the
    // wide/narrow column path and the medium in-row expansion stays unmounted.
    const details = screen.getAllByRole('region', { name: 'Item detail' })
    expect(details).toHaveLength(1)
    expect(within(details[0] as HTMLElement).getByRole('heading', { name: 'Registry approval' })).toBeTruthy()
    expect(within(details[0] as HTMLElement).getByText('Your reply')).toBeTruthy()
  })
})

describe('workspace lens', () => {
  const items = [
    makeItem({ id: 'a', title: 'Hookshot approval', source: { sessionId: 's1', sessionTitle: 'Hookshot review', workspace: { workspaceId: 'workspace-1', title: 'Hookshot' } } }),
    makeItem({ id: 'b', title: 'NX2navi decision', source: { sessionId: 's2', sessionTitle: 'NX2navi review', workspace: { workspaceId: 'workspace-2', title: 'NX2navi' } } }),
    makeItem({ id: 'c', title: 'Loose item', source: { sessionId: 's3', sessionTitle: 'Scratch' } }),
  ]
  const snapshot = makeSnapshot(items, {
    sessions: [
      makeSessionRow({ sessionId: 's1', title: 'Hookshot review' }),
      makeSessionRow({ sessionId: 's2', title: 'NX2navi review' }),
      makeSessionRow({ sessionId: 's3', title: 'Scratch' }),
    ],
    workspaces: [
      makeWorkspaceRow({ workspaceId: 'workspace-1', title: 'Hookshot', itemCount: 1 }),
      makeWorkspaceRow({ workspaceId: 'workspace-2', title: 'NX2navi', itemCount: 1 }),
      makeWorkspaceRow({ workspaceId: 'workspace-3', title: 'Empty', itemCount: 0, sessionCount: 0 }),
    ],
  })

  it('groups by workspace with counts and Ungrouped last', () => {
    const page = createPageStore({ groupBy: 'workspace' })
    renderPage(new FakeInbox(readyState(snapshot)), page)
    expect(screen.getByRole('region', { name: 'Hookshot · 1 item · 1 session' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'NX2navi · 1 item · 1 session' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Ungrouped · 1 item · 1 session' })).toBeTruthy()
  })

  it('offers every workspace in the facet with its count, including empty ones', () => {
    const page = createPageStore({ groupBy: 'workspace' })
    renderPage(new FakeInbox(readyState(snapshot)), page)
    fireEvent.click(screen.getByRole('button', { name: 'Workspace filter' }))
    const options = screen.getAllByRole('menuitem').map(option => option.textContent)
    expect(options).toEqual(['All workspaces', 'Hookshot (1)', 'NX2navi (1)', 'Empty (0)', 'Ungrouped (1)'])
  })

  it('names the workspace filter honestly when no narrowing is set', () => {
    renderPage(new FakeInbox(readyState(snapshot)))
    const trigger = screen.getByRole('button', { name: 'Workspace filter' })
    expect(trigger.textContent).toContain('Workspace')
    expect(trigger.textContent).toContain('All workspaces')
  })

  it('narrows the list when a workspace is picked from the facet', () => {
    const page = createPageStore({ groupBy: 'workspace' })
    renderPage(new FakeInbox(readyState(snapshot)), page)
    fireEvent.click(screen.getByRole('button', { name: 'Workspace filter' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hookshot (1)' }))
    // The store changed; the fake inbox has not, but the page re-renders from it.
    expect(screen.getByText('Hookshot approval')).toBeTruthy()
    expect(screen.queryByText('NX2navi decision')).toBeNull()
    expect(screen.queryByText('Loose item')).toBeNull()
  })

  it('puts the open count in the page head as a real badge (OD-16)', () => {
    renderPage(new FakeInbox(readyState(snapshot)))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Open items')
    expect(screen.getByText('3 waiting')).toBeTruthy()
    // Tab labels no longer carry "(N)" text; the count lives in the head badge.
    expect(screen.getByRole('tab', { name: 'Needs you' })).toBeTruthy()
    expect(screen.queryByText(/Needs you \(/)).toBeNull()
  })

  it('wires every tablist control to a rendered panel and marks the page opened', () => {
    const onOpened = vi.fn()
    renderPage(new FakeInbox(readyState(snapshot)), createPageStore(), { onOpened })
    expect(onOpened).toHaveBeenCalledTimes(1)
    for (const tab of screen.getAllByRole('tab')) {
      const controls = tab.getAttribute('aria-controls')
      expect(controls, tab.textContent ?? '').toBeTruthy()
      expect(document.getElementById(controls ?? ''), controls ?? '').toBeTruthy()
    }
  })

  it('marks a removed workspace in the facet and group heading', () => {
    const item = makeItem({ id: 'gone', title: 'Old work', source: { sessionId: 's9', sessionTitle: 'Old chat', workspace: { workspaceId: 'workspace-9', title: 'Old project' } } })
    const removed = makeSnapshot([item], {
      sessions: [makeSessionRow({ sessionId: 's9', title: 'Old chat' })],
      workspaces: [makeWorkspaceRow({ workspaceId: 'workspace-9', title: 'Old project', removed: true })],
    })
    renderPage(new FakeInbox(readyState(removed)), createPageStore({ groupBy: 'workspace' }))
    const removedGroup = screen.getByRole('region', { name: 'Old project (workspace removed) · 1 item · 1 session' })
    expect(within(removedGroup).getByRole('button', { name: 'Old project' })).toBeTruthy()
  })
})

describe('tabs and filters', () => {
  it('keeps all four sections reachable, with the Resolved shell present', () => {
    renderPage(new FakeInbox(readyState(makeSnapshot([]))))
    for (const name of [/Needs you/, /Candidates/, /Snoozed/, /Resolved/]) {
      expect(screen.getByRole('tab', { name })).toBeTruthy()
    }
  })

  it('switching to a section with no items keeps the filter and shows its empty copy', async () => {
    const page = createPageStore()
    const inbox = new FakeInbox(readyState(makeSnapshot([makeItem()])))
    renderPage(inbox, page)
    fireEvent.click(screen.getByRole('tab', { name: /Snoozed/ }))
    // Simulate the section read completing for the new tab.
    inbox.set({ ...inbox.source.getSnapshot(), readKey: 'snoozed' })
    await waitFor(() => {
      expect(screen.getByText('No snoozed items.')).toBeTruthy()
    })
    expect(page.getSnapshot().filters.tab).toBe('snoozed')
  })

  it('re-reads the section population when the tab changes (Snoozed cannot use the default window)', () => {
    const refresh = vi.fn()
    renderPage(new FakeInbox(readyState(makeSnapshot([makeItem()]))), createPageStore(), { refresh })
    expect(refresh).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: /Snoozed/ }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('clears the search with the Clear filters control when narrowed to nothing', () => {
    const page = createPageStore({ search: 'no-such-item' })
    renderPage(new FakeInbox(readyState(makeSnapshot([makeItem()]))), page)
    expect(screen.getByText('No matches for “no-such-item” in Needs you')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(page.getSnapshot().filters.search).toBe('')
  })
})

describe('cross-surface handoffs (D-3)', () => {
  it('lands a candidates handoff selected once its section read exists', () => {
    const candidate = makeItem({
      id: 'candidate-1',
      tier: 'candidate',
      severity: 3,
      title: 'Inferred decision',
    })
    const page = createPageStore({ tab: 'candidates' })
    // What index.openInbox does for the panel/card seam.
    page.actions.setFilters({ tab: 'candidates', search: '', workspace: 'all', sessionId: undefined })
    page.actions.select('candidate-1')
    renderPage(new FakeInbox(readyState(makeSnapshot([candidate]), { readKey: 'candidates' })), page)
    const detail = screen.getByRole('region', { name: 'Item detail' })
    expect(within(detail).getByRole('heading', { name: 'Inferred decision' })).toBeTruthy()
  })

  it('does not discard a handoff selection on the previous section read', () => {
    const candidate = makeItem({ id: 'candidate-1', tier: 'candidate', severity: 3, title: 'Inferred decision' })
    const page = createPageStore({ tab: 'candidates' })
    page.actions.select('candidate-1')
    // The snapshot/read identity still belongs to Needs you: the selection must
    // survive until the Candidates read lands (it used to be cleared at once).
    renderPage(new FakeInbox(readyState(makeSnapshot([candidate]), { readKey: 'needs-you' })), page)
    const detail = screen.getByRole('region', { name: 'Item detail' })
    expect(within(detail).getByRole('heading', { name: 'Inferred decision' })).toBeTruthy()
  })
})

describe('answering from the page', () => {
  it('routes one click through the controller and announces the outcome', async () => {
    const item = makeItem({
      kind: 'question',
      title: 'Ship before Friday?',
      reply: { controls: ['option'], options: ['Yes', 'No'], freeText: false, requiresConfirm: false },
    })
    const refresh = vi.fn()
    const { settle, answers } = fakeSettle({
      answer: async (target, payload) => {
        answers.push({ itemId: target.id, payload, options: undefined })
        return { kind: 'settled', reply, deliveryId: 'delivery-1' }
      },
    })
    renderPage(new FakeInbox(readyState(makeSnapshot([item]))), createPageStore(), { settle, refresh })

    // The detail pane owns the draft; selecting the row opens it.
    fireEvent.click(screen.getByRole('button', { name: 'Select Ship before Friday?' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))

    expect(answers).toEqual([{ itemId: item.id, payload: { type: 'option', option: 'Yes' }, options: undefined }])
    await waitFor(() => {
      expect(refresh).toHaveBeenCalled()
    })
    expect(screen.getAllByText(/Answer applied/).length).toBeGreaterThan(0)
  })

  it('warns before a send that would resume an idle session', async () => {
    const item = makeItem({
      kind: 'decision',
      title: 'Keep five colours?',
      reply: { controls: ['text'], freeText: true, requiresConfirm: false },
    })
    const { settle, answers } = fakeSettle({
      planFor: () => messagePlan,
      answer: async (target, payload, options) => {
        answers.push({ itemId: target.id, payload, options })
        return { kind: 'sent', reply, deliveryId: 'delivery-2' }
      },
    })
    renderPage(new FakeInbox(readyState(makeSnapshot([item]))), createPageStore(), { settle, refresh: vi.fn() })

    // The draft lives in the selected item's detail; select it first.
    fireEvent.click(screen.getByRole('button', { name: 'Select Keep five colours?' }))
    fireEvent.change(screen.getAllByRole('textbox', { name: 'Your reply' })[0] as HTMLElement, { target: { value: 'keep five' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Send to session' })[0] as HTMLElement)

    // The first click only warns; no request has been made yet.
    expect(answers).toEqual([])
    expect(screen.getAllByRole('group', { name: 'Send and resume?' })[0]).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Send & resume now' })[0] as HTMLElement)

    await waitFor(() => {
      expect(answers).toEqual([{
        itemId: item.id,
        payload: { type: 'text', text: 'keep five' },
        options: { confirmedWake: true },
      }])
    })
  })

  it('prefers the catalogue Session title and falls back to the honest untitled label', () => {
    const item = makeItem({ id: 'a', title: 'Registry approval', source: { sessionId: 'session-1' } })
    const snapshot = makeSnapshot([item])
    const first = renderPage(new FakeInbox(readyState(snapshot)), createPageStore(), {
      sessionTitle: () => 'Plugin implementation and docs review',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Select Registry approval' }))
    expect(screen.getAllByText(/Plugin implementation and docs review/u).length).toBeGreaterThan(0)
    expect(screen.queryByText(/\(untitled session\)/u)).toBeNull()
    first.unmount()
    renderPage(new FakeInbox(readyState(snapshot)))
    fireEvent.click(screen.getByRole('button', { name: 'Select Registry approval' }))
    expect(screen.getAllByText(/\(untitled session\)/u).length).toBeGreaterThan(0)
  })

  it('presents an authored approval as a session message, not a card grant', () => {
    const item = authoredApproval()
    const { settle } = fakeSettle({ planFor: () => messagePlan })
    renderPage(new FakeInbox(readyState(makeSnapshot([item]))), createPageStore(), {
      settle,
      sessionTitle: () => 'Plugin implementation and docs review',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Select Registry access' }))
    const detail = screen.getByRole('region', { name: 'Item detail' })
    expect(within(detail).getByText(t('answer.approval.allowBodyToSession'))).toBeTruthy()
    // The session-card hint is false for an authored approval: no card exists.
    expect(within(detail).queryByText(t('row.action.approvalNeedsSession'))).toBeNull()
    const allow = within(detail).getByRole('button', { name: 'Allow once' })
    expect(allow).toHaveProperty('disabled', false)
    expect(within(detail).getAllByText(/Plugin implementation and docs review/u).length).toBeGreaterThan(0)
  })

  it('does not auto-wake an authored approval: it stops at Send & resume', async () => {
    const item = authoredApproval()
    const { settle, answers } = fakeSettle({
      planFor: () => messagePlan,
      answer: async (target, payload, options) => {
        answers.push({ itemId: target.id, payload, options })
        return { kind: 'sent', reply, deliveryId: 'delivery-9' }
      },
    })
    renderPage(new FakeInbox(readyState(makeSnapshot([item]))), createPageStore(), { settle, refresh: vi.fn() })
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    const dialog = screen.getByRole('dialog', { name: 'Allow once' })
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Allow once' }))
    // The shipped confirmation is only consent to the decision; spending a turn
    // still needs the page's explicit wake step.
    expect(answers).toEqual([])
    expect(screen.getAllByRole('group', { name: 'Send and resume?' }).length).toBeGreaterThan(0)
    fireEvent.click(screen.getAllByRole('button', { name: 'Send & resume now' })[0] as HTMLElement)
    await waitFor(() => {
      expect(answers).toEqual([{
        itemId: item.id,
        payload: { type: 'approval', outcome: 'allow-once' },
        options: { confirmedWake: true },
      }])
    })
  })

  it('shows a failure in place with a Retry that reuses the delivery id', async () => {
    const item = makeItem({
      kind: 'question',
      title: 'Ship before Friday?',
      reply: { controls: ['option'], options: ['Yes', 'No'], freeText: false, requiresConfirm: false },
    })
    const { settle, answers } = fakeSettle()
    renderPage(new FakeInbox(readyState(makeSnapshot([item]))), createPageStore(), { settle, refresh: vi.fn() })

    fireEvent.click(screen.getByRole('button', { name: 'Select Ship before Friday?' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))

    await screen.findAllByText(/Not applied — it changed since you saw it/)
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0] as HTMLElement)
    await waitFor(() => {
      expect(answers).toHaveLength(2)
    })
    expect(answers[1]?.options).toEqual({ deliveryId: 'test-delivery', confirmedWake: false })
  })

  it('clears the selection when the detail dismisses the item (D-13)', async () => {
    const item = makeItem({ title: 'Dismiss me' })
    const dismiss = vi.fn(async () => undefined)
    renderPage(new FakeInbox(readyState(makeSnapshot([item]))), createPageStore(), { dismiss })
    fireEvent.click(screen.getByRole('button', { name: 'Select Dismiss me' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => {
      expect(screen.getByText('Select an item')).toBeTruthy()
    })
    expect(dismiss).toHaveBeenCalled()
  })

  it('shows a handled notice when the selected item leaves the section (D-13)', async () => {
    const inbox = new FakeInbox(readyState(makeSnapshot([makeItem({ title: 'Handled item' })]), { readKey: 'needs-you' }))
    renderPage(inbox, createPageStore())
    fireEvent.click(screen.getByRole('button', { name: 'Select Handled item' }))
    inbox.set(readyState(makeSnapshot([]), { readKey: 'needs-you' }))
    await waitFor(() => {
      expect(screen.getByText('That item is no longer in this list.')).toBeTruthy()
    })
  })

  it('does not dismiss a candidate through the generic keyboard shortcut (D-16)', () => {
    let hooks: { onShortcut(action: string): void } | undefined
    const dismiss = vi.fn(async () => undefined)
    const page = createPageStore({ tab: 'candidates' })
    page.actions.select('candidate-1')
    renderPage(
      new FakeInbox(readyState(makeSnapshot([makeItem({ id: 'candidate-1', tier: 'candidate', severity: 3, title: 'Maybe an item?' })]))),
      page,
      {
        dismiss,
        shortcuts: {
          bind: (next) => { hooks = next as typeof hooks; return () => undefined },
          keys: () => ({ next: ['j'], previous: ['k'], select: ['Enter'], clear: ['Esc'], send: ['Mod+Enter'], snooze: ['s'], dismiss: ['d'] }),
        },
      },
    )
    hooks?.onShortcut('dismiss')
    hooks?.onShortcut('snooze')
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('surfaces the keyboard hint line when shortcuts are injected', () => {
    renderPage(new FakeInbox(readyState(makeSnapshot([makeItem()]))), createPageStore(), {
      shortcuts: {
        bind: () => () => undefined,
        keys: () => ({ next: ['j'], previous: ['k'], select: ['Enter'], clear: ['Esc'], send: ['Mod+Enter'], snooze: ['s'], dismiss: ['d'] }),
      },
    })
    expect(screen.getByText(/J\/K move/u)).toBeTruthy()
  })

  it('keeps reply controls disabled when the composition injects no settle seam', () => {
    renderPage(new FakeInbox(readyState(makeSnapshot([makeItem({ kind: 'approval', title: 'Registry access' })]))))
    expect(screen.getByRole('button', { name: 'Allow once' })).toHaveProperty('disabled', true)
  })
})


describe('candidate confirmation', () => {
  /** One candidate row as the prose gate would have raised it. */
  function candidate(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
    return makeItem({
      id: 'candidate-1',
      tier: 'candidate',
      severity: 3,
      title: 'Also update the docs?',
      quote: 'Want me to also update the docs?',
      detectedBy: ['regex-gate'],
      source: { sessionId: 'session-1', sessionTitle: 'Docs review', turn: 4 },
      ...overrides,
    })
  }

  /** The candidate seam with an honest bulk write. */
  function fakeCandidates(options: {
    readonly promote?: (item: OpenItemRecord, patch?: CandidatePromotePatch) => Promise<CandidateResult>
    readonly promoteMany?: (targets: readonly CandidateTarget[]) => Promise<CandidateBulkResult>
    readonly suppress?: (item: OpenItemRecord) => Promise<CandidateResult>
  } = {}): CandidateActions {
    return {
      promote: options.promote ?? (async () => ({ ok: true } as const)),
      suppress: options.suppress ?? (async () => ({ ok: true } as const)),
      promoteMany: options.promoteMany ?? (async targets => ({ confirmed: targets.length, failed: 0, failures: [] })),
    }
  }

  it('promotes a candidate from its row with the version the row showed and a projected title', async () => {
    const promote = vi.fn(async (_item: OpenItemRecord, _patch?: CandidatePromotePatch) => ({ ok: true } as const))
    const page = createPageStore({ tab: 'candidates' })
    renderPage(
      new FakeInbox(readyState(makeSnapshot([candidate()]))),
      page,
      { candidates: fakeCandidates({ promote }) },
    )
    fireEvent.click(screen.getByRole('button', { name: t('candidate.action.promote') }))
    await waitFor(() => {
      expect(promote).toHaveBeenCalledTimes(1)
    })
    expect(promote.mock.calls[0]?.[0]).toMatchObject({ id: 'candidate-1', version: 1 })
    // The quick confirm still corrects the durable title (no picker on the row).
    expect(promote.mock.calls[0]?.[1]).toEqual({ kind: 'decision', title: 'Also update the docs?' })
  })

  it('suppresses a candidate from its row and keeps both controls disabled while writing', async () => {
    let finish!: (value: CandidateResult) => void
    const suppress = vi.fn(() => new Promise<CandidateResult>((resolve) => { finish = resolve }))
    const page = createPageStore({ tab: 'candidates' })
    renderPage(
      new FakeInbox(readyState(makeSnapshot([candidate()]))),
      page,
      { candidates: fakeCandidates({ suppress }) },
    )
    fireEvent.click(screen.getByRole('button', { name: t('candidate.action.suppress') }))
    const dialog = screen.getByRole('dialog', { name: t('candidate.suppress.title') })
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: t('candidate.action.suppress') }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: t('candidate.action.suppress') })).toHaveProperty('disabled', true)
    })
    expect(screen.getByRole('button', { name: t('candidate.action.promote') })).toHaveProperty('disabled', true)
    finish({ ok: true })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: t('candidate.action.suppress') })).toHaveProperty('disabled', false)
    })
  })

  it('keeps a refused candidate write readable beside the row and retries the same action', async () => {
    const promote = vi.fn(async (_item: OpenItemRecord, _patch?: CandidatePromotePatch) => ({
      ok: false,
      message: 'Could not update “Also update the docs?”: it changed since you saw it.',
    } as const))
    const page = createPageStore({ tab: 'candidates' })
    renderPage(
      new FakeInbox(readyState(makeSnapshot([candidate()]))),
      page,
      { candidates: fakeCandidates({ promote }) },
    )
    fireEvent.click(screen.getByRole('button', { name: t('candidate.action.promote') }))
    await waitFor(() => {
      expect(screen.getByText(/it changed since you saw it/u)).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: t('answer.retry') }))
    await waitFor(() => {
      expect(promote).toHaveBeenCalledTimes(2)
    })
  })

  it('does not offer Snooze or Dismiss as candidate rejections (one rejection path)', () => {
    const page = createPageStore({ tab: 'candidates' })
    page.actions.select('candidate-1')
    renderPage(
      new FakeInbox(readyState(makeSnapshot([candidate()]))),
      page,
      {
        candidates: fakeCandidates(),
        dismiss: vi.fn(async () => undefined),
        snooze: vi.fn(async () => undefined),
      },
    )
    const detail = screen.getByRole('region', { name: t('detail.aria') })
    expect(within(detail).queryByRole('button', { name: t('detail.snooze') })).toBeNull()
    expect(within(detail).queryByRole('button', { name: t('detail.dismiss') })).toBeNull()
    expect(within(detail).getByRole('button', { name: t('candidate.action.suppress') })).toBeTruthy()
  })

  it('reviews ticked candidates before confirming, then writes the batch once', async () => {
    const first = candidate({ id: 'candidate-1', title: 'First inference' })
    const second = candidate({ id: 'candidate-2', title: 'Second inference' })
    const promoteMany = vi.fn(async (_targets: readonly CandidateTarget[]) => ({ confirmed: 2, failed: 0, failures: [] }))
    const page = createPageStore({ tab: 'candidates' })
    renderPage(
      new FakeInbox(readyState(makeSnapshot([first, second]))),
      page,
      { candidates: fakeCandidates({ promoteMany }) },
    )
    fireEvent.click(screen.getByRole('checkbox', { name: t('candidate.bulk.select', { title: 'First inference' }) }))
    fireEvent.click(screen.getByRole('checkbox', { name: t('candidate.bulk.select', { title: 'Second inference' }) }))
    expect(screen.getByText('2 candidates selected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('candidate.bulk.confirm.other', { count: 2 }) }))
    // Nothing is written from the bar: the review step lists each projected title
    // and its inferred kind first.
    const dialog = screen.getByRole('dialog', { name: t('candidate.bulk.review.title') })
    expect(within(dialog).getByText('First inference')).toBeTruthy()
    expect(within(dialog).getByText('Second inference')).toBeTruthy()
    expect(dialog.textContent ?? '').toContain(t('candidate.bulk.review.note'))
    expect(promoteMany).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: t('candidate.bulk.review.confirm') }))
    await waitFor(() => {
      expect(promoteMany).toHaveBeenCalledTimes(1)
    })
    const targets = promoteMany.mock.calls[0]?.[0] ?? []
    expect(targets.map(target => target.item.id).sort()).toEqual(['candidate-1', 'candidate-2'])
    expect(targets.every(target => target.patch?.kind === 'decision')).toBe(true)
    await waitFor(() => {
      expect(screen.queryByText('2 candidates selected')).toBeNull()
    })
  })

  it('lets the review correct a kind before the batch write', async () => {
    const promoteMany = vi.fn(async (_targets: readonly CandidateTarget[]) => ({ confirmed: 1, failed: 0, failures: [] }))
    const page = createPageStore({ tab: 'candidates' })
    renderPage(
      new FakeInbox(readyState(makeSnapshot([candidate({ title: 'First inference' })]))),
      page,
      { candidates: fakeCandidates({ promoteMany }) },
    )
    fireEvent.click(screen.getByRole('checkbox', { name: t('candidate.bulk.select', { title: 'First inference' }) }))
    fireEvent.click(screen.getByRole('button', { name: t('candidate.bulk.confirm.one', { count: 1 }) }))
    const dialog = screen.getByRole('dialog', { name: t('candidate.bulk.review.title') })
    fireEvent.click(within(dialog).getByRole('button', { name: t('candidate.kind.choose', { title: 'First inference' }) }))
    fireEvent.click(within(dialog).getByRole('menuitem', { name: 'Question' }))
    fireEvent.click(within(dialog).getByRole('button', { name: t('candidate.bulk.review.confirm') }))
    await waitFor(() => {
      expect(promoteMany).toHaveBeenCalledTimes(1)
    })
    expect(promoteMany.mock.calls[0]?.[0]).toEqual([
      { item: expect.objectContaining({ id: 'candidate-1' }), patch: { kind: 'question', title: 'First inference' } },
    ])
  })

  it('reports which bulk confirmations failed without clearing the reason', async () => {
    const first = candidate({ id: 'candidate-1', title: 'First inference' })
    const second = candidate({ id: 'candidate-2', title: 'Second inference' })
    const page = createPageStore({ tab: 'candidates' })
    renderPage(
      new FakeInbox(readyState(makeSnapshot([first, second]))),
      page,
      {
        candidates: fakeCandidates({
          promoteMany: async () => ({
            confirmed: 1,
            failed: 1,
            failures: [{ itemId: 'candidate-2', message: 'Could not update “Second inference”: it changed since you saw it.' }],
          }),
        }),
      },
    )
    fireEvent.click(screen.getByRole('checkbox', { name: t('candidate.bulk.select', { title: 'First inference' }) }))
    fireEvent.click(screen.getByRole('checkbox', { name: t('candidate.bulk.select', { title: 'Second inference' }) }))
    fireEvent.click(screen.getByRole('button', { name: t('candidate.bulk.confirm.other', { count: 2 }) }))
    fireEvent.click(within(screen.getByRole('dialog', { name: t('candidate.bulk.review.title') })).getByRole('button', { name: t('candidate.bulk.review.confirm') }))
    await waitFor(() => {
      expect(screen.getByText('1 candidate could not be confirmed — see its row')).toBeTruthy()
    })
    // The refusal stays beside the row it belongs to, not only in the count.
    expect(screen.getByText(/Could not update “Second inference”/u)).toBeTruthy()
  })

  it('does not offer bulk checkboxes outside the Candidates tab', () => {
    renderPage(new FakeInbox(readyState(makeSnapshot([makeItem({ title: 'A needs-you item' })]))))
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('explains the honest capture semantics above the candidate list', () => {
    const page = createPageStore({ tab: 'candidates' })
    renderPage(
      new FakeInbox(readyState(makeSnapshot([candidate()]))),
      page,
      { candidates: fakeCandidates() },
    )
    expect(screen.getByText(t('candidates.caption', { count: 1 }))).toBeTruthy()
    expect(screen.getByText(/Detected in the final message of a turn/u)).toBeTruthy()
  })

  it('annotates candidates from the same session and turn with their sibling count', () => {
    const first = candidate({ id: 'candidate-1', title: 'E — Ship together?' })
    const second = candidate({ id: 'candidate-2', title: 'D — Keep the buttons?' })
    const page = createPageStore({ tab: 'candidates' })
    renderPage(
      new FakeInbox(readyState(makeSnapshot([first, second]))),
      page,
      { candidates: fakeCandidates() },
    )
    expect(screen.getAllByText(t('candidate.evidence.siblings', { count: 2, turn: 4 })).length).toBe(2)
  })

  it('prunes ticks a narrow filter hides and says how many were dropped', async () => {
    const first = candidate({ id: 'candidate-1', title: 'First inference' })
    const second = candidate({ id: 'candidate-2', title: 'Second inference' })
    const page = createPageStore({ tab: 'candidates' })
    renderPage(
      new FakeInbox(readyState(makeSnapshot([first, second]))),
      page,
      { candidates: fakeCandidates() },
    )
    fireEvent.click(screen.getByRole('checkbox', { name: t('candidate.bulk.select', { title: 'First inference' }) }))
    fireEvent.click(screen.getByRole('checkbox', { name: t('candidate.bulk.select', { title: 'Second inference' }) }))
    expect(screen.getByText('2 candidates selected')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: t('controls.filter.aria') }), { target: { value: 'First' } })
    await waitFor(() => {
      expect(screen.getByText('1 candidate selected')).toBeTruthy()
    })
    expect(screen.getByText(t('candidate.bulk.stale.one', { count: 1 }))).toBeTruthy()
  })

  it('shows the candidate review surface in the detail pane with editable title and kind', async () => {
    const promote = vi.fn(async (_item: OpenItemRecord, _patch?: CandidatePromotePatch) => ({ ok: true } as const))
    const page = createPageStore({ tab: 'candidates' })
    page.actions.select('candidate-1')
    renderPage(
      new FakeInbox(readyState(makeSnapshot([candidate()]))),
      page,
      { candidates: fakeCandidates({ promote }) },
    )
    const detail = screen.getByRole('region', { name: t('detail.aria') })
    expect(within(detail).getByText(t('candidate.heading'))).toBeTruthy()
    expect(within(detail).getByText(t('candidate.context.decision'))).toBeTruthy()
    expect(within(detail).getByText(t('candidate.evidence.detail'))).toBeTruthy()
    // Kind is inferred and correctable; the title is editable before confirming.
    expect(within(detail).getByRole('button', { name: t('candidate.kind.choose', { title: 'Also update the docs?' }) })).toBeTruthy()
    const titleField = within(detail).getByRole('textbox', { name: t('candidate.title.label') })
    expect(titleField).toHaveProperty('value', 'Also update the docs?')
    fireEvent.change(titleField, { target: { value: 'Update the docs before shipping' } })
    fireEvent.click(within(detail).getByRole('button', { name: t('candidate.action.promote') }))
    await waitFor(() => {
      expect(promote).toHaveBeenCalledTimes(1)
    })
    expect(promote.mock.calls[0]?.[1]).toEqual({ kind: 'decision', title: 'Update the docs before shipping' })
    expect(document.body.textContent ?? '').not.toContain('review-only')
  })

  it('never renders the detector body on a candidate or a promoted prose item', () => {
    const detectorBody = 'This session ended a turn with a decision request; confirm to turn it into an item.'
    const page = createPageStore({ tab: 'candidates' })
    page.actions.select('candidate-1')
    renderPage(
      new FakeInbox(readyState(makeSnapshot([candidate({ body: detectorBody })]))),
      page,
      { candidates: fakeCandidates() },
    )
    const detail = screen.getByRole('region', { name: t('detail.aria') })
    expect(within(detail).queryByText(detectorBody)).toBeNull()
  })

  it('renders the source quote and options of an inferred candidate and carries the options into the confirm', async () => {
    const promote = vi.fn(async (_item: OpenItemRecord, _patch?: CandidatePromotePatch) => ({ ok: true } as const))
    const page = createPageStore({ tab: 'candidates' })
    page.actions.select('candidate-1')
    renderPage(
      new FakeInbox(readyState(makeSnapshot([candidate({
        quote: 'Ship together as one PR/branch or two?',
        options: ['(a) One PR/branches', '(b) Two PRs'],
        reply: { controls: ['option', 'text'], options: ['(a) One PR/branches', '(b) Two PRs'], freeText: true, requiresConfirm: true },
      })]))),
      page,
      { candidates: fakeCandidates({ promote }) },
    )
    const detail = screen.getByRole('region', { name: t('detail.aria') })
    expect(within(detail).getByText(t('candidate.options.title'))).toBeTruthy()
    expect(within(detail).getByText('(a) One PR/branches')).toBeTruthy()
    expect(within(detail).getByText(t('candidate.source.title'))).toBeTruthy()
    expect(within(detail).getByText('Ship together as one PR/branch or two?')).toBeTruthy()
    fireEvent.click(within(detail).getByRole('button', { name: t('candidate.action.promote') }))
    await waitFor(() => {
      expect(promote).toHaveBeenCalledTimes(1)
    })
    // The choices travel with the confirm, so the promoted item keeps its answer
    // options instead of silently becoming free text.
    expect(promote.mock.calls[0]?.[1]).toEqual({
      kind: 'decision',
      title: 'Also update the docs?',
      options: ['(a) One PR/branches', '(b) Two PRs'],
    })
  })
})
