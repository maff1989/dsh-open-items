// @vitest-environment jsdom
/**
 * The read-only resolved detail (UI.md §5.1): the three sections, the verbatim
 * decision, the delivery/evidence record, the honest acknowledgement, Reopen
 * (including its refusals), Copy, the History disclosure and the disabled
 * Delete-forever entry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('./primitives-mock'))
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { ResolvedDetail, type ResolvedDetailProps } from '../../src/client/ui/register/resolved-detail'
import { at, makeAnswered, makeArchived, makeDetected, makeDismissed, makeInFlight, makeRecent } from './register-fixtures'
import { NOW } from './register-fixtures'
import { t } from './fixtures'

afterEach(cleanup)

/** Render the detail with the given seams. */
function renderDetail(overrides: Partial<ResolvedDetailProps> = {}): void {
  const props: ResolvedDetailProps = {
    record: makeRecent(),
    t,
    now: NOW,
    onBack: vi.fn(),
    busy: false,
    onReopen: vi.fn(),
    ...overrides,
  }
  render(<ResolvedDetail {...props} />)
}

/** The detail region. */
function detail(): HTMLElement {
  return screen.getByRole('region', { name: 'Resolved item' })
}

describe('resolved detail: what you decided', () => {
  it('renders the stored payload verbatim, with its note', () => {
    renderDetail({ record: makeAnswered() })
    const region = detail()
    expect(within(region).getByRole('heading', { name: 'What you decided' })).toBeTruthy()
    expect(within(region).getByText('allowed once — note: corporate registry only')).toBeTruthy()
    // The body and quote are context, not a rewrite of the decision.
    expect(within(region).getByText('The agent asked for one sandbox escalation.')).toBeTruthy()
  })

  it('renders a text decision and its provenance', () => {
    renderDetail({ record: makeRecent() })
    expect(within(detail()).getByText('Leave it scroll-only for now.')).toBeTruthy()
    expect(within(detail()).getByText('dsh-highlights review')).toBeTruthy()
    expect(within(detail()).getByText('turn 4')).toBeTruthy()
  })

  it('prefers the catalogue Session title over a record with no snapshot title', () => {
    renderDetail({ record: makeRecent({ source: { sessionId: 'session-1' } }), sessionTitle: () => 'Plugin implementation and docs review' })
    expect(within(detail()).getByText('Plugin implementation and docs review')).toBeTruthy()
  })

  it('falls back to the honest untitled label, never claiming deletion', () => {
    renderDetail({ record: makeRecent({ source: { sessionId: 'session-1' } }) })
    expect(within(detail()).getByText('(untitled session)')).toBeTruthy()
    expect(document.body.textContent ?? '').not.toContain('(deleted session)')
  })

  it('names the detector for a detector-closed record', () => {
    renderDetail({ record: makeDetected() })
    expect(within(detail()).getByText('Detector')).toBeTruthy()
    expect(within(detail()).getByText('goal/change:resumed')).toBeTruthy()
  })

  it('renders a dismissal as not an item, without an acknowledgement claim', () => {
    renderDetail({ record: makeDismissed() })
    expect(within(detail()).getByText('not an item — note: not an item, docs follow-up')).toBeTruthy()
    expect(within(detail()).getByText('—')).toBeTruthy()
  })
})

describe('resolved detail: how it travelled and what happened next', () => {
  it('shows the track, delivery id and log evidence', () => {
    renderDetail({ record: makeAnswered() })
    const region = detail()
    expect(within(region).getByRole('heading', { name: 'How it travelled' })).toBeTruthy()
    expect(within(region).getByText(/client-settle · Applied/u)).toBeTruthy()
    expect(within(region).getByText('delivery-1')).toBeTruthy()
    expect(within(region).getAllByText(/seq 412/u).length).toBeGreaterThan(0)
  })

  it('says a dismissal had no delivery instead of inventing one', () => {
    renderDetail({ record: makeDismissed() })
    expect(within(detail()).getByText(/No delivery was recorded/u)).toBeTruthy()
  })

  it('states the acknowledgement with its evidence and time', () => {
    renderDetail({ record: makeAnswered() })
    const region = detail()
    expect(within(region).getByRole('heading', { name: 'What happened next' })).toBeTruthy()
    expect(within(region).getByText(/acknowledged by the retried call/u)).toBeTruthy()
  })

  it('states "no acknowledgement observed" when the window elapsed', () => {
    renderDetail({ record: makeRecent() })
    expect(within(detail()).getByText('no acknowledgement observed')).toBeTruthy()
  })

  it('marks an in-flight answer as awaiting the session', () => {
    renderDetail({ record: makeInFlight() })
    expect(within(detail()).getAllByText(/This answer is in flight/u).length).toBeGreaterThan(0)
    expect(within(detail()).getByText('awaiting acknowledgement')).toBeTruthy()
  })

  it('shows the archived banner when the transcript text was dropped', () => {
    renderDetail({ record: makeArchived() })
    expect(within(detail()).getByText(/In the archive: the transcript excerpt is no longer stored/u)).toBeTruthy()
  })
})

