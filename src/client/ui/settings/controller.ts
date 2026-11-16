/**
 * Shared state of the Open Items settings page.
 *
 * One controller backs the `settings.section` page, so a Settings read happens
 * only once the page mounts and every surface renders the same Host truth. Reads
 * are whole-record; writes carry the version that was read and the Host answers
 * a lost race with `conflict` (the live record), which this controller adopts as
 * truth instead of overwriting someone else's change. There is no Save button
 * and no optimistic state: the controls always show what the Host has accepted.
 *
 * Mirrors the in-repo precedent `highlight-plugin/dsh-highlights/src/client/ui/
 * settings/controller.ts`, minus the retention row this plugin does not own.
 *
 * @module dsh-open-items/client/ui/settings/controller
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

import type { SettingsPatch, SettingsRecord } from '../../../shared/protocol'
import type { SettingsTransport } from '../../data/transport'

/** Load lifecycle of the settings record. */
export type SettingsStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Everything the settings page observes. */
export interface SettingsState {
  /** Idle until the page mounts; never read at boot. */
  readonly status: SettingsStatus
  /** Host truth; undefined until the first successful read. */
  readonly settings: SettingsRecord | undefined
  /** A write is in flight; the controls stay disabled until it settles. */
  readonly saving: boolean
  /** The field whose write is in flight, so the page can say which row is saving. */
  readonly savingField?: keyof SettingsPatch
  /** The last read failed; `settings` keeps the previous truth when it had one. */
  readonly loadFailed: boolean
  /** The last write failed; the controls already show the unchanged Host truth. */
  readonly saveFailed: boolean
  /** A write lost the compare-and-set race and the Host record was adopted. */
  readonly conflicted: boolean
}

/** The settings page's face. */
export interface SettingsController {
  /** Observable state for `useSyncExternalStore`. */
  readonly source: ObservableSnapshot<SettingsState>
  /** Current state (synchronous). */
  getSnapshot(): SettingsState
  /** Load once when idle or after a failure; safe to call on every mount. */
  ensure(): void
  /** Force a read (the retry control, or after the connection returns). */
  refresh(): void
  /**
   * Apply one patch with compare-and-set.
   * @param patch - fields to change.
   * @returns true when the Host accepted the write.
   */
  update(patch: SettingsPatch): Promise<boolean>
  /** Release the state; in-flight results are ignored. */
  dispose(): void
}

/** Injection points for tests. */
export interface SettingsControllerOptions {
  readonly transport: SettingsTransport
}

/** Initial state before the first read. */
const INITIAL: SettingsState = {
  status: 'idle',
  settings: undefined,
  saving: false,
  loadFailed: false,
  saveFailed: false,
  conflicted: false,
}

/**
 * Create the settings controller.
 * @param options - the route transport (or a test double).
 * @returns the controller.
 */
export function createSettingsController(options: SettingsControllerOptions): SettingsController {
  const { transport } = options
  let state: SettingsState = INITIAL
  const listeners = new Set<() => void>()
  let disposed = false
  let readInFlight: Promise<void> | undefined

  /** Publish a partial state patch to every subscriber. */
  function publish(patch: Partial<SettingsState>): void {
    if (disposed) return
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }

  /** Read the Host record once; concurrent callers share the in-flight read. */
  async function read(): Promise<void> {
    if (disposed) return
    if (readInFlight !== undefined) return readInFlight
    const run = (async (): Promise<void> => {
      if (state.settings === undefined) publish({ status: 'loading', loadFailed: false })
      try {
        const value = await transport.settingsRead()
        publish({ status: 'ready', settings: value.settings, loadFailed: false })
      } catch {
        if (disposed) return
        publish(state.settings === undefined
          ? { status: 'error', loadFailed: true }
          : { loadFailed: true })
      }
    })()
    readInFlight = run
    try {
      await run
    } finally {
      if (readInFlight === run) readInFlight = undefined
    }
  }

  return {
    source: {
      getSnapshot: () => state,
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    getSnapshot: () => state,
    ensure() {
      const snapshot = state
      if (snapshot.status === 'idle' || snapshot.status === 'error') void read()
    },
    refresh() {
      void read()
    },
    async update(patch) {
      const snapshot = state
      if (disposed || snapshot.settings === undefined || snapshot.saving) return false
      const savingField = (Object.keys(patch) as (keyof SettingsPatch)[])[0]
      publish({ saving: true, ...(savingField === undefined ? {} : { savingField }), saveFailed: false, conflicted: false })
      try {
        const result = await transport.settingsWrite({ expectedVersion: snapshot.settings.version, patch })
        if (result.status === 'written') {
          publish({ status: 'ready', saving: false, savingField: undefined, settings: result.settings })
          return true
        }
        // Lost the race: adopt the Host's current record, not the caller's
        // staged one. The next click writes against the re-read version.
        publish({ status: 'ready', saving: false, savingField: undefined, conflicted: true, settings: result.settings })
        return false
      } catch {
        publish({ saving: false, savingField: undefined, saveFailed: true })
        return false
      }
    },
    dispose() {
      disposed = true
      listeners.clear()
      readInFlight = undefined
    },
  }
}
