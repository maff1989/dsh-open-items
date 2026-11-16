// @vitest-environment jsdom
/**
 * Nav row: OD-16 makes the row dot-only (no numeric chip); the count stays as
 * a screen-reader sentence, and the new-items dot still comes from the inbox
 * snapshot. Both stay silent (and absent) at zero.
 */
import { vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('./primitives-mock'))

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

import { InboxNavIcon, type InboxNavIconProps } from '../../src/client/ui/nav-icon'
import type { InboxState } from '../../src/client/data/inbox-store'
import { makeSnapshot, t } from './fixtures'

afterEach(cleanup)

/** State with the supplied counts and new-since marker (the row reads counts only). */
function stateWith(needsYou: number, newSinceLastVisit: number): InboxState {
  const snapshot = makeSnapshot([])
  return {
    status: 'ready',
    snapshot: { ...snapshot, counts: { ...snapshot.counts, needsYou, newSinceLastVisit } },
    hello: undefined,
    error: undefined,
    offline: false,
    lastReadAt: 1,
    refreshing: false,
  }
}

/** Render the nav occupant over a fixed state. */
function renderNav(state: InboxState, size = 20): void {
  const source: ObservableSnapshot<InboxState> = {
    getSnapshot: () => state,
    subscribe: () => () => undefined,
  }
  /**
   * The registration's hooks compartment, bound for the test.
   * @param selector - snapshot selector.
   * @returns the selected value.
   */
  function useSnap<S>(selector: (value: InboxState) => S): S {
    return useSyncExternalStore(source.subscribe, () => selector(source.getSnapshot()))
  }
  const props = { size, t, useSnap } as unknown as InboxNavIconProps
  render(<InboxNavIcon {...props} />)
}

describe('nav icon', () => {
  it('renders no numeric chip and keeps the exact count for assistive tech', () => {
    renderNav(stateWith(7, 0))
    expect(document.querySelector('.dsh-oi-navPip')).toBeNull()
    expect(document.querySelector('.dsh-oi-nav')?.getAttribute('data-count')).toBe('7')
    expect(document.body.textContent).toContain('7 items waiting')
  })

  it('keeps the full count in the accessible sentence beyond nine', () => {
    renderNav(stateWith(23, 0))
    expect(document.querySelector('.dsh-oi-navPip')).toBeNull()
    expect(document.body.textContent).toContain('23 items waiting')
  })

  it('renders no hidden count at zero', () => {
    renderNav(stateWith(0, 0))
    expect(document.querySelector('.dsh-oi-nav')).not.toBeNull()
    expect(document.body.textContent).not.toContain('waiting')
  })

  it('shows the new-items dot only when items arrived since the last visit', () => {
    renderNav(stateWith(2, 1))
    expect(document.querySelector('.dsh-oi-navDot')).toBeTruthy()
    cleanup()
    renderNav(stateWith(2, 0))
    expect(document.querySelector('.dsh-oi-navDot')).toBeNull()
  })
})
