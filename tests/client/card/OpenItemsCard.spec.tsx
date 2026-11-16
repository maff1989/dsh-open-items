// @vitest-environment jsdom
/**
 * The in-session card at the component level: rendering from `meta`, hydration
 * from the durable record, the exact reply request, and every degraded state
 * (conflict, offline, legacy, error, cap, no-controls rules).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('../primitives-mock'))

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { ReplyRequest, ReplyValue } from '../../../src/shared/protocol'
import type { CardItem, CardMeta, OpenItemRecord } from '../../../src/shared/schema'
import { OpenItemsRpcError } from '../../../src/client/data/transport'
import { cardEn, type OpenItemsCardKey } from '../../../src/client/ui/card/card-locales'
import { OpenItemsCard } from '../../../src/client/ui/card/OpenItemsCard'
import type { CardTransport, OpenItemsCardProps, OpenItemsToolBlock } from '../../../src/client/ui/card/slot-contracts'
import { makeItem, makeSnapshot } from '../fixtures'

afterEach(cleanup)

/** Substitute `{name}` placeholders the way the locale runtime does. */
function fill(template: string, params?: Record<string, string | number>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/** Card namespace translator over the real dictionary. */
function cardT(): OpenItemsCardProps['t'] {
  return ((key: OpenItemsCardKey, params?: Record<string, string | number>) =>
    fill(cardEn[key] ?? String(key), params)) as unknown as OpenItemsCardProps['t']
}

/** One wire card item (host `toCardItems` shape) with the row's callId. */
function cardItem(overrides: Partial<CardItem> = {}): CardItem {
  return {
    id: 'item-1',
    kind: 'decision',
    state: 'open',
    title: 'Which registry should the build use?',
    detailPreview: 'The agent needs a choice before the migration can continue.',
    options: ['Corporate', 'Public npm'],
    blocking: true,
    version: 1,
    sessionId: 'session-1',
    callId: 'call-1',
    reply: { controls: ['option'], options: ['Corporate', 'Public npm'], freeText: false, requiresConfirm: false },
    ...overrides,
  }
}

/** One v1 card payload. */
function metaOf(items: readonly CardItem[], overrides: Partial<CardMeta> = {}): CardMeta {
  return { v: 1, items, total: items.length, truncated: false, ...overrides }
}

/** One durable record matching the card's defaults. */
function makeRecord(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    id: 'item-1',
    version: 2,
    source: { sessionId: 'session-1', callId: 'call-1' },
    options: ['Corporate', 'Public npm'],
    reply: { controls: ['option'], options: ['Corporate', 'Public npm'], freeText: false, requiresConfirm: false },
    ...overrides,
  })
}

/** One successful reply value. */
function replyValue(item: OpenItemRecord, outcome: ReplyValue['outcome'], note?: string): ReplyValue {
  return {
    item,
    delivery: {
      deliveryId: 'd-1',
      at: 1,
      track: 'session-message',
      payload: { type: 'dismiss' },
      state: outcome === 'recorded' ? 'queued' : 'settled',
    },
    outcome,
    ...(note === undefined ? {} : { note }),
  }
}

/** Fake route face with spies so request shapes are assertable. */
interface FakeTransport extends CardTransport {
  list: ReturnType<typeof vi.fn>
  reply: ReturnType<typeof vi.fn>
  delivery: ReturnType<typeof vi.fn>
}

