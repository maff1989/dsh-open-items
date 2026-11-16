/**
 * Session → workspace resolution for the inbox lens (DESIGN §5.10, D14).
 *
 * Ownership is **membership in `workspace.sessionIds`**, exactly as the shipped
 * sidebar resolves it (`repo:docs/subsystems/workspace.md:120`), never a `cwd`
 * comparison: a session can be moved between workspaces, a workspace can be
 * renamed or deleted, and two workspaces can share a directory spelling. The
 * item stores a snapshot so grouping history survives deletion.
 *
 * The resolver is a pure function over a structural registry list, so it is
 * testable without the Host service and the capture wiring can pass a fake.
 *
 * @module dsh-open-items/host/workspace
 */

import type { WorkspaceRef } from '../shared/schema'

/** The one workspace grouping label the UI uses for items outside every workspace. */
export const UNGROUPED_LABEL = 'Ungrouped'

/** The minimal workspace shape the resolver reads. */
export interface WorkspaceLike {
  readonly id: string
  readonly path?: string
  readonly title?: string
  readonly sessionIds?: readonly string[]
}

/** The minimal workspace registry shape the resolver reads. */
export interface WorkspaceRegistryLike {
  list(): readonly WorkspaceLike[]
}

/** Resolve one session's workspace membership. */
export type WorkspaceResolver = (sessionId: string) => WorkspaceRef | undefined

/**
 * Project one workspace onto the snapshot an item stores.
 *
 * `workspaceId` is the durable grouping identity; `title` and `path` are display
 * snapshots, so a deleted workspace still renders under the name it had.
 * @param workspace - registry entity (or a structural stand-in).
 * @returns the snapshot to store on the item.
 */
export function workspaceRefOf(workspace: WorkspaceLike): WorkspaceRef {
  const title = workspace.title?.trim()
  const path = workspace.path?.trim()
  return {
    workspaceId: workspace.id,
    ...title === undefined || title === '' ? {} : { title },
    ...path === undefined || path === '' ? {} : { path },
  }
}

/**
 * Build a resolver over one registry snapshot.
 *
 * The registry's durable order decides the winner when two workspaces both list
 * a session (it cannot in practice, but the rule is explicit rather than
 * incidental): the first workspace whose `sessionIds` contains the id.
 * @param workspaces - the registry's ordered list.
 * @returns a resolver returning the membership snapshot, or undefined for
 *   Ungrouped.
 */
export function resolverFrom(workspaces: readonly WorkspaceLike[]): WorkspaceResolver {
  const ordered = [...workspaces]
  return (sessionId: string): WorkspaceRef | undefined => {
    if (sessionId === '') return undefined
    for (const workspace of ordered) {
      if (workspace.sessionIds?.includes(sessionId) === true) return workspaceRefOf(workspace)
    }
    return undefined
  }
}

/**
 * Resolve workspace membership through a live registry.
 *
 * Every call reads the registry's current list: the list is synchronous and
 * cheap (in-memory, durable order) and a backfill spans many minutes over which
 * the user may rename or re-group, so a cached snapshot would go stale.
 * A missing registry (an uncomposed Workspace capability) resolves Ungrouped
 * instead of failing capture.
 * @param registry - the workspace registry, when the profile mounts one.
 * @returns a resolver for the current registry state.
 */
export function createWorkspaceResolver(registry: WorkspaceRegistryLike | undefined): WorkspaceResolver {
  return (sessionId: string): WorkspaceRef | undefined => {
    if (registry === undefined) return undefined
    return resolverFrom(registry.list())(sessionId)
  }
}

/**
 * Read the workspace registry from an optional Host service lookup.
 *
 * `ctx.get('workspaceRegistry')` is the sanctioned optional-service read; the
 * capture wiring degrades to Ungrouped when the capability is absent.
 * @param get - service lookup, normally `ctx.get`.
 * @returns the registry, or undefined when the profile does not mount it.
 */
export function findWorkspaceRegistry(
  get: (name: string) => unknown,
): WorkspaceRegistryLike | undefined {
  const candidate = get('workspaceRegistry')
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const list = (candidate as { list?: unknown }).list
  if (typeof list !== 'function') return undefined
  return candidate as WorkspaceRegistryLike
}
