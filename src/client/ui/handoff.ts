/**
 * Navigation seam shared by every surface that jumps into the inbox page.
 *
 * The page's sections are item-state partitions, so a handoff that selects an
 * item must also land on a section that can contain it. Without the target tab,
 * "Open in inbox" from a resolved row or a candidate left the page on Needs you
 * with a selected id no section item matched — a blank detail pane that looked
 * like a dead click.
 *
 * @module dsh-open-items/client/ui/handoff
 */
import type { OpenItemRecord } from '../../shared/schema'
import type { InboxTab } from '../data/page-store'

/** What a cross-surface handoff can ask the page to show. */
export interface OpenInboxOptions {
  /** Item to select once the page lands. */
  readonly itemId?: string
  /** Session to narrow the page to. */
  readonly sessionId?: string
  /** Section that can contain the target item (defaults to Needs you). */
  readonly tab?: InboxTab
}

/**
 * The section that contains one record.
 * @param item - the durable record a handoff points at.
 * @returns the inbox section for that record.
 */
export function inboxTabFor(item: Pick<OpenItemRecord, 'state' | 'tier'>): InboxTab {
  if (item.state === 'snoozed') return 'snoozed'
  // An answered-but-unacknowledged item shows in the register's in-flight band
  // (the inbox read's needs-you window is open/stale only).
  if (item.state === 'awaiting' || item.state === 'resolved' || item.state === 'archived') return 'resolved'
  if (item.tier === 'candidate') return 'candidates'
  return 'needs-you'
}
