// @vitest-environment jsdom
/**
 * The panel's registration contract: what it declares in the tab registry, what
 * the keyed body seat receives, and what it deliberately never does.
 *
 * This runs against a hand-written context, because registration is the one part
 * of the panel that talks to Cordis instead of React. It is the regression guard
 * for the two-stage public path (`ctx.sidebarRightTabs.register` + keyed
 * `sidebar.right.pane.tab`) and for "the panel never opens itself".
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// The registration module imports the body, which imports the platform
// primitives; the shell provides them at runtime, so tests stand in a mock.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('../primitives-mock'))

import type { Context } from '@deepseek-ai/cordis'

import {
  PANEL_TAB_ID,
  PANEL_TAB_KIND,
  registerOpenItemsPanel,
  type OpenItemsPanelDeps,
} from '../../../src/client/ui/panel/register'
import { handoffShippedAsk, revealToolRow } from '../../../src/client/ui/panel/reveal'
import { SESSION, fakeTransport, liveAsk, toolItem } from './helpers'

/** One captured tab-type registration. */
interface CapturedTab {
  readonly id: string
  readonly kind: string
  readonly priority?: string
  readonly keepMounted?: boolean
  readonly title: () => string
  readonly guide?: readonly unknown[]
}

/** One captured slot registration. */
interface CapturedSlot {
  readonly name: string
  readonly key?: string
  readonly locale?: string
  readonly inject: () => Record<string, unknown>
}

/** One fake context plus everything it captured. */
function fakeContext(options: { questionPanels?: { reveal: (sessionId: string, callId: string) => boolean } } = {}) {
  const tabs: CapturedTab[] = []
  const slots: CapturedSlot[] = []
  const injections: (readonly string[])[] = []
  const resetListeners: (() => void)[] = []
  const effects: (() => void)[] = []
  const services = new Map<string, unknown>()
  if (options.questionPanels !== undefined) services.set('userQuestionPanels', options.questionPanels)
  const ctx = {
    locale: {
      bind: () => (key: string) => `t:${key}`,
      register: () => () => {},
    },
    effect: (fn: () => (() => void) | void, _label?: string) => {
      const dispose = fn()
      effects.push(() => {
        if (typeof dispose === 'function') dispose()
      })
      return () => {}
    },
    inject: (deps: readonly string[], callback: (scope: unknown) => void) => {
      injections.push(deps)
      callback(ctx)
      return () => {}
    },
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (spec: CapturedSlot, _component: unknown) => {
        slots.push(spec)
        return () => {}
      },
    },
    sidebarRightTabs: {
      register: (definition: CapturedTab) => {
        tabs.push(definition)
        return () => {}
      },
    },
    on: (event: string, listener: () => void) => {
      if (event === 'connection/reset') resetListeners.push(listener)
      return () => {
        const index = resetListeners.indexOf(listener)
        if (index >= 0) resetListeners.splice(index, 1)
      }
    },
    get: (name: string) => services.get(name),
  }
  return { ctx: ctx as unknown as Context, tabs, slots, injections, resetListeners, effects }
}

/** The deps a registration needs, with spies. */
function deps(): OpenItemsPanelDeps & { readonly openInbox: ReturnType<typeof vi.fn> } {
  return { transport: fakeTransport(), openInbox: vi.fn() }
}

afterEach(() => {
  document.head.innerHTML = ''
})

