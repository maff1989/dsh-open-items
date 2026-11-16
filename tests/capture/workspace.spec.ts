/**
 * Workspace resolution rules: membership, order, snapshots and the Ungrouped
 * fallback (DESIGN §5.10). No cwd heuristic is ever consulted.
 *
 * @module tests/capture/workspace.spec
 */

import { describe, expect, it } from 'vitest'

import {
  UNGROUPED_LABEL,
  createWorkspaceResolver,
  findWorkspaceRegistry,
  resolverFrom,
  workspaceRefOf,
  type WorkspaceLike,
} from '../../src/host/workspace'

/** One ordered registry list: Hookshot, then a second workspace. */
const WORKSPACES: readonly WorkspaceLike[] = [
  { id: 'ws-1', title: 'Hookshot', path: '/work/hookshot', sessionIds: ['s-a', 's-b'] },
  { id: 'ws-2', title: 'Orbit', path: '/work/orbit', sessionIds: ['s-c'] },
  { id: 'ws-3', title: 'Empty', path: '/work/empty', sessionIds: [] },
]

describe('membership resolution', () => {
  it('resolves the workspace whose sessionIds contains the session', () => {
    const resolve = resolverFrom(WORKSPACES)
    expect(resolve('s-b')).toEqual({ workspaceId: 'ws-1', title: 'Hookshot', path: '/work/hookshot' })
    expect(resolve('s-c')).toEqual({ workspaceId: 'ws-2', title: 'Orbit', path: '/work/orbit' })
  })

  it('returns undefined (Ungrouped) for a session no workspace lists', () => {
    const resolve = resolverFrom(WORKSPACES)
    expect(resolve('s-missing')).toBeUndefined()
    expect(resolve('')).toBeUndefined()
    // A workspace exists but does not own this session; cwd proximity is irrelevant.
    expect(resolve('s-elsewhere')).toBeUndefined()
  })

  it('first workspace in durable order wins when two list the same session', () => {
    const overlapping: readonly WorkspaceLike[] = [
      { id: 'ws-first', title: 'First', sessionIds: ['s-shared'] },
      { id: 'ws-second', title: 'Second', sessionIds: ['s-shared'] },
    ]
    expect(resolverFrom(overlapping)('s-shared')?.workspaceId).toBe('ws-first')
  })

  it('does not mutate the registry list it was given', () => {
    const list = [...WORKSPACES]
    const resolve = resolverFrom(list)
    resolve('s-a')
    resolve('s-c')
    expect(list.map(workspace => workspace.id)).toEqual(['ws-1', 'ws-2', 'ws-3'])
  })
})

describe('snapshots', () => {
  it('keeps the display title and path with the durable id', () => {
    expect(workspaceRefOf({ id: 'ws-9', title: 'Renamed', path: '/work/x' }))
      .toEqual({ workspaceId: 'ws-9', title: 'Renamed', path: '/work/x' })
  })

  it('omits blank fields rather than storing empty strings', () => {
    expect(workspaceRefOf({ id: 'ws-9', title: '  ', path: '' })).toEqual({ workspaceId: 'ws-9' })
    expect(workspaceRefOf({ id: 'ws-9' })).toEqual({ workspaceId: 'ws-9' })
  })
})

describe('live registry and degradation', () => {
  it('reads the registry list on every call so a rename lands immediately', () => {
    let title = 'Before'
    const registry = {
      list: () => [{ id: 'ws-1', title, path: '/work/hookshot', sessionIds: ['s-a'] }],
    }
    const resolve = createWorkspaceResolver(registry)
    expect(resolve('s-a')?.title).toBe('Before')
    title = 'After'
    expect(resolve('s-a')?.title).toBe('After')
  })

  it('resolves Ungrouped when no workspace capability is mounted', () => {
    expect(createWorkspaceResolver(undefined)('s-a')).toBeUndefined()
  })

  it('finds a structural registry through an optional service lookup', () => {
    const registry = { list: () => WORKSPACES }
    expect(findWorkspaceRegistry(name => name === 'workspaceRegistry' ? registry : undefined))
      .toBe(registry)
  })

  it('treats a missing or malformed service as absent', () => {
    expect(findWorkspaceRegistry(() => undefined)).toBeUndefined()
    expect(findWorkspaceRegistry(() => ({ list: 'not a function' }))).toBeUndefined()
    expect(findWorkspaceRegistry(() => null)).toBeUndefined()
  })

  it('exposes the Ungrouped label the surfaces use', () => {
    expect(UNGROUPED_LABEL).toBe('Ungrouped')
  })
})
