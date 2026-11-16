// @vitest-environment jsdom
/**
 * Reveal and hand-off seams: the panel's only DOM coupling and its only route
 * back into the shipped ask surfaces.
 *
 * The reveal lookup is scoped to the session's own conversation and keyed by
 * rc.1's `data-chat-call-id` marker on tool call rows; everything is best effort
 * and reports a value instead of throwing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  canRevealShippedAsk,
  handoffShippedAsk,
  optionalService,
  revealToolRow,
} from '../../../src/client/ui/panel/reveal'
import { SESSION, liveAsk, toolItem } from './helpers'

/** Mount one conversation root with an optional tool call row. */
function mountConversation(sessionId: string, callId?: string): HTMLElement {
  const conversation = document.createElement('div')
  conversation.dataset['conversationSession'] = sessionId
  if (callId !== undefined) {
    const row = document.createElement('div')
    row.dataset['chatCallId'] = callId
    row.dataset['chatAnchorKey'] = `call:${callId}`
    // jsdom does not implement scrollIntoView; the reveal must still work.
    row.scrollIntoView = vi.fn()
    conversation.appendChild(row)
  }
  document.body.appendChild(conversation)
  return conversation
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('revealToolRow', () => {
  it('focuses the row of one call inside this session conversation', () => {
    mountConversation(SESSION, 'call-1')
    const result = revealToolRow(SESSION, 'call-1')
    expect(result).toEqual('revealed')
    const row = document.querySelector<HTMLElement>('[data-chat-call-id="call-1"]')
    expect(row?.dataset['openItemsRevealed']).toBe('')
    expect(row?.scrollIntoView).toHaveBeenCalled()
  })

  it('never touches another session conversation', () => {
    mountConversation('session-2', 'call-1')
    expect(revealToolRow(SESSION, 'call-1')).toEqual('not-found')
  })

  it('reports no-anchor when the record carries no call id', () => {
    mountConversation(SESSION, 'call-1')
    expect(revealToolRow(SESSION, undefined)).toEqual('no-anchor')
    expect(revealToolRow(SESSION, '')).toEqual('no-anchor')
  })

  it('reports not-found when the row is not rendered (windowed out or folded)', () => {
    mountConversation(SESSION, 'call-other')
    expect(revealToolRow(SESSION, 'call-1')).toEqual('not-found')
  })

  it('escapes the call id in the attribute selector', () => {
    mountConversation(SESSION, 'call-1')
    expect(revealToolRow(SESSION, 'call-1"')).toEqual('not-found')
  })
})

describe('shipped-ask hand-off', () => {
  it('reveals a question card through the shipped seam', () => {
    const reveal = vi.fn(() => true)
    const ctx = { get: (name: string) => (name === 'userQuestionPanels' ? { reveal } : undefined) }
    expect(canRevealShippedAsk(ctx)).toBe(true)
    expect(handoffShippedAsk(ctx, liveAsk())).toEqual('revealed')
    expect(reveal).toHaveBeenCalledWith(SESSION, 'ask-1')
  })

  it('reports unavailable when the shipped card refuses or the seam is absent', () => {
    const refusing = { get: () => ({ reveal: () => false }) }
    expect(handoffShippedAsk(refusing, liveAsk())).toEqual('unavailable')
    expect(handoffShippedAsk({ get: () => undefined }, liveAsk())).toEqual('unavailable')
    expect(handoffShippedAsk({}, liveAsk())).toEqual('unavailable')
  })

  it('has no seam for an approval (no call id in this build)', () => {
    expect(handoffShippedAsk({ get: () => ({ reveal: () => true }) }, liveAsk({
      kind: 'approval',
      source: { sessionId: SESSION, approvalId: 'approval-1' },
    }))).toEqual('unavailable')
  })

  it('survives a throwing service lookup', () => {
    const ctx = { get: () => { throw new Error('no such service') } }
    expect(optionalService(ctx, 'userQuestionPanels')).toBeUndefined()
    expect(handoffShippedAsk(ctx, liveAsk())).toEqual('unavailable')
  })

  it('keeps the tool-row reveal independent of the ask seam', () => {
    mountConversation(SESSION, 'call-1')
    const ctx = { get: () => undefined }
    expect(revealToolRow(SESSION, toolItem().source.callId, document)).toEqual('revealed')
    expect(canRevealShippedAsk(ctx)).toBe(false)
  })
})
