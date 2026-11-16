/**
 * Browser half of the Open Items plugin.
 *
 * Composition root: one route transport and inbox store, one app-scoped page
 * store (so filters, grouping and scroll survive opening a session), the locale
 * dictionaries, the plugin stylesheet, and three contributions — the inbox page
 * in the layout's `main` seat, its row/badge in `sidebar.panellist`, and the
 * session-scoped right-panel tab (`./ui/panel/register`).
 *
 * Also registered: the in-session card on the `open_items` tool row (M3) and the
 * per-session right panel (M3). Still deliberately absent: the workspace
 * context-menu entry, the session pip/header chip, and a live delta channel for
 * the panel (projection-key delivery is V1.1).
 *
 * @module dsh-open-items/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'

import { createCandidateActions } from './data/candidate-actions'
import { inboxQueryForTab } from './data/tab-query'
import { createShortcutSeam } from './data/keyboard'
import { createInboxStore } from './data/inbox-store'
import { ALL_WORKSPACES, createPageStore } from './data/page-store'
import { createRegisterStore } from './data/register-store'
import { createSettleController } from './data/settle'
import { createTransport } from './data/transport'
import { CLIENT_STYLES } from './styles'
import { LOCALE_NAMESPACE, en, zh } from './locales'
import { registerAnswerToastHost } from './ui/answer/register'
import { registerOpenItemsCard } from './ui/card/register'
import { InboxNavIcon } from './ui/nav-icon'
import { InboxPage } from './ui/page'
import { inboxTabFor, type OpenInboxOptions } from './ui/handoff'
import { PLUGIN_VERSION } from './version'
import { registerOpenItemsPanel } from './ui/panel/register'
import { registerSettingsSurface } from './ui/settings/register'
import { answerNotices } from './ui/answer/notices'
import type { InboxQuery, OpenItemRecord } from '../shared/schema'

/** Browser plugin name (the id the bundle registers under). */
export const name = 'dsh-open-items'

/** Client services the browser half cannot run without. */
export const inject = ['slots', 'locale']

/** Shared panel id: the `main` key and the sidebar row id must match. */
const PANEL_ID = 'open-items' as unknown as MainPanelId

/** Sidebar row order: after the shipped Plugins row (`0`) and Highlights (`20`). */
const NAV_ORDER = 30

/** How often the page re-reads while it is the visible window. */
const POLL_MS = 60_000

/** localStorage key of the last-visit marker (drives the nav new-dot, OD-16). */
const LAST_VISIT_KEY = 'dsh-open-items:lastVisit'

