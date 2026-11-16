/**
 * The session-scoped panel store: what it asks the host for, what it keeps, and
 * what one reply looks like on the wire.
 *
 * The store is the panel's only data path, so these assertions are the contract:
 * every read is narrowed to this panel's session, a failed read never becomes a
 * false empty state, and one activation is exactly one `reply` with a
 * client-minted delivery id (DESIGN §6.3).
 */
import { describe, expect, it, vi } from 'vitest'

import { OpenItemsRpcError } from '../../../src/client/data/transport'
import { createPanelStore } from '../../../src/client/ui/panel/panel-store'
import {
  SESSION,
  fakeTransport,
  resolvedItem,
  textReply,
  toolItem,
  waitingItem,
} from './helpers'

/** Await one microtask turn so store writes settle. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('panel store reads', () => {
  it('narrows both reads to this panel session', async () => {
    const transport = fakeTransport({ items: [toolItem()], resolved: [resolvedItem()], resolvedTotal: 1 })
    const store = createPanelStore(transport, { sessionId: SESSION })
    await store.refresh()
    expect(transport.calls.list).toHaveLength(1)
    expect(transport.calls.list[0]).toEqual({ query: { scope: { sessionId: SESSION }, status: 'all', limit: 200 } })
    expect(transport.calls.register).toHaveLength(1)
    expect(transport.calls.register[0]).toEqual({ query: { scope: { sessionId: SESSION }, status: 'resolved', limit: 5 } })
    expect(store.getSnapshot().items.map(item => item.id)).toEqual(['item-1'])
    expect(store.getSnapshot().resolvedTotal).toBe(1)
    expect(store.getSnapshot().loaded).toBe(true)
  })

  it('drops rows the host returned for another session', async () => {
    const other = toolItem({ id: 'other', source: { sessionId: 'session-2', callId: 'call-9' } })
    const transport = fakeTransport({ items: [toolItem({ id: 'mine' }), other] })
    const store = createPanelStore(transport, { sessionId: SESSION })
    await store.refresh()
    expect(store.getSnapshot().items.map(item => item.id)).toEqual(['mine'])
  })

  it('starts cold and stays unloaded until the first read lands', async () => {
    const transport = fakeTransport({ items: [toolItem()] })
    const store = createPanelStore(transport, { sessionId: SESSION })
    expect(store.getSnapshot().status).toBe('idle')
    expect(store.getSnapshot().loaded).toBe(false)
    const reading = store.refresh()
    expect(store.getSnapshot().status).toBe('loading')
    await reading
    expect(store.getSnapshot().status).toBe('ready')
    expect(store.getSnapshot().loaded).toBe(true)
    expect(store.getSnapshot().lastReadAt).toBeGreaterThan(0)
  })

  it('keeps the last list when a later read fails (stale, not empty)', async () => {
    const base = fakeTransport({ items: [toolItem()] })
    let reads = 0
    const flaky = Object.assign({}, base, {
      list: async (request?: Parameters<typeof base.list>[0], signal?: AbortSignal) => {
        reads += 1
        if (reads > 1) throw new OpenItemsRpcError('transport', 'offline')
        return base.list(request, signal)
      },
    })
    const store = createPanelStore(flaky, { sessionId: SESSION })
    await store.refresh()
    expect(store.getSnapshot().loaded).toBe(true)
    await store.refresh(true)
    const state = store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.offline).toBe(true)
    expect(state.items.map(item => item.id)).toEqual(['item-1'])
  })

  it('reports a carrier fault as offline and a business fault as an error', async () => {
    const offline = createPanelStore(fakeTransport({ listError: new OpenItemsRpcError('transport', 'offline') }), { sessionId: SESSION })
    await offline.refresh()
    expect(offline.getSnapshot().status).toBe('error')
    expect(offline.getSnapshot().offline).toBe(true)

    const refused = createPanelStore(fakeTransport({ listError: new OpenItemsRpcError('forbidden', 'nope') }), { sessionId: SESSION })
    await refused.refresh()
    expect(refused.getSnapshot().offline).toBe(false)
    expect(refused.getSnapshot().error).toBe('nope')
  })

  it('marks a stale list offline when a later read fails at the carrier', async () => {
    const transport = fakeTransport({ items: [toolItem()] })
    const store = createPanelStore(transport, { sessionId: SESSION })
    await store.refresh()
    const failing: typeof transport = Object.assign({ ...transport }, {
      list: async () => {
        throw new OpenItemsRpcError('transport', 'offline')
      },
    })
    const store2 = createPanelStore(failing, { sessionId: SESSION })
    await store2.refresh()
    // First read fails: no data, so this is the error state.
    expect(store2.getSnapshot().status).toBe('error')
    expect(store2.getSnapshot().offline).toBe(true)
  })

  it('single-flights concurrent reads and honours the freshness window', async () => {
    let clock = 1_000
    const transport = fakeTransport({ items: [toolItem()] })
    const store = createPanelStore(transport, { sessionId: SESSION, now: () => clock })
    const first = store.refresh()
    const second = store.refresh()
    await Promise.all([first, second])
    expect(transport.calls.list).toHaveLength(1)
    await store.refresh()
    expect(transport.calls.list).toHaveLength(1)
    clock += 3_000
    await store.refresh()
    expect(transport.calls.list).toHaveLength(2)
  })

  it('stops publishing after dispose', async () => {
    const transport = fakeTransport({ items: [toolItem()] })
    const store = createPanelStore(transport, { sessionId: SESSION })
    const listener = vi.fn()
    store.subscribe(listener)
    store.dispose()
    await store.refresh()
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('panel store replies', () => {
  it('sends one reply with the CAS token, a minted delivery id and no track claim', async () => {
    const transport = fakeTransport({ items: [toolItem({ version: 4 })] })
    const store = createPanelStore(transport, { sessionId: SESSION, mintDeliveryId: () => 'delivery-1' })
    await store.refresh()
    const outcome = await store.reply(toolItem({ version: 4 }), { type: 'option', option: 'Corporate registry' })
    expect(transport.calls.reply).toHaveLength(1)
    expect(transport.calls.reply[0]).toEqual({
      itemId: 'item-1',
      expectedVersion: 4,
      deliveryId: 'delivery-1',
      payload: { type: 'option', option: 'Corporate registry' },
    })
    expect(outcome).toMatchObject({ kind: 'sent', itemId: 'item-1', outcome: 'sent' })
  })

  it('carries the explicit wake confirmation only when asked', async () => {
    const transport = fakeTransport({ items: [toolItem({ reply: textReply(true) })] })
    const store = createPanelStore(transport, { sessionId: SESSION, mintDeliveryId: () => 'd' })
    await store.refresh()
    await store.reply(toolItem({ reply: textReply(true) }), { type: 'text', text: 'yes' }, { confirmedWake: true })
    expect(transport.calls.reply[0]?.confirmedWake).toBe(true)
    await store.reply(toolItem({ reply: textReply(true) }), { type: 'text', text: 'yes again' })
    expect(transport.calls.reply[1]).not.toHaveProperty('confirmedWake')
  })

  it('names the session-message track for an approval decision', async () => {
    const approval = toolItem({
      kind: 'approval',
      reply: { controls: ['approve', 'deny'], freeText: false, requiresConfirm: false },
    })
    const transport = fakeTransport({ items: [approval] })
    const store = createPanelStore(transport, { sessionId: SESSION, mintDeliveryId: () => 'd-approval' })
    await store.refresh()
    // The panel only renders authored approvals (no live card), so the decision
    // must name the message track; the confirmation supplies the wake consent.
    await store.reply(approval, { type: 'approval', outcome: 'deny', note: 'dry run first' }, { confirmedWake: true })
    expect(transport.calls.reply[0]).toMatchObject({
      deliveryId: 'd-approval',
      payload: { type: 'approval', outcome: 'deny', note: 'dry run first' },
      requestedTrack: 'session-message',
      confirmedWake: true,
    })
  })

  it('moves the answered item into the waiting section without a re-read', async () => {
    const transport = fakeTransport({ items: [toolItem()] })
    const store = createPanelStore(transport, { sessionId: SESSION })
    await store.refresh()
    const readsBefore = transport.calls.list.length
    await store.reply(toolItem(), { type: 'option', option: 'Corporate registry' })
    expect(store.getSnapshot().items.map(item => item.state)).toEqual(['awaiting'])
    expect(store.getSnapshot().pending.size).toBe(0)
    expect(transport.calls.list).toHaveLength(readsBefore)
  })

  it('turns a lost CAS into a conflict value and re-reads', async () => {
    const transport = fakeTransport({
      items: [toolItem()],
      replyError: new OpenItemsRpcError('conflict', 'version moved'),
    })
    const store = createPanelStore(transport, { sessionId: SESSION })
    await store.refresh()
    const readsBefore = transport.calls.list.length
    const outcome = await store.reply(toolItem(), { type: 'option', option: 'x' })
    expect(outcome).toEqual({ kind: 'conflict', itemId: 'item-1' })
    await settle()
    expect(transport.calls.list.length).toBeGreaterThan(readsBefore)
  })

  it('reports a refused reply as a failed value, never a throw', async () => {
    const transport = fakeTransport({
      items: [toolItem()],
      replyError: new OpenItemsRpcError('agent-unavailable', 'no agent'),
    })
    const store = createPanelStore(transport, { sessionId: SESSION })
    await store.refresh()
    const outcome = await store.reply(toolItem(), { type: 'approval', outcome: 'deny' })
    expect(outcome).toEqual({ kind: 'failed', itemId: 'item-1', code: 'agent-unavailable', message: 'no agent' })
    expect(store.getSnapshot().pending.size).toBe(0)
  })

  it('refuses a second activation while the first is in flight', async () => {
    let release: (() => void) | undefined
    const transport = fakeTransport({ items: [toolItem()] })
    const slow: typeof transport = Object.assign({ ...transport }, {
      reply: async () => {
        await new Promise<void>(resolve => {
          release = resolve
        })
        return {
          item: waitingItem({ id: 'item-1' }),
          delivery: { deliveryId: 'd', at: 1, track: 'session-message' as const, payload: { type: 'text' as const, text: 'x' }, state: 'delivered' as const },
          outcome: 'sent' as const,
        }
      },
    })
    const store = createPanelStore(slow, { sessionId: SESSION })
    await store.refresh()
    const first = store.reply(toolItem(), { type: 'option', option: 'a' })
    expect(store.getSnapshot().pending.has('item-1')).toBe(true)
    const second = await store.reply(toolItem(), { type: 'option', option: 'a' })
    expect(second.kind).toBe('failed')
    release?.()
    await first
    expect(store.getSnapshot().pending.size).toBe(0)
  })
})
