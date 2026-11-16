/**
 * The session-scoped right-panel tab body: "what does this chat still owe me?"
 *
 * Session scope is structural, not a selection read: the right sidebar mints this
 * body per session and hands it that session's standard props, so there is no
 * "current session" lookup anywhere in this file. Switching chats unmounts it;
 * the tab itself stays in that session's persisted layout (UI.md §7.5).
 *
 * Layout contract of the seat: the tab body is a fixed, clipped box, so our root
 * fills it (`height:100%`) and **the body element owns the scroll**. Popups
 * (tooltips, menus) portal.
 *
 * Chrome follows the panel conventions (S-16): filter capsules are the shipped
 * `Pill`, the header overflow is a shipped `Menu`, the "Resolved here" section is
 * a shipped `DisclosureRow`, and the footer names the cross-session total (from
 * `hello.counts`, which is global by contract) with the way out to the inbox.
 *
 * Freshness: a read on mount (a restored panel is cold — skeleton, never a false
 * empty), a read when `tab.visible` turns true (collapse does not unmount this
 * body; it only makes it inert), window focus, `connection/reset`, the tab's own
 * Refresh command, and after every write. Nothing polls while hidden: the
 * optional visible-surface interval only exists while the tab is visible.
 *
 * @module dsh-open-items/client/ui/panel/OpenItemsPanel
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import {
  Button,
  DisclosureRow,
  IconCheckCircleOutlineRegular,
  IconEllipsisOutlineRegular,
  IconRefreshOutlineRegular,
  Menu,
  Pill,
  StateDot,
  Tag,
  Tooltip,
  type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

import type { InboxTransport } from '../../data/transport'
import type { OpenItemRecord, ReplyPayload } from '../../../shared/schema'
import type { OpenItemsNamespace } from '../../locales'
import type { PageTranslate } from '../../format'
import { absoluteLabel, relativeLabel } from '../../format'
import { inboxTabFor, type OpenInboxOptions } from '../handoff'
import { KIND_META } from '../kind'
import { createPanelStore, type PanelOutcome, type PanelState } from './panel-store'
import { PanelRow } from './PanelRow'
import {
  PANEL_ROW_LIMIT,
  PANEL_ROW_STEP,
  choiceModelOf,
  derivePanelView,
  panelControlOf,
  type PanelFilter,
} from './derive'
import type { HandoffResult, RevealResult } from './reveal'

/** What the registration injects into the panel body. */
export interface OpenItemsPanelInjected {
  /** Typed route transport (the panel never touches `fetch` itself). */
  readonly transport: InboxTransport
  /** Opt-in visible-surface poll interval in ms (0 disables; the default). */
  readonly pollMs: number
  /** Navigate to the inbox page, focused on one item and its containing section. */
  readonly openInbox: (options?: OpenInboxOptions) => void
  /** Subscribe to the carrier's reconnect event. */
  readonly onConnectionReset: (listener: () => void) => () => void
  /** Focus a tool-raised item's transcript row. */
  readonly reveal: (item: OpenItemRecord) => RevealResult
  /** Hand a live shipped ask back to the surface that owns it. */
  readonly handoff: (item: OpenItemRecord) => HandoffResult
  /** Whether the shipped question card has a reveal seam in this build. */
  readonly canRevealAsk: boolean
  /** Clock override (tests pin the freshness window). */
  readonly clock?: () => number
}

/** Props the renderer assembles for the tab body registration. */
export type OpenItemsPanelProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<OpenItemsNamespace>
  & InjectFace<OpenItemsPanelInjected>

/** How often relative labels re-render. */
const CLOCK_TICK_MS = 60_000

/** Header filter definitions, in render order. */
const FILTERS: readonly { readonly value: PanelFilter; readonly labelKey: 'panel.filter.all' | 'tabs.needsYou' | 'panel.section.waiting' }[] = [
  { value: 'all', labelKey: 'panel.filter.all' },
  { value: 'needs-you', labelKey: 'tabs.needsYou' },
  { value: 'waiting', labelKey: 'panel.section.waiting' },
]

/** Header overflow rows (OD-11): the two cross-surface actions. */
function overflowItems(t: PageTranslate): readonly MenuItem[] {
  return [
    { id: 'open-inbox', label: t('panel.footer.open') },
    { id: 'refresh', label: t('controls.refresh') },
  ]
}

