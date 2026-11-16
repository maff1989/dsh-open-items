/**
 * The Open Items page shell: header, tabs, grouping/facet controls, the list and
 * the detail pane — one page for every width.
 *
 * Data comes from the app-scoped inbox store; view state (tab, grouping, lens,
 * search, folds, selection, scroll) comes from the app-scoped page store, so
 * opening a session and returning restores the reader's place. Answers travel
 * through the injected settle seam; candidate rows are confirmed or refused
 * through the injected candidate seam (promote / suppress), never answered.
 *
 * Responsive contract (container queries in `styles.ts`):
 * - narrow (<640px): list, or the selected item as a pushed full page;
 * - medium (640-879px): one column with the selected row expanded in place;
 * - wide (>=880px): list column + independently scrolling detail column.
 *
 * @module dsh-open-items/client/ui/page
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  AnimatedRows,
  Button,
  DisclosureRow,
  IconChevronDownOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconCloseOutlineRegular,
  IconFlatListOutlineRegular,
  IconFolderCloseRegular,
  IconRefreshOutlineRegular,
  IconRightUpOutlineRegular,
  IconWarningOutlineRegular,
  IconSearchOutlineRegular,
  Input,
  Menu,
  Modal,
  Pill,
  SegmentedTabs,
  StateDot,
  Tag,
  Tooltip,
  type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

import type { CandidateActions, CandidateFailure, CandidatePromotePatch, CandidateResult } from '../data/candidate-actions'
import { skewOf } from '../data/compat'
import type { InboxState } from '../data/inbox-store'
import {
  ALL_WORKSPACES,
  UNGROUPED_WORKSPACE,
  sessionGroupKey,
  workspaceGroupKey,
  type GroupBy,
  type InboxTab,
  type PageStore,
  type PageState,
} from '../data/page-store'
import type { PageTranslate, SessionTitleResolver } from '../format'
import { absoluteLabel, relativeLabel, sessionLabelOf, tCount, COUNT_KEYS } from '../format'
import type { OpenItemKind, OpenItemRecord, ReplyPayload } from '../../shared/schema'
import type { RegisterState } from '../data/register-store'
import type { AnswerPlan, SettleController } from '../data/settle'
import { announcementOf, attemptOf, sendingAttempt, type AnswerAttempt } from './answer/feedback'
import { answerNotices, noticeOf } from './answer/notices'
import { deriveInboxView, type InboxView, type SessionGroupView, type WorkspaceGroupView } from '../derive/inbox-view'
import type { OpenItemsNamespace } from '../locales'
import { candidateOptionsOf, titleOf } from './candidate'
import { ItemDetail } from './detail'
import type { OpenInboxOptions } from './handoff'
import { KindPicker } from './kind'
import { ItemRow, type RowHandlers } from './row'
import { NO_REGISTER_SNAPSHOT, NO_REGISTER_SUBSCRIBE, type RegisterUi } from './register/contract'
import { RegisterTab } from './register/register-tab'
import { ResolvedDetail } from './register/resolved-detail'

/** What the registration injects into the page. */
export interface InboxPageInjected {
  /** Bare observable exposed through the slot `hooks` compartment. */
  readonly hooks: { readonly snap: ObservableSnapshot<InboxState> }
  /** App-scoped page view state and its named actions. */
  readonly page: PageStore
  /** Force a Host re-read (the page's refresh control). */
  readonly refresh: () => void
  /** Mark the page as visited (the new-item dot clears once it is opened). */
  readonly onOpened?: () => void
  /**
   * The durable last-visit marker as it stood when the page mounted. Items first
   * observed at/after it are "new" for this visit; it is read here before
   * `onOpened` advances the durable marker.
   */
  readonly lastVisit?: () => number
  /** Append the next inbox page (cursor paging, OD-08). */
  readonly loadMore?: () => Promise<void>
  /** Navigation seam for "Open session"; absent in a catalog-less composition. */
  readonly openSession?: (sessionId: string) => void
  /**
   * Resolve a Session display title from the client catalogue. Absent (or
   * unanswered) leaves the item's own snapshot title, then the honest untitled
   * fallback — a missing title never claims the Session was deleted.
   */
  readonly sessionTitle?: SessionTitleResolver
  /** Cross-session/session-scoped navigation into this page (panel handoff). */
  readonly openInbox?: (options?: OpenInboxOptions) => void
  /** Dismiss/snooze seams (the page owns the confirmation copy; the root owns the route). */
  readonly dismiss?: (item: OpenItemRecord) => Promise<void>
  readonly snooze?: (item: OpenItemRecord, until: number) => Promise<void>
  /**
   * Candidate lifecycle seams ("It's an item" / "Not an item"). Absent in a
   * composition without the promote/suppress endpoints; the row then explains
   * instead of rendering a dead control.
   */
  readonly candidates?: CandidateActions
  /** Fixed keyboard subset (OD-09). */
  readonly shortcuts?: {
    bind(hooks: {
      onShortcut(action: 'next' | 'previous' | 'select' | 'clear' | 'send' | 'snooze' | 'dismiss'): void
      isEnabled(): boolean
    }): () => void
    keys(): Record<'next' | 'previous' | 'select' | 'clear' | 'send' | 'snooze' | 'dismiss', readonly string[]>
  }
  /** Carrier reconnect seam for the Resolved tab's freshness. */
  readonly onConnectionReset?: (listener: () => void) => () => void
  /**
   * Answer seam: track 1 settles the shipped live card, track 2 asks the Host
   * to settle, and the delivery matrix carries everything else. Absent in a
   * composition with no delivery layer, which keeps every reply control
   * disabled instead of promising a write that cannot happen.
   */
  readonly settle?: SettleController
  /**
   * Additive seam of the Resolved tab: the register store, its detail and the
   * export dialog. Absent in a composition that predates the register (the
   * other three tabs still render; the Resolved tab says it is unavailable).
   */
  readonly registerUi?: RegisterUi
}

/** Props the renderer assembles for this registration. */
export type InboxPageProps =
  PropsRuntime<'main'>
  & PropsLocale<OpenItemsNamespace>
  & InjectFace<InboxPageInjected>

/** How often relative labels re-render. */
const CLOCK_TICK_MS = 60_000

/** Tab order and dictionary keys. */
const TABS: readonly { readonly value: InboxTab; readonly label: 'tabs.needsYou' | 'tabs.candidates' | 'tabs.snoozed' | 'tabs.resolved' }[] = [
  { value: 'needs-you', label: 'tabs.needsYou' },
  { value: 'candidates', label: 'tabs.candidates' },
  { value: 'snoozed', label: 'tabs.snoozed' },
  { value: 'resolved', label: 'tabs.resolved' },
]

/** One workspace facet's display name, without its count. */
function facetName(t: PageTranslate, facet: InboxView['facets'][number]): string {
  const name = facet.ungrouped
    ? t('controls.workspace.ungrouped')
    : facet.title !== undefined && facet.title !== ''
      ? facet.title
      : facet.workspaceId ?? t('controls.workspace.ungrouped')
  return facet.removed ? `${name} (${t('controls.workspace.removed')})` : name
}

/** One workspace facet option label (menu rows keep their counts). */
function facetLabel(t: PageTranslate, facet: InboxView['facets'][number]): string {
  return `${facetName(t, facet)} (${String(facet.count)})`
}

/** Group heading copy for a session. */
function sessionHeading(t: PageTranslate, group: SessionGroupView): string {
  const title = group.title !== undefined && group.title !== '' ? group.title : t('group.untitledSession')
  const meta = tCount(t, COUNT_KEYS.items, group.items.length)
  return `${title} · ${meta}`
}

