/**
 * The list read one section tab needs.
 *
 * The inbox page is four sections over one App-scoped store. The Host's list
 * endpoint defaults to needs-you states, so a read that carries no state filter
 * can never return a snoozed row; before this mapping, the Snoozed tab was
 * always empty while its count was non-zero (the same class of contradiction as
 * the new-item watermark). The mapping is kept pure so the contract is testable
 * without a transport.
 *
 * Counts are unaffected: the Host computes them over every stored record, so
 * switching tabs never changes the nav/page numbers.
 *
 * @module dsh-open-items/client/data/tab-query
 */
import type { ListStatusFilter, OpenItemState, OpenItemTier } from '../../shared/schema'
import type { InboxTab } from './page-store'

/** States and tiers one section reads. */
export interface SectionQuery {
  /** `all`, then narrowed by `states`; the Host's absent-status default is needs-you only. */
  readonly status: ListStatusFilter
  readonly states: readonly OpenItemState[]
  readonly tiers?: readonly OpenItemTier[]
}

/**
 * The state/tier filter of one section read.
 * @param tab - active inbox section.
 * @returns the filter sent with the list request.
 */
export function inboxQueryForTab(tab: InboxTab): SectionQuery {
  switch (tab) {
    case 'needs-you':
      return { status: 'all', states: ['open', 'stale'] }
    case 'candidates':
      // Candidates are open/stale items with the candidate tier; the page's own
      // tab predicate still narrows to the tier after the read.
      return { status: 'all', states: ['open', 'stale'], tiers: ['candidate'] }
    case 'snoozed':
      return { status: 'all', states: ['snoozed'] }
    case 'resolved':
      // The register owns the Resolved content; the inbox read only keeps the
      // page title counts fresh, so it keeps the needs-you window.
      return { status: 'all', states: ['open', 'stale'] }
  }
}
