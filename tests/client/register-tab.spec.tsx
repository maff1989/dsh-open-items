// @vitest-environment jsdom
/**
 * The Resolved tab at the DOM level: the honest header, the in-flight band, the
 * filter bar, day grouping and order, source indicators, empty/error states, the
 * load-more path and the export dialog wiring.
 *
 * Store behaviour (queries, paging, reopen) is covered by the store suite; this
 * file asserts what a reader sees.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('./primitives-mock'))
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'

import type { RegisterStore } from '../../src/client/data/register-store'

import { RegisterTab } from '../../src/client/ui/register/register-tab'
import { t } from './fixtures'
import {
  NOW,
  makeAnswered,
  makeArchived,
  makeDetected,
  makeDismissed,
  makeInFlight,
  makeRecent,
} from './register-fixtures'
import { fakeRegisterStore, readyState } from './register-test-store'
import type { RegisterState } from '../../src/client/data/register-store'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** Subscribing host for the tab, so a store action re-renders it like the page. */
function Harness({ store, sessionTitle }: {
  readonly store: RegisterStore
  readonly sessionTitle?: (sessionId: string) => string | undefined
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  return (
    <RegisterTab
      t={t}
      now={NOW}
      store={store}
      state={state}
      {...(sessionTitle === undefined ? {} : { sessionTitle })}
    />
  )
}

/** Render the tab over a fake store. */
function renderTab(state: RegisterState): {
  actions: ReturnType<typeof fakeRegisterStore>['actions']
  setState: (patch: Partial<RegisterState>) => void
} {
  const fake = fakeRegisterStore(state)
  render(<Harness store={fake.store} />)
  return { actions: fake.actions, setState: fake.setState }
}

/** ids of the rendered rows, in DOM order. */
function renderedIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('li.dsh-oi-regRow')]
    .map(node => node.dataset['itemId'] ?? '')
}

describe('Resolved tab: header and rows', () => {
  it('states the counts and the completeness claim', () => {
    renderTab(readyState([makeAnswered(), makeDismissed(), makeRecent()], [makeInFlight()]))
    expect(screen.getByText(/3 resolved · 1 in flight · 0 archived · nothing pruned/u)).toBeTruthy()
  })

  it('says when earlier records were pruned, and when rows were compacted', () => {
    renderTab(readyState(
      [makeAnswered(), makeArchived()],
      [],
      { earlierRecordsPruned: true, total: 2, archived: 1 },
    ))
    expect(screen.getByText(/earlier records pruned/u)).toBeTruthy()
    expect(screen.getByText(/1 compacted/u)).toBeTruthy()
    expect(screen.queryByText(/nothing pruned/u)).toBeNull()
  })

  it('resolves the Session label from the catalogue, and never claims deletion', () => {
    const untitled = makeAnswered({ source: { sessionId: 'session-1' } })
    const first = render(<Harness store={fakeRegisterStore(readyState([untitled])).store} sessionTitle={() => 'Plugin implementation and docs review'} />)
    expect(screen.getByText('Plugin implementation and docs review')).toBeTruthy()
    first.unmount()
    render(<Harness store={fakeRegisterStore(readyState([untitled])).store} />)
    expect(screen.getByText('(untitled session)')).toBeTruthy()
    expect(document.body.textContent ?? '').not.toContain('(deleted session)')
  })

  it('renders the row anatomy: source word, decision, title, provenance, acknowledgement', () => {
    renderTab(readyState([makeAnswered()]))
    expect(screen.getByText('by you')).toBeTruthy()
    expect(screen.getByText('allowed once — note: corporate registry only')).toBeTruthy()
    expect(screen.getByText('Install the corporate registry')).toBeTruthy()
    expect(screen.getByText('acknowledged by the retried call')).toBeTruthy()
    expect(screen.getByText('dsh-highlights review')).toBeTruthy()
    expect(screen.getByText(/turn 4/u)).toBeTruthy()
  })

  it('marks a dismissal as by you and not as a missing acknowledgement', () => {
    renderTab(readyState([makeDismissed()]))
    expect(screen.getByText('by you')).toBeTruthy()
    expect(screen.getByText('not an item — note: not an item, docs follow-up')).toBeTruthy()
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.queryByText('no acknowledgement observed')).toBeNull()
  })

  it('names the detector on an automatically closed row', () => {
    renderTab(readyState([makeDetected()]))
    expect(screen.getByText('automatic')).toBeTruthy()
    expect(screen.getByText(/goal changed/u)).toBeTruthy()
    expect(screen.getByText('goal/change:resumed')).toBeTruthy()
  })

  it('groups by day, newest first, with per-day counts and stable order', () => {
    renderTab(readyState([makeAnswered(), makeDismissed(), makeRecent()]))
    const headings = [...document.querySelectorAll<HTMLElement>('.dsh-oi-regDayTitle')]
      .map(node => node.textContent ?? '')
    expect(headings).toHaveLength(2)
    expect(headings[0]).toContain('Today')
    expect(headings[0]).toContain('2 decisions')
    expect(headings[1]).not.toContain('Today')
    expect(renderedIds()).toEqual(['reg-answered', 'reg-dismissed', 'reg-recent'])
    // The day sections carry their day key for styling and tools.
    const days = [...document.querySelectorAll<HTMLElement>('section[data-day]')].map(node => node.dataset['day'])
    expect(days).toHaveLength(2)
  })

  it('selects a row and shows the read-only detail inline', () => {
    const { actions } = renderTab(readyState([makeAnswered()]))
    fireEvent.click(screen.getByRole('button', { name: 'Select Install the corporate registry' }))
    expect(actions.select).toHaveBeenCalledWith('reg-answered')
    expect(screen.getByRole('region', { name: 'Resolved item' })).toBeTruthy()
    expect(screen.getByText('What you decided')).toBeTruthy()
  })
})

