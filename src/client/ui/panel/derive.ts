/**
 * Pure derivations behind the session panel: which items belong to which
 * section, which of them the panel may answer, and what each row's controls are.
 *
 * React-free and transport-free so the rules are unit-testable. The panel
 * renders only what these functions return; no component re-derives a rule.
 *
 * Rules (UI.md §7.2-§7.3, DESIGN.md §5.9):
 * - Needs you = the OI-05 predicate (structural severity 1|2 in `open`/`stale`);
 *   candidates and severity-3 FYI rows are not counted here (the page owns the
 *   Candidates tab and the FYI group), so the panel and the page share one
 *   meaning of "needs you".
 * - Waiting on the agent = `awaiting` (answered, not yet acknowledged).
 * - Resolved here = the register page (active resolutions), newest first, last
 *   five by default; the panel never renders archived rows.
 * - Snoozed items are deliberately absent: the panel is "what this chat still
 *   owes me", and a snoozed item is one the reader deferred (the inbox owns it).
 * - Only an item raised by the `open_items` tool is answerable in the panel. A
 *   live shipped ask (a harness approval/question the composer card owns) is
 *   hand-off only: the panel never renders a second Allow/Deny surface.
 *
 * @module dsh-open-items/client/ui/panel/derive
 */
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'

import type { OpenItemRecord, ReplyDescriptor } from '../../../shared/schema'
import { compareItems, isNeedsYou, isResolved } from '../../derive/inbox-view'

export { isResolved }

/** The panel's section filter, as the three header pills express it. */
export type PanelFilter = 'all' | 'needs-you' | 'waiting'

/** Section identity, used for headings and keys. */
export type PanelSectionId = 'needs-you' | 'waiting' | 'resolved'

/** What a row is allowed to do, from the non-duplication rule. */
export type PanelControl = 'answerable' | 'handoff' | 'readonly'

/** The control model a row renders inside its action line. */
export type PanelChoice =
  | { readonly kind: 'approval' }
  | { readonly kind: 'options'; readonly options: readonly string[] }
  | { readonly kind: 'text' }
  | { readonly kind: 'none' }

/** Maximum rows the panel renders per list before it says it is truncating. */
export const PANEL_ROW_LIMIT = 200
/** Rows one "Show more" click reveals per section. */
export const PANEL_ROW_STEP = 50

/** Maximum resolved rows shown inside the collapsed disclosure. */
export const PANEL_RESOLVED_LIMIT = 5

/** Kinds a shipped composer card can own (hand-off only in the panel). */
const SHIPPED_ASK_KINDS: readonly OpenItemRecord['kind'][] = ['approval', 'question', 'plan-review']

/**
 * An item still waiting on the user, using the page's one strict meaning
 * (resolve-3 refinement): structural severity 1|2 in open/stale. Candidates and
 * severity-3 FYI items are excluded from the panel's "Needs you" so the page and
 * the panel can never show different numbers under the same words; the page owns
 * those surfaces (Candidates tab, FYI group).
 * @param item - the durable record.
 * @returns true when the item is "needs you" by the OI-05 predicate.
 */
export function isOpenItem(item: OpenItemRecord): boolean {
  return isNeedsYou(item)
}

/** An item the user answered that the session has not acknowledged yet. */
export function isWaitingItem(item: OpenItemRecord): boolean {
  return item.deletedAt === undefined && item.state === 'awaiting'
}

/**
 * Whether the `open_items` tool raised this item and it therefore has its own
 * in-session card (DESIGN §5.9 non-duplication table).
 *
 * Detection source is authoritative, not `source.callId`: a *shipped* question
 * also carries its tool `callId`, and that is exactly the item the panel must
 * hand off rather than answer (the tool raise path stamps `detectedBy: ['tool']`
 * — `src/host/store.ts`, `src/host/tools.ts`).
 * @param item - the durable record.
 * @returns true when the tool owns the answer surface.
 */
export function isToolRaised(item: OpenItemRecord): boolean {
  return item.detectedBy.includes('tool')
}

/**
 * Whether this is a live harness ask whose answer surface is the shipped
 * composer card (so the panel must not render its own Allow/Deny).
 * @param item - the durable record.
 * @returns true when the row is hand-off only.
 */
export function isHandoffOnly(item: OpenItemRecord): boolean {
  return !isToolRaised(item)
    && item.blocking
    && SHIPPED_ASK_KINDS.includes(item.kind)
}

/**
 * The control model of one row.
 * @param item - the durable record.
 * @returns the row's allowed action class.
 */
export function panelControlOf(item: OpenItemRecord): PanelControl {
  if (!isOpenItem(item)) return 'readonly'
  if (item.tier === 'candidate') return 'readonly'
  if (isToolRaised(item)) return replyDescriptorOf(item) === undefined ? 'readonly' : 'answerable'
  if (isHandoffOnly(item)) return 'handoff'
  return 'readonly'
}

/** The reply descriptor an answerable item exposes, when it exposes anything. */
function replyDescriptorOf(item: OpenItemRecord): ReplyDescriptor | undefined {
  const descriptor = item.reply
  const hasOptions = (descriptor.options ?? item.options ?? []).length > 0
  if (!descriptor.freeText && !hasOptions && descriptor.controls.length === 0) return undefined
  return descriptor
}

/**
 * The control model a row renders.
 * @param item - the durable record.
 * @returns the choice model (never for a non-answerable row).
 */
