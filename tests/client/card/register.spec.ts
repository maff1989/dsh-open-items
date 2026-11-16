// @vitest-environment jsdom
/**
 * Registration contract of the in-session card: the exact keyed slot entry, the
 * injected business face, the style/disposer lifecycle and the second locale
 * dictionary's integrity.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('../primitives-mock'))

import type { Context } from '@deepseek-ai/cordis'

import { cardEn, cardZh, CARD_LOCALE_NAMESPACE, type OpenItemsCardKey } from '../../../src/client/ui/card/card-locales'
import { registerOpenItemsCard } from '../../../src/client/ui/card/register'
import { OPEN_ITEMS_TOOL_NAME } from '../../../src/client/ui/card/slot-contracts'

afterEach(() => {
  for (const style of document.head.querySelectorAll('style[data-plugin-css="dsh-open-items"]')) style.remove()
})

/** One registration the fake slot table captured. */
interface CapturedRegistration {
  readonly options: Record<string, unknown>
  readonly component: unknown
}

/** A fake Cordis context recording every contribution. */
function fakeContext(): {
  ctx: Context
  registrations: CapturedRegistration[]
  dictionaries: { namespace: string; dicts: Record<string, Record<string, string>> }[]
  disposers: (() => void)[]
} {
  const registrations: CapturedRegistration[] = []
  const dictionaries: { namespace: string; dicts: Record<string, Record<string, string>> }[] = []
  const disposers: (() => void)[] = []
  const ctx = {
    effect: (fn: () => (() => void) | void) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    slots: {
      inject: (_key: string, callback: () => () => void) => {
        disposers.push(callback())
      },
      register: (options: Record<string, unknown>, component: unknown) => {
        registrations.push({ options, component })
        return () => undefined
      },
    },
    locale: {
      register: (namespace: string, dicts: Record<string, Record<string, string>>) => {
        dictionaries.push({ namespace, dicts })
        return () => undefined
      },
    },
  } as unknown as Context
  return { ctx, registrations, dictionaries, disposers }
}

/** Placeholder names of one template. */
function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/gu)].map(match => match[1] ?? '').sort()
}

describe('registerOpenItemsCard', () => {
  it('registers the keyed tool view named by the wire tool', () => {
    const { ctx, registrations } = fakeContext()
    registerOpenItemsCard(ctx, { transport: vi.fn() as never, openInbox: vi.fn() })

    expect(registrations).toHaveLength(1)
    const [registration] = registrations
    expect(registration?.options).toMatchObject({
      name: 'tool.call.toolview',
      key: OPEN_ITEMS_TOOL_NAME,
      locale: CARD_LOCALE_NAMESPACE,
    })
    expect(OPEN_ITEMS_TOOL_NAME).toBe('open_items')
    expect(typeof registration?.component).toBe('function')
  })

  it('injects the session id, the route face and the peer/session probes', () => {
    const { ctx, registrations } = fakeContext()
    const transport = {
      list: vi.fn(),
      reply: vi.fn(),
      delivery: vi.fn(),
    }
    const openInbox = vi.fn()
    const now = (): number => 42
    const sessionIsSubagent = (sessionId: string): boolean => sessionId === 'sub-session'
    const peerReadOnly = (): boolean => true
    registerOpenItemsCard(ctx, {
      transport: transport as never,
      openInbox,
      now,
      sessionIsSubagent,
      peerReadOnly,
    })

    const inject = registrations[0]?.options.inject as (sessionId: string) => Record<string, unknown>
    const face = inject('session-1')
    expect(face.sessionId).toBe('session-1')
    expect(face.transport).toBe(transport)
    expect(face.openInbox).toBe(openInbox)
    expect((face.now as () => number)()).toBe(42)
    expect((face.isSubagent as () => boolean)()).toBe(false)
    expect((face.peerReadOnly as () => boolean)()).toBe(true)

    const subagentFace = inject('sub-session')
    expect((subagentFace.isSubagent as () => boolean)()).toBe(true)
  })

  it('owns a stylesheet and its disposers', () => {
    const { ctx, disposers } = fakeContext()
    registerOpenItemsCard(ctx, { transport: vi.fn() as never, openInbox: vi.fn() })
    const style = document.head.querySelector('style[data-plugin-css="dsh-open-items"][data-plugin-css-part="card"]')
    expect(style).not.toBeNull()
    expect(style?.textContent).toContain('.dsh-oi-card')
    expect(document.head.querySelectorAll('style[data-plugin-css="dsh-open-items"]')).toHaveLength(1)
    for (const dispose of disposers) dispose()
    expect(document.head.querySelector('style[data-plugin-css="dsh-open-items"]')).toBeNull()
  })

  it('registers its own card dictionary with both baseline locales', () => {
    const { ctx, dictionaries } = fakeContext()
    registerOpenItemsCard(ctx, { transport: vi.fn() as never, openInbox: vi.fn() })
    expect(dictionaries).toHaveLength(1)
    expect(dictionaries[0]?.namespace).toBe('openItemsCard')
    expect(Object.keys(dictionaries[0]?.dicts ?? {})).toEqual(['en', 'zh'])
  })
})

describe('card locale dictionary', () => {
  it('keeps both locales key-for-key identical', () => {
    expect(Object.keys(cardZh).sort()).toEqual(Object.keys(cardEn).sort())
  })

  it('has no empty copy and no drifting placeholders', () => {
    for (const [key, value] of Object.entries(cardEn)) {
      expect(value.trim(), `en.${key}`).not.toBe('')
      const zhValue = cardZh[key as OpenItemsCardKey]
      expect(zhValue?.trim(), `zh.${key}`).not.toBe('')
      expect(placeholders(zhValue ?? ''), `zh.${key}`).toEqual(placeholders(value))
    }
  })

  it('keeps the two send claims as different sentences', () => {
    expect(cardEn['card.receipt.applied']).not.toBe(cardEn['card.receipt.recorded'])
    expect(cardEn['card.receipt.applied']).toContain('next step')
    expect(cardEn['card.receipt.recorded']).toContain('next runs')
  })
})