describe('registerOpenItemsPanel', () => {
  it('declares the extension tab type after the shipped kinds', () => {
    const { ctx, tabs } = fakeContext()
    registerOpenItemsPanel(ctx, deps())
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.id).toBe(PANEL_TAB_ID)
    expect(tabs[0]?.kind).toBe(PANEL_TAB_KIND)
    expect(tabs[0]?.priority).toBe('extension')
    expect(tabs[0]?.keepMounted).toBe(false)
    expect(tabs[0]?.title()).toBe('t:panel.title')
    // No guide entry, no badge seat: discovery is the session header chip, and
    // the panel must not compete with the guide's default page.
    expect(tabs[0]?.guide).toBeUndefined()
  })

  it('registers the body in the keyed session seat under the same id', () => {
    const { ctx, slots } = fakeContext()
    registerOpenItemsPanel(ctx, deps())
    expect(slots).toHaveLength(1)
    expect(slots[0]?.name).toBe('sidebar.right.pane.tab')
    expect(slots[0]?.key).toBe(PANEL_TAB_ID)
    expect(slots[0]?.locale).toBe('openItems')
  })

  it('injects the transport, the inbox seam and the reveal/hand-off faces', () => {
    const registration = fakeContext()
    const injectedDeps = deps()
    registerOpenItemsPanel(registration.ctx, injectedDeps)
    expect(registration.injections).toEqual([['sidebarRightTabs']])
    const face = registration.slots[0]?.inject()
    expect(face?.['transport']).toBe(injectedDeps.transport)
    expect(face?.['openInbox']).toBe(injectedDeps.openInbox)
    // No polling unless a composition opts in.
    expect(face?.['pollMs']).toBe(0)
    expect(typeof face?.['reveal']).toBe('function')
    expect(typeof face?.['handoff']).toBe('function')
    expect(face?.['canRevealAsk']).toBe(false)
    expect(typeof face?.['onConnectionReset']).toBe('function')
  })

  it('honours a configured visible poll interval', () => {
    const registration = fakeContext()
    registerOpenItemsPanel(registration.ctx, { ...deps(), pollMs: 15_000 })
    expect(registration.slots[0]?.inject()['pollMs']).toBe(15_000)
  })

  it('wires the carrier reset subscription and disposes it with the seat', () => {
    const registration = fakeContext()
    registerOpenItemsPanel(registration.ctx, deps())
    const subscribe = registration.slots[0]?.inject()['onConnectionReset'] as (listener: () => void) => () => void
    const listener = vi.fn()
    const dispose = subscribe(listener)
    expect(registration.resetListeners).toHaveLength(1)
    dispose()
    expect(registration.resetListeners).toHaveLength(0)
    expect(listener).not.toHaveBeenCalled()
  })

  it('exposes the shipped question seam when the questions UI is mounted', () => {
    const reveal = vi.fn(() => true)
    const registration = fakeContext({ questionPanels: { reveal } })
    registerOpenItemsPanel(registration.ctx, deps())
    const face = registration.slots[0]?.inject()
    expect(face?.['canRevealAsk']).toBe(true)
    const handoff = face?.['handoff'] as (item: ReturnType<typeof liveAsk>) => string
    expect(handoff(liveAsk())).toBe('revealed')
    expect(reveal).toHaveBeenCalledWith(SESSION, 'ask-1')
  })

  it('reveals tool-raised rows by call id without any service dependency', () => {
    const registration = fakeContext()
    registerOpenItemsPanel(registration.ctx, deps())
    const face = registration.slots[0]?.inject()
    const reveal = face?.['reveal'] as (item: ReturnType<typeof toolItem>) => string
    expect(reveal(toolItem())).toBe('not-found')
    expect(revealToolRow(SESSION, undefined)).toBe('no-anchor')
    expect(handoffShippedAsk(registration.ctx, liveAsk())).toBe('unavailable')
  })

  it('injects the panel stylesheet and removes it on dispose', () => {
    const registration = fakeContext()
    registerOpenItemsPanel(registration.ctx, deps())
    const styles = [...document.head.querySelectorAll('style[data-plugin-css="dsh-open-items-panel"]')]
    expect(styles).toHaveLength(1)
    expect(styles[0]?.textContent).toContain('.dsh-oi-panelBody')
    for (const dispose of registration.effects) dispose()
    expect(document.head.querySelectorAll('style[data-plugin-css="dsh-open-items-panel"]')).toHaveLength(0)
  })

  it('never opens the panel: there is no sidebarRight controller in this registration', () => {
    const registration = fakeContext()
    // A fake context without `sidebarRight` would throw if the registration ever
    // tried to open a tab; it also records no such call anywhere.
    registerOpenItemsPanel(registration.ctx, deps())
    expect(registration.tabs).toHaveLength(1)
    expect(registration.slots).toHaveLength(1)
    const source = String(registerOpenItemsPanel)
    expect(source).not.toContain('openTab')
  })
})
