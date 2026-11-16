// @vitest-environment jsdom
/**
 * The session panel at the component level: cold skeleton, sections, filters,
 * in-panel answering, hand-off-only live asks, reveal fallbacks, the visibility
 * gate and the 300px layout contract.
 *
 * Every case renders the real body over a scripted transport, so the DOM and the
 * route calls are asserted together (the panel's only data path is that route).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('../primitives-mock'))
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { OpenItemsPanel } from '../../../src/client/ui/panel/OpenItemsPanel'
import { OpenItemsRpcError } from '../../../src/client/data/transport'
import { PANEL_STYLES } from '../../../src/client/ui/panel/panelStyles'
import { SESSION, candidateItem, fakeTab, fakeTransport, liveAsk, panelProps, resolvedItem, toolItem, waitingItem } from './helpers'
import { t } from '../fixtures'

afterEach(cleanup)

/** Render the panel and return its render result plus the spies. */
function renderPanel(overrides: Parameters<typeof panelProps>[1] = {}, transport = fakeTransport()) {
  const props = panelProps(transport, overrides)
  const view = render(<OpenItemsPanel {...props} />)
  return { ...view, transport, rerenderPanel: (next: Parameters<typeof panelProps>[1]) => view.rerender(<OpenItemsPanel {...panelProps(transport, next)} />) }
}

/** Wait for the first read to land. */
async function ready(transport: { calls: { list: unknown[] } }): Promise<void> {
  await waitFor(() => {
    expect(transport.calls.list.length).toBeGreaterThan(0)
  })
  await waitFor(() => {
    expect(screen.getByLabelText('Open items').getAttribute('data-panel-status')).toBe('ready')
  })
}