export function choiceModelOf(item: OpenItemRecord): PanelChoice {
  if (panelControlOf(item) !== 'answerable') return { kind: 'none' }
  const descriptor = replyDescriptorOf(item)
  if (descriptor === undefined) return { kind: 'none' }
  const options = descriptor.options ?? item.options ?? []
  if (descriptor.controls.includes('approve') || descriptor.controls.includes('deny')) {
    return { kind: 'approval' }
  }
  if (descriptor.controls.includes('option') && options.length > 0) return { kind: 'options', options }
  if (descriptor.freeText) return { kind: 'text' }
  if (options.length > 0) return { kind: 'options', options }
  return { kind: 'none' }
}

/**
 * The dot tone of one row: attention for a blocking structural item, ongoing
 * for an answer in flight, done for a resolution, idle otherwise.
 * @param item - the durable record.
 * @returns the StateDot state.
 */
export function dotStateOf(item: OpenItemRecord): StateDotState {
  if (isResolved(item)) return 'done'
  if (item.state === 'awaiting') return 'ongoing'
  if (item.tier === 'candidate') return 'idle'
  return item.severity === 1 ? 'warning' : 'idle'
}

/**
 * Triage order of the Needs-you section: structural before candidate, then the
 * inbox's severity-then-longest-waiting order.
 * @param left - first record.
 * @param right - second record.
 * @returns comparator result.
 */
export function compareNeedsYou(left: OpenItemRecord, right: OpenItemRecord): number {
  const tierRank = (item: OpenItemRecord): number => (item.tier === 'structural' ? 0 : 1)
  if (tierRank(left) !== tierRank(right)) return tierRank(left) - tierRank(right)
  return compareItems(left, right)
}

/** Everything the panel renders for one load state. */
export interface PanelSections {
  readonly filter: PanelFilter
  /** Needs-you rows in render order (candidates last). */
  readonly needsYou: readonly OpenItemRecord[]
  /** Waiting-on-the-agent rows, newest first. */
  readonly waiting: readonly OpenItemRecord[]
  /** Resolved rows of the register page, newest first. */
  readonly resolved: readonly OpenItemRecord[]
  /** Total active resolutions in this session (register `total`). */
  readonly resolvedTotal: number
  /**
   * Inferred candidates this session raised and the reader has not confirmed
   * yet. Not Needs-you rows (they are not items until confirmed): the panel only
   * offers the "Inferred (N) → review" handoff to the Candidates tab.
   */
  readonly candidateCount: number
  /** Rows the current filter shows. */
  readonly counts: {
    readonly needsYou: number
    readonly waiting: number
    readonly open: number
    readonly candidates: number
  }
  /** Whether the Needs-you section is in the current filter. */
  readonly showNeedsYou: boolean
  /** Whether the Waiting section is in the current filter. */
  readonly showWaiting: boolean
  /** True when a list cap hides rows (the panel says so). */
  readonly truncated: boolean
}

/**
 * Split a session's stored items into the panel's sections.
 * @param items - records for one session (any lifecycle state).
 * @param filter - active section filter.
 * @returns sections, counts and visibility flags.
 */
export function derivePanelSections(
  items: readonly OpenItemRecord[],
  filter: PanelFilter,
  limit: number = PANEL_ROW_LIMIT,
): Pick<PanelSections, 'needsYou' | 'waiting' | 'counts' | 'showNeedsYou' | 'showWaiting' | 'truncated' | 'candidateCount'> {
  const live = items.filter(item => item.deletedAt === undefined)
  const needsYou = live.filter(isOpenItem).slice().sort(compareNeedsYou)
  const waiting = live
    .filter(isWaitingItem)
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt || compareItems(left, right))
  const limitedNeedsYou = needsYou.slice(0, limit)
  const limitedWaiting = waiting.slice(0, limit)
  // Candidates are counted for the handoff row but are never Needs-you rows:
  // they only become items when the reader confirms them on the page.
  const candidateCount = live.filter(item => item.tier === 'candidate'
    && (item.state === 'open' || item.state === 'stale')).length
  return {
    needsYou: limitedNeedsYou,
    waiting: limitedWaiting,
    candidateCount,
    counts: {
      needsYou: needsYou.length,
      waiting: waiting.length,
      open: needsYou.length + waiting.length,
      candidates: candidateCount,
    },
    showNeedsYou: filter !== 'waiting',
    showWaiting: filter !== 'needs-you',
    truncated: needsYou.length > limitedNeedsYou.length || waiting.length > limitedWaiting.length,
  }
}

/**
 * Merge the derived sections with the register page the store already holds.
 * @param items - session items from the last list read.
 * @param resolved - register page (newest first).
 * @param resolvedTotal - register total for this session.
 * @param filter - active section filter.
 * @returns the complete section view.
 */
export function derivePanelView(
  items: readonly OpenItemRecord[],
  resolved: readonly OpenItemRecord[],
  resolvedTotal: number,
  filter: PanelFilter,
  limit: number = PANEL_ROW_LIMIT,
): PanelSections {
  const sections = derivePanelSections(items, filter, limit)
  return {
    ...sections,
    filter,
    resolved: resolved.slice(0, PANEL_RESOLVED_LIMIT),
    resolvedTotal,
  }
}

/**
 * Copy key of a row's context action.
 * @param control - the row's control class.
 * @param item - the durable record.
 * @param canRevealAsk - whether the shipped question card's reveal seam exists.
 * @returns the dictionary key for the action label.
 */
export function rowActionKeyOf(
  control: PanelControl,
  item: OpenItemRecord,
  canRevealAsk: boolean,
): 'panel.action.answerInChat' | 'panel.action.openInbox' | 'panel.action.showInChat' | 'panel.action.review' {
  if (control === 'handoff') return canRevealAsk && item.source.callId !== undefined ? 'panel.action.answerInChat' : 'panel.action.openInbox'
  if (control === 'answerable') return 'panel.action.showInChat'
  if (isResolved(item)) return 'panel.action.openInbox'
  return 'panel.action.review'
}
