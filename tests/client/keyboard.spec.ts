import { describe, expect, it } from 'vitest'

import { createShortcutSeam } from '../../src/client/data/keyboard'

/** Fake client context exposing one shortcuts service. */
function contextOf(platform: string): {
  ctx: { get(name: string): unknown; inject(deps: string[], callback: (scope: unknown) => () => void): unknown }
  registered: string[]
  fire: (gesture: Record<string, unknown>, region?: string) => void
} {
  const registered: string[] = []
  let listener: ((input: never) => void) | undefined
  const service = {
    platform,
    registerFixed: (command: { id: string }) => {
      registered.push(command.id)
      return () => undefined
    },
    observeFixedInput: (next: (input: never) => void) => {
      listener = next
      return () => undefined
    },
  }
  const ctx = {
    get: (name: string) => (name === 'shortcuts' ? service : undefined),
    inject: (_deps: string[], callback: (scope: unknown) => () => void) => {
      ;(callback as (scope: unknown) => () => void)({ shortcuts: service })
      return () => undefined
    },
  }
  return {
    ctx,
    registered,
    fire: (gesture, region = 'page') => {
      listener?.({
        type: 'keydown',
        gesture: { repeat: false, composing: false, defaultPrevented: false, control: false, alt: false, shift: false, meta: false, ...gesture },
        context: { region, modal: null },
      } as never)
    },
  }
}

describe('keyboard seam', () => {
  it('registers the agreed subset and dispatches it', () => {
    const { ctx, registered, fire } = contextOf('macos')
    const seam = createShortcutSeam(ctx as never, key => key)
    const actions: string[] = []
    const dispose = seam.bind({ isEnabled: () => true, onShortcut: action => actions.push(action) })
    expect(registered).toEqual([
      'open-items.next', 'open-items.previous', 'open-items.select', 'open-items.clear',
      'open-items.send', 'open-items.snooze', 'open-items.dismiss',
    ])
    fire({ code: 'KeyJ' })
    fire({ code: 'KeyK' })
    fire({ code: 'KeyS' })
    fire({ code: 'KeyD' })
    fire({ code: 'Enter', meta: true })
    expect(actions).toEqual(['next', 'previous', 'snooze', 'dismiss', 'send'])
    expect(seam.keys().send).toEqual(['⌘', '↵'])
    dispose()
  })

  it('never fires from text entry, composition, a dialog or a consumed key', () => {
    const { ctx, fire } = contextOf('windows')
    const seam = createShortcutSeam(ctx as never, key => key)
    const actions: string[] = []
    seam.bind({ isEnabled: () => true, onShortcut: action => actions.push(action) })
    fire({ code: 'KeyJ' }, 'editable')
    fire({ code: 'KeyJ', composing: true })
    fire({ code: 'KeyJ', defaultPrevented: true })
    expect(actions).toEqual([])
    expect(seam.keys().send).toEqual(['Ctrl', '↵'])
  })
})
