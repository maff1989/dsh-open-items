/**
 * Live workspace stamping (REVIEW-rc1 P0-04c, WP-02).
 *
 * Derived items captured after install used to be Ungrouped forever: only the
 * backfill resolved the workspace snapshot. The live driver now receives the
 * same Host registry seam and stamps every draft exactly as the backfill does —
 * membership in `workspace.sessionIds`, never a `cwd` heuristic (DESIGN §5.10).
 *
 * @module tests/capture/workspace-live.spec
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import { createCaptureDriver, registerOpenItemsCapture, type LiveSessionLike } from '../../src/host/capture'
import { createHostWorkspaceResolver } from '../../src/host/capture-context'
import { FakeCaptureContext, FakeSink } from './fakes'
import { T0, approvalAsked, approvalDecided, askUserQuestionArgs, toolCall, turnEnd, turnStart } from './fixtures'

/** One deterministic clock. */
const NOW = T0 + 5 * 24 * 60 * 60 * 1000

/** A real `Session`-shaped record whose cwd deliberately differs from membership. */
function liveSession(sessionId: string, cwd: string): LiveSessionLike {
  return { id: sessionId, inheritedEventCount: 0, header: { id: sessionId, createdAt: T0, cwd } }
}

/** One deleted-tool pair: a live draft source. */
function approvalPair(callId: string): ReturnType<typeof approvalAsked>[] {
  return [approvalAsked(0, `approval-${callId}`, 'bash', callId), approvalDecided(1, `approval-${callId}`, 'unavailable')]
}

describe('createCaptureDriver workspace seam', () => {
  it('stamps the resolver snapshot by session membership, not by cwd', async () => {
    const sink = new FakeSink()
    const driver = createCaptureDriver({
      sink,
      source: 'projection',
      now: () => NOW,
      workspaceOf: sessionId => sessionId === 'session-root'
        ? { workspaceId: 'ws-1', title: 'Hookshot', path: '/work/hookshot' }
        : undefined,
    })
    const drafts = await driver.driveSession(liveSession('session-root', '/work/elsewhere'), approvalPair('call-1'))
    expect(drafts[0]?.workspace).toEqual({ workspaceId: 'ws-1', title: 'Hookshot', path: '/work/hookshot' })
    // The session's own cwd is still captured as evidence, independent of the lens.
    expect(drafts[0]?.cwd).toBe('/work/elsewhere')
  })

  it('leaves a non-member draft ungrouped (Ungrouped fallback)', async () => {
    const driver = createCaptureDriver({
      sink: new FakeSink(),
      source: 'projection',
      now: () => NOW,
      workspaceOf: sessionId => sessionId === 'session-member'
        ? { workspaceId: 'ws-1', title: 'Hookshot' }
        : undefined,
    })
    const drafts = await driver.driveSession(liveSession('session-other', '/work/hookshot'), approvalPair('call-2'))
    expect(drafts[0]?.workspace).toBeUndefined()
  })

  it('contains a throwing resolver: the draft still lands without a workspace', async () => {
    const errors: unknown[] = []
    const driver = createCaptureDriver({
      sink: new FakeSink(),
      source: 'projection',
      now: () => NOW,
      workspaceOf: () => {
        throw new Error('registry unavailable')
      },
      onError: error => { errors.push(error) },
    })
    const drafts = await driver.driveSession(liveSession('session-root', '/work/x'), approvalPair('call-3'))
    expect([...new Set(drafts.map(draft => draft.artifactId))]).toEqual(['approval:call-3'])
    expect(drafts[0]?.workspace).toBeUndefined()
    expect(errors).toHaveLength(1)
  })

  it('resolves once per call, so one event cannot produce mixed snapshots', async () => {
    let calls = 0
    const driver = createCaptureDriver({
      sink: new FakeSink(),
      source: 'projection',
      now: () => NOW,
      workspaceOf: () => {
        calls += 1
        return { workspaceId: 'ws-1' }
      },
    })
    await driver.driveSession(liveSession('session-root', '/work/x'), [
      turnStart(0, 1),
      toolCall(1, 'call-a', 'ask_user_question', askUserQuestionArgs('First?', ['Yes', 'No'])),
      toolCall(2, 'call-b', 'ask_user_question', askUserQuestionArgs('Second?', ['Yes', 'No'])),
      turnEnd(3, 1),
    ])
    expect(calls).toBe(1)
  })
})

describe('createHostWorkspaceResolver', () => {
  /** A service-shaped context: only `get` is used. */
  function fakeContext(services: Readonly<Record<string, unknown>>): Context {
    return { get: (name: string) => services[name] } as unknown as Context
  }

  it('resolves membership and ignores cwd proximity', () => {
    const resolve = createHostWorkspaceResolver(fakeContext({
      workspaceRegistry: {
        list: () => [
          { workspaceId: 'ws-1', title: 'Hookshot', path: '/work/hookshot', sessionIds: ['s-a'] },
          { workspaceId: 'ws-2', title: 'Orbit', path: '/work/orbit', sessionIds: ['s-b'] },
        ],
      },
    }))
    expect(resolve?.('s-b')).toEqual({ workspaceId: 'ws-2', title: 'Orbit', path: '/work/orbit' })
    expect(resolve?.('s-c')).toBeUndefined()
  })

  it('tolerates a registry that throws and reports no capability when absent', () => {
    const throwing = createHostWorkspaceResolver(fakeContext({
      workspaceRegistry: { list: () => { throw new Error('registry offline') } },
    }))
    expect(throwing?.('s-a')).toBeUndefined()
    expect(createHostWorkspaceResolver(fakeContext({}))).toBeUndefined()
  })
})

describe('registerOpenItemsCapture live workspace wiring', () => {
  it('stamps live drafts from the mounted workspace registry', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', {
      list: () => [{ workspaceId: 'ws-live', title: 'Live', path: '/work/live', sessionIds: ['session-root'] }],
    })
    const sink = new FakeSink()
    const capture = registerOpenItemsCapture(ctx, {
      sink,
      context: new FakeCaptureContext({ sessions: [] }),
      now: () => NOW,
      autoBackfill: false,
    })
    try {
      ctx.emit('session/event', liveSession('session-root', '/work/other') as never, {
        seq: 0,
        type: 'approval/asked',
        time: T0,
        data: { id: 'approval-live', toolName: 'bash', callId: 'call-live' },
      } as never)
      ctx.emit('session/event', liveSession('session-root', '/work/other') as never, {
        seq: 1,
        type: 'approval/decided',
        time: T0 + 1000,
        data: { id: 'approval-live', outcome: 'unavailable' },
      } as never)
      await capture.dispose()
      expect(sink.opens[0]?.workspace).toEqual({ workspaceId: 'ws-live', title: 'Live', path: '/work/live' })
    } finally {
      await capture.dispose()
    }
  })
})
