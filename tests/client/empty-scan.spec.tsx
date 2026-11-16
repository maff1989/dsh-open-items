// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('./primitives-mock'))
import { cleanup, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'

import { InboxPage, type InboxPageProps } from '../../src/client/ui/page'
import { createInboxStore } from '../../src/client/data/inbox-store'
import { createPageStore } from '../../src/client/data/page-store'
import { t } from './fixtures'

afterEach(cleanup)

/** Render the page over a store whose hello reports capture diagnostics. */
async function renderWithCaptureLastBackfill(lastBackfill: unknown): Promise<void> {
  const snapshot = { revision: 1, generatedAt: 0, items: [], sessions: [], workspaces: [], counts: { needsYou: 0, candidates: 0, awaiting: 0, snoozed: 0, resolved: 0, newSinceLastVisit: 0, earlierRecordsPruned: false }, refreshing: false }
  const store = createInboxStore({
    hello: async () => ({
      protocol: 1, domainVersion: 1, schemaVersion: 3, installId: 'i',
      capabilities: { canSettleClient: false, canHostSettle: false, canDeliver: false, canRegister: true, hasContextLine: false },
      counts: { needsYou: 0, candidates: 0, awaiting: 0 },
      earlierRecordsPruned: false,
      capture: { mounted: true, projection: true, live: true, backfill: true, cursors: 2, catalogSessions: 49, ...(lastBackfill === undefined ? {} : { lastBackfill }) },
    }),
    list: async () => ({ snapshot }),
    register: async () => ({ items: [], total: 0, earlierRecordsPruned: false }),
    reply: async () => { throw new Error('unused') },
    delivery: async () => ({}),
    dismiss: async () => { throw new Error('unused') },
    snooze: async () => { throw new Error('unused') },
    reopen: async () => { throw new Error('unused') },
    delete: async () => { throw new Error('unused') },
  } as never)
  const page = createPageStore()
  function useSnap<S>(selector: (state: unknown) => S): S {
    return useSyncExternalStore(store.source.subscribe, () => selector(store.source.getSnapshot()))
  }
  await store.refresh(true)
  const props = { t, page, refresh: vi.fn(), useSnap, registerUi: undefined } as unknown as InboxPageProps
  render(<InboxPage {...props} />)
}

describe('empty/loading honesty', () => {
  it('names what the backfill scanned when the inbox is empty', async () => {
    await renderWithCaptureLastBackfill({ eligible: 49, folded: 49, skipped: 0, failed: 0, drafts: 3, durationMs: 10, at: 1 })
    expect(await screen.findByText(/scanned 2 of 49 stored sessions/u)).toBeTruthy()
  })

  it('says it is still scanning before the first pass reports', async () => {
    await renderWithCaptureLastBackfill(undefined)
    expect(await screen.findByText(/Catching up on earlier sessions/u)).toBeTruthy()
  })
})
