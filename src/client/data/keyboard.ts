/**
 * The plugin's fixed keyboard subset (OD-09).
 *
 * The DSH client owns application commands through `ctx.shortcuts`; the plugin
 * contributes its keys as *fixed* actions (a plugin cannot expose remapping in
 * rc2), so the service reserves them and the shared `ShortcutKeys` primitive can
 * render the same keycaps. This module stays dependency-free and structural: the
 * shortcuts service is a client platform service this bundle must not require,
 * so it is read through the Context and narrowed here.
 *
 * Text entry, IME composition, an open menu/dialog and already-consumed keys
 * never fire a plugin shortcut.
 *
 * @module dsh-open-items/client/data/keyboard
 */
import type { Context } from '@deepseek-ai/cordis'

/** The command subset the inbox defines. */
export type ShortcutAction = 'next' | 'previous' | 'select' | 'clear' | 'send' | 'snooze' | 'dismiss'

/** What the page does with one shortcut. */
export interface ShortcutHooks {
  /** Handle one action; the page owns what it means for the current selection. */
  onShortcut(action: ShortcutAction): void
  /** Whether shortcuts should act at all (the page is the visible surface). */
  isEnabled(): boolean
}

/** Platform keycap labels for hints (primary = Meta on macOS, Ctrl elsewhere). */
export interface ShortcutKeyLabels {
  readonly next: readonly string[]
  readonly previous: readonly string[]
  readonly select: readonly string[]
  readonly clear: readonly string[]
  readonly send: readonly string[]
  readonly snooze: readonly string[]
  readonly dismiss: readonly string[]
}

/** Narrowed shortcuts service (structural; no platform-module import). */
interface ShortcutsLike {
  readonly platform: string
  registerFixed(command: {
    readonly id: string
    readonly label: () => string
    readonly keys: readonly string[]
    readonly bindings: readonly {
      readonly code: string
      readonly secondCode?: string
      readonly modifiers: readonly string[]
    }[]
    readonly group: 'application'
  }): () => void
  observeFixedInput(listener: (input: {
    readonly type: 'keydown'
    readonly gesture: {
      readonly code: string
      readonly control: boolean
      readonly alt: boolean
      readonly shift: boolean
      readonly meta: boolean
      readonly repeat: boolean
      readonly composing: boolean
      readonly defaultPrevented: boolean
    }
    readonly context: { readonly region: string; readonly modal: string | null }
  }) => void): () => void
}

/** One fixed command definition (id, action, physical binding, keycap label). */
interface FixedSpec {
  readonly action: ShortcutAction
  readonly id: string
  readonly labelKey: string
  readonly code: string
  readonly modifiers: readonly string[]
}

/** The subset: j/k, Enter, Esc, primary+Enter, S, D (EDGE: no arrow keys — panel owns them). */
const SPECS: readonly FixedSpec[] = [
  { action: 'next', id: 'open-items.next', labelKey: 'shortcut.next', code: 'KeyJ', modifiers: [] },
  { action: 'previous', id: 'open-items.previous', labelKey: 'shortcut.previous', code: 'KeyK', modifiers: [] },
  { action: 'select', id: 'open-items.select', labelKey: 'shortcut.select', code: 'Enter', modifiers: [] },
  { action: 'clear', id: 'open-items.clear', labelKey: 'shortcut.clear', code: 'Escape', modifiers: [] },
  { action: 'send', id: 'open-items.send', labelKey: 'shortcut.send', code: 'Enter', modifiers: ['primary'] },
  { action: 'snooze', id: 'open-items.snooze', labelKey: 'shortcut.snooze', code: 'KeyS', modifiers: [] },
  { action: 'dismiss', id: 'open-items.dismiss', labelKey: 'shortcut.dismiss', code: 'KeyD', modifiers: [] },
]

/** Whether a gesture matches one spec on this platform. */
function matches(spec: FixedSpec, gesture: { code: string; control: boolean; alt: boolean; shift: boolean; meta: boolean }, primary: 'meta' | 'control'): boolean {
  if (spec.code !== gesture.code) return false
  const expected = spec.modifiers.map(modifier => (modifier === 'primary' ? primary : modifier))
  return expected.includes('meta') === gesture.meta
    && expected.includes('control') === gesture.control
    && expected.includes('alt') === gesture.alt
    && expected.includes('shift') === gesture.shift
    && expected.length === [gesture.meta, gesture.control, gesture.alt, gesture.shift].filter(Boolean).length
}

/** Resolve the live service at call time (it may mount after this row). */
function serviceOf(ctx: Context): ShortcutsLike | undefined {
  return (ctx as unknown as { get(name: string): unknown }).get('shortcuts') as ShortcutsLike | undefined
}

/** The page-facing keyboard seam. */
export interface ShortcutSeam {
  /** Register the plugin's fixed keys for one page instance; returns the disposer. */
  bind(hooks: ShortcutHooks): () => void
  /** Keycap labels for inline hints (platform-aware). */
  keys(): ShortcutKeyLabels
}

/**
 * Create the keyboard seam around `ctx.shortcuts`.
 * @param ctx - client root context.
 * @param labelOf - resolves one command label.
 * @returns the seam the page injects.
 */
export function createShortcutSeam(ctx: Context, labelOf: (key: string) => string): ShortcutSeam {
  let hooks: ShortcutHooks | undefined
  let attached = false
  let disposers: (() => void)[] = []

  const primaryOf = (service: ShortcutsLike): 'meta' | 'control' => (service.platform === 'macos' ? 'meta' : 'control')

  const attach = (service: ShortcutsLike): void => {
    attached = true
    disposers = SPECS.map(spec => service.registerFixed({
      id: spec.id,
      label: () => labelOf(spec.labelKey),
      keys: [spec.code === 'KeyJ' ? 'J' : spec.code === 'KeyK' ? 'K' : spec.code === 'KeyS' ? 'S' : spec.code === 'KeyD' ? 'D' : spec.code === 'Escape' ? 'Esc' : '↵'],
      bindings: [{ code: spec.code, modifiers: spec.modifiers }],
      group: 'application',
    }))
    disposers.push(service.observeFixedInput((input) => {
      if (hooks === undefined || !hooks.isEnabled()) return
      const { gesture } = input
      if (gesture.repeat || gesture.composing || gesture.defaultPrevented) return
      if (input.context.region === 'editable' || input.context.modal !== null) return
      const spec = SPECS.find(candidate => matches(candidate, gesture, primaryOf(service)))
      if (spec !== undefined) hooks.onShortcut(spec.action)
    }))
  }

  const detach = (): void => {
    for (const dispose of disposers) dispose()
    disposers = []
    attached = false
  }

  // `ctx.inject` runs synchronously when the service is already mounted and
  // re-runs when it appears; the disposer releases the registrations on unload.
  const binding = ctx.inject(['shortcuts'], (scope) => {
    const service = (scope as unknown as { shortcuts: ShortcutsLike }).shortcuts
    attach(service)
    return () => { detach() }
  })

  return {
    bind(next) {
      hooks = next
      if (serviceOf(ctx) !== undefined && !attached) attach(serviceOf(ctx) as ShortcutsLike)
      return () => {
        hooks = undefined
        void binding
        detach()
      }
    },
    keys() {
      const service = serviceOf(ctx)
      const primary = service === undefined ? 'Ctrl' : (primaryOf(service) === 'meta' ? '⌘' : 'Ctrl')
      return {
        next: ['J'], previous: ['K'], select: ['↵'], clear: ['Esc'],
        send: [primary, '↵'], snooze: ['S'], dismiss: ['D'],
      }
    },
  }
}