/**
 * Count-bearing label of one filter pill.
 * @param t - translator.
 * @param label - pill label.
 * @param count - rows the pill would show.
 * @returns the accessible label.
 */
function filterLabel(t: PageTranslate, label: string, count: number): string {
  return t('panel.filterCount', { label, count })
}

/** Skeleton rows shown while the session's first read is in flight. */
function PanelSkeleton({ t }: { readonly t: PageTranslate }): ReactNode {
  return (
    <div className="dsh-oi-panelSkeleton" role="status" aria-label={t('panel.loading.aria')}>
      <div className="dsh-oi-skeletonRow" />
      <div className="dsh-oi-skeletonRow" />
      <div className="dsh-oi-skeletonRow" />
    </div>
  )
}

/** One resolved row: read-only, its title opens the inbox detail. */
function ResolvedRow(props: {
  readonly item: OpenItemRecord
  readonly t: PageTranslate
  readonly now: number
  readonly onOpenInbox: () => void
}): ReactNode {
  const { item, t, now, onOpenInbox } = props
  const meta = KIND_META[item.kind]
  return (
    <li className="dsh-oi-panelRow" data-item-id={item.id} data-control="readonly" data-state={item.state}>
      <div className="dsh-oi-panelRowHead">
        <span className="dsh-oi-panelRowState">
          <StateDot state="done" size={6} className="dsh-oi-panelRowDot" />
        </span>
        <button type="button" className="dsh-oi-panelRowTitle" onClick={onOpenInbox}>
          {item.title}
        </button>
      </div>
      <p className="dsh-oi-panelRowMeta">
        <span className="dsh-oi-kindMark">
          <span className="dsh-oi-panelRowGlyph" aria-hidden="true">{meta.render(12)}</span>
          <span>{t(meta.label)}</span>
        </span>
        <span className="dsh-oi-panelRowTime" title={absoluteLabel(item.resolvedAt ?? item.updatedAt)}>
          {relativeLabel(t, item.resolvedAt ?? item.updatedAt, now)}
        </span>
      </p>
    </li>
  )
}

/**
 * Render the session's open items.
 * @param props - slot standard props, copy, the transport and the reveal seams.
 * @returns the tab body element.
 */