describe('resolved detail: actions', () => {
  it('offers Reopen and sends the item id', () => {
    const onReopen = vi.fn()
    renderDetail({ record: makeRecent(), onReopen })
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(onReopen).toHaveBeenCalledWith('reg-recent')
  })

  it('shows progress while the reopen is in flight', () => {
    renderDetail({ record: makeRecent(), busy: true })
    expect(screen.getByRole('button', { name: 'Reopening…' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Reopening…' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('refuses to reopen an approval whose permission was exercised, and says why', () => {
    renderDetail({ record: makeAnswered() })
    const reopen = screen.getByRole('button', { name: 'Reopen' }) as HTMLButtonElement
    expect(reopen.disabled).toBe(true)
    expect(reopen.title).toMatch(/A permission that was already exercised/u)
  })

  it('disables Reopen when the seam is unavailable', () => {
    renderDetail({ onReopen: undefined })
    const reopen = screen.getByRole('button', { name: 'Reopen' }) as HTMLButtonElement
    expect(reopen.disabled).toBe(true)
    expect(reopen.title).toMatch(/Host route/u)
  })

  it('copies the decision and reports the result', async () => {
    const copy = vi.fn(async () => true)
    renderDetail({ record: makeRecent(), copy })
    fireEvent.click(screen.getByRole('button', { name: 'Copy decision' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy())
    expect(copy).toHaveBeenCalledWith('Leave it scroll-only for now.')
  })

  it('reports a failed copy instead of claiming success', async () => {
    const copy = vi.fn(async () => false)
    renderDetail({ record: makeRecent(), copy })
    fireEvent.click(screen.getByRole('button', { name: 'Copy decision' }))
    await waitFor(() => expect(screen.getByText('Could not copy')).toBeTruthy())
  })

  it('shows a reopen success notice from the store', () => {
    renderDetail({
      record: makeRecent(),
      notice: { tone: 'ok', code: 'reopened' },
      onDismissNotice: vi.fn(),
    })
    expect(screen.getByText('Reopened — it is back in Needs you.')).toBeTruthy()
  })

  it('shows a reopen refusal with its reason', () => {
    renderDetail({ record: makeRecent(), notice: { tone: 'error', code: 'reopen-failed', message: 'conflict' } })
    expect(screen.getByText('Could not reopen: conflict')).toBeTruthy()
  })

  it('offers delete-forever through a menu whose confirmation needs the acknowledgement', async () => {
    const onDelete = vi.fn(async () => true)
    renderDetail({ record: makeRecent(), onDelete })
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete forever' }))
    const confirm = screen.getByRole('button', { name: 'Delete forever' })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand this cannot be undone' }))
    fireEvent.click(confirm)
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('reg-recent', expect.any(Number)))
  })

  it('keeps the delete row disabled with its reason when the seam is absent', () => {
    renderDetail({ record: makeRecent() })
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    const row = screen.getByRole('menuitem', { name: 'Delete forever' }) as HTMLButtonElement
    expect(row.disabled).toBe(true)
    expect(row.getAttribute('data-disabled-reason')).toContain('Deletion is not wired in this build yet.')
  })
})

describe('resolved detail: history', () => {
  it('discloses earlier resolutions and the reopen count', () => {
    const record = makeRecent({
      reopenCount: 2,
      resolutionLog: [
        {
          kind: 'dismissed',
          at: at(-4, 9, 0),
          actor: 'user',
          payload: { type: 'dismiss', reason: 'later' },
        },
      ],
      history: [
        { at: at(-5, 9, 0), action: 'raised' },
        { at: at(-4, 9, 0), action: 'dismissed', detail: 'later' },
        { at: at(-3, 12, 0), action: 'reopened', detail: 'was resolved' },
      ],
    })
    renderDetail({ record })
    const disclosure = screen.getByRole('button', { name: /History · reopened 2 times/u })
    fireEvent.click(disclosure)
    expect(screen.getAllByText(/dismissed · /u).length).toBeGreaterThan(0)
    expect(screen.getByText(/raised · /u)).toBeTruthy()
  })

  it('omits the disclosure when there is only one cycle', () => {
    renderDetail({ record: makeRecent() })
    expect(screen.queryByText(/History/u)).toBeNull()
  })
})