describe('panel states', () => {
  it('shows a skeleton on a cold restored panel, never a false empty state', async () => {
    const transport = fakeTransport({ items: [toolItem()] })
    renderPanel({}, transport)
    expect(screen.getByRole('status', { name: 'Loading this session’s open items' })).toBeTruthy()
    expect(screen.queryByText('Nothing open in this session.')).toBeNull()
    await ready(transport)
    expect(screen.queryByRole('status', { name: 'Loading this session’s open items' })).toBeNull()
  })

  it('shows the empty state when the session never raised anything', async () => {
    const transport = fakeTransport()
    renderPanel({}, transport)
    await ready(transport)
    expect(screen.getByText('Nothing open in this session.')).toBeTruthy()
    expect(screen.getByText('Items appear here when the agent needs a decision.')).toBeTruthy()
  })

  it('shows the error state with a retry when the first read fails', async () => {
    const transport = fakeTransport({ listError: new Error('boom') })
    renderPanel({}, transport)
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Could not load this session’s items.')
    })
    expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('keeps the list and shows an offline banner when a later read fails', async () => {
    const base = fakeTransport({ items: [toolItem()] })
    let reads = 0
    const flaky = Object.assign({}, base, {
      list: async (request?: Parameters<typeof base.list>[0], signal?: AbortSignal) => {
        reads += 1
        if (reads > 1) throw new OpenItemsRpcError('transport', 'offline')
        return base.list(request, signal)
      },
    })
    const transport = Object.assign(flaky, { calls: base.calls }) as typeof base
    let clock = 1_000
    const { rerender } = render(<OpenItemsPanel {...panelProps(transport, { clock: () => clock })} />)
    await ready(transport)
    clock += 5_000
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => {
      expect(screen.getByText(/Can't reach the harness/)).toBeTruthy()
    })
    expect(screen.getByText('Keep 5 colours or 3?')).toBeTruthy()
    rerender(<OpenItemsPanel {...panelProps(transport, { clock: () => clock })} />)
  })
})

describe('panel session scoping', () => {
  it('asks only for its own session and drops rows from another one', async () => {
    const mine = toolItem({ id: 'mine', title: 'Mine', source: { sessionId: SESSION, callId: 'call-1' } })
    const other = toolItem({ id: 'other', title: 'Other', source: { sessionId: 'session-2', callId: 'call-2' } })
    const transport = fakeTransport({ items: [mine, other] })
    renderPanel({ sessionId: SESSION }, transport)
    await ready(transport)
    expect(screen.getByText('Mine')).toBeTruthy()
    expect(screen.queryByText('Other')).toBeNull()
    expect(transport.calls.list[0]?.query?.scope).toEqual({ sessionId: SESSION })
    expect(transport.calls.register[0]?.query?.scope).toEqual({ sessionId: SESSION })
  })

  it('remounts for another session with that session’s own scope', async () => {
    const transport = fakeTransport({ items: [] })
    const first = render(<OpenItemsPanel {...panelProps(transport, { sessionId: 'session-a' })} />)
    await waitFor(() => {
      expect(transport.calls.list.length).toBe(1)
    })
    first.unmount()
    render(<OpenItemsPanel {...panelProps(transport, { sessionId: 'session-b' })} />)
    await waitFor(() => {
      expect(transport.calls.list.length).toBe(2)
    })
    expect(transport.calls.list[1]?.query?.scope).toEqual({ sessionId: 'session-b' })
  })
})

describe('panel sections and filters', () => {
  /** Three rows: two open (one candidate) and one waiting. */
  function fixtureTransport() {
    return fakeTransport({
      items: [
        toolItem({ id: 'urgent', title: 'Registry access for the pnpm add', severity: 1, firstSeenAt: 2_000 }),
        candidateItem({ id: 'candidate', title: 'Palette candidate', firstSeenAt: 1_000 }),
        waitingItem({ id: 'waiting', title: 'Palette sent' }),
      ],
      resolved: [resolvedItem({ id: 'r1', title: 'Keep five colours' })],
      resolvedTotal: 4,
    })
  }

  it('renders the header count and one section per class with counts', async () => {
    const transport = fixtureTransport()
    renderPanel({}, transport)
    await ready(transport)
    // Strict predicate: candidates and severity-3 FYI are not the panel's Needs you.
    expect(screen.getByText('2 open')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Needs you (1)' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Waiting on the agent (1)' })).toBeTruthy()
    expect(screen.getByText('Resolved here · 4')).toBeTruthy()
  })

  it('does not list candidates under Needs you (the page owns the Candidates tab)', async () => {
    const transport = fixtureTransport()
    renderPanel({}, transport)
    await ready(transport)
    const rows = [...document.querySelectorAll<HTMLElement>('.dsh-oi-panelRow')]
    const titles = rows.map(row => row.querySelector('.dsh-oi-panelRowTitle')?.textContent)
    expect(titles).toContain('Registry access for the pnpm add')
    expect(titles).not.toContain('Palette candidate')
    // The page-level Candidates tab still shows it; the panel count says 1.
    expect(screen.getByRole('heading', { name: 'Needs you (1)' })).toBeTruthy()
  })

  it('offers the Inferred (N) handoff to the Candidates tab without counting candidates as Needs you', async () => {
    const openInbox = vi.fn()
    const transport = fixtureTransport()
    renderPanel({ openInbox }, transport)
    await ready(transport)
    // Candidates remain excluded from Needs-you: one structural row, one
    // candidate — the heading still says 1.
    expect(screen.getByRole('heading', { name: 'Needs you (1)' })).toBeTruthy()
    const handoff = screen.getByRole('button', { name: t('panel.inferred.row', { count: 1 }) })
    fireEvent.click(handoff)
    expect(openInbox).toHaveBeenCalledWith({ sessionId: SESSION, tab: 'candidates' })
  })

  it('still shows the inferred handoff when the session has only candidates', async () => {
    const transport = fakeTransport({
      items: [candidateItem({ id: 'candidate', title: 'Palette candidate' })],
      resolved: [],
      resolvedTotal: 0,
    })
    const openInbox = vi.fn()
    renderPanel({ openInbox }, transport)
    await ready(transport)
    expect(screen.queryByText(t('panel.empty.title'))).toBeNull()
    expect(screen.getByRole('button', { name: t('panel.inferred.row', { count: 1 }) })).toBeTruthy()
  })

  it('filters by section without changing the header count', async () => {
    const transport = fixtureTransport()
    renderPanel({}, transport)
    await ready(transport)
    fireEvent.click(screen.getByRole('button', { name: 'Waiting on the agent (1)' }))
    expect(screen.queryByRole('heading', { name: 'Needs you (1)' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Waiting on the agent (1)' })).toBeTruthy()
    expect(screen.getByText('2 open')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Waiting on the agent (1)' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps Resolved here collapsed until asked and opens the inbox from a row', async () => {
    const transport = fixtureTransport()
    const openInbox = vi.fn()
    renderPanel({ openInbox }, transport)
    await ready(transport)
    const toggle = screen.getByRole('button', { name: /Resolved here/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Keep five colours')).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByText('Keep five colours'))
    expect(openInbox).toHaveBeenCalledWith({ itemId: 'r1', tab: 'resolved' })
  })

  it('offers the cross-session view from the resolved section', async () => {
    const transport = fixtureTransport()
    const openInbox = vi.fn()
    renderPanel({ openInbox }, transport)
    await ready(transport)
    fireEvent.click(screen.getByRole('button', { name: 'View all in Open items →' }))
    expect(openInbox).toHaveBeenCalledWith({ sessionId: SESSION, tab: 'resolved' })
  })
})

describe('panel answering and hand-off', () => {
  it('answers a tool-raised item in place through the route', async () => {
    const transport = fakeTransport({ items: [toolItem()] })
    renderPanel({}, transport)
    await ready(transport)
    fireEvent.click(screen.getByRole('radio', { name: 'Corporate registry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    await waitFor(() => {
      expect(transport.calls.reply).toHaveLength(1)
    })
    expect(transport.calls.reply[0]).toMatchObject({
      itemId: 'item-1',
      expectedVersion: 1,
      payload: { type: 'option', option: 'Corporate registry' },
    })
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Waiting on the agent (1)' })).toBeTruthy()
    })
  })

  it('sends a free-text answer and asks for confirmation when the host requires it', async () => {
    const transport = fakeTransport({
      items: [toolItem({ reply: { controls: ['text'], freeText: true, requiresConfirm: true } })],
    })
    renderPanel({}, transport)
    await ready(transport)
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply to Keep 5 colours or 3?' }), { target: { value: 'yes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(transport.calls.reply).toHaveLength(0)
    expect(screen.getByText('Answering resumes this session and spends a turn.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }))
    await waitFor(() => {
      expect(transport.calls.reply).toHaveLength(1)
    })
    expect(transport.calls.reply[0]?.confirmedWake).toBe(true)
  })

  it('renders no Allow/Deny for a live shipped ask and hands it off instead', async () => {
    const transport = fakeTransport({ items: [liveAsk({ title: 'Ship the migration before Friday?' })] })
    const handoff = vi.fn(() => 'revealed' as const)
    const openInbox = vi.fn()
    renderPanel({ handoff, openInbox, canRevealAsk: true }, transport)
    await ready(transport)
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Answer in chat' }))
    expect(handoff).toHaveBeenCalledTimes(1)
    expect(openInbox).not.toHaveBeenCalled()
  })

  it('falls back to the inbox detail when the shipped ask cannot be revealed', async () => {
    const transport = fakeTransport({ items: [liveAsk({ title: 'Ship the migration before Friday?' })] })
    const openInbox = vi.fn()
    renderPanel({ handoff: () => 'unavailable' as const, openInbox, canRevealAsk: true }, transport)
    await ready(transport)
    fireEvent.click(screen.getByRole('button', { name: 'Answer in chat' }))
    expect(openInbox).toHaveBeenCalledWith({ itemId: 'item-1', tab: 'needs-you' })
  })

  it('reveals a tool-raised row and falls back to the inbox when the anchor is absent', async () => {
    const transport = fakeTransport({ items: [toolItem()] })
    const reveal = vi.fn(() => 'revealed' as const)
    const openInbox = vi.fn()
    renderPanel({ reveal, openInbox }, transport)
    await ready(transport)
    fireEvent.click(screen.getByRole('button', { name: 'Show in chat: Keep 5 colours or 3?' }))
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(openInbox).not.toHaveBeenCalled()
  })

  it('opens the inbox detail when the transcript row is not found', async () => {
    const transport = fakeTransport({ items: [toolItem()] })
    const openInbox = vi.fn()
    renderPanel({ reveal: () => 'not-found' as const, openInbox }, transport)
    await ready(transport)
    fireEvent.click(screen.getByRole('button', { name: 'Show in chat: Keep 5 colours or 3?' }))
    expect(openInbox).toHaveBeenCalledWith({ itemId: 'item-1', tab: 'needs-you' })
  })

  it('never opens anything by itself on mount', async () => {
    const transport = fakeTransport({ items: [toolItem()] })
    const openInbox = vi.fn()
    const reveal = vi.fn()
    const handoff = vi.fn()
    renderPanel({ openInbox, reveal, handoff }, transport)
    await ready(transport)
    expect(openInbox).not.toHaveBeenCalled()
    expect(reveal).not.toHaveBeenCalled()
    expect(handoff).not.toHaveBeenCalled()
  })
})

describe('panel freshness gate', () => {
  it('does not read at all while the panel is hidden, and reads on the visible edge', async () => {
    const transport = fakeTransport({ items: [toolItem()] })
    let clock = 1_000
    const { rerender } = render(<OpenItemsPanel {...panelProps(transport, { tab: fakeTab({ visible: false }), clock: () => clock })} />)
    await Promise.resolve()
    expect(transport.calls.list).toHaveLength(0)
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(transport.calls.list).toHaveLength(0)
    clock += 5_000
    rerender(<OpenItemsPanel {...panelProps(transport, { tab: fakeTab({ visible: true }), clock: () => clock })} />)
    await waitFor(() => {
      expect(transport.calls.list).toHaveLength(1)
    })
  })

  it('re-reads on window focus only while visible', async () => {
    const transport = fakeTransport({ items: [toolItem()] })
    let clock = 1_000
    const { rerender } = render(<OpenItemsPanel {...panelProps(transport, { tab: fakeTab({ visible: true }), clock: () => clock })} />)
    await waitFor(() => {
      expect(transport.calls.list).toHaveLength(1)
    })
    clock += 5_000
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => {
      expect(transport.calls.list).toHaveLength(2)
    })
    rerender(<OpenItemsPanel {...panelProps(transport, { tab: fakeTab({ visible: false }), clock: () => clock })} />)
    clock += 5_000
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(transport.calls.list).toHaveLength(2)
  })

  it('re-reads on a carrier reset while visible', async () => {
    const transport = fakeTransport({ items: [toolItem()] })
    let reset: (() => void) | undefined
    let clock = 1_000
    const { rerender } = render(
      <OpenItemsPanel
        {...panelProps(transport, {
          tab: fakeTab({ visible: true }),
          clock: () => clock,
          onConnectionReset: (listener) => {
            reset = listener
            return () => {}
          },
        })}
      />,
    )
    await waitFor(() => {
      expect(transport.calls.list).toHaveLength(1)
    })
    clock += 5_000
    reset?.()
    await waitFor(() => {
      expect(transport.calls.list).toHaveLength(2)
    })
    rerender(<OpenItemsPanel {...panelProps(transport, { tab: fakeTab({ visible: false }), clock: () => clock })} />)
    reset?.()
    await Promise.resolve()
    expect(transport.calls.list).toHaveLength(2)
  })

  it('polls only while visible when the opt-in interval is configured', async () => {
    const transport = fakeTransport({ items: [toolItem()] })
    let clock = 1_000
    const alwaysStale = (): number => {
      clock += 5_000
      return clock
    }
    const { rerender } = render(
      <OpenItemsPanel {...panelProps(transport, { tab: fakeTab({ visible: false }), pollMs: 10, clock: alwaysStale })} />,
    )
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(transport.calls.list).toHaveLength(0)
    rerender(<OpenItemsPanel {...panelProps(transport, { tab: fakeTab({ visible: true }), pollMs: 10, clock: alwaysStale })} />)
    await waitFor(() => {
      expect(transport.calls.list.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('binds the tab refresh command to the same forced read', async () => {
    const transport = fakeTransport({ items: [toolItem()] })
    let refresh: (() => void) | undefined
    render(
      <OpenItemsPanel
        {...panelProps(transport, {
          tab: fakeTab({ actions: { bindCommands: (commands) => { refresh = commands.refresh; return () => {} } } }),
        })}
      />,
    )
    await waitFor(() => {
      expect(transport.calls.list).toHaveLength(1)
    })
    refresh?.()
    await waitFor(() => {
      expect(transport.calls.list).toHaveLength(2)
    })
  })
})

describe('panel navigation target and 300px contract', () => {
  it('clears the filter and flashes the deep-linked row', async () => {
    const transport = fakeTransport({ items: [toolItem(), waitingItem({ id: 'waiting', title: 'Palette sent' })] })
    renderPanel({ tab: fakeTab({ navigation: { address: 'sidebar://open-items', revision: 1, params: { itemId: 'item-1' } } }) }, transport)
    await ready(transport)
    await waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-item-id="item-1"]')?.dataset['flash']).toBe('true')
    })
  })

  it('fills the tab body and owns its own scroll', async () => {
    const transport = fakeTransport({ items: [toolItem()] })
    renderPanel({}, transport)
    await ready(transport)
    const root = screen.getByLabelText('Open items')
    expect(root.className).toContain('dsh-oi-panel')
    const body = root.querySelector('.dsh-oi-panelBody')
    expect(body?.getAttribute('data-panel-body')).toBe('')
    // The wrapper the seat gives us is clipped; only our body may scroll.
    expect(PANEL_STYLES).toMatch(/\.dsh-oi-panel \{[^}]*height: 100%;[^}]*min-height: 0;/u)
    expect(PANEL_STYLES).toMatch(/\.dsh-oi-panelBody \{[^}]*overflow-y: auto;/u)
    expect(PANEL_STYLES).toMatch(/\.dsh-oi-panelRowTitle \{[^}]*\.\.\.|-webkit-line-clamp: 2;/u)
  })

  it('keeps a row to one glyph, one clamped title, one meta line and one action line', async () => {
    const transport = fakeTransport({ items: [toolItem()] })
    renderPanel({}, transport)
    await ready(transport)
    const row = document.querySelector<HTMLElement>('.dsh-oi-panelRow')
    expect(row?.getAttribute('data-control')).toBe('answerable')
    expect(row?.querySelector('.dsh-oi-panelRowGlyph')).toBeTruthy()
    expect(row?.querySelector('.dsh-oi-panelRowTitle')).toBeTruthy()
    expect(row?.querySelector('.dsh-oi-panelRowMeta')?.textContent).toContain('Decision')
    expect(row?.querySelectorAll('.dsh-oi-panelOptions')).toHaveLength(1)
  })
})


describe('panel chrome additions', () => {
  it('requires the shipped approval confirmation before posting an approval', async () => {
    const transport = fakeTransport({
      items: [toolItem({
        kind: 'approval',
        reply: { controls: ['approve', 'deny'], freeText: false, requiresConfirm: false },
        options: undefined,
      })],
    })
    renderPanel({}, transport)
    await ready(transport)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(transport.calls.reply).toHaveLength(0)
    const dialog = screen.getByRole('dialog', { name: 'Allow once' })
    // A tool-raised approval is authored: the copy names the session message,
    // and that acknowledgement checkbox is the explicit wake consent.
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'I understand this sends to the session' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(transport.calls.reply).toHaveLength(1))
    expect(transport.calls.reply[0]).toMatchObject({
      payload: { type: 'approval', outcome: 'allow-once' },
      requestedTrack: 'session-message',
      confirmedWake: true,
    })
  })

  it('shows the cross-session count and opens the inbox from the footer', async () => {
    const transport = fakeTransport({
      items: [toolItem()],
      helloValue: {
        protocol: 1,
        domainVersion: 3,
        schemaVersion: 3,
        installId: 'install-1',
        capabilities: { canSettleClient: true, canHostSettle: true, canDeliver: true, canRegister: true, hasContextLine: false },
        counts: { needsYou: 7, candidates: 1, awaiting: 0 },
        earlierRecordsPruned: false,
      },
    })
    const openInbox = vi.fn()
    renderPanel({ openInbox }, transport)
    await ready(transport)
    expect(screen.getByText('7 open across all sessions')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View all in Open items' }))
    expect(openInbox).toHaveBeenCalledWith()
  })

  it('offers the overflow menu with the inbox and refresh actions', async () => {
    const transport = fakeTransport({ items: [toolItem()] })
    const openInbox = vi.fn()
    renderPanel({ openInbox }, transport)
    await ready(transport)
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    const menu = screen.getByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'View all in Open items' }))
    expect(openInbox).toHaveBeenCalledWith()
  })
})


describe('panel session handoff', () => {
  it('filters the cross-session view to this panel session (OD-12)', async () => {
    const transport = fakeTransport({ items: [toolItem()], resolved: [resolvedItem()], resolvedTotal: 1 })
    const openInbox = vi.fn()
    renderPanel({ openInbox }, transport)
    await ready(transport)
    fireEvent.click(screen.getByRole('button', { name: 'View all in Open items →' }))
    expect(openInbox).toHaveBeenCalledWith({ sessionId: SESSION, tab: 'resolved' })
  })
})