/** Build the fake transport; tests replace the members they exercise. */
function makeTransport(overrides: Partial<CardTransport> = {}): FakeTransport {
  return {
    list: vi.fn(async () => ({ snapshot: makeSnapshot([]) })),
    reply: vi.fn(async () => replyValue(makeRecord({ state: 'awaiting' }), 'applied')),
    delivery: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as FakeTransport
}

/** Render options for one card. */
interface RenderOptions {
  readonly items?: readonly CardItem[]
  readonly meta?: unknown
  readonly transport?: FakeTransport
  readonly callId?: string
  readonly isSubagent?: boolean
  readonly peerReadOnly?: boolean
  readonly now?: number
}

/** Render the card with composed props. */
function renderCard(options: RenderOptions = {}): { transport: FakeTransport; openInbox: ReturnType<typeof vi.fn> } {
  const transport = options.transport ?? makeTransport()
  const openInbox = vi.fn()
  const meta = 'meta' in options ? options.meta : metaOf(options.items ?? [cardItem()])
  const block: OpenItemsToolBlock = {
    kind: 'tool-result',
    callId: options.callId ?? 'call-1',
    isError: false,
    meta,
  }
  const props = {
    callId: options.callId ?? 'call-1',
    toolName: 'open_items',
    phase: 'result',
    block,
    t: cardT(),
    sessionId: 'session-1',
    transport,
    openInbox,
    now: () => options.now ?? 1_700_000_000_000,
    isSubagent: () => options.isSubagent === true,
    peerReadOnly: () => options.peerReadOnly === true,
  } as unknown as OpenItemsCardProps
  render(<OpenItemsCard {...props} />)
  return { transport, openInbox }
}

describe('rendering from meta', () => {
  it('renders an actionable option card at its tool row', () => {
    renderCard()
    expect(screen.getByText('Open items')).toBeTruthy()
    expect(screen.getByText('1 item raised')).toBeTruthy()
    expect(screen.getByText('Decision')).toBeTruthy()
    expect(screen.getByText('Which registry should the build use?')).toBeTruthy()
    expect(screen.getByText(/The agent needs a choice/)).toBeTruthy()
    expect(within(screen.getByRole('radiogroup', { name: 'Answer choices' })).getAllByRole('radio')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Answer' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Open in Open items' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('hydrates on mount with the session-scoped read', async () => {
    const transport = makeTransport()
    renderCard({ transport })
    await waitFor(() => { expect(transport.list).toHaveBeenCalledTimes(1) })
    expect(transport.list.mock.calls[0]?.[0]).toEqual({
      query: { scope: { sessionId: 'session-1' }, status: 'all', limit: 200 },
    })
  })

  it('prefers the newer durable record and renders its settled receipt', async () => {
    const resolution = {
      kind: 'answered' as const,
      at: 1_700_000_000_000,
      actor: 'user' as const,
      payload: { type: 'option' as const, option: 'Corporate' },
    }
    const transport = makeTransport({
      list: vi.fn(async () => ({ snapshot: makeSnapshot([makeRecord({ version: 4, state: 'resolved', resolution })]) })),
    })
    renderCard({ transport })
    await screen.findByText(/Corporate/)
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull()
    expect(screen.getByText(/Answered in Open items/)).toBeTruthy()
  })

  it('caps the printed rows and links to the inbox for the remainder', () => {
    const items = Array.from({ length: 7 }, (_, index) => cardItem({ id: `item-${index}`, title: `Raised ${index}` }))
    const { openInbox } = renderCard({ items, meta: metaOf(items, { total: 7, truncated: true }) })
    expect(document.querySelectorAll('.dsh-oi-cardItem')).toHaveLength(5)
    expect(screen.getByText('and 2 more')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review all 7' }))
    expect(openInbox).toHaveBeenCalledWith()
  })
})

describe('candidate tier', () => {
  it('never offers reply controls for an inferred candidate and hands off to Candidates', async () => {
    const transport = makeTransport({
      list: vi.fn(async () => ({
        snapshot: makeSnapshot([makeRecord({
          tier: 'candidate',
          version: 2,
          title: '- **E** — Ship together as one PR or two?',
          detectedBy: ['regex-gate'],
        })]),
      })),
    })
    const { openInbox } = renderCard({ transport })
    // The hydrated record wins; its title is projected for display.
    await screen.findByText('E — Ship together as one PR or two?')
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    expect(screen.getByText(cardEn['card.inferred'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: cardEn['card.openCandidates'] }))
    expect(openInbox).toHaveBeenCalledWith('item-1')
  })
})

describe('answering', () => {
  it('submits the chosen option as one reply request carrying the hydrated version', async () => {
    const transport = makeTransport({
      list: vi.fn(async () => ({ snapshot: makeSnapshot([makeRecord({ version: 2 })]) })),
    })
    renderCard({ transport })
    // The hydrated record (title and version 2) replaces the raise snapshot first.
    await screen.findByText('Keep 5 colours or 3?')

    fireEvent.click(screen.getByRole('radio', { name: 'Corporate' }))
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))

    await waitFor(() => { expect(transport.reply).toHaveBeenCalledTimes(1) })
    const request = transport.reply.mock.calls[0]?.[0] as ReplyRequest
    expect(request).toMatchObject({
      itemId: 'item-1',
      expectedVersion: 2,
      payload: { type: 'option', option: 'Corporate' },
      requestedTrack: 'session-message',
    })
    expect(typeof request.deliveryId).toBe('string')
    expect(request.deliveryId.length).toBeGreaterThan(8)

    await screen.findByText(/Answered ·/)
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull()
  })

  it('disables the controls after the first send and never sends twice', async () => {
    let settle: (value: ReplyValue) => void = () => undefined
    const transport = makeTransport()
    transport.reply = vi.fn(() => new Promise<ReplyValue>((resolve) => { settle = resolve }))
    renderCard({ transport })

    fireEvent.click(screen.getByRole('radio', { name: 'Corporate' }))
    const answer = screen.getByRole('button', { name: 'Answer' })
    fireEvent.click(answer)
    fireEvent.click(screen.getByRole('button', { name: 'Sending…' }))
    expect(transport.reply).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Sending…' })).toHaveProperty('disabled', true)

    settle(replyValue(makeRecord({ state: 'awaiting' }), 'applied'))
    await screen.findByText(/Answered ·/)
  })

  it('says "saved" when the turn had already ended', async () => {
    const transport = makeTransport({
      reply: vi.fn(async () => replyValue(makeRecord({ state: 'awaiting' }), 'recorded', 'the agent will see it when it next runs')),
    })
    renderCard({ transport })
    fireEvent.click(screen.getByRole('radio', { name: 'Corporate' }))
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    await screen.findByText(/Saved: the agent will see it when it next runs/u)
  })

  it('sends free text and keeps the two send claims distinct', async () => {
    const transport = makeTransport()
    const freeText = cardItem({
      reply: { controls: ['text'], freeText: true, requiresConfirm: false },
      options: [],
    })
    renderCard({ items: [freeText], transport })
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: '  Corporate registry  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => { expect(transport.reply).toHaveBeenCalledTimes(1) })
    expect(transport.reply.mock.calls[0]?.[0]).toMatchObject({
      payload: { type: 'text', text: 'Corporate registry' },
      requestedTrack: 'session-message',
    })
  })

  it('dismisses through the same reply path', async () => {
    const transport = makeTransport({
      reply: vi.fn(async () => replyValue(makeRecord({ state: 'resolved' }), 'applied')),
    })
    renderCard({ transport })
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => { expect(transport.reply).toHaveBeenCalledTimes(1) })
    expect(transport.reply.mock.calls[0]?.[0]).toMatchObject({ payload: { type: 'dismiss' } })
    await screen.findByText(/Dismissed ·/)
  })
})

describe('degraded states', () => {
  it('shows the conflict copy and reveals the winning answer', async () => {
    const resolution = {
      kind: 'answered' as const,
      at: 1_700_000_000_000,
      actor: 'user' as const,
      payload: { type: 'option' as const, option: 'Public npm' },
    }
    const transport = makeTransport()
    transport.list = vi.fn()
      .mockResolvedValueOnce({ snapshot: makeSnapshot([makeRecord({ version: 2 })]) })
      .mockResolvedValue({ snapshot: makeSnapshot([makeRecord({ version: 3, state: 'resolved', resolution })]) })
    transport.reply = vi.fn(async () => { throw new OpenItemsRpcError('conflict', 'changed elsewhere') })
    renderCard({ transport })

    fireEvent.click(screen.getByRole('radio', { name: 'Corporate' }))
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    await screen.findByText(/already answered in another window/u)
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull()

    fireEvent.click(await screen.findByRole('button', { name: 'Show the answer' }))
    await screen.findByText(/Public npm/u)
    fireEvent.click(screen.getByRole('button', { name: 'Hide the answer' }))
    expect(screen.queryByText(/Public npm/u)).toBeNull()
  })

  it('keeps the controls after an offline failure and retries the same delivery id', async () => {
    const transport = makeTransport()
    transport.reply = vi.fn()
      .mockRejectedValueOnce(new OpenItemsRpcError('transport', 'network down'))
      .mockResolvedValueOnce(replyValue(makeRecord({ state: 'awaiting' }), 'applied'))
    renderCard({ transport })

    fireEvent.click(screen.getByRole('radio', { name: 'Corporate' }))
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    await screen.findByText(/Can't reach the harness/u)
    const firstRequest = transport.reply.mock.calls[0]?.[0] as ReplyRequest

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => { expect(transport.reply).toHaveBeenCalledTimes(2) })
    expect(transport.delivery).toHaveBeenCalledWith({ deliveryId: firstRequest.deliveryId })
    expect(transport.reply.mock.calls[1]?.[0]).toMatchObject({ deliveryId: firstRequest.deliveryId })
    await screen.findByText(/Answered ·/)
  })

  it('recovers a lost response through the delivery read', async () => {
    const transport = makeTransport()
    transport.reply = vi.fn(async () => { throw new OpenItemsRpcError('transport', 'response lost') })
    transport.delivery = vi.fn(async () => ({
      delivery: {
        deliveryId: 'd-1',
        at: 1,
        track: 'session-message' as const,
        payload: { type: 'option' as const, option: 'Corporate' },
        state: 'delivered' as const,
      },
      item: makeRecord({ state: 'awaiting' }),
    }))
    renderCard({ transport })
    fireEvent.click(screen.getByRole('radio', { name: 'Corporate' }))
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    await screen.findByText(/Can't reach the harness/u)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText(/Answered ·/)
    // The recovery read proved it landed, so nothing was sent twice.
    expect(transport.reply).toHaveBeenCalledTimes(1)
  })

  it('degrades to the legacy row when meta is absent or unreadable', () => {
    const transport = makeTransport()
    renderCard({ transport, meta: undefined })
    expect(screen.getByText(/This build of Open items cannot show this card/u)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open in Open items' }))
    expect(screen.queryByText('Which registry should the build use?')).toBeNull()
  })

  it('never throws on hostile metadata', () => {
    const transport = makeTransport()
    expect(() => {
      renderCard({ transport, meta: { v: 1, items: [{ id: 7, title: null }, null, 'x'], total: 'many' } })
    }).not.toThrow()
    expect(screen.getByText(/This build of Open items cannot show this card/u)).toBeTruthy()
  })

  it('renders an error row for an isError result', () => {
    const transport = makeTransport()
    const props = {
      callId: 'call-1',
      toolName: 'open_items',
      phase: 'result',
      block: { kind: 'tool-result', callId: 'call-1', isError: true, error: { reason: 'the store refused' } },
      t: cardT(),
      sessionId: 'session-1',
      transport,
      openInbox: vi.fn(),
      now: () => 1,
      isSubagent: () => false,
      peerReadOnly: () => false,
    } as unknown as OpenItemsCardProps
    render(<OpenItemsCard {...props} />)
    expect(screen.getByText(/the store refused/u)).toBeTruthy()
    expect(screen.getByText(/nothing here is answerable/u)).toBeTruthy()
  })

  it('renders no card before the result stage', () => {
    const props = {
      callId: 'call-1',
      toolName: 'open_items',
      phase: 'preparing',
      block: {},
      t: cardT(),
      sessionId: 'session-1',
      transport: makeTransport(),
      openInbox: vi.fn(),
      now: () => 1,
      isSubagent: () => false,
      peerReadOnly: () => false,
    } as unknown as OpenItemsCardProps
    const { container } = render(<OpenItemsCard {...props} />)
    expect(container.textContent).toBe('')
  })
})

describe('no-control rules', () => {
  it('never renders Allow/Deny for an approval item', async () => {
    const approval = cardItem({ kind: 'approval', reply: { controls: ['approve', 'deny'], freeText: false, requiresConfirm: false } })
    renderCard({ items: [approval] })
    await waitFor(() => { expect(screen.getByText(/Approvals are answered/iu)).toBeTruthy() })
    expect(screen.queryByRole('button', { name: /Allow/iu })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull()
  })

  it('does not answer a foreign call id', async () => {
    renderCard({ items: [cardItem({ callId: 'call-other' })] })
    await screen.findByText(/raised earlier and is answered in Open items/u)
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull()
  })

  it('explains a subagent session instead of offering controls', async () => {
    renderCard({ isSubagent: true })
    await screen.findByText(/subagent session cannot answer/iu)
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull()
  })

  it('disables controls for a read-only peer', async () => {
    renderCard({ peerReadOnly: true })
    await screen.findByText(/Read-only session/iu)
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull()
  })

  it('opens the inbox with the item preselected', async () => {
    const { openInbox } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Open in Open items' }))
    expect(openInbox).toHaveBeenCalledWith('item-1')
  })
})
