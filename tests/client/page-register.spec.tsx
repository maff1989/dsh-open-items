// @vitest-environment jsdom
/**
 * Page integration of the Resolved tab: the shell mounts the register from the
 * injected seam, hides the inbox-only controls, keeps one store for the list and
 * the wide detail, and refreshes the inbox after a reopen. Without the seam the
 * tab says the register is unavailable instead of looking empty.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('./primitives-mock'))
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

import { InboxPage, type InboxPageProps } from '../../src/client/ui/page'
import { createPageStore } from '../../src/client/data/page-store'
import type { InboxState } from '../../src/client/data/inbox-store'
import type { InboxSnapshot } from '../../src/shared/schema'
import { makeItem, makeSnapshot, t } from './fixtures'
import { NOW, makeAnswered, makeDismissed, makeInFlight } from './register-fixtures'
import { fakeRegisterStore, readyState } from './register-test-store'

afterEach(cleanup)

/** Hand-writable inbox source for the page shell. */
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
}

/** Ready inbox state with an open item so the other tabs have content. */
function inboxState(snapshot: InboxSnapshot = makeSnapshot([
  makeItem({ id: 'open-1', title: 'Open item', source: { sessionId: 'session-1', sessionTitle: 'Chat' } }),
])): InboxState {
  return {
    status: 'ready',
    snapshot,
    hello: undefined,
    error: undefined,
    offline: false,
    lastReadAt: NOW,
    refreshing: false,
  }
}

/** Render the page with an optional register seam. */
function renderPage(options: { readonly withRegister: boolean }): {
  actions: ReturnType<typeof fakeRegisterStore>['actions']
  refresh: ReturnType<typeof vi.fn>
} {
  const inbox = new FakeInbox(inboxState())
  const page = createPageStore()
  const refresh = vi.fn()
  const fake = fakeRegisterStore(readyState(
    [makeAnswered(), makeDismissed()],
    [makeInFlight()],
    { total: 2 },
  ))
  /** Bound hooks compartment of the registration. */
  function useSnap<S>(selector: (state: InboxState) => S): S {
    return useSyncExternalStore(inbox.source.subscribe, () => selector(inbox.source.getSnapshot()))
  }
  const props = {
    t,
    page,
    refresh,
    useSnap,
    ...(options.withRegister ? { registerUi: { store: fake.store } } : {}),
  } as unknown as InboxPageProps
  render(<InboxPage {...props} />)
  return { actions: fake.actions, refresh }
}

/** Switch the page to the Resolved tab. */
function openResolvedTab(): void {
  fireEvent.click(screen.getByRole('tab', { name: /Resolved/ }))
}

describe('page + register seam', () => {
  it('mounts the register when the Resolved tab opens', () => {
    renderPage({ withRegister: true })
    expect(screen.queryByText(/resolved · /u)).toBeNull()
    openResolvedTab()
    expect(screen.getByText(/2 resolved · 1 in flight · 0 archived · nothing pruned/u)).toBeTruthy()
    expect(screen.getByText('Install the corporate registry')).toBeTruthy()
  })

  it('hides the inbox-only grouping and workspace controls on the Resolved tab', () => {
    renderPage({ withRegister: true })
    expect(screen.getByRole('button', { name: 'Group items by' })).toBeTruthy()
    openResolvedTab()
    expect(screen.queryByRole('button', { name: 'Group items by' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Workspace filter' })).toBeNull()
    // The register's own filters are present instead.
    expect(screen.getByRole('button', { name: 'Source' })).toBeTruthy()
  })

  it('shows the read-only detail in the page detail column and reopens through the store', async () => {
    const { actions, refresh } = renderPage({ withRegister: true })
    openResolvedTab()
    fireEvent.click(screen.getByRole('button', { name: 'Select Install the corporate registry' }))
    const regions = screen.getAllByRole('region', { name: 'Resolved item' })
    expect(regions.length).toBeGreaterThan(0)
    expect(screen.getAllByText('What you decided').length).toBeGreaterThan(0)

    // The answered approval was already exercised: Reopen is refused in place.
    const reopenButtons = screen.getAllByRole('button', { name: 'Reopen' }) as HTMLButtonElement[]
    expect(reopenButtons.length).toBeGreaterThan(0)
    expect(reopenButtons.some(button => button.disabled)).toBe(true)

    // A reopenable row (the dismissal) reopens and refreshes the inbox.
    fireEvent.click(screen.getByRole('button', { name: 'Select Want me to also update the docs?' }))
    const enabled = screen.getAllByRole('button', { name: 'Reopen' }).find(button => !(button as HTMLButtonElement).disabled)
    expect(enabled).toBeDefined()
    fireEvent.click(enabled as HTMLElement)
    await waitFor(() => expect(actions.reopen).toHaveBeenCalledWith('reg-dismissed'))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('says the register is unavailable when the composition has no seam', () => {
    renderPage({ withRegister: false })
    openResolvedTab()
    expect(screen.getByText("The register isn't available in this build yet.")).toBeTruthy()
    // The other tabs still work: no regression for a composition without the seam.
    fireEvent.click(screen.getByRole('tab', { name: /Needs you/ }))
    expect(screen.getByText('Open item')).toBeTruthy()
  })
})
