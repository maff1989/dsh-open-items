/**
 * Sidebar nav row occupant: the Open Items glyph plus the new-items dot.
 *
 * OD-16 (rc2): the sidebar has no numeric nav-badge seat, so this row renders
 * no count chip — an overlay number reads as a separate application. The count
 * lives in the page title (owned by the page); the nav row keeps only the quiet
 * "new since your last visit" dot and a screen-reader sentence.
 *
 * The sidebar owns the row and its accessible name (from the list `label`); this
 * component supplies the glyph and the ambient signal. Both decorations are
 * `aria-hidden`; the count sentence rides a visually hidden span so a screen
 * reader still hears the number without seeing a badge.
 *
 * @module dsh-open-items/client/ui/nav-icon
 */
import type { ReactNode } from 'react'
import { IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

import type { InboxState } from '../data/inbox-store'
import { countOf } from '../data/inbox-store'
import { tCount, COUNT_KEYS } from '../format'
import type { OpenItemsNamespace } from '../locales'

/** What the nav row registration injects. */
export interface InboxNavInjected {
  /** Bare observable exposed through the slot `hooks` compartment. */
  readonly hooks: { readonly snap: ObservableSnapshot<InboxState> }
}

/** Props the renderer assembles for the panellist row. */
export type InboxNavIconProps =
  PropsRuntime<'sidebar.panellist'>
  & PropsLocale<OpenItemsNamespace>
  & InjectFace<InboxNavInjected>

/**
 * Render the nav glyph and the new-items dot (never a numeric chip, OD-16).
 * @param props - sidebar icon share, copy and the inbox snapshot hook.
 * @returns the icon element.
 */
export function InboxNavIcon({ size, t, useSnap }: InboxNavIconProps): ReactNode {
  const count = useSnap(countOf)
  const fresh = useSnap(state => (state.snapshot?.counts.newSinceLastVisit ?? 0) > 0)
  const label = count > 0 ? tCount(t, COUNT_KEYS.navWaiting, count) : ''
  return (
    <span className="dsh-oi-nav" data-count={count} data-fresh={fresh ? 'true' : undefined}>
      <IconChecklistOutlineRegular size={size} />
      {fresh && <span className="dsh-oi-navDot" aria-hidden="true" />}
      {label !== '' && <span className="dsh-oi-visually-hidden">{label}</span>}
    </span>
  )
}
