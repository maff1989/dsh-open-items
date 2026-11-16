/**
 * Registration of the Open Items right-panel tab type and its body.
 *
 * Two stages through the Sidebar's public path only, exactly as the installed
 * `dsh-highlights` precedent does it (and as `research/right-panel.md` records):
 *
 * 1. `ctx.sidebarRightTabs.register` declares *what* the tab is — its identity,
 *    its kind, its chip title — with no runtime hook and no per-session state.
 *    `priority: 'extension'` keeps us after the shipped Files/Terminal/Browser
 *    tabs; `keepMounted: false` means a hidden panel costs nothing.
 * 2. `ctx.slots.inject('sidebar.right.pane.tab', …)` supplies the body under the
 *    definition's `id`. The seat is session-scoped, so the sidebar **injects this
 *    session's id** — the body never reads a "selected session" and can never
 *    list another session's items.
 *
 * No tab badge exists in the product: the only per-tab surfaces are the body and
 * a 28px title chip, and this registration deliberately does not use the title
 * seat (the count lives on the nav pill and the session header chip). Nothing
 * here opens the panel: opening is the user's action (`ctx.sidebarRight.openTab`
 * from the header chip), because opening reflows the conversation.
 *
 * @module dsh-open-items/client/ui/panel/register
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

import type { OpenItemRecord } from '../../../shared/schema'
import { LOCALE_NAMESPACE } from '../../locales'
import type { InboxTransport } from '../../data/transport'
import { OpenItemsPanel } from './OpenItemsPanel'
import type { OpenInboxOptions } from '../handoff'
import { PANEL_STYLES } from './panelStyles'
import {
  canRevealShippedAsk,
  handoffShippedAsk,
  revealToolRow,
  type HandoffResult,
  type RevealResult,
} from './reveal'

/** Right-Sidebar tab type id (the definition id, also the body slot key). */
export const PANEL_TAB_ID = 'dsh-open-items/tab'

/** Right-Sidebar tab kind opened by `ctx.sidebarRight.openTab('open-items')`. */
export const PANEL_TAB_KIND = 'open-items'

/** Navigation parameters of the `open-items` page kind. */
declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /**
     * `itemId` asks the body to clear its filter and focus (scroll + flash) that
     * row once; `revision` on the tab's navigation makes a repeat act again.
     */
    'open-items': { readonly itemId?: string }
  }
}

/** What the panel registration needs from the plugin body. */
export interface OpenItemsPanelDeps {
  /** The plugin's route transport (shared with the page and the nav pill). */
  readonly transport: InboxTransport
  /**
   * Navigate to the inbox page, optionally focused on one item and landing on
   * the section that can contain it. The panel is the only caller: it is the
   * "everything" view from inside one chat.
   * @param options - item/session to focus and the section to land on.
   */
  readonly openInbox: (options?: OpenInboxOptions) => void
  /** Opt-in visible-surface poll interval in ms; omitted or 0 disables polling. */
  readonly pollMs?: number
}

/** Append one plugin-owned stylesheet to the document. */
function injectPanelStylesheet(css: string): () => void {
  const element = document.createElement('style')
  element.dataset.pluginCss = 'dsh-open-items-panel'
  element.textContent = css
  document.head.appendChild(element)
  return () => {
    element.remove()
  }
}

/**
 * Register the `open-items` tab type and its session-scoped body.
 *
 * Gated on the `sidebarRightTabs` service through `ctx.inject`, so a
 * composition without the right sidebar (a bare page host) simply has no
 * panel instead of failing activation.
 * @param ctx - client root context owning the tab registry and the slot registry.
 * @param deps - the transport and the inbox navigation seam.
 */
export function registerOpenItemsPanel(ctx: Context, deps: OpenItemsPanelDeps): void {
  const t = ctx.locale.bind(LOCALE_NAMESPACE)

  ctx.effect(() => injectPanelStylesheet(PANEL_STYLES), 'open-items: panel stylesheet')

  ctx.inject(['sidebarRightTabs'], (scope) => {
    scope.effect(() => scope.sidebarRightTabs.register({
      id: PANEL_TAB_ID,
      kind: PANEL_TAB_KIND,
      priority: 'extension',
      keepMounted: false,
      title: () => t('panel.title'),
    }), 'open-items: panel tab type')

    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab',
      key: PANEL_TAB_ID,
      locale: LOCALE_NAMESPACE,
      inject: () => ({
        transport: deps.transport,
        pollMs: deps.pollMs ?? 0,
        openInbox: deps.openInbox,
        onConnectionReset: (listener: () => void) => scope.on('connection/reset', listener),
        reveal: (item: OpenItemRecord): RevealResult => revealToolRow(item.source.sessionId, item.source.callId),
        handoff: (item: OpenItemRecord): HandoffResult => handoffShippedAsk(scope, item),
        canRevealAsk: canRevealShippedAsk(scope),
      }),
    }, OpenItemsPanel)), 'open-items: panel tab body')
  })
}
