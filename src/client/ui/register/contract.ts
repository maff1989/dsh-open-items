/**
 * The page-level seam of the Resolved tab.
 *
 * The page is composed by `src/client/index.ts`, which owns the transport. This
 * module is the small, additive contract that lets the page mount the register
 * without importing transport types itself: the composition root passes one
 * `RegisterUi`, and the tab, the detail and the export dialog share its store.
 *
 * `NO_REGISTER_SUBSCRIBE` / `NO_REGISTER_SNAPSHOT` are the stable no-op face for
 * a page composed without the seam (the older unit tests and a partial
 * composition), so `useSyncExternalStore` remains unconditional.
 *
 * @module dsh-open-items/client/ui/register/contract
 */
import type { RegisterStore } from '../../data/register-store'

/** What the page receives to mount the register surfaces. */
export interface RegisterUi {
  readonly store: RegisterStore
}

/** Stable no-op subscription for a page without the seam. */
export const NO_REGISTER_SUBSCRIBE = (): (() => void) => () => undefined

/** Stable undefined snapshot for a page without the seam. */
export const NO_REGISTER_SNAPSHOT = (): undefined => undefined
