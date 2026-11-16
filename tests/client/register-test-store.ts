/**
 * Test harness for the register components: a controllable `RegisterStore` and
 * a ready-state factory.
 *
 * The components only read `state` and call named actions, so a fake store keeps
 * component tests focused on the DOM contract; the real store's behaviour is
 * covered by `register-store.spec.ts`.
 */
import { vi } from 'vitest'

import type {
  RegisterNotice,
  RegisterState,
  RegisterStore,
} from '../../src/client/data/register-store'
import {
  INITIAL_REGISTER_FILTERS,
  exportSummaryOf,
  type RegisterFilters,
} from '../../src/client/derive/register-view'
import type { OpenItemRecord } from '../../src/shared/schema'
import { NOW } from './register-fixtures'

/** A ready register state with the given rows and band. */
export function readyState(
  items: readonly OpenItemRecord[],
  inFlight: readonly OpenItemRecord[] = [],
  patch: Partial<RegisterState> = {},
): RegisterState {
  return {
    status: 'ready',
    filters: INITIAL_REGISTER_FILTERS,
    items,
    inFlight,
    total: items.length,
    archived: 0,
    earlierRecordsPruned: false,
    loadingMore: false,
    offline: false,
    lastReadAt: NOW,
    selectedId: null,
    exporting: false,
    ...patch,
  }
}

/** The actions a test can assert on, typed as mocks. */
export interface FakeRegisterActions {
  setFilters: ReturnType<typeof vi.fn>
  clearFilters: ReturnType<typeof vi.fn>
  select: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
  loadMore: ReturnType<typeof vi.fn>
  reopen: ReturnType<typeof vi.fn>
  collectForExport: ReturnType<typeof vi.fn>
  downloadArchive: ReturnType<typeof vi.fn>
  dismissNotice: ReturnType<typeof vi.fn>
}

/** A store over one state value: actions publish a new state and notify. */
export function fakeRegisterStore(initial: RegisterState): {
  store: RegisterStore
  actions: FakeRegisterActions
  setState: (patch: Partial<RegisterState>) => void
} {
  let state = initial
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<RegisterState>): void => {
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }
  const setFilters = vi.fn((patch: Partial<RegisterFilters>) => {
    publish({ filters: { ...state.filters, ...patch }, selectedId: null })
  })
  const actions: FakeRegisterActions = {
    setFilters,
    clearFilters: vi.fn(() => publish({ filters: INITIAL_REGISTER_FILTERS })),
    select: vi.fn((itemId: string | null) => publish({ selectedId: itemId })),
    refresh: vi.fn(async () => {}),
    loadMore: vi.fn(async () => {}),
    reopen: vi.fn(async (itemId: string) => publish({
      busyId: itemId,
      notice: { tone: 'ok', code: 'reopened' } satisfies RegisterNotice,
      items: state.items.filter(item => item.id !== itemId),
      total: Math.max(0, state.total - 1),
    })),
    collectForExport: vi.fn(async () => ({
      ok: true as const,
      records: state.items,
      inFlight: state.inFlight.length,
      summary: exportSummaryOf(state.items, state.inFlight, state.earlierRecordsPruned),
    })),
    downloadArchive: vi.fn(async () => ({
      ok: true as const,
      filename: 'open-items-20261113T1500Z-4-30-days-all-sources.html',
      byteLength: 4096,
    })),
    dismissNotice: vi.fn(() => publish({ notice: undefined })),
  }
  const store: RegisterStore = {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => state,
    pluginVersion: '9.9.9-test',
    schemaVersion: 3,
    now: () => NOW,
    actions: actions as unknown as RegisterStore['actions'],
  }
  return { store, actions, setState: publish }
}
