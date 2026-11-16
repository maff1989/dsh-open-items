/**
 * Capture seam catalog tests: the backfill must see the whole persisted corpus,
 * not only the sessions a roster happens to summarise.
 *
 * Regression for the live-profile failure where `sessionController.list()` (the
 * visible-session view) was used as the backfill catalog: a cold profile listed
 * only its resident chats, so the historical pass never ran over the stored
 * logs. The catalog now comes from `sessionQuery.listSessions()` while the
 * controller is optional enrichment.
 *
 * @module tests/capture/seams
 */
import { describe, expect, it } from 'vitest'

import type { Context } from '@deepseek-ai/cordis'

import { createHostCaptureSeams } from '../../src/host/capture-context'
import type { OpenItemsStore } from '../../src/host/store'

/** Minimal service-shaped context: `ctx.get(name)` returns what the test provides. */
function fakeContext(services: Readonly<Record<string, unknown>>): Context {
  return {
    get: (name: string) => services[name],
  } as unknown as Context
}

/** Cursor store stub: the catalog read does not touch it. */
const cursorStore = {
  getCursor: () => undefined,
  putCursor: async () => undefined,
} as unknown as OpenItemsStore

/** One persisted record in the installed `sessionQuery.listSessions()` shape. */
function record(id: string, createdAt: number, extra: Record<string, unknown> = {}): unknown {
  return { header: { id, createdAt, ...extra }, live: false, persisted: true }
}

/** A roster row in the installed `sessionController.list()` shape. */
function rosterRow(sessionId: string, updatedAt: number, running = false): unknown {
  return { sessionId, updatedAt, running, projections: { values: { title: `title of ${sessionId}` } } }
}

describe('capture seams catalog', () => {
  it('lists every persisted session even when the roster only summarises one', async () => {
    const ctx = fakeContext({
      sessionQuery: {
        listSessions: async () => [record('resident', 1_000, { cwd: '/work/a' }), record('cold-1', 2_000, { cwd: '/work/b' }), record('cold-2', 3_000)],
        readSession: async () => ({ events: [] }),
      },
      sessionController: {
        list: async () => ({ items: [rosterRow('resident', 9_000, true)] }),
      },
    })
    const seams = createHostCaptureSeams(ctx, cursorStore)
    expect(seams).toBeDefined()
    const sessions = await seams!.context.listSessions()
    expect(sessions.map(session => session.sessionId)).toEqual(['resident', 'cold-1', 'cold-2'])
  })

  it('enriches roster-known sessions and falls back to the header otherwise', async () => {
    const ctx = fakeContext({
      sessionQuery: {
        listSessions: async () => [record('resident', 1_000, { cwd: '/work/a' }), record('cold', 2_000, { origin: 'subagent', delegationDepth: 1 })],
        readSession: async () => ({ events: [] }),
      },
      sessionController: {
        list: async () => ({ items: [rosterRow('resident', 9_000, true)] }),
      },
    })
    const seams = createHostCaptureSeams(ctx, cursorStore)!
    const sessions = await seams.context.listSessions()
    expect(sessions[0]).toMatchObject({
      sessionId: 'resident',
      updatedAt: 9_000,
      title: 'title of resident',
      cwd: '/work/a',
      archived: false,
    })
    expect(sessions[1]).toMatchObject({ sessionId: 'cold', updatedAt: 2_000, origin: 'subagent', delegationDepth: 1 })
    // Liveness comes from the roster snapshot taken during the catalog read.
    expect(seams.isSessionRunning?.('resident')).toBe(true)
    expect(seams.isSessionRunning?.('cold')).toBeUndefined()
  })

  it('requires the corpus service and tolerates a missing or throwing roster', async () => {
    const noQuery = fakeContext({ sessionController: { list: async () => ({ items: [] }) } })
    expect(createHostCaptureSeams(noQuery, cursorStore)).toBeUndefined()

    const throwingRoster = fakeContext({
      sessionQuery: {
        listSessions: async () => [record('a', 10)],
        readSession: async () => ({ events: [] }),
      },
      sessionController: {
        list: async () => {
          throw new Error('roster unavailable')
        },
      },
    })
    const seams = createHostCaptureSeams(throwingRoster, cursorStore)!
    expect((await seams.context.listSessions()).map(session => session.sessionId)).toEqual(['a'])
  })

  it('skips malformed records instead of inventing a session id', async () => {
    const ctx = fakeContext({
      sessionQuery: {
        listSessions: async () => [{ header: {} }, { header: { id: 42 } }, record('ok', 5)],
        readSession: async () => ({ events: [] }),
      },
    })
    const seams = createHostCaptureSeams(ctx, cursorStore)!
    expect((await seams.context.listSessions()).map(session => session.sessionId)).toEqual(['ok'])
  })

  it('does not report roster activity as a log-activity watermark', async () => {
    // Installed `SessionSummary.updatedAt` is `max(createdAt, lastPromptAt)` — the
    // last *user prompt*, a lower bound on log activity. Skipping a read on it
    // would hide tool/approval events that arrive after the prompt, so the seam
    // reports `updatedAt` for ordering/eligibility only and omits `lastActivityAt`.
    const ctx = fakeContext({
      sessionQuery: {
        listSessions: async () => [record('resident', 1_000)],
        readSession: async () => ({ events: [] }),
      },
      sessionController: { list: async () => ({ items: [rosterRow('resident', 9_000, true)] }) },
    })
    const seams = createHostCaptureSeams(ctx, cursorStore)!
    const [resident] = await seams.context.listSessions()
    expect(resident?.updatedAt).toBe(9_000)
    expect(resident?.lastActivityAt).toBeUndefined()
  })

  it('keeps the header creation time as the only clock for a roster-less session', async () => {
    const ctx = fakeContext({
      sessionQuery: {
        listSessions: async () => [record('cold', 2_000)],
        readSession: async () => ({ events: [] }),
      },
    })
    const seams = createHostCaptureSeams(ctx, cursorStore)!
    const [cold] = await seams.context.listSessions()
    expect(cold).toMatchObject({ sessionId: 'cold', updatedAt: 2_000 })
    expect(cold?.lastActivityAt).toBeUndefined()
  })

  it('marks archived sessions from the workspace registry', async () => {
    const ctx = fakeContext({
      sessionQuery: {
        listSessions: async () => [record('archived', 1)],
        readSession: async () => ({ events: [] }),
      },
      workspaceRegistry: {
        list: () => [],
        archivedSessionIds: ['archived'],
      },
    })
    const seams = createHostCaptureSeams(ctx, cursorStore)!
    expect((await seams.context.listSessions())[0]).toMatchObject({ sessionId: 'archived', archived: true })
  })
})
