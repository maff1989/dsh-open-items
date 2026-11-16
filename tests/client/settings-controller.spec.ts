/**
 * Settings controller: the page owns Host truth, writes are compare-and-set,
 * and a lost race is a value the controller adopts rather than overwrites.
 *
 * No component is mounted here; these are the state transitions the Settings
 * page renders.
 */
import { describe, expect, it, vi } from 'vitest'

import { createSettingsController } from '../../src/client/ui/settings/controller'
import type { SettingsTransport } from '../../src/client/data/transport'
import type { SettingsRecord, SettingsWriteInput, SettingsWriteValue } from '../../src/shared/protocol'
import { DEFAULT_SETTINGS } from '../../src/shared/protocol'

/** One deferred promise a test can settle explicitly. */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

/** One settings record with the defaults and an overridden field. */
function record(overrides: Partial<SettingsRecord> = {}): SettingsRecord {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

/** A fake transport whose read and write results each test states. */
function fakeTransport(overrides: Partial<SettingsTransport> = {}): SettingsTransport & {
  readonly reads: number
  readonly writes: SettingsWriteInput[]
} {
  const state = { reads: 0 }
  const writes: SettingsWriteInput[] = []
  return {
    get reads() { return state.reads },
    writes,
    async settingsRead() {
      state.reads += 1
      return { settings: record() }
    },
    async settingsWrite(input) {
      writes.push(input)
      return { status: 'written', settings: record({ version: input.expectedVersion + 1, ...input.patch }) } satisfies SettingsWriteValue
    },
    ...overrides,
  }
}

describe('createSettingsController', () => {
  it('starts idle and never reads before the page mounts', async () => {
    const transport = fakeTransport()
    const controller = createSettingsController({ transport })
    expect(controller.getSnapshot()).toMatchObject({ status: 'idle', settings: undefined })
    expect(transport.reads).toBe(0)
    await Promise.resolve()
    expect(transport.reads).toBe(0)
    controller.dispose()
  })

  it('reads once when ensure is called and exposes Host truth', async () => {
    const transport = fakeTransport({
      async settingsRead() {
        return { settings: record({ version: 4, modelNudge: true, proseCandidates: false }) }
      },
    })
    const controller = createSettingsController({ transport })
    controller.ensure()
    expect(controller.getSnapshot().status).toBe('loading')
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    expect(controller.getSnapshot().settings).toEqual(record({ version: 4, modelNudge: true, proseCandidates: false }))
    controller.ensure()
    await Promise.resolve()
    // A loaded controller does not re-read on a second mount.
    expect(controller.getSnapshot().status).toBe('ready')
    controller.dispose()
  })

  it('writes with the version that was read and adopts the written record', async () => {
    const transport = fakeTransport()
    const controller = createSettingsController({ transport })
    controller.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().settings).toBeDefined() })
    await expect(controller.update({ modelNudge: true })).resolves.toBe(true)
    expect(transport.writes).toEqual([{ expectedVersion: 0, patch: { modelNudge: true } }])
    expect(controller.getSnapshot()).toMatchObject({ saving: false, saveFailed: false, conflicted: false })
    expect(controller.getSnapshot().settings).toMatchObject({ version: 1, modelNudge: true, proseCandidates: true })
    controller.dispose()
  })

  it('adopts the Host record on a lost compare-and-set race and reports conflict', async () => {
    const transport = fakeTransport({
      async settingsWrite() {
        return { status: 'conflict', settings: record({ version: 7, modelNudge: false, proseCandidates: false }) } satisfies SettingsWriteValue
      },
    })
    const controller = createSettingsController({ transport })
    controller.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().settings).toBeDefined() })
    await expect(controller.update({ modelNudge: true })).resolves.toBe(false)
    expect(controller.getSnapshot()).toMatchObject({ saving: false, conflicted: true, saveFailed: false })
    // The caller's staged value is discarded; the panel shows what the Host has.
    expect(controller.getSnapshot().settings).toMatchObject({ version: 7, modelNudge: false, proseCandidates: false })
    controller.dispose()
  })

  it('keeps the last good record when a later read fails', async () => {
    let fail = false
    const transport = fakeTransport({
      async settingsRead() {
        if (fail) throw new Error('offline')
        return { settings: record({ version: 2 }) }
      },
    })
    const controller = createSettingsController({ transport })
    controller.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    fail = true
    controller.refresh()
    await vi.waitFor(() => { expect(controller.getSnapshot().loadFailed).toBe(true) })
    expect(controller.getSnapshot().settings).toMatchObject({ version: 2 })
    expect(controller.getSnapshot().status).toBe('ready')
    controller.dispose()
  })

  it('reaches the error state when the first read fails, and retries after it', async () => {
    let attempt = 0
    const transport = fakeTransport({
      async settingsRead() {
        attempt += 1
        if (attempt === 1) throw new Error('offline')
        return { settings: record({ version: 3 }) }
      },
    })
    const controller = createSettingsController({ transport })
    controller.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('error') })
    expect(controller.getSnapshot().loadFailed).toBe(true)
    controller.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    expect(controller.getSnapshot().settings).toMatchObject({ version: 3 })
    controller.dispose()
  })

  it('reports a failed write without touching the shown record', async () => {
    const transport = fakeTransport({
      async settingsWrite() {
        throw new Error('refused')
      },
    })
    const controller = createSettingsController({ transport })
    controller.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().settings).toBeDefined() })
    await expect(controller.update({ proseCandidates: false })).resolves.toBe(false)
    expect(controller.getSnapshot()).toMatchObject({ saving: false, saveFailed: true, conflicted: false })
    expect(controller.getSnapshot().settings).toMatchObject({ proseCandidates: true })
    controller.dispose()
  })

  it('refuses a second write while one is in flight and ignores results after dispose', async () => {
    const pending = deferred<SettingsWriteValue>()
    const transport = fakeTransport({
      settingsWrite: () => pending.promise,
    })
    const controller = createSettingsController({ transport })
    controller.ensure()
    await vi.waitFor(() => { expect(controller.getSnapshot().settings).toBeDefined() })
    const first = controller.update({ modelNudge: true })
    expect(controller.getSnapshot().saving).toBe(true)
    await expect(controller.update({ proseCandidates: false })).resolves.toBe(false)
    controller.dispose()
    pending.resolve({ status: 'written', settings: record({ version: 1, modelNudge: true }) })
    await expect(first).resolves.toBe(true)
    // Disposed: the in-flight result was ignored, so the state never changed.
    expect(controller.getSnapshot().saving).toBe(true)
    expect(controller.getSnapshot().settings).toMatchObject({ version: 0 })
  })
})
