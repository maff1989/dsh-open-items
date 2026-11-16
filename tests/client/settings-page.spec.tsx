// @vitest-environment jsdom
/**
 * Settings → Open Items page: two capture decisions rendered from Host truth,
 * written with compare-and-set, and honest about loading, conflicts and failures.
 *
 * The primitives are the shipped ones (a mock stands in for the platform shell);
 * the transport is a fake, so no harness is involved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('./primitives-mock'))
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { SettingsPage, type SettingsPageProps } from '../../src/client/ui/settings/SettingsPage'
import { createSettingsController, type SettingsController } from '../../src/client/ui/settings/controller'
import type { SettingsTransport } from '../../src/client/data/transport'
import type { SettingsRecord, SettingsWriteInput, SettingsWriteValue } from '../../src/shared/protocol'
import { DEFAULT_SETTINGS } from '../../src/shared/protocol'
import { t } from './fixtures'

afterEach(cleanup)

/** One settings record with the defaults and an overridden field. */
function record(overrides: Partial<SettingsRecord> = {}): SettingsRecord {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

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

/** A fake settings transport; every test states the results it needs. */
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

/** Create a controller over the fake transport. */
function controllerOf(transport: SettingsTransport): SettingsController {
  return createSettingsController({ transport })
}

/** Render the page with one controller. */
function renderPage(controller: SettingsController): void {
  render(<SettingsPage {...{ t, controller } as unknown as SettingsPageProps} />)
}

/** One switch by its accessible name. */
function switchNamed(name: string): HTMLButtonElement {
  return screen.getByRole('switch', { name }) as HTMLButtonElement
}

describe('SettingsPage', () => {
  it('renders the title, intro and the three opt-in decisions with their defaults', async () => {
    renderPage(controllerOf(fakeTransport()))
    expect(screen.getByRole('heading', { name: t('settings.page.title') })).toBeTruthy()
    expect(screen.getByText(t('settings.page.intro'))).toBeTruthy()
    await waitFor(() => { expect(screen.getAllByRole('switch')).toHaveLength(3) })
    expect(switchNamed(t('settings.modelNudge.title')).getAttribute('aria-checked')).toBe('false')
    expect(switchNamed(t('settings.proseCandidates.title')).getAttribute('aria-checked')).toBe('true')
    // Model-assisted extraction is opt-in: off until the user enables it.
    expect(switchNamed(t('settings.llmExtraction.title')).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(t('settings.modelNudge.desc'))).toBeTruthy()
    expect(screen.getByText(t('settings.proseCandidates.desc'))).toBeTruthy()
    expect(screen.getByText(t('settings.llmExtraction.desc'))).toBeTruthy()
  })

  it('orders the extraction row after Prose candidates', async () => {
    renderPage(controllerOf(fakeTransport()))
    await waitFor(() => { expect(screen.getAllByRole('switch')).toHaveLength(3) })
    const switches = screen.getAllByRole('switch')
    expect(switches.map(node => node.getAttribute('aria-label'))).toEqual([
      t('settings.modelNudge.title'),
      t('settings.proseCandidates.title'),
      t('settings.llmExtraction.title'),
    ])
  })

  it('keeps the extraction copy honest about egress and the deployment precondition', async () => {
    renderPage(controllerOf(fakeTransport()))
    await waitFor(() => { expect(screen.getAllByRole('switch')).toHaveLength(3) })
    const copy = t('settings.llmExtraction.desc')
    expect(copy).toContain('extraction model')
    expect(copy).toContain('last assistant message')
    expect(copy).toContain('Nothing leaves the machine while this is off')
    expect(copy).toContain('no extraction provider or model configured')
    expect(screen.getByText(copy)).toBeTruthy()
  })

  it('writes the model-nudge toggle with the version it read, then shows Host truth', async () => {
    const transport = fakeTransport()
    renderPage(controllerOf(transport))
    await waitFor(() => { expect(switchNamed(t('settings.modelNudge.title')).getAttribute('aria-checked')).toBe('false') })
    fireEvent.click(switchNamed(t('settings.modelNudge.title')))
    await waitFor(() => { expect(transport.writes).toEqual([{ expectedVersion: 0, patch: { modelNudge: true } }]) })
    await waitFor(() => { expect(switchNamed(t('settings.modelNudge.title')).getAttribute('aria-checked')).toBe('true') })
    // The other decision is untouched by the patch.
    expect(switchNamed(t('settings.proseCandidates.title')).getAttribute('aria-checked')).toBe('true')
  })

  it('shows a saving state while the write is in flight and clears it when it settles', async () => {
    const pending = deferred<SettingsWriteValue>()
    const transport = fakeTransport({ settingsWrite: async () => await pending.promise })
    renderPage(controllerOf(transport))
    await waitFor(() => { expect(screen.getAllByRole('switch')).toHaveLength(3) })
    fireEvent.click(switchNamed(t('settings.modelNudge.title')))
    await waitFor(() => { expect(screen.getByText(t('settings.saving'))).toBeTruthy() })
    pending.resolve({ status: 'written', settings: record({ version: 1, modelNudge: true }) })
    await waitFor(() => { expect(screen.queryByText(t('settings.saving'))).toBeNull() })
  })

  it('writes the prose-candidate toggle off', async () => {
    const transport = fakeTransport()
    renderPage(controllerOf(transport))
    await waitFor(() => { expect(switchNamed(t('settings.proseCandidates.title')).getAttribute('aria-checked')).toBe('true') })
    fireEvent.click(switchNamed(t('settings.proseCandidates.title')))
    await waitFor(() => { expect(transport.writes).toEqual([{ expectedVersion: 0, patch: { proseCandidates: false } }]) })
    await waitFor(() => { expect(switchNamed(t('settings.proseCandidates.title')).getAttribute('aria-checked')).toBe('false') })
  })

  it('writes the model-assisted extraction toggle on with the read version', async () => {
    const transport = fakeTransport()
    renderPage(controllerOf(transport))
    await waitFor(() => { expect(screen.getAllByRole('switch')).toHaveLength(3) })
    expect(switchNamed(t('settings.llmExtraction.title')).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(switchNamed(t('settings.llmExtraction.title')))
    await waitFor(() => { expect(transport.writes).toEqual([{ expectedVersion: 0, patch: { llmExtraction: true } }]) })
    await waitFor(() => { expect(switchNamed(t('settings.llmExtraction.title')).getAttribute('aria-checked')).toBe('true') })
    // The other decisions are untouched by the extraction patch.
    expect(switchNamed(t('settings.modelNudge.title')).getAttribute('aria-checked')).toBe('false')
    expect(switchNamed(t('settings.proseCandidates.title')).getAttribute('aria-checked')).toBe('true')
  })

  it('shows the conflict line and the Host values after a lost race', async () => {
    const transport = fakeTransport({
      async settingsWrite() {
        return {
          status: 'conflict',
          settings: record({ version: 5, modelNudge: true, proseCandidates: false, llmExtraction: true }),
        } satisfies SettingsWriteValue
      },
    })
    renderPage(controllerOf(transport))
    await waitFor(() => { expect(screen.getAllByRole('switch')).toHaveLength(3) })
    fireEvent.click(switchNamed(t('settings.modelNudge.title')))
    await waitFor(() => { expect(screen.getByText(t('settings.conflict'))).toBeTruthy() })
    expect(switchNamed(t('settings.modelNudge.title')).getAttribute('aria-checked')).toBe('true')
    expect(switchNamed(t('settings.proseCandidates.title')).getAttribute('aria-checked')).toBe('false')
    // The third row shows Host truth too, not the staged value.
    expect(switchNamed(t('settings.llmExtraction.title')).getAttribute('aria-checked')).toBe('true')
  })

  it('reports a failed write without pretending the toggle changed', async () => {
    const transport = fakeTransport({
      async settingsWrite() {
        throw new Error('refused')
      },
    })
    renderPage(controllerOf(transport))
    await waitFor(() => { expect(screen.getAllByRole('switch')).toHaveLength(3) })
    fireEvent.click(switchNamed(t('settings.proseCandidates.title')))
    await waitFor(() => { expect(screen.getByText(t('settings.saveFailed'))).toBeTruthy() })
    expect(switchNamed(t('settings.proseCandidates.title')).getAttribute('aria-checked')).toBe('true')
  })

  it('disables both controls while a write is in flight', async () => {
    const pending = deferred<SettingsWriteValue>()
    const transport = fakeTransport({ settingsWrite: () => pending.promise })
    renderPage(controllerOf(transport))
    await waitFor(() => { expect(screen.getAllByRole('switch')).toHaveLength(3) })
    fireEvent.click(switchNamed(t('settings.modelNudge.title')))
    await waitFor(() => {
      expect(switchNamed(t('settings.modelNudge.title'))).toHaveProperty('disabled', true)
      expect(switchNamed(t('settings.proseCandidates.title'))).toHaveProperty('disabled', true)
      expect(switchNamed(t('settings.llmExtraction.title'))).toHaveProperty('disabled', true)
    })
    pending.resolve({ status: 'written', settings: record({ version: 1, modelNudge: true }) })
    await waitFor(() => {
      expect(switchNamed(t('settings.modelNudge.title'))).toHaveProperty('disabled', false)
      expect(switchNamed(t('settings.llmExtraction.title'))).toHaveProperty('disabled', false)
    })
  })

  it('shows a retry control when the first load fails and re-reads on click', async () => {
    let reads = 0
    const transport = fakeTransport({
      async settingsRead() {
        reads += 1
        if (reads === 1) throw new Error('offline')
        return { settings: record({ version: 2 }) }
      },
    })
    renderPage(controllerOf(transport))
    await waitFor(() => { expect(screen.getByText(t('settings.loadFailed'))).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: t('settings.retry') }))
    await waitFor(() => { expect(screen.getAllByRole('switch')).toHaveLength(3) })
    expect(reads).toBe(2)
  })
})