describe('Resolved tab: in-flight band', () => {
  it('puts answers waiting on the session in a band above the days', () => {
    renderTab(readyState([makeAnswered()], [makeInFlight()]))
    const band = screen.getByRole('region', { name: 'In flight · 1' })
    expect(within(band).getByText('in flight')).toBeTruthy()
    expect(within(band).getByText('awaiting acknowledgement')).toBeTruthy()
    // Band first in the DOM, then the day section.
    const ids = renderedIds()
    expect(ids[0]).toBe('reg-inflight')
  })
})

describe('Resolved tab: filters', () => {
  it('shows the four filter menus and the search box', () => {
    renderTab(readyState([makeAnswered()]))
    for (const name of ['Period', 'Source', 'Kind', 'Outcome']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    expect(screen.getByLabelText('Search')).toBeTruthy()
  })

  it('maps a source menu selection to the store filter', () => {
    const { actions } = renderTab(readyState([makeAnswered()]))
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Automatic' }))
    expect(actions.setFilters).toHaveBeenCalledWith({ source: 'detector' })
  })

  it('maps period, kind and outcome menu selections', () => {
    const { actions } = renderTab(readyState([makeAnswered()]))
    fireEvent.click(screen.getByRole('button', { name: 'Period' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    expect(actions.setFilters).toHaveBeenCalledWith({ period: 'archive' })
    fireEvent.click(screen.getByRole('button', { name: 'Kind' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Approval' }))
    expect(actions.setFilters).toHaveBeenCalledWith({ kind: 'approval' })
    fireEvent.click(screen.getByRole('button', { name: 'Outcome' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Dismissed' }))
    expect(actions.setFilters).toHaveBeenCalledWith({ outcome: 'dismissed' })
  })

  it('commits the search on blur so typing does not read the route per keystroke', () => {
    const { actions } = renderTab(readyState([makeAnswered()]))
    const search = screen.getByRole('textbox', { name: 'Search' })
    fireEvent.change(search, { target: { value: 'registry' } })
    fireEvent.blur(search)
    expect(actions.setFilters).toHaveBeenCalledWith({ search: 'registry' })
  })

  it('applies the per-session filter from a row session reference and shows a clearable chip', () => {
    const { actions, setState } = renderTab(readyState([makeAnswered()]))
    fireEvent.click(screen.getByRole('button', { name: 'dsh-highlights review' }))
    expect(actions.setFilters).toHaveBeenCalledWith({ sessionId: 'session-1' })

    // With the session filter active the chip is shown and clears the filter.
    setState({ filters: { ...readyState([]).filters, sessionId: 'session-1' } })
    const chip = screen.getByRole('button', { name: /session: dsh-highlights review/ })
    fireEvent.click(chip)
    expect(actions.setFilters).toHaveBeenCalledWith({ sessionId: undefined })
  })

  it('clears every filter with the Clear control', () => {
    const { actions } = renderTab(readyState([makeAnswered()], [], {
      filters: { ...readyState([]).filters, period: 'today' },
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(actions.clearFilters).toHaveBeenCalled()
  })
})

describe('Resolved tab: states', () => {
  it('renders the unfiltered empty state', () => {
    renderTab(readyState([]))
    expect(screen.getByText('No decisions yet.')).toBeTruthy()
  })

  it('renders the filtered empty state when a filter is active', () => {
    renderTab(readyState([], [], { filters: { ...readyState([]).filters, search: 'nothing' } }))
    expect(screen.getByText('No decisions match these filters.')).toBeTruthy()
  })

  it('renders the loading skeleton', () => {
    renderTab(readyState([], [], { status: 'loading' }))
    expect(screen.getByRole('status', { name: 'Loading the register…' })).toBeTruthy()
  })

  it('renders the hard error with its message and a retry', () => {
    const { actions } = renderTab(readyState([], [], { status: 'error', error: 'HTTP 500' }))
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('HTTP 500')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(actions.refresh).toHaveBeenCalled()
  })

  it('says the register is unavailable rather than pretending it is empty', () => {
    renderTab(readyState([], [], { status: 'error', error: 'register-unavailable' }))
    expect(screen.getByText("The register isn't available in this build yet.")).toBeTruthy()
    expect(screen.queryByText('No decisions yet.')).toBeNull()
  })

  it('renders the unavailable state when the page has no register seam', () => {
    render(<RegisterTab t={t} now={NOW} />)
    expect(screen.getByText("The register isn't available in this build yet.")).toBeTruthy()
  })

  it('keeps the stale rows and shows an offline banner on a carrier failure', () => {
    renderTab(readyState([makeAnswered()], [], { offline: true, lastReadAt: NOW - 120_000 }))
    expect(screen.getByText(/Can't reach the harness/u)).toBeTruthy()
    expect(screen.getByText('Install the corporate registry')).toBeTruthy()
  })

  it('offers Load more only when a cursor remains', () => {
    const withCursor = renderTab(readyState([makeAnswered()], [], { nextCursor: 'next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(withCursor.actions.loadMore).toHaveBeenCalled()
    cleanup()
    renderTab(readyState([makeAnswered()]))
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })
})

describe('Resolved tab: export dialog', () => {
  it('opens the dialog from the current filter with the filter label', () => {
    renderTab(readyState([makeAnswered(), makeDismissed()]))
    fireEvent.click(screen.getByRole('button', { name: 'Export these results' }))
    const dialog = screen.getByRole('dialog', { name: 'Export results' })
    expect(dialog).toBeTruthy()
    expect(within(dialog).getByText(/2 records · filtered to: 30 days · All sources/u)).toBeTruthy()
    expect(within(dialog).getByText(/Deterministic: the same filter exports the same file/u)).toBeTruthy()
  })

  it('passes the chosen format and options to the download seam with the frozen header fields', async () => {
    const { actions } = renderTab(readyState([makeAnswered()], [makeInFlight()]))
    fireEvent.click(screen.getByRole('button', { name: 'Export these results' }))
    const dialog = screen.getByRole('dialog', { name: 'Export results' })
    fireEvent.click(within(dialog).getByRole('tab', { name: /CSV/u }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Include transcript excerpts/u }))
    expect(within(dialog).getByText(/1 in flight: an answer is not exported/u)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export .csv' }))
    await waitFor(() => expect(actions.downloadArchive).toHaveBeenCalledTimes(1))
    expect(actions.downloadArchive).toHaveBeenCalledWith(expect.objectContaining({
      format: 'csv',
      includeExcerpts: false,
      includeArchive: false,
      generatedAt: NOW,
      pluginVersion: '9.9.9-test',
      schemaVersion: 3,
      earlierRecordsPruned: false,
      filterLabel: '30 days · All sources',
    }))
  })

  it('defaults the archive box on in the Archive period', () => {
    renderTab(readyState([makeArchived()], [], {
      filters: { ...readyState([]).filters, period: 'archive' },
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Export these results' }))
    const archive = screen.getByRole('checkbox', { name: /Include archived records/u }) as HTMLInputElement
    expect(archive.checked).toBe(true)
  })

  it('reports success with the file name and size', async () => {
    const { actions } = renderTab(readyState([makeAnswered()]))
    actions.downloadArchive.mockResolvedValueOnce({ ok: true, filename: 'open-items-abc.html', byteLength: 4096 })
    fireEvent.click(screen.getByRole('button', { name: 'Export these results' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export .html' }))
    await waitFor(() => expect(screen.getByText(/Saved open-items-abc\.html \(4\.0 KB\)/u)).toBeTruthy())
  })

  it('reports failure with the reason and keeps the dialog open', async () => {
    const { actions } = renderTab(readyState([makeAnswered()]))
    actions.downloadArchive.mockResolvedValueOnce({ ok: false, error: 'download-unavailable' })
    fireEvent.click(screen.getByRole('button', { name: 'Export these results' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export .html' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByText(/Export failed: download-unavailable/u)).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Export results' })).toBeTruthy()
  })

  it('closes the dialog on Cancel', () => {
    renderTab(readyState([makeAnswered()]))
    fireEvent.click(screen.getByRole('button', { name: 'Export these results' }))
    const dialog = screen.getByRole('dialog', { name: 'Export results' })
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Cancel' })[0] as HTMLElement)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
