/**
 * Registration of the in-session card: the keyed `tool.call.toolview` entry for
 * the `open_items` wire tool, its own stylesheet and its own locale namespace.
 *
 * Shape follows the installed out-of-tree precedent
 * (`highlight-plugin/dsh-highlights/src/client/ui/tools/register.ts`) and the
 * plugin's own composition-root conventions: one entry point called by
 * `src/client/index.ts`, every contribution owned by `ctx.effect`, the
 * registrant's business face passed through `inject` (slot components may not
 * reach for `ctx`). The inject factory receives the surrounding Session id —
 * that is how the card scopes its hydration read without importing any
 * standard-prop package.
 *
 * @module dsh-open-items/client/ui/card/register
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

import { CARD_STYLES } from './card-styles'
import { CARD_LOCALE_NAMESPACE, cardEn, cardZh } from './card-locales'
import { OpenItemsCardSlot } from './OpenItemsCard'
import { OPEN_ITEMS_TOOL_NAME, type CardTransport } from './slot-contracts'

/** Dependencies the composition root supplies. */
export interface OpenItemsCardDeps {
  /** Typed route client shared with the inbox page. */
  readonly transport: CardTransport
  /** Show the inbox with one item selected; never changes the selected Session. */
  readonly openInbox: (itemId?: string) => void
  /** Injected clock for receipts (defaults to `Date.now`). */
  readonly now?: () => number
  /** Whether one Session is a subagent session (no answer controls). */
  readonly sessionIsSubagent?: (sessionId: string) => boolean
  /** Whether this client is a read-only/non-owner peer (controls disabled). */
  readonly peerReadOnly?: () => boolean
}

/**
 * Append one plugin-owned stylesheet to the document.
 * @param css - stylesheet text.
 * @returns the disposer that removes the element.
 */
function injectStylesheet(css: string): () => void {
  const element = document.createElement('style')
  element.dataset.pluginCss = 'dsh-open-items'
  element.dataset.pluginCssPart = 'card'
  element.textContent = css
  document.head.appendChild(element)
  return () => {
    element.remove()
  }
}

/**
 * Register the in-session card.
 * @param ctx - client root context owning every contribution.
 * @param deps - route face, navigation seam and the optional peer/session probes.
 */
export function registerOpenItemsCard(ctx: Context, deps: OpenItemsCardDeps): void {
  const now = deps.now ?? (() => Date.now())

  ctx.effect(() => injectStylesheet(CARD_STYLES), 'open-items: card styles')
  ctx.effect(
    () => ctx.locale.register(CARD_LOCALE_NAMESPACE, { en: cardEn, zh: cardZh }),
    'open-items: card dictionaries',
  )

  ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: OPEN_ITEMS_TOOL_NAME,
    locale: CARD_LOCALE_NAMESPACE,
    inject: (sessionId: string) => ({
      sessionId: String(sessionId),
      transport: deps.transport,
      openInbox: deps.openInbox,
      now,
      isSubagent: () => deps.sessionIsSubagent?.(String(sessionId)) === true,
      peerReadOnly: () => deps.peerReadOnly?.() === true,
    }),
  }, OpenItemsCardSlot)), 'open-items: in-session card')
}