/** Group heading copy for a workspace. */
function workspaceHeading(t: PageTranslate, group: WorkspaceGroupView): string {
  const name = group.ungrouped
    ? t('controls.workspace.ungrouped')
    : group.title !== undefined && group.title !== ''
      ? group.title
      : group.workspaceId ?? t('controls.workspace.ungrouped')
  const removed = group.removed ? ` (${t('controls.workspace.removed')})` : ''
  return `${name}${removed} · ${tCount(t, COUNT_KEYS.items, group.itemCount)} · ${tCount(t, COUNT_KEYS.sessions, group.sessionCount)}`
}

/** Disclosure header shared by workspace and session groups. */
function GroupHeader(props: {
  readonly icon: ReactNode
  readonly title: string
  readonly meta?: ReactNode
  readonly open: boolean
  readonly onToggle: () => void
  readonly accessory?: ReactNode
}): ReactNode {
  const accessory = props.meta === undefined && props.accessory === undefined
    ? undefined
    : (
      <>
        {props.meta !== undefined && <span className="dsh-oi-groupMeta">{props.meta}</span>}
        {props.accessory}
      </>
    )
  return (
    <div className="dsh-oi-groupHeader">
      <DisclosureRow
        icon={props.icon}
        title={props.title}
        open={props.open}
        expandable
        expandOnRowClick
        onToggle={props.onToggle}
        {...(accessory === undefined ? {} : { headerAccessory: accessory })}
      />
    </div>
  )
}

/** Tab label key per section, for the named filtered-empty copy. */
const TAB_LABEL_KEY = {
  'needs-you': 'tabs.needsYou',
  candidates: 'tabs.candidates',
  snoozed: 'tabs.snoozed',
  resolved: 'tabs.resolved',
} as const

/** Empty-state copy per tab. */
function emptyCopy(
  t: PageTranslate,
  tab: InboxTab,
  narrowed: boolean,
  search: string,
): { title: string; body: string } {
  if (narrowed) {
    const term = search.trim()
    // Name the needle and the section when a search is what emptied the list;
    // a workspace/session-only narrowing keeps the generic copy.
    if (term !== '') {
      return {
        title: t('empty.filtered.named.title', { term, section: t(TAB_LABEL_KEY[tab]) }),
        body: t('empty.filtered.named.body'),
      }
    }
    return { title: t('empty.filtered.title'), body: t('empty.filtered.body') }
  }
  switch (tab) {
    case 'needs-you':
      return { title: t('empty.needsYou.title'), body: t('empty.needsYou.body') }
    case 'candidates':
      return { title: t('empty.candidates.title'), body: t('empty.candidates.body') }
    case 'snoozed':
      return { title: t('empty.snoozed.title'), body: t('empty.snoozed.body') }
    case 'resolved':
      return { title: t('empty.resolved.title'), body: t('empty.resolved.body') }
  }
}

/**
 * Render the inbox page.
 * @param props - slot standard props, copy and the injected stores/seams.
 * @returns the page element.
 */