export function OpenItemsPanel(props: OpenItemsPanelProps): ReactNode {
  const {
    t,
    transport,
    pollMs,
    openInbox,
    onConnectionReset,
    reveal,
    handoff,
    canRevealAsk,
    clock,
    sessionId,
    useTabInfo,
  } = props
  const { tab } = useTabInfo()
  const session = String(sessionId)
  const visible = tab.visible

  const store = useMemo(
    () => createPanelStore(transport, { sessionId: session, ...(clock === undefined ? {} : { now: clock }) }),
    [transport, session, clock],
  )
  const state: PanelState = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useEffect(() => () => {
    store.dispose()
  }, [store])

  const [filter, setFilter] = useState<PanelFilter>('all')
  const [resolvedOpen, setResolvedOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [flashId, setFlashId] = useState<string | null>(null)
  // Show more raises the per-section visible cap; the store still owns the read.
  const [rowLimit, setRowLimit] = useState(PANEL_ROW_LIMIT)
  const [menuOpen, setMenuOpen] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  const flashedKey = useRef<string | undefined>(undefined)

  // Visibility is read from a ref inside DOM listeners so a re-render is not
  // needed for the gate to be correct.
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  // Cold read when the body is (or becomes) visible: a restored tab has its
  // identity but none of its data, and a panel mounted while collapsed must not
  // spend a request nobody can see.
  useEffect(() => {
    if (!visible) return
    void store.refresh(!store.getSnapshot().loaded)
  }, [visible, store])

  // Focus and reconnect re-reads, gated on visibility (never while put away).
  useEffect(() => {
    const onFocus = (): void => {
      if (!visibleRef.current) return
      void store.refresh()
    }
    window.addEventListener('focus', onFocus)
    const disposeReset = onConnectionReset(onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      disposeReset()
    }
  }, [store, onConnectionReset])

  // Opt-in visible-surface fallback poll. Hidden panels never schedule one.
  useEffect(() => {
    if (pollMs <= 0 || !visible) return
    const timer = setInterval(() => {
      if (!document.hidden) void store.refresh()
    }, pollMs)
    return () => {
      clearInterval(timer)
    }
  }, [pollMs, visible, store])

  // The tab's own Refresh command (tab menu and the page.refresh shortcut, which
  // only reaches us while the panel holds focus).
  useEffect(() => {
    const actions = tab.actions as { bindCommands?: (commands: { refresh: () => void }) => () => void } | undefined
    if (typeof actions?.bindCommands !== 'function') return
    return actions.bindCommands({ refresh: () => { void store.refresh(true) } })
  }, [tab.actions, store])

  // Relative labels need a slow tick; a frozen clock reads as stale data.
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()) }, CLOCK_TICK_MS)
    return () => { window.clearInterval(timer) }
  }, [])

  const view = derivePanelView(state.items, state.resolved, state.resolvedTotal, filter, rowLimit)

  // Deep link: `openTab('open-items', { params: { itemId } })` clears the filter,
  // scrolls the target row into view once per navigation revision, and flashes it.
  const targetId = (tab.navigation?.params as { readonly itemId?: string } | undefined)?.itemId
  const navigationKey = `${String(tab.navigation?.revision ?? 0)}:${targetId ?? ''}`
  useEffect(() => {
    if (targetId === undefined) return
    setFilter('all')
  }, [navigationKey, targetId])
  useEffect(() => {
    if (targetId === undefined || !visible || !state.loaded) return
    if (flashedKey.current === navigationKey) return
    const row = listRef.current?.querySelector<HTMLElement>(`[data-item-id="${targetId.replace(/["\\]/gu, '\\$&')}"]`)
    if (row === null || row === undefined) return
    flashedKey.current = navigationKey
    try {
      row.scrollIntoView({ block: 'center' })
    } catch {
      // A host without scrollIntoView still shows the flash.
    }
    setFlashId(targetId)
  }, [targetId, navigationKey, visible, state.loaded, state.items, state.resolved])
  useEffect(() => {
    if (flashId === null) return
    const timer = window.setTimeout(() => { setFlashId(null) }, 1_200)
    return () => { window.clearTimeout(timer) }
  }, [flashId])

  const reply = (item: OpenItemRecord, payload: ReplyPayload, options?: { readonly confirmedWake?: boolean }): void => {
    void store.reply(item, payload, options)
  }
  const onReveal = (item: OpenItemRecord): void => {
    if (reveal(item) === 'not-found') openInbox({ itemId: item.id, tab: inboxTabFor(item) })
  }
  const onHandoff = (item: OpenItemRecord): void => {
    if (handoff(item) === 'unavailable') openInbox({ itemId: item.id, tab: inboxTabFor(item) })
  }

  // Keyboard: j/k (or arrows) walk the rows' focusable titles; Escape releases
  // focus. Typing inside a reply field keeps its native keys.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    const tag = target.tagName
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
    if (!['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'].includes(event.key)) return
    if (event.key === 'Escape') {
      target.blur()
      return
    }
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-oi-row-focus]') ?? [])]
    if (rows.length === 0) return
    event.preventDefault()
    const current = rows.indexOf(document.activeElement as HTMLElement)
    let next = current === -1 ? 0 : current
    if (event.key === 'j' || event.key === 'ArrowDown') next = Math.min(current + 1, rows.length - 1)
    else if (event.key === 'k' || event.key === 'ArrowUp') next = Math.max(current - 1, 0)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = rows.length - 1
    rows[Math.max(next, 0)]?.focus()
  }

  const openCount = view.counts.open
  const headline = state.loaded ? t('panel.count', { count: openCount }) : ''
  const outcomeFor = (item: OpenItemRecord): PanelOutcome | undefined => (
    state.outcome !== undefined && state.outcome.itemId === item.id ? state.outcome : undefined
  )
  const renderRow = (item: OpenItemRecord): ReactNode => (
    <PanelRow
      key={item.id}
      item={item}
      t={t}
      now={now}
      control={panelControlOf(item)}
      choice={choiceModelOf(item)}
      pending={state.pending.has(item.id)}
      flash={flashId === item.id}
      outcome={outcomeFor(item)}
      canRevealAsk={canRevealAsk}
      onReply={(payload, options) => { reply(item, payload, options) }}
      onReveal={() => { onReveal(item) }}
      onHandoff={() => { onHandoff(item) }}
      onOpenInbox={() => { openInbox({ itemId: item.id, tab: inboxTabFor(item) }) }}
    />
  )

  const sectionHeading = (label: string, count: number): string => t('panel.filterCount', { label, count })

  const banner = state.offline && state.loaded
    ? { tone: 'offline', text: t('banner.offline', { time: relativeLabel(t, state.lastReadAt, now) }) }
    : state.error !== undefined && state.loaded
      ? { tone: 'error', text: t('banner.error', { message: state.error }) }
      : undefined

  return (
    <section
      className="dsh-oi-panel"
      aria-label={t('panel.title')}
      aria-busy={state.refreshing || (!state.loaded && state.status === 'loading')}
      data-panel-status={state.loaded ? 'ready' : state.status}
    >
      <header className="dsh-oi-panelHeader">
        <div className="dsh-oi-panelTitleRow">
          <h2 className="dsh-oi-panelTitle">{t('panel.title')}</h2>
          {state.loaded && openCount > 0 && (
            <span
              className="dsh-oi-panelCount"
              data-panel-count={openCount}
              aria-label={t('panel.countAria', { count: openCount })}
            >
              <Tag tone="outline">{headline}</Tag>
            </span>
          )}
          <Tooltip label={t('controls.refresh')} side="bottom">
            <Button
              size="sm"
              variant="ghost"
              className="dsh-oi-panelRefresh"
              aria-label={t('controls.refresh.aria')}
              aria-busy={state.refreshing || undefined}
              disabled={state.refreshing}
              icon={<IconRefreshOutlineRegular size={13} />}
              onClick={() => { void store.refresh(true) }}
            />
          </Tooltip>
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            align="end"
            items={overflowItems(t)}
            onSelect={(id) => {
              setMenuOpen(false)
              if (id === 'refresh') void store.refresh(true)
              else openInbox()
            }}
            anchor={(
              <Button
                size="sm"
                variant="ghost"
                className="dsh-oi-panelMore"
                aria-label={t('panel.more')}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                icon={<IconEllipsisOutlineRegular size={14} />}
                onClick={() => { setMenuOpen(previous => !previous) }}
              />
            )}
          />
        </div>
        <div className="dsh-oi-panelFilters" role="group" aria-label={t('panel.filter.aria')}>
          {FILTERS.map(entry => {
            const count = entry.value === 'all'
              ? openCount
              : entry.value === 'needs-you' ? view.counts.needsYou : view.counts.waiting
            const active = filter === entry.value
            return (
              <Pill
                key={entry.value}
                active={active}
                className="dsh-oi-panelPill"
                aria-pressed={active}
                onClick={() => { setFilter(entry.value) }}
              >
                {filterLabel(t, t(entry.labelKey), count)}
              </Pill>
            )
          })}
        </div>
      </header>

      {banner !== undefined && (
        <div
          className={`dsh-oi-banner ${banner.tone === 'offline' ? 'dsh-oi-banner--offline' : 'dsh-oi-banner--error'} dsh-oi-panelBanner`}
          role="status"
        >
          <span>{banner.text}</span>
          <Button size="sm" variant="outline" onClick={() => { void store.refresh(true) }}>
            {t('banner.offline.retry')}
          </Button>
        </div>
      )}

      <div className="dsh-oi-panelBody" ref={listRef} onKeyDown={onKeyDown} data-panel-body="">
        {!state.loaded && state.status === 'error'
          ? (
            <div className="dsh-oi-state" role="alert">
              <p className="dsh-oi-stateTitle">{t('panel.error.title')}</p>
              <p className="dsh-oi-stateBody">{state.error ?? ''}</p>
              <Button size="sm" variant="outline" onClick={() => { void store.refresh(true) }}>
                {t('banner.offline.retry')}
              </Button>
            </div>
          )
          : !state.loaded
            ? <PanelSkeleton t={t} />
            : openCount === 0 && view.candidateCount === 0 && view.resolvedTotal === 0
              ? (
                <div className="dsh-oi-state dsh-oi-panelEmpty">
                  <p className="dsh-oi-stateTitle">{t('panel.empty.title')}</p>
                  <p className="dsh-oi-stateBody">{t('panel.empty.body')}</p>
                </div>
              )
              : (
                <div className="dsh-oi-panelSections" aria-label={t('panel.sections.aria')}>
                  {state.refreshing && (
                    <span className="dsh-oi-visually-hidden" role="status">{t('a11y.refreshing')}</span>
                  )}
                  {openCount === 0 && view.candidateCount === 0 && (
                    <p className="dsh-oi-panelEmptyLine">{t('panel.empty.title')}</p>
                  )}
                  {view.showNeedsYou && view.needsYou.length > 0 && (
                    <section className="dsh-oi-panelSection" aria-label={t('tabs.needsYou')}>
                      <h3 className="dsh-oi-panelSectionTitle">
                        {sectionHeading(t('tabs.needsYou'), view.counts.needsYou)}
                      </h3>
                      <ol className="dsh-oi-panelList">{view.needsYou.map(renderRow)}</ol>
                    </section>
                  )}
                  {view.showWaiting && view.waiting.length > 0 && (
                    <section className="dsh-oi-panelSection" aria-label={t('panel.section.waiting')}>
                      <h3 className="dsh-oi-panelSectionTitle">
                        {sectionHeading(t('panel.section.waiting'), view.counts.waiting)}
                      </h3>
                      <ol className="dsh-oi-panelList">{view.waiting.map(renderRow)}</ol>
                    </section>
                  )}
                  {view.candidateCount > 0 && (
                    <div className="dsh-oi-panelCandidate" role="group" aria-label={t('panel.inferred.aria', { count: view.candidateCount })}>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="dsh-oi-panelCandidateAction"
                        onClick={() => { openInbox({ sessionId: session, tab: 'candidates' }) }}
                      >
                        {t('panel.inferred.row', { count: view.candidateCount })}
                      </Button>
                    </div>
                  )}
                  {view.truncated && (
                    <div className="dsh-oi-panelLimit" role="status">
                      <span>{t('panel.limit', { shown: rowLimit, total: Math.max(view.counts.needsYou, view.counts.waiting) })}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => { setRowLimit(limit => limit + PANEL_ROW_STEP) }}
                      >
                        {t('panel.showMore')}
                      </Button>
                    </div>
                  )}
                  {view.resolvedTotal > 0 && (
                    <section className="dsh-oi-panelSection dsh-oi-panelResolved" aria-label={t('panel.section.resolved')}>
                      <DisclosureRow
                        icon={<IconCheckCircleOutlineRegular size={14} />}
                        title={t('panel.resolved.count', { count: view.resolvedTotal })}
                        open={resolvedOpen}
                        expandable
                        onToggle={() => { setResolvedOpen(open => !open) }}
                        headerAccessory={(
                          <Button
                            size="sm"
                            variant="ghost"
                            className="dsh-oi-panelResolvedAll"
                            onClick={() => { openInbox({ sessionId: session, tab: 'resolved' }) }}
                          >
                            {t('panel.resolved.viewAll')}
                          </Button>
                        )}
                      >
                        <ol className="dsh-oi-panelList" aria-label={t('panel.resolved.aria')}>
                          {view.resolved.map(item => (
                            <ResolvedRow
                              key={item.id}
                              item={item}
                              t={t}
                              now={now}
                              onOpenInbox={() => { openInbox({ itemId: item.id, tab: 'resolved' }) }}
                            />
                          ))}
                        </ol>
                      </DisclosureRow>
                    </section>
                  )}
                </div>
              )}
      </div>

      <footer className="dsh-oi-panelFooter">
        <span
          className="dsh-oi-panelFooterCount"
          aria-label={t('panel.footer.countAria', { count: state.globalOpen })}
        >
          {state.loaded ? t('panel.footer.count', { count: state.globalOpen }) : ''}
        </span>
        <Button size="sm" variant="outline" onClick={() => { openInbox() }}>
          {t('panel.footer.open')}
        </Button>
      </footer>
    </section>
  )
}
