// @vitest-environment jsdom
/**
 * Settings registration contract: one `settings.section` entry under the Open
 * Items id at order 40, sharing one controller, and no settings request until
 * the page mounts (a reconnect only refreshes a page that already loaded).
 *
 * Runs against a hand-written context, like the panel registration suite,
 * because registration talks to Cordis rather than React.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('./primitives-mock'))

import type { Context } from '@deepseek-ai/cordis'

import {
  SETTINGS_SECTION_ID,
  SETTINGS_SECTION_ORDER,
  registerSettingsSurface,
} from '../../src/client/ui/settings/register'
import type { SettingsTransport } from '../../src/client/data/transport'
import { DEFAULT_SETTINGS } from '../../src/shared/protocol'

/** One captured slot registration. */
interface CapturedSlot {
  readonly name: string
  readonly id?: string
  readonly order?: number
  readonly locale?: string
  readonly label?: () => string
  readonly inject?: () => Record<string, unknown>
}

/** One fake context plus everything it captured. */
function fakeContext() {
  const slots: CapturedSlot[] = []
  const resetListeners: (() => void)[] = []
  const disposers: (() => void)[] = []
  const labels: string[] = []
  const ctx = {
    locale: {
      bind: () => (key: string) => `t:${key}`,
      register: () => () => {},
    },
    effect: (fn: () => (() => void) | void, label?: string) => {
      if (label !== undefined) labels.push(label)
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (spec: CapturedSlot, _component: unknown) => {
        slots.push(spec)
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
  }
  return { ctx: ctx as unknown as Context, slots, resetListeners, disposers, labels }
}

/** A settings transport recording what it was asked for. */
function fakeTransport(): SettingsTransport & { readonly reads: number; readonly writes: unknown[] } {
  const state = { reads: 0 }
  const writes: unknown[] = []
  return {
    get reads() { return state.reads },
    writes,
    async settingsRead() {
      state.reads += 1
      return { settings: DEFAULT_SETTINGS }
    },
    async settingsWrite(input) {
      writes.push(input)
      return { status: 'written', settings: { ...DEFAULT_SETTINGS, version: 1 } }
    },
  }
}

afterEach(() => {
  document.head.innerHTML = ''
})

describe('registerSettingsSurface', () => {
  it('registers one settings.section page under the Open Items id at order 40', () => {
    const { ctx, slots } = fakeContext()
    registerSettingsSurface(ctx, { transport: fakeTransport() })
    expect(slots).toHaveLength(1)
    const slot = slots[0]
    expect(slot?.name).toBe('settings.section')
    expect(slot?.id).toBe(SETTINGS_SECTION_ID)
    expect(slot?.order).toBe(SETTINGS_SECTION_ORDER)
    expect(SETTINGS_SECTION_ID).toBe('open-items')
    expect(SETTINGS_SECTION_ORDER).toBe(40)
    expect(slot?.locale).toBe('openItems')
    expect(slot?.label?.()).toBe('t:settings.nav.label')
    expect(Object.keys(slot?.inject?.() ?? {})).toEqual(['controller'])
  })

  it('reads nothing at registration; the page mount is the only trigger', async () => {
    const transport = fakeTransport()
    const { ctx } = fakeContext()
    registerSettingsSurface(ctx, { transport })
    expect(transport.reads).toBe(0)
    await Promise.resolve()
    expect(transport.reads).toBe(0)
  })

  it('refreshes a loaded page on connection/reset but leaves an untouched one unloaded', async () => {
    const transport = fakeTransport()
    const { ctx, slots, resetListeners } = fakeContext()
    registerSettingsSurface(ctx, { transport })
    // Untouched: the page was never opened, so a reset stays request-free.
    for (const listener of resetListeners) listener()
    await Promise.resolve()
    expect(transport.reads).toBe(0)

    const controller = (slots[0]?.inject?.().controller ?? undefined) as
      | { ensure: () => void; getSnapshot: () => { status: string } }
      | undefined
    controller?.ensure()
    await vi.waitFor(() => { expect(controller?.getSnapshot().status).toBe('ready') })
    expect(transport.reads).toBe(1)
    for (const listener of resetListeners) listener()
    await vi.waitFor(() => { expect(transport.reads).toBe(2) })
  })

  it('owns the controller lifecycle and its freshness listener effects', () => {
    const { ctx, disposers, labels } = fakeContext()
    registerSettingsSurface(ctx, { transport: fakeTransport() })
    expect(disposers.length).toBeGreaterThanOrEqual(2)
    expect(labels).toContain('open-items: settings section')
    expect(labels).toContain('open-items: settings freshness')
    expect(labels).toContain('open-items: settings controller')
    for (const dispose of disposers) dispose()
  })
})