export function InboxPage(props: InboxPageProps): ReactNode {
  const { t, page, refresh } = props
  const inbox = props.useSnap(state => state)
  const viewState: PageState = useSyncExternalStore(page.subscribe, page.getSnapshot)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const snapshot = inbox.snapshot
  const skew = skewOf(inbox.hello)
  const sessionTitleOf = props.sessionTitle
  const view = useMemo(
    () => deriveInboxView(snapshot, viewState.filters, sessionTitleOf),
    [snapshot, viewState.filters, sessionTitleOf],
  )
  const selected = useMemo(
    () => view.items.find(item => item.id === viewState.selectedId)
      ?? snapshot?.items.find(item => item.id === viewState.selectedId),
    [view.items, snapshot, viewState.selectedId],
  )
  const settle = props.settle
  // One attempt per item, owned here so the row, the detail, the in-place
  // notice and the live region all read the same state. `pendingWake` holds a
  // send that would spend a turn and has not been confirmed yet; `focusTarget`
  // is where focus goes after a cleared item leaves the list.
  const [attempts, setAttempts] = useState<ReadonlyMap<string, AnswerAttempt>>(() => new Map())
  const [pendingWake, setPendingWake] = useState<{
    readonly itemId: string
    readonly payload: ReplyPayload
    readonly plan: AnswerPlan
  } | null>(null)
  const [focusTarget, setFocusTarget] = useState<string | null>(null)
  // Candidate writes in flight, keyed by item id: one click per candidate, and
  // both controls of that row stay disabled until the Host answers. A refused
  // write keeps its message beside the row/detail until the next attempt.
  const [candidateBusy, setCandidateBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [candidateFailures, setCandidateFailures] = useState<ReadonlyMap<string, CandidateFailure>>(() => new Map())
  const [liveMessage, setLiveMessage] = useState('')
  const [clearedNotice, setClearedNotice] = useState(false)
  const [fyiOpen, setFyiOpen] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkFailure, setBulkFailure] = useState<string | undefined>(undefined)
  // The bulk confirm is a review step, not a blind write: opening the dialog
  // snapshots the ticked rows and their inferred kinds, each correctable.
  const [bulkReviewOpen, setBulkReviewOpen] = useState(false)
  const [bulkKinds, setBulkKinds] = useState<ReadonlyMap<string, OpenItemKind>>(() => new Map())
  // Ticks pruned by a narrowing or a refresh: the page says how many instead of
  // losing them silently.
  const [staleTicks, setStaleTicks] = useState<number | undefined>(undefined)
  // Captured once per mount: advancing the marker on open must not erase the
  // "new" marks the reader just came to see.
  const [visitMarker] = useState(() => props.lastVisit?.() ?? 0)
  const isNewItem = useCallback(
    (item: OpenItemRecord): boolean => visitMarker > 0 && item.firstSeenAt >= visitMarker,
    [visitMarker],
  )
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [groupMenuOpen, setGroupMenuOpen] = useState(false)
  const [sectionMenuOpen, setSectionMenuOpen] = useState(false)
  const [submitSignal, setSubmitSignal] = useState(0)
  const viewRef = useRef(view)
  viewRef.current = view

  /**
   * Answer one item through the controller and render whatever it reports.
   * The first click of a send that would resume an idle session only warns; the
   * explicit confirm arrives through `options.confirmedWake`.
   */
  const runAnswer: (
    item: OpenItemRecord,
    payload: ReplyPayload,
    options?: { readonly confirmedWake?: boolean; readonly deliveryId?: string },
  ) => Promise<void> = useCallback(async (item, payload, options = {}) => {
    if (settle === undefined) return
    const plan: AnswerPlan = settle.planFor?.(item, payload)
      ?? { track: 'message', settles: false, steers: false, requiresWakeConfirmation: true }
    const confirmedWake = options.confirmedWake === true
    if (!confirmedWake && plan.requiresWakeConfirmation) {
      setPendingWake({ itemId: item.id, payload, plan })
      // Keep the item open for the confirm; selecting an already-selected row
      // toggles it closed, so only select when the warning targets another row.
      if (page.getSnapshot().selectedId !== item.id) page.actions.select(item.id)
      return
    }
    setPendingWake(null)
    const sessionTitle = sessionLabelOf(t, item, sessionTitleOf)
    const attemptInput = {
      itemId: item.id,
      plan,
      payload,
      confirmedWake,
      ...(options.deliveryId === undefined ? {} : { deliveryId: options.deliveryId }),
    }
    setAttempts(previous => new Map(previous).set(item.id, sendingAttempt(t, attemptInput)))
    const result = await settle.answer(item, payload, {
      confirmedWake,
      ...(options.deliveryId === undefined ? {} : { deliveryId: options.deliveryId }),
    })
    const attempt = attemptOf(t, { ...attemptInput, sessionTitle, result })
    setAttempts(previous => new Map(previous).set(item.id, attempt))
    const before = viewRef.current.items
    const index = before.findIndex(candidate => candidate.id === item.id)
    const remaining = before.filter(candidate => candidate.id !== item.id)
    const next = remaining[Math.min(Math.max(index, 0), Math.max(remaining.length - 1, 0))]
    const notice = noticeOf(t, attempt, {
      retry: () => {
        void runAnswer(item, payload, {
          ...(attempt.deliveryId === undefined ? {} : { deliveryId: attempt.deliveryId }),
        })
      },
      wake: () => {
        void runAnswer(item, payload, { confirmedWake: true })
      },
    })
    if (notice !== undefined) answerNotices.show(notice)
    setLiveMessage(announcementOf(t, attempt, remaining.length))
    if (attempt.status === 'failed') return
    if (next !== undefined) setFocusTarget(next.id)
    refresh()
  }, [page, refresh, sessionTitleOf, settle, t])

  /** Retry the exact failed attempt of one item, reusing its deliveryId. */
  const retryAttempt = useCallback((item: OpenItemRecord): void => {
    const attempt = attempts.get(item.id)
    if (attempt !== undefined) {
      void runAnswer(item, attempt.payload, {
        ...(attempt.deliveryId === undefined ? {} : { deliveryId: attempt.deliveryId }),
      })
      return
    }
    // A delivery that failed in another surface: its payload and id are durable.
    const last = item.deliveries.at(-1)
    if (last === undefined) return
    void runAnswer(item, last.payload, { deliveryId: last.deliveryId })
  }, [attempts, runAnswer])

  /** The explicit "Send & resume now": a new attempt that may spend a turn. */
  const wakeAttempt = useCallback((item: OpenItemRecord): void => {
    const attempt = attempts.get(item.id)
    const payload = attempt?.payload ?? (pendingWake !== null && pendingWake.itemId === item.id ? pendingWake.payload : undefined)
    if (payload === undefined) return
    setPendingWake(null)
    void runAnswer(item, payload, { confirmedWake: true })
  }, [attempts, pendingWake, runAnswer])

  const cancelWake = useCallback((): void => {
    setPendingWake(null)
  }, [])

  /**
   * Run one candidate write: keep the row disabled while it is in flight, keep
   * the reason beside the row/detail when it is refused, and move focus to the
   * neighbouring row when the candidate leaves the list.
   */
  const runCandidate = useCallback((
    item: OpenItemRecord,
    retry: CandidateFailure['retry'],
    action: (target: OpenItemRecord) => Promise<CandidateResult>,
  ): void => {
    setCandidateFailures(previous => {
      if (!previous.has(item.id)) return previous
      const next = new Map(previous)
      next.delete(item.id)
      return next
    })
    setCandidateBusy(previous => new Set(previous).add(item.id))
    void action(item).then((result) => {
      if (result.ok) {
        const items = viewRef.current.items
        const index = items.findIndex(candidate => candidate.id === item.id)
        const remaining = items.filter(candidate => candidate.id !== item.id)
        const next = remaining[Math.min(Math.max(index, 0), Math.max(remaining.length - 1, 0))]
        page.actions.untickCandidate(item.id)
        if (page.getSnapshot().selectedId === item.id) page.actions.select(null)
        if (next !== undefined) setFocusTarget(next.id)
        return
      }
      setCandidateFailures(previous => new Map(previous).set(item.id, { message: result.message, retry }))
    }).finally(() => {
      setCandidateBusy(previous => {
        if (!previous.has(item.id)) return previous
        const next = new Set(previous)
        next.delete(item.id)
        return next
      })
    })
  }, [page])

  const handlers: RowHandlers = useMemo(() => {
    const base = {
      select: (itemId: string) => page.actions.select(itemId),
      ...(props.openSession === undefined ? {} : { openSession: props.openSession }),
      ...(sessionTitleOf === undefined ? {} : { sessionTitle: sessionTitleOf }),
    }
    const candidates = props.candidates
    const candidateHandlers = candidates === undefined
      ? {}
      : {
          promote: (item: OpenItemRecord, patch?: CandidatePromotePatch) => {
            runCandidate(item, 'promote', (target) => {
              if (patch !== undefined) return candidates.promote(target, patch)
              // A quick confirm from the row has no picker: it keeps the
              // inferred kind and cleans the stored title, and passes the
              // choices through so the promoted row stays answerable.
              const options = candidateOptionsOf(target)
              return candidates.promote(target, {
                kind: target.kind,
                title: titleOf(target),
                ...(options.length === 0 ? {} : { options }),
              })
            })
          },
          suppress: (item: OpenItemRecord) => { runCandidate(item, 'suppress', target => candidates.suppress(target)) },
          candidatePending: (item: OpenItemRecord) => candidateBusy.has(item.id),
          candidateFailure: (item: OpenItemRecord) => candidateFailures.get(item.id),
        }
    if (settle === undefined) return { ...base, ...candidateHandlers }
    return {
      ...base,
      answer: (item: OpenItemRecord, payload: ReplyPayload) => {
        void runAnswer(item, payload)
      },
      canAnswer: item => settle.canAnswer(item),
      canAnswerApproval: item => settle.canDecideApproval(item),
      planFor: (item, payload) => settle.planFor?.(item, payload)
        ?? { track: 'message', settles: false, steers: false, requiresWakeConfirmation: true },
      retry: retryAttempt,
      wake: wakeAttempt,
      ...candidateHandlers,
    }
  }, [candidateBusy, candidateFailures, page, props.candidates, props.openSession, retryAttempt, runAnswer, runCandidate, sessionTitleOf, settle, wakeAttempt])

  // Fixed keyboard subset (OD-09): the page maps navigation/actions; text entry,
  // open menus and IME composition are filtered before this runs.
  useEffect(() => {
    const shortcuts = props.shortcuts
    if (shortcuts === undefined) return undefined
    return shortcuts.bind({
      isEnabled: () => !document.hidden,
      onShortcut: (action) => {
        const items = viewRef.current.items
        const selectedId = page.getSnapshot().selectedId
        const index = items.findIndex(item => item.id === selectedId)
        const select = (at: number): void => {
          const item = items[Math.min(Math.max(at, 0), Math.max(items.length - 1, 0))]
          if (item !== undefined) page.actions.select(item.id)
        }
        if (action === 'next') { select(index + 1); return }
        if (action === 'previous') { select(index === -1 ? 0 : index - 1); return }
        if (action === 'select') { select(index === -1 ? 0 : index); return }
        if (action === 'clear') { page.actions.select(null); return }
        if (action === 'send') { setSubmitSignal(value => value + 1); return }
        const item = items[index] ?? snapshot?.items.find(candidate => candidate.id === selectedId)
        if (item === undefined) return
        // A candidate is confirmed or refused, never dismissed/snoozed through
        // the generic keys: those actions would bypass its one rejection path.
        if (item.tier === 'candidate') return
        if (action === 'dismiss') { void dismissAndClean?.(item); return }
        snoozeAndClean?.(item, Date.now() + 3_600_000)
      },
    })
  }, [page, props.shortcuts, props.dismiss, props.snooze, snapshot])

  // Resolved tab (additive): one subscription to the register store, so the
  // list, the in-flight band and the wide detail column share one state.
  const registerUi = props.registerUi
  const registerState: RegisterState | undefined = useSyncExternalStore(
    registerUi?.store.subscribe ?? NO_REGISTER_SUBSCRIBE,
    registerUi?.store.getSnapshot ?? NO_REGISTER_SNAPSHOT,
  )
  const resolvedSelected = registerState === undefined
    ? undefined
    : [...registerState.items, ...registerState.inFlight].find(item => item.id === registerState.selectedId)
  const registerDetailHandlers = useMemo(() => {
    if (registerUi === undefined) return undefined
    const store = registerUi.store
    return {
      onBack: () => store.actions.select(null),
      onSessionFilter: (sessionId: string) => store.actions.setFilters({ sessionId }),
      onReopen: (itemId: string) => {
        void store.actions.reopen(itemId).then(() => {
          if (store.getSnapshot().notice?.tone === 'ok') refresh()
        })
      },
      onDismissNotice: () => store.actions.dismissNotice(),
      ...(sessionTitleOf === undefined ? {} : { sessionTitle: sessionTitleOf }),
    }
  }, [registerUi, refresh, sessionTitleOf])

  // Restore the list scroll position once per mount: the page unmounts when a
  // conversation opens, and the reader's place must come back.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pageRef = useRef<HTMLDivElement | null>(null)
  // S-08: exactly one detail mount. The in-row expansion belongs to the medium
  // single-column layout (640-879px); wide and narrow use the detail column.
  // jsdom has no ResizeObserver, so tests keep the column path (medium=false).
  const [medium, setMedium] = useState(false)
  const [wide, setWide] = useState(false)
  // Responsive layout modes the CSS cannot switch by itself: narrow pushes a
  // detail page (head becomes a back row) and phone replaces the tab strip with
  // a Section menu (below ~440px page width the four labels would clip).
  const [narrow, setNarrow] = useState(false)
  const [phone, setPhone] = useState(false)
  useEffect(() => {
    const node = pageRef.current
    if (node === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      setMedium(width >= 640 && width < 880)
      setWide(width >= 880)
      setNarrow(width < 640)
      setPhone(width < 440)
    })
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [])
  const restored = useRef(false)
  // S-01 deviation (round-4): the inert compact page bar was removed. The bar is
  // not sticky, so the 28→16px shrink was decoration that only jumped the
  // layout; UI.md §2 records the deviation.
  useLayoutEffect(() => {
    if (restored.current) return
    restored.current = true
    const node = scrollRef.current
    if (node !== null) node.scrollTop = viewState.scrollTop
  }, [viewState.scrollTop])

  const onScroll = useCallback(() => {
    const node = scrollRef.current
    if (node !== null) page.actions.rememberScroll(node.scrollTop)
  }, [page.actions])

  // Opening the page is the visit: advance the durable marker and refresh the
  // counts so the sidebar's new-item dot clears (UI.md §8).
  const opened = props.onOpened
  useEffect(() => {
    opened?.()
  }, [opened])

  // The app-scoped page store survives page unmounts, so the initial read
  // already used the persisted tab. When the reader changes sections the list
  // must be re-read for that section's population: the default needs-you window
  // cannot return a snoozed row, so the Snoozed tab would otherwise stay empty
  // under a non-zero count.
  const readTab = useRef(viewState.filters.tab)
  useEffect(() => {
    if (readTab.current === viewState.filters.tab) return
    readTab.current = viewState.filters.tab
    refresh()
  }, [refresh, viewState.filters.tab])

  // The section the page currently shows, compared with the section the last
  // completed read answered. While they differ, the list renders a loading state
  // instead of the previous section's rows (and never its empty copy).
  const sectionPending = inbox.snapshot !== undefined
    && inbox.readKey !== undefined
    && inbox.readKey !== view.tab

  // On the wide layout the detail column is a third of the page: select the
  // first row once so the page opens as a master-detail view rather than an
  // instruction. Only once per mount, and never over an explicit handoff.
  const autoSelected = useRef(false)
  useEffect(() => {
    if (autoSelected.current || !wide || inbox.snapshot === undefined) return
    if (viewState.selectedId !== null) {
      autoSelected.current = true
      return
    }
    const first = view.items[0]
    if (first === undefined) return
    autoSelected.current = true
    page.actions.select(first.id)
  }, [inbox.snapshot, page, view.items, viewState.selectedId, wide])

  // Clear a selection that the current section no longer contains (a dismiss or
  // snooze from the detail used to leave a dangling id and a blank pane), and
  // say so instead of showing the instruction-only empty pane.
  useEffect(() => {
    if (viewState.selectedId === null) return
    // The Resolved section reads its rows from the register store, not this
    // list; and a section that has not finished its read yet cannot judge a
    // handoff selection (it must not be cleared on the previous section's data).
    if (view.tab === 'resolved') return
    if (inbox.readKey !== view.tab) return
    // FYI rows are selectable but deliberately outside `view.items` (they are
    // not "needs you"), so the containment check includes them.
    if (
      view.items.some(item => item.id === viewState.selectedId)
      || view.fyi.some(item => item.id === viewState.selectedId)
    ) {
      setClearedNotice(false)
      return
    }
    page.actions.select(null)
    setClearedNotice(true)
  }, [inbox.readKey, view.tab, view.items, view.fyi, page, viewState.selectedId])

  // Bulk ticks describe rows the reader can see. Whenever a workspace/search/
  // session narrowing or an inbox refresh changes that set, the ticks for rows
  // that vanished are pruned and the page reports how many (never silently).
  // The section-read guard keeps a still-loading section from pruning ticks
  // against the previous section's rows.
  useEffect(() => {
    if (view.tab !== 'candidates') return
    if (inbox.readKey !== view.tab) return
    if (viewState.candidateSelection.size === 0) return
    const removed = page.actions.pruneCandidates(view.items.map(item => item.id))
    if (removed > 0) setStaleTicks(removed)
  }, [inbox.readKey, page, view.items, view.tab, viewState.candidateSelection])

  // Same session+turn candidates are one turn's decisions (contract §3): the
  // row annotates how many siblings the turn produced.
  const sameTurnCounts = useMemo(() => {
    const counts = new Map<string, number>()
    if (view.tab !== 'candidates') return counts
    for (const item of view.items) {
      if (item.source.turn === undefined) continue
      const key = `${item.source.sessionId}:${String(item.source.turn)}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [view.items, view.tab])

  // The ticked rows, resolved against the list the reader can actually see.
  const bulkTargets = useMemo(
    () => (view.tab === 'candidates'
      ? view.items.filter(item => viewState.candidateSelection.has(item.id))
      : []),
    [view.items, view.tab, viewState.candidateSelection],
  )

  /**
   * Open the bulk review. Nothing is written from the bar: the dialog lists the
   * projected title and the chosen/inferred kind of each ticked candidate, and
   * the kinds are correctable there before the one confirm write.
   */
  const openBulkReview = useCallback((): void => {
    const selected = page.getSnapshot().candidateSelection
    const targets = viewRef.current.items.filter(item => selected.has(item.id))
    if (targets.length === 0) {
      // Nothing visible left to confirm (the ticks went stale): clear them so
      // the bar cannot promise an action that would do nothing.
      setStaleTicks(selected.size)
      page.actions.clearCandidates()
      return
    }
    setBulkFailure(undefined)
    setBulkKinds(new Map(targets.map(item => [item.id, item.kind])))
    setBulkReviewOpen(true)
  }, [page])

  /**
   * Confirm every ticked candidate with the corrections chosen in the review.
   * One batch write: N confirms cost one inbox re-read, never N+1.
   */
  const confirmBulk = useCallback(async (): Promise<void> => {
    const candidatesApi = props.candidates
    if (candidatesApi === undefined) return
    const selected = page.getSnapshot().candidateSelection
    const visible = viewRef.current.items
    const visibleIds = new Set(visible.map(item => item.id))
    // Ticks the current list no longer shows are never silently dropped: the
    // count is reported before the batch runs.
    const stale = [...selected].filter(id => !visibleIds.has(id)).length
    if (stale > 0) setStaleTicks(stale)
    const targets = visible.filter(item => selected.has(item.id))
    setBulkReviewOpen(false)
    if (targets.length === 0) {
      page.actions.clearCandidates()
      return
    }
    setBulkBusy(true)
    setBulkFailure(undefined)
    const result = await candidatesApi.promoteMany(targets.map((item) => {
      const options = candidateOptionsOf(item)
      return {
        item,
        patch: {
          kind: bulkKinds.get(item.id) ?? item.kind,
          title: titleOf(item),
          ...(options.length === 0 ? {} : { options }),
        },
      }
    }))
    setBulkBusy(false)
    page.actions.clearCandidates()
    setBulkKinds(new Map())
    if (result.failures.length > 0) {
      // A refused row keeps its reason beside it, exactly like a single confirm.
      setCandidateFailures((previous) => {
        const next = new Map(previous)
        for (const failure of result.failures) {
          next.set(failure.itemId, { message: failure.message, retry: 'promote' })
        }
        return next
      })
    }
    if (result.failed > 0) {
      setBulkFailure(t(result.failed === 1 ? 'candidate.bulk.failed.one' : 'candidate.bulk.failed.other', { count: result.failed }))
    }
    // `promoteMany` already re-read the inbox once for the whole batch.
  }, [bulkKinds, page, props.candidates, t])

  /** Remove one item from the list and keep focus on its neighbour. */
  const removeAndFocus = useCallback((itemId: string): void => {
    const items = viewRef.current.items
    const index = items.findIndex(candidate => candidate.id === itemId)
    const remaining = items.filter(candidate => candidate.id !== itemId)
    const next = remaining[Math.min(Math.max(index, 0), Math.max(remaining.length - 1, 0))]
    if (page.getSnapshot().selectedId === itemId) page.actions.select(null)
    if (next !== undefined) setFocusTarget(next.id)
  }, [page])
  const dismissAndClean = useCallback((item: OpenItemRecord): void => {
    const dismissal = props.dismiss
    if (dismissal === undefined) return
    void dismissal(item).finally(() => { removeAndFocus(item.id) })
  }, [props.dismiss, removeAndFocus])
  const snoozeAndClean = useCallback((item: OpenItemRecord, until: number): void => {
    const snooze = props.snooze
    if (snooze === undefined) return
    void snooze(item, until).finally(() => { removeAndFocus(item.id) })
  }, [props.snooze, removeAndFocus])

  // Focus moves once per removal; the row consumes the flag on its next render.
  useEffect(() => {
    if (focusTarget === null) return undefined
    const handle = window.setTimeout(() => {
      setFocusTarget(null)
    }, 0)
    return () => {
      window.clearTimeout(handle)
    }
  }, [focusTarget])

  const openSession = props.openSession
  const filtered = view.narrowed
  const empty = view.items.length === 0

  const renderSessionGroup = (group: SessionGroupView, nested = false): ReactNode => {
    const key = sessionGroupKey(group.sessionId)
    const open = !viewState.collapsed.has(key)
    const title = group.title !== undefined && group.title !== '' ? group.title : t('group.untitledSession')
    return (
      <section
        className="dsh-oi-group"
        key={key}
        data-nested={nested ? 'true' : undefined}
        aria-label={sessionHeading(t, group)}
      >
        <GroupHeader
          icon={<IconFlatListOutlineRegular size={12} />}
          title={title}
          meta={(
            <>
              {group.items.length > 1 && (
                <span className="dsh-oi-groupCount">{tCount(t, COUNT_KEYS.items, group.items.length)}</span>
              )}
              <span className="dsh-oi-groupUpdated">
                {t('group.updated', { time: relativeLabel(t, group.updatedAt, now) })}
              </span>
            </>
          )}
          open={open}
          onToggle={() => page.actions.toggleCollapsed(key)}
          accessory={openSession !== undefined
            ? (
              <Tooltip label={t('group.openSession')} side="bottom">
                <Button
                  size="sm"
                  variant="ghost"
                  className="dsh-oi-groupOpen"
                  onClick={() => openSession(group.sessionId)}
                  aria-label={t('group.openSession.aria', { title })}
                  icon={<IconRightUpOutlineRegular size={14} />}
                >
                  <span className="dsh-oi-groupOpenLabel">{t('group.openSession')}</span>
                </Button>
              </Tooltip>
            )
            : undefined}
        />
        {open && (
          <AnimatedRows
            className="dsh-oi-groupRows"
            role="list"
            label={sessionHeading(t, group)}
            rowKeys={group.items.map(item => item.id)}
            ready
            resetKey={`${viewState.filters.tab}:${viewState.filters.groupBy}:${viewState.filters.search}:${viewState.filters.workspace}:${viewState.filters.sessionId ?? ''}:${group.sessionId}`}
          >
            {group.items.map(item => (
              <Fragment key={item.id}>
                <ItemRow
                  item={item}
                  t={t}
                  now={now}
                  selected={item.id === viewState.selectedId}
                  handlers={handlers}
                  attempt={attempts.get(item.id)}
                  focusRequested={focusTarget === item.id}
                  isNew={isNewItem(item)}
                  sameTurnCount={item.source.turn === undefined ? undefined : sameTurnCounts.get(`${item.source.sessionId}:${String(item.source.turn)}`)}
                  selectable={viewState.filters.tab === 'candidates' && props.candidates !== undefined}
                  bulkSelected={viewState.candidateSelection.has(item.id)}
                  onToggleBulk={(itemId) => {
                    setStaleTicks(undefined)
                    page.actions.toggleCandidate(itemId)
                  }}
                  bulkBusy={bulkBusy}
                />
                {medium && item.id === viewState.selectedId && (
                  <li className="dsh-oi-inlineDetail" role="listitem">
                    <ItemDetail
                      key={item.id}
                      item={item}
                      t={t}
                      now={now}
                      handlers={handlers}
                      onBack={() => page.actions.select(null)}
                      attempt={attempts.get(item.id)}
                      awaitingWake={pendingWake?.itemId === item.id}
                      onRetry={() => retryAttempt(item)}
                      onWake={() => wakeAttempt(item)}
                      onCancelWake={cancelWake}
                      {...(props.dismiss === undefined ? {} : { onDismiss: () => { dismissAndClean(item) } })}
                      {...(props.snooze === undefined ? {} : { onSnooze: (until: number) => { snoozeAndClean(item, until) } })}
                    />
                  </li>
                )}
              </Fragment>
            ))}
          </AnimatedRows>
        )}
      </section>
    )
  }

  const renderWorkspaceGroup = (group: WorkspaceGroupView): ReactNode => {
    const key = workspaceGroupKey(group.key)
    const open = !viewState.collapsed.has(key)
    const title = group.ungrouped
      ? t('controls.workspace.ungrouped')
      : group.title !== undefined && group.title !== ''
        ? group.title
        : group.workspaceId ?? t('controls.workspace.ungrouped')
    return (
      <section className="dsh-oi-group" key={key} aria-label={workspaceHeading(t, group)}>
        <GroupHeader
          icon={<IconFolderCloseRegular size={12} />}
          title={title}
          meta={(
            <>
              <span className="dsh-oi-groupCount">{tCount(t, COUNT_KEYS.items, group.itemCount)}</span>
              <span className="dsh-oi-groupCount">{tCount(t, COUNT_KEYS.sessions, group.sessionCount)}</span>
              <span className="dsh-oi-groupUpdated">
                {t('group.updated', { time: relativeLabel(t, group.updatedAt, now) })}
              </span>
            </>
          )}
          open={open}
          onToggle={() => page.actions.toggleCollapsed(key)}
        />
        {open && (
          <div className="dsh-oi-groups">
            {group.sessions.map(session => renderSessionGroup({
              ...session,
              workspaceKey: group.key,
              workspaceTitle: group.title,
            }, true))}
          </div>
        )}
      </section>
    )
  }

  const loadingSkeleton = (
    <div className="dsh-oi-skeleton" role="status" aria-label={t('state.loadingAria')}>
      <span className="dsh-oi-visually-hidden">{t('banner.loading')}</span>
      <div className="dsh-oi-skeletonRow" />
      <div className="dsh-oi-skeletonRow" />
      <div className="dsh-oi-skeletonRow" />
      {inbox.hello?.capture?.backfill === true && inbox.hello.capture.lastBackfill === undefined && (
        <p className="dsh-oi-stateBody">{t('state.scanning')}</p>
      )}
    </div>
  )

  // One status region, by priority: protocol/data skew, then a hard error, then
  // offline. Two banners used to stack and push the list down.
  const statusLine = skew !== 'none'
    ? {
      tone: 'error' as const,
      text: skew === 'protocol'
        ? t('banner.skew.protocol', { protocol: String(inbox.hello?.protocol ?? 0) })
        : t('banner.skew.domain', { domain: String(inbox.hello?.domainVersion ?? 0) }),
      retry: false,
      skew,
    }
    : inbox.error !== undefined && inbox.snapshot !== undefined
      ? {
        tone: inbox.offline ? 'offline' as const : 'error' as const,
        text: inbox.offline
          ? (sectionPending
            ? t('banner.offline.pending')
            : t('banner.offline', { time: relativeLabel(t, inbox.lastReadAt, now) }))
          : t('banner.error', { message: inbox.error }),
        retry: true,
        skew: undefined,
      }
      : inbox.offline
        ? {
          tone: 'offline' as const,
          text: t('banner.offline', { time: relativeLabel(t, inbox.lastReadAt, now) }),
          retry: true,
          skew: undefined,
        }
        : undefined

  const workspaceFacet = view.facets.find(facet => facet.key === viewState.filters.workspace)
  const workspaceValue = viewState.filters.workspace === ALL_WORKSPACES
    ? t('controls.workspace.all')
    : workspaceFacet !== undefined
      ? facetName(t, workspaceFacet)
      : t('controls.workspace.ungrouped')

  // The four sections filter one shared list/detail region, so every tab names
  // that one panel: per-tab panels would duplicate or remount the same list. The
  // panel's aria-labelledby follows the active tab below.
  const tabs = TABS.map(tab => ({
    value: tab.value,
    id: `dsh-oi-tab-${tab.value}`,
    panelId: 'dsh-oi-tabpanel',
    label: t(tab.label),
  })) as [SegmentedTab<InboxTab>, ...SegmentedTab<InboxTab>[]]

  return (
    <div
      ref={pageRef}
      className="dsh-oi-page"
      data-selected={selected !== undefined ? 'true' : 'false'}
      data-pushed={narrow && selected !== undefined ? 'true' : undefined}
      data-phone={phone ? 'true' : undefined}
      data-tab={view.tab}
    >
      <div className="dsh-oi-pageBar">
        {narrow && selected !== undefined
          ? (
            <div className="dsh-oi-pageHead">
              <div className="dsh-oi-pushedBar">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<IconChevronLeftOutlineRegular size={14} />}
                  onClick={() => { page.actions.select(null) }}
                >
                  {t('page.back')}
                </Button>
              </div>
            </div>
          )
          : (
        <div className="dsh-oi-pageHead">
          <header className="dsh-oi-header" data-window-drag>
            <div className="dsh-oi-heading">
              <h1 className="dsh-oi-title">{t('page.title')}</h1>
              <div className="dsh-oi-counts">
                {view.counts.needsYou > 0 && (
                  <Tag tone="warning">{tCount(t, COUNT_KEYS.needsYou, view.counts.needsYou)}</Tag>
                )}
                {view.counts.candidates > 0 && (
                  <Tag tone="neutral">{tCount(t, COUNT_KEYS.candidates, view.counts.candidates)}</Tag>
                )}
              </div>
            </div>
            <div className="dsh-oi-tools">
              <Tooltip label={t('controls.refresh')} side="bottom">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={refresh}
                  aria-label={t('controls.refresh.aria')}
                  aria-busy={inbox.refreshing}
                  disabled={inbox.refreshing}
                  icon={inbox.refreshing
                    ? <StateDot state="ongoing" size={13} />
                    : <IconRefreshOutlineRegular size={13} />}
                />
              </Tooltip>
            </div>
          </header>
          <div className="dsh-oi-tabsRow">
            <div className="dsh-oi-tabsCell">
            {phone
              ? (
                <Menu
                  open={sectionMenuOpen}
                  onClose={() => { setSectionMenuOpen(false) }}
                  selectedId={viewState.filters.tab}
                  items={TABS.map(tab => ({ id: tab.value, label: t(tab.label) }))}
                  onSelect={(id) => { setSectionMenuOpen(false); page.actions.setTab(id as InboxTab) }}
                  anchor={(
                    <Button
                      size="sm"
                      variant="outline"
                      className="dsh-oi-controlButton"
                      aria-label={t('tabs.aria')}
                      aria-haspopup="menu"
                      aria-expanded={sectionMenuOpen}
                      onClick={() => { setSectionMenuOpen(value => !value) }}
                    >
                      <span className="dsh-oi-controlLabel">{t('section.label')}</span>
                      <span className="dsh-oi-controlValue">{t(TAB_LABEL_KEY[viewState.filters.tab])}</span>
                      <IconChevronDownOutlineRegular size={12} />
                    </Button>
                  )}
                />
              )
              : (
                <SegmentedTabs
                  className="dsh-oi-tabs"
                  items={tabs}
                  value={viewState.filters.tab}
                  onChange={value => page.actions.setTab(value)}
                  label={t('tabs.aria')}
                  size="sm"
                />
              )}
            </div>
            {viewState.filters.tab !== 'resolved' && (
              <div className="dsh-oi-controls">
                {viewState.filters.workspace === ALL_WORKSPACES && (
                  <Menu
                    open={groupMenuOpen}
                    onClose={() => { setGroupMenuOpen(false) }}
                    selectedId={viewState.filters.groupBy}
                    items={[
                      { id: 'session', label: t('controls.groupBy.session') },
                      { id: 'workspace', label: t('controls.groupBy.workspace') },
                    ] satisfies readonly MenuItem[]}
                    onSelect={(id) => { setGroupMenuOpen(false); page.actions.setGroupBy(id as GroupBy) }}
                    anchor={(
                      <Button
                        size="sm"
                        variant="outline"
                        className="dsh-oi-controlButton"
                        aria-label={t('controls.groupBy.aria')}
                        aria-haspopup="menu"
                        aria-expanded={groupMenuOpen}
                        onClick={() => { setGroupMenuOpen(!groupMenuOpen) }}
                      >
                        <span className="dsh-oi-controlLabel">{t('controls.groupBy')}</span>
                        <span className="dsh-oi-controlValue">
                          {t(viewState.filters.groupBy === 'session' ? 'controls.groupBy.session' : 'controls.groupBy.workspace')}
                        </span>
                        <IconChevronDownOutlineRegular size={12} />
                      </Button>
                    )}
                  />
                )}
                {viewState.filters.sessionId !== undefined && (
                  <Pill
                    active
                    aria-label={t('controls.session.clear')}
                    onClick={() => { page.actions.setSession(undefined) }}
                  >
                    {t('controls.session.chip', {
                      title: snapshot?.sessions.find(row => row.sessionId === viewState.filters.sessionId)?.title
                        ?? viewState.filters.sessionId,
                    })} ×
                  </Pill>
                )}
                {view.narrowed && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      page.actions.setSearch('')
                      page.actions.setWorkspace(ALL_WORKSPACES)
                      page.actions.setSession(undefined)
                    }}
                  >
                    {t('empty.filtered.clear')}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
          )}
      </div>

      {statusLine !== undefined && (
        <div
          className={`dsh-oi-banner dsh-oi-banner--${statusLine.tone}`}
          role="status"
          {...(statusLine.skew === undefined ? {} : { 'data-skew': statusLine.skew })}
        >
          <span>{statusLine.text}</span>
          {statusLine.retry && (
            <Button size="sm" variant="outline" onClick={refresh}>{t('banner.offline.retry')}</Button>
          )}
        </div>
      )}

      <div
        id="dsh-oi-tabpanel"
        className="dsh-oi-columns"
        role="tabpanel"
        {...(phone || (narrow && selected !== undefined)
          ? { 'aria-label': t('page.title') }
          : { 'aria-labelledby': `dsh-oi-tab-${view.tab}` })}
      >
        <div className="dsh-oi-listColumn">
          {viewState.filters.tab !== 'resolved' && (
            <div className="dsh-oi-listHeader">
              <span className="dsh-oi-searchWrap">
                <Input
                  className="dsh-oi-search"
                  icon={<IconSearchOutlineRegular size={14} />}
                  aria-label={t('controls.filter.aria')}
                  placeholder={t('controls.filter.placeholder')}
                  value={viewState.filters.search}
                  onChange={event => page.actions.setSearch(event.target.value)}
                />
                {viewState.filters.search !== '' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="dsh-oi-searchClear"
                    aria-label={t('controls.filter.clear')}
                    icon={<IconCloseOutlineRegular size={12} />}
                    onClick={() => { page.actions.setSearch('') }}
                  />
                )}
              </span>
                            <Menu
                open={workspaceMenuOpen}
                onClose={() => { setWorkspaceMenuOpen(false) }}
                selectedId={viewState.filters.workspace}
                items={[
                  { id: ALL_WORKSPACES, label: t('controls.workspace.all') },
                  ...view.facets.filter(facet => !facet.ungrouped).map(facet => ({ id: facet.key, label: facetLabel(t, facet) })),
                  {
                    id: UNGROUPED_WORKSPACE,
                    label: facetLabel(t, view.facets.find(facet => facet.ungrouped) ?? {
                      key: UNGROUPED_WORKSPACE,
                      workspaceId: undefined,
                      title: undefined,
                      removed: false,
                      ungrouped: true,
                      count: 0,
                    }),
                  },
                ] satisfies readonly MenuItem[]}
                onSelect={(id) => { setWorkspaceMenuOpen(false); page.actions.setWorkspace(id) }}
                anchor={(
                  <Button
                    size="sm"
                    variant="outline"
                    className="dsh-oi-controlButton"
                    aria-label={t('controls.workspace.aria')}
                    aria-haspopup="menu"
                    aria-expanded={workspaceMenuOpen}
                    onClick={() => { setWorkspaceMenuOpen(!workspaceMenuOpen) }}
                  >
                    <span className="dsh-oi-controlLabel">{t('controls.workspace')}</span>
                    <span className="dsh-oi-controlValue">{workspaceValue}</span>
                    <IconChevronDownOutlineRegular size={12} />
                  </Button>
                )}
              />

            </div>
          )}
          <div className="dsh-oi-listScroll" ref={scrollRef} onScroll={onScroll}>
            {viewState.filters.tab === 'needs-you' && view.awaiting > 0 && (
              <div className="dsh-oi-noticeLine" role="status">
                <span>{t(view.awaiting === 1 ? 'needsYou.awaiting.one' : 'needsYou.awaiting.other', { count: view.awaiting })}</span>
                <Button size="sm" variant="ghost" onClick={() => { page.actions.setTab('resolved') }}>
                  {t('needsYou.awaiting.action')}
                </Button>
              </div>
            )}
            {viewState.filters.tab === 'resolved'
              ? (
                <RegisterTab
                  t={t}
                  now={now}
                  onReopened={refresh}
                  inlineDetail={medium}
                  {...(registerUi === undefined ? {} : { store: registerUi.store, state: registerState })}
                  {...(openSession === undefined ? {} : { openSession })}
                  {...(props.onConnectionReset === undefined ? {} : { onConnectionReset: props.onConnectionReset })}
                  {...(sessionTitleOf === undefined ? {} : { sessionTitle: sessionTitleOf })}
                />
              )
              : inbox.status === 'error' && inbox.snapshot === undefined
              ? (
                <div className="dsh-oi-state" role="alert">
                  <p className="dsh-oi-stateTitle">{t('banner.error', { message: inbox.error ?? '' })}</p>
                  <Button size="sm" variant="outline" onClick={refresh}>{t('banner.offline.retry')}</Button>
                </div>
              )
              : inbox.snapshot === undefined
                ? loadingSkeleton
                : sectionPending
                  ? loadingSkeleton
                  : empty
                  ? (
                    <div className="dsh-oi-state">
                      <p className="dsh-oi-stateTitle">{emptyCopy(t, view.tab, filtered, viewState.filters.search).title}</p>
                      <p className="dsh-oi-stateBody">{emptyCopy(t, view.tab, filtered, viewState.filters.search).body}</p>
                      {inbox.hello?.capture !== undefined && (
                        <p className="dsh-oi-stateMeta">
                          {inbox.hello.capture.backfill === true && inbox.hello.capture.lastBackfill === undefined
                            ? t('state.scanning')
                            : t('state.scanned', {
                              scanned: inbox.hello.capture.cursors,
                              sessions: inbox.hello.capture.catalogSessions ?? 0,
                            })}
                        </p>
                      )}
                    </div>
                  )
                  : (
                    <>
                      {inbox.refreshing && <span className="dsh-oi-visually-hidden" role="status">{t('a11y.refreshing')}</span>}
                      {/* Result announcement for screen readers (UI.md §6.3/§10). */}
                      <span className="dsh-oi-visually-hidden" role="status">{liveMessage}</span>
                      {view.tab === 'candidates' && viewState.candidateSelection.size > 0 && (
                        <div className="dsh-oi-bulkBar" role="group" aria-label={t('candidate.bulk.aria')}>
                          <span role="status">{t(viewState.candidateSelection.size === 1 ? 'candidate.bulk.selected.one' : 'candidate.bulk.selected.other', { count: viewState.candidateSelection.size })}</span>
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={bulkBusy}
                            onClick={openBulkReview}
                          >
                            {bulkBusy
                              ? t('candidate.action.pending')
                              : t(viewState.candidateSelection.size === 1 ? 'candidate.bulk.confirm.one' : 'candidate.bulk.confirm.other', { count: viewState.candidateSelection.size })}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={bulkBusy}
                            onClick={() => { page.actions.clearCandidates() }}
                          >
                            {t('candidate.bulk.clear')}
                          </Button>
                        </div>
                      )}
                      {staleTicks !== undefined && staleTicks > 0 && (
                        <p className="dsh-oi-detailFailure" role="status">
                          {t(staleTicks === 1 ? 'candidate.bulk.stale.one' : 'candidate.bulk.stale.other', { count: staleTicks })}
                        </p>
                      )}
                      {bulkFailure !== undefined && (
                        <p className="dsh-oi-detailFailure" role="status">{bulkFailure}</p>
                      )}
                      <Modal
                        open={view.tab === 'candidates' && bulkReviewOpen}
                        onClose={() => { setBulkReviewOpen(false) }}
                        title={t('candidate.bulk.review.title')}
                        description={t('candidate.bulk.review.note')}
                        closeLabel={t('candidate.bulk.review.cancel')}
                        footer={(
                          <>
                            <Button size="sm" variant="outline" disabled={bulkBusy} onClick={() => { setBulkReviewOpen(false) }}>
                              {t('candidate.bulk.review.cancel')}
                            </Button>
                            <Button size="sm" variant="primary" disabled={bulkBusy || bulkTargets.length === 0} onClick={() => { void confirmBulk() }}>
                              {bulkBusy ? t('candidate.action.pending') : t('candidate.bulk.review.confirm')}
                            </Button>
                          </>
                        )}
                      >
                        <ul className="dsh-oi-bulkReview">
                          {bulkTargets.map(item => (
                            <li className="dsh-oi-bulkReviewRow" key={item.id} data-item-id={item.id}>
                              <span className="dsh-oi-bulkReviewTitle" dir="auto">{titleOf(item)}</span>
                              <KindPicker
                                kind={bulkKinds.get(item.id) ?? item.kind}
                                t={t}
                                ariaLabel={t('candidate.kind.choose', { title: titleOf(item) })}
                                disabled={bulkBusy}
                                onSelect={(kind) => {
                                  setBulkKinds(previous => new Map(previous).set(item.id, kind))
                                }}
                              />
                            </li>
                          ))}
                        </ul>
                      </Modal>
                      {view.tab === 'candidates' && (
                        <p className="dsh-oi-listCaption">{t('candidates.caption', { count: view.items.length })}</p>
                      )}
                      <div className="dsh-oi-groups">
                        {viewState.filters.groupBy === 'workspace'
                          ? view.workspaceGroups.map(group => renderWorkspaceGroup(group))
                          : view.sessionGroups.map(group => renderSessionGroup(group))}
                      </div>
                    </>
                  )}
          {viewState.filters.tab === 'needs-you' && view.fyi.length > 0 && (
            <section
              className="dsh-oi-fyi"
              aria-label={t(view.fyi.length === 1 ? 'fyi.title.one' : 'fyi.title.other', { count: view.fyi.length })}
            >
              <GroupHeader
                icon={<IconWarningOutlineRegular size={12} />}
                title={t(view.fyi.length === 1 ? 'fyi.title.one' : 'fyi.title.other', { count: view.fyi.length })}
                meta={<span className="dsh-oi-groupUpdated">{t('fyi.hint')}</span>}
                open={fyiOpen}
                onToggle={() => { setFyiOpen(value => !value) }}
              />
              {fyiOpen && (
                <AnimatedRows
                  className="dsh-oi-groupRows"
                  role="list"
                  label={t('fyi.title.other', { count: view.fyi.length })}
                  rowKeys={view.fyi.map(item => item.id)}
                  ready
                  resetKey="fyi"
                >
                  {view.fyi.map(item => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      t={t}
                      now={now}
                      selected={item.id === viewState.selectedId}
                      handlers={handlers}
                      attempt={attempts.get(item.id)}
                      focusRequested={focusTarget === item.id}
                      isNew={isNewItem(item)}
                    />
                  ))}
                </AnimatedRows>
              )}
            </section>
          )}
          </div>
          {inbox.nextCursor !== undefined && viewState.filters.tab !== 'resolved' && !sectionPending && (
            <div className="dsh-oi-loadMore">
              <Button
                size="sm"
                variant="outline"
                disabled={inbox.loadingMore}
                onClick={() => { void props.loadMore?.() }}
              >
                {inbox.loadingMore ? t('list.loadingMore') : t('list.loadMore')}
              </Button>
              <span className="dsh-oi-loadMoreNote">{t('list.truncated')}</span>
            </div>
          )}
          {inbox.loadMoreError !== undefined && viewState.filters.tab !== 'resolved' && !sectionPending && (
            <p className="dsh-oi-loadMoreError" role="alert">
              {t('list.loadMoreFailed', { message: inbox.loadMoreError })}{' '}
              <Button size="sm" variant="outline" onClick={() => { void props.loadMore?.() }}>{t('answer.retry')}</Button>
            </p>
          )}
          {props.shortcuts !== undefined && viewState.filters.tab !== 'resolved' && (
            <p className="dsh-oi-shortcutHint">{t('shortcut.hint')}</p>
          )}
        </div>
        <div className="dsh-oi-detailColumn">
          {medium ? null : viewState.filters.tab === 'resolved'
            ? (
              resolvedSelected !== undefined && registerDetailHandlers !== undefined
                ? (
                  <ResolvedDetail
                    record={resolvedSelected}
                    t={t}
                    now={now}
                    busy={registerState?.busyId === resolvedSelected.id}
                    {...registerDetailHandlers}
                    {...(registerState?.notice === undefined ? {} : { notice: registerState.notice })}
                    {...(openSession === undefined ? {} : { openSession })}
                  />
                )
                : (
                  <div className="dsh-oi-state">
                    <p className="dsh-oi-stateTitle">{t('detail.empty.title')}</p>
                    <p className="dsh-oi-stateBody">{t('detail.empty.body')}</p>
                  </div>
                )
            )
            : selected !== undefined
              ? (
                <ItemDetail
                  key={selected.id}
                  item={selected}
                  t={t}
                  now={now}
                  handlers={handlers}
                  onBack={() => page.actions.select(null)}
                  attempt={attempts.get(selected.id)}
                  awaitingWake={pendingWake?.itemId === selected.id}
                  onRetry={() => retryAttempt(selected)}
                  onWake={() => wakeAttempt(selected)}
                  onCancelWake={cancelWake}
                  {...(props.dismiss === undefined ? {} : { onDismiss: () => { dismissAndClean(selected) } })}
                  {...(props.snooze === undefined ? {} : { onSnooze: (until: number) => { snoozeAndClean(selected, until) } })}
                  submitSignal={submitSignal}
                />
              )
              : (
                <div className="dsh-oi-state">
                  <p className="dsh-oi-stateTitle">{t(clearedNotice ? 'detail.handled.title' : 'detail.empty.title')}</p>
                  <p className="dsh-oi-stateBody">{t(clearedNotice ? 'detail.handled.body' : 'detail.empty.body')}</p>
                </div>
              )}
        </div>
      </div>
    </div>
  )
}