/** Read the last-visit instant; 0 when absent or storage is unavailable. */
function readLastVisit(): number {
  try {
    const raw = window.localStorage.getItem(LAST_VISIT_KEY)
    const value = raw === null ? 0 : Number(raw)
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

/** Persist that the reader has now seen the list. */
function writeLastVisit(at: number): void {
  try {
    window.localStorage.setItem(LAST_VISIT_KEY, String(at))
  } catch {
    // No storage: the dot stays honest-off rather than claiming fresh items.
  }
}

/** Structural slice of the client workspace-navigation service (`ctx.uiWorkspace`). */
interface WorkspaceNavigationLike {
  /** Select a Session and show its conversation. */
  openSession?: (sessionId: string) => void
}

/** Session-catalogue slice the card reads to recognise a subagent Session. */
interface SessionCatalogueLike {
  readonly list?: {
    getSnapshot?: () => {
      readonly byId?: Readonly<Record<string, {
        readonly origin?: string
        readonly parentId?: string
        readonly title?: string
      }>>
    }
  }
}

/**
 * Append one plugin-owned stylesheet to the document.
 * @param css - stylesheet text.
 * @returns the disposer that removes the element.
 */
function injectStylesheet(css: string): () => void {
  const element = document.createElement('style')
  element.dataset.pluginCss = 'dsh-open-items'
  element.textContent = css
  document.head.appendChild(element)
  return () => {
    element.remove()
  }
}

/**
 * Register the plugin's browser contributions.
 * @param ctx - client root context owning every contribution.
 */
export function apply(ctx: Context): void {
  const translate = ctx.locale.bind(LOCALE_NAMESPACE)
  const shortcuts = createShortcutSeam(ctx, key => translate(key as never))
  // The Host only reports `newSinceLastVisit` when a list request carries
  // `since`, so the client owns the durable marker (P0-08f).
  let since = readLastVisit()

  ctx.effect(() => injectStylesheet(CLIENT_STYLES), 'open-items: stylesheet')
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { en, zh }), 'open-items: dictionaries')

  const transport = createTransport()
  const inbox = createInboxStore(transport)
  // Answering: track 1 settles the shipped live card this browser already
  // holds, track 2 asks the Host to settle, and the delivery matrix carries the
  // rest. The carrier is feature-detected per call, so a profile without the
  // shipped card clients degrades instead of offering a dead control.
  const settle = createSettleController({
    context: ctx as unknown as { get(name: string): unknown },
    transport,
    hello: () => inbox.getSnapshot().hello,
  })
  const page = createPageStore()
  /**
   * The list read of the section the page currently shows. `since` stays the
   * new-item marker (inbox matching ignores it), while the section's states make
   * Snoozed able to return snoozed rows and Candidates candidate rows; counts
   * stay global over every stored record.
   */
  const listRequest = (): { query?: InboxQuery } => {
    const section = inboxQueryForTab(page.getSnapshot().filters.tab)
    return {
      query: {
        status: section.status,
        states: section.states,
        ...(section.tiers === undefined ? {} : { tiers: section.tiers }),
        ...(since === 0 ? {} : { since }),
      },
    }
  }
  // The Resolved tab's store: the register endpoint plus the one write this
  // milestone owns (reopen). The export dialog reuses the deterministic
  // generators from main through the same store.
  const register = createRegisterStore({
    register: (query, signal) => transport.register({ query }, signal),
    reopen: (itemId, expectedVersion) => transport.reopen({ itemId, expectedVersion }),
    deleteRecord: (itemId, expectedVersion) => transport.delete({ itemId, expectedVersion }),
    now: () => Date.now(),
    pluginVersion: PLUGIN_VERSION,
  })
  ctx.effect(() => () => {
    inbox.dispose()
  }, 'open-items: inbox store')

  /** The active section key the inbox store compares with its read identity. */
  const sectionKey = (): string => page.getSnapshot().filters.tab

  // Ping the Host for a first snapshot immediately; the page renders skeletons
  // until it lands. The durable last-visit marker is NOT advanced here: only
  // opening the page consumes newness (round-3 J-3), so a launch that never
  // opens the inbox keeps the sidebar dot truthful.
  void inbox.refresh(true, listRequest(), sectionKey())

  // Freshness policy (DESIGN §5.3): no push channel reaches an out-of-tree
  // bundle, so a focus / visibility / reconnect re-read keeps the inbox honest
  // without a busy poll. A slow visible-window poll covers the "page left open
  // on a second monitor" case the design accepts.
  ctx.effect(() => {
    const onFocus = (): void => {
      void inbox.refresh(false, listRequest(), sectionKey())
    }
    const onVisibility = (): void => {
      if (!document.hidden) void inbox.refresh(false, listRequest(), sectionKey())
    }
    const onReset = (): void => {
      void inbox.refresh(true, listRequest(), sectionKey())
    }
    const timer = setInterval(() => {
      if (!document.hidden) void inbox.refresh(false, listRequest(), sectionKey())
    }, POLL_MS)
    const disposeReset = ctx.on('connection/reset', onReset)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(timer)
      disposeReset()
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, 'open-items: freshness')

  const refresh = (): void => {
    void inbox.refresh(true, listRequest(), sectionKey())
  }

  /**
   * The reader opened the page: advance the durable last-visit marker and
   * re-read the counts, so the sidebar's new-item dot clears in this session
   * instead of waiting for the next app start (UI.md §8).
   */
  const markVisited = (): void => {
    since = Date.now()
    writeLastVisit(since)
    refresh()
  }

  // Candidate lifecycle (WP-C, §7): confirm ("It's an item") or refuse ("Not an
  // item") an inferred candidate. Every outcome reaches the app-scoped notice
  // host, and a write re-reads the inbox so rows show Host truth.
  const candidates = createCandidateActions({
    transport,
    refresh,
    notify: notice => answerNotices.show(notice),
    translate: (key, params) => translate(key, params),
  })

  // Navigation seam (P0-07): resolve the workspace navigation service when the
  // reader acts, never during apply. `ctx.inject` would gate the whole page
  // registration on the service, and an apply-time `ctx.get` races the Loader
  // (the same defect the host capture hardening fixed). A composition without
  // the navigation domain keeps registration and the click becomes a no-op.
  const workspaceNavigation = (): WorkspaceNavigationLike | undefined => (
    (ctx as unknown as { get(name: string): unknown }).get('uiWorkspace') as WorkspaceNavigationLike | undefined
  )
  /**
   * Select one Session and show its conversation ("Open session").
   * @param sessionId - Session to open.
   */
  const openSession = (sessionId: string): void => {
    workspaceNavigation()?.openSession?.(sessionId)
  }

  // Session labels: the catalogue is read structurally and on demand, never at
  // apply time (same Loader race the navigation seam avoids). An authored raise
  // stamps no title, so the inbox resolves it from here instead of claiming the
  // Session was deleted.
  const sessionCatalogue = (): SessionCatalogueLike | undefined => (
    (ctx as unknown as { get(name: string): unknown }).get('sessions') as SessionCatalogueLike | undefined
  )
  /**
   * Resolve one Session's display title from the client catalogue.
   * @param sessionId - Session to label.
   * @returns the trimmed title, or undefined when the catalogue cannot answer.
   */
  const sessionTitleOf = (sessionId: string): string | undefined => {
    const row = sessionCatalogue()?.list?.getSnapshot?.().byId?.[sessionId]
    return typeof row?.title === 'string' && row.title.trim() !== '' ? row.title.trim() : undefined
  }
  /**
   * Whether one Session is a subagent Session (the card hides answer controls).
   * @param sessionId - Session the card belongs to.
   * @returns true for a subagent-origin or child Session.
   */
  const sessionIsSubagent = (sessionId: string): boolean => {
    const row = sessionCatalogue()?.list?.getSnapshot?.().byId?.[sessionId]
    return row?.origin === 'subagent' || row?.parentId !== undefined
  }

  // The panel's only way out to the cross-session view: select the item in the
  // page detail (when one is named) and show the page. The page keeps the
  // session-agnostic view by design; the panel is per-session.
  const openInbox = (options?: OpenInboxOptions): void => {
    // Reset the page filters so the target is visible, land on the section that
    // can contain it, then narrow to the Session when the caller asked for the
    // session-scoped view (OD-12).
    page.actions.setFilters({
      tab: options?.tab ?? 'needs-you',
      search: '',
      workspace: ALL_WORKSPACES,
      sessionId: options?.sessionId,
    })
    if (options?.itemId !== undefined) {
      // The Resolved section renders from the register store, not the inbox
      // list; the page's selectedId cannot reach its detail pane.
      if ((options.tab ?? 'needs-you') === 'resolved') register.actions.select(options.itemId)
      else page.actions.select(options.itemId)
    }
    ctx.get('layout')?.selectPanel(PANEL_ID)
  }

  /** Dismiss one item and offer the app-wide Undo (Toast, S-04). */
  const dismissItem = async (item: OpenItemRecord): Promise<void> => {
    try {
      const value = await transport.dismiss({ itemId: item.id, expectedVersion: item.version })
      refresh()
      answerNotices.show({
        tone: 'ok',
        text: translate('inbox.dismissed', { title: item.title }),
        action: {
          label: translate('inbox.undo'),
          run: () => {
            void transport.reopen({ itemId: value.item.id, expectedVersion: value.item.version }).then(() => { refresh() })
          },
        },
      })
    } catch (error) {
      answerNotices.show({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Snooze one item until an instant; the Host has no unsnooze, so no Undo. */
  const snoozeItem = async (item: OpenItemRecord, until: number): Promise<void> => {
    try {
      await transport.snooze({ itemId: item.id, expectedVersion: item.version, until })
      refresh()
      answerNotices.show({ tone: 'ok', text: translate('inbox.snoozed', { title: item.title }) })
    } catch (error) {
      answerNotices.show({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: LOCALE_NAMESPACE,
    // Additive seam: the Resolved tab, its detail and the export dialog. A
    // composition without it still renders the other three tabs.
    inject: () => ({
      hooks: { snap: inbox.source },
      page,
      refresh,
      onOpened: markVisited,
      // The marker as it stood when this page mounted: captured before
      // `markVisited` advances it, so the row "new" marks stay stable for the
      // visit and the next visit compares against the updated one.
      lastVisit: () => since,
      loadMore: () => inbox.loadMore(),
      settle,
      openSession,
      sessionTitle: sessionTitleOf,
      openInbox,
      dismiss: dismissItem,
      snooze: snoozeItem,
      candidates,
      shortcuts,
      onConnectionReset: (listener: () => void) => ctx.on('connection/reset', listener),
      registerUi: { store: register },
    }),
  }, InboxPage)), 'open-items: page')

  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: NAV_ORDER,
    locale: LOCALE_NAMESPACE,
    label: () => translate('nav.label'),
    inject: () => ({ hooks: { snap: inbox.source } }),
  }, InboxNavIcon)), 'open-items: nav row')

  // In-session card (M3): answers a raised item at its `open_items` tool row.
  // Subagent detection reads the Session catalogue structurally (the controller
  // package is a dev peer this bundle needs no runtime import for), resolved on
  // every call so a service mounted after this row is still seen.
  registerOpenItemsCard(ctx, {
    transport,
    // The card wants the bare item id; resolve the section from the app-scoped
    // snapshot so a settled receipt lands on Resolved instead of a blank
    // Needs-you detail. An item this client has never loaded is presumed
    // settled (the card is rendering its receipt).
    openInbox: (itemId?: string) => {
      if (itemId === undefined) {
        openInbox()
        return
      }
      const known = inbox.getSnapshot().snapshot?.items.find(item => item.id === itemId)
      openInbox({ itemId, tab: known === undefined ? 'resolved' : inboxTabFor(known) })
    },
    now: () => Date.now(),
    sessionIsSubagent,
  })

  // App-surviving answer feedback (S-04): one Toast host in the root overlay
  // seat, so a transient success/failure survives leaving the page.
  registerAnswerToastHost(ctx)

  // Session-scoped right-panel tab (M3). Registers the tab type + body and
  // injects the shared transport; it never opens itself.
  registerOpenItemsPanel(ctx, { transport, openInbox })

  // Settings → Open Items (WP-C, §2): the opt-in model nudge and the prose
  // candidate gate. Shares this route transport; reads nothing until mounted.
  registerSettingsSurface(ctx, { transport })
}
