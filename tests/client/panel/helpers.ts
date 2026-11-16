/**
 * Shared fixtures for the session-panel suite: item factories, a scriptable
 * route transport and the framework-seat props the panel body reads.
 *
 * The panel is exercised through its real store and a fake transport, so the
 * tests pin both the DOM and the exact route calls (scope, status, payload).
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

import type {
  InboxSnapshot,
  OpenItemRecord,
  OpenItemState,
  ReplyDescriptor,
} from '../../../src/shared/schema'
import type {
  HelloValue,
  ListRequest,
  ListValue,
  RegisterRequest,
  RegisterValue,
  ReplyRequest,
  ReplyValue,
} from '../../../src/shared/protocol'
import { makeItem, makeSnapshot, t } from '../fixtures'
import type { OpenInboxOptions } from '../../../src/client/ui/handoff'
import type { InboxTransport } from '../../../src/client/data/transport'
import type { OpenItemsPanelProps, OpenItemsPanelInjected } from '../../../src/client/ui/panel/OpenItemsPanel'

/** Session every fixture record belongs to unless a test states otherwise. */
export const SESSION = 'session-1'

/** One answerable descriptor with options. */
export function optionReply(options: readonly string[]): ReplyDescriptor {
  return { controls: ['option'], options, freeText: false, requiresConfirm: false }
}

/** One free-text descriptor. */
export function textReply(requiresConfirm = false): ReplyDescriptor {
  return { controls: ['text'], freeText: true, requiresConfirm }
}

/** An item raised by the `open_items` tool (has its own transcript card). */
export function toolItem(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    detectedBy: ['tool'],
    source: { sessionId: SESSION, sessionTitle: 'Mock query builder', callId: 'call-1' },
    reply: optionReply(['Corporate registry', 'Public registry']),
    ...overrides,
  })
}

/** A live shipped ask captured from the harness (composer card owns it). */
export function liveAsk(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    kind: 'question',
    blocking: true,
    detectedBy: ['projection'],
    source: { sessionId: SESSION, sessionTitle: 'Mock query builder', callId: 'ask-1' },
    reply: { controls: [], freeText: false, requiresConfirm: false },
    ...overrides,
  })
}

/** A prose-inferred candidate. */
export function candidateItem(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    tier: 'candidate',
    severity: 3,
    detectedBy: ['projection'],
    source: { sessionId: SESSION, sessionTitle: 'Mock query builder' },
    ...overrides,
  })
}

/** An answered item the session has not acknowledged. */
export function waitingItem(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    id: 'item-waiting',
    state: 'awaiting',
    tier: 'structural',
    title: 'Registry choice sent',
    reply: textReply(),
    ...overrides,
  })
}

/** One resolved row of the register. */
export function resolvedItem(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    id: 'item-resolved',
    state: 'resolved',
    title: 'Keep the palette',
    resolvedAt: 4_000,
    resolution: { kind: 'answered', at: 4_000, actor: 'user', payload: { type: 'option', option: 'Keep' } },
    ...overrides,
  })
}

/** One inbox snapshot over the supplied records (counts are cross-session). */
export function snapshotOf(items: readonly OpenItemRecord[], overrides: Partial<InboxSnapshot> = {}): InboxSnapshot {
  return makeSnapshot(items, overrides)
}

/** Scripted behaviour of the fake transport. */
export interface TransportScript {
  readonly items?: readonly OpenItemRecord[]
  readonly resolved?: readonly OpenItemRecord[]
  readonly resolvedTotal?: number
  readonly listError?: Error
  readonly registerError?: Error
  readonly replyError?: Error
  readonly replyValue?: (request: ReplyRequest) => ReplyValue
  readonly helloValue?: HelloValue
}

/** One recorded route call. */
export interface RecordedCalls {
  readonly list: ListRequest[]
  readonly register: RegisterRequest[]
  readonly reply: ReplyRequest[]
  readonly all: string[]
}

/** A transport whose reads and write are fully scripted, plus its call log. */
export function fakeTransport(script: TransportScript = {}): InboxTransport & { readonly calls: RecordedCalls } {
  const calls: { list: ListRequest[]; register: RegisterRequest[]; reply: ReplyRequest[]; all: string[] } = {
    list: [],
    register: [],
    reply: [],
    all: [],
  }
  const listValue = (_request: ListRequest = {}): ListValue => ({
    snapshot: snapshotOf(script.items ?? []),
  })
  const transport: InboxTransport = {
    hello: async (): Promise<HelloValue> => script.helloValue ?? {
      protocol: 1,
      domainVersion: 3,
      schemaVersion: 3,
      installId: 'install-1',
      capabilities: { canSettleClient: true, canHostSettle: true, canDeliver: true, canRegister: true, hasContextLine: false },
      counts: { needsYou: 0, candidates: 0, awaiting: 0 },
      earlierRecordsPruned: false,
    },
    list: async (request = {}) => {
      calls.list.push(request)
      calls.all.push('list')
      if (script.listError !== undefined) throw script.listError
      return listValue(request)
    },
    register: async (request = {}) => {
      calls.register.push(request)
      calls.all.push('register')
      if (script.registerError !== undefined) throw script.registerError
      const value: RegisterValue = {
        items: (script.resolved ?? []).filter(record => record.deletedAt === undefined),
        total: script.resolvedTotal ?? (script.resolved ?? []).length,
        earlierRecordsPruned: false,
      }
      return value
    },
    reply: async request => {
      calls.reply.push(request)
      calls.all.push('reply')
      if (script.replyError !== undefined) throw script.replyError
      if (script.replyValue !== undefined) return script.replyValue(request)
      const base = (script.items ?? []).find(entry => entry.id === request.itemId)
        ?? (script.resolved ?? []).find(entry => entry.id === request.itemId)
        ?? toolItem({ id: request.itemId })
      return {
        item: {
          ...base,
          state: 'awaiting' as OpenItemState,
          version: base.version + 1,
          deliveries: [{
            deliveryId: request.deliveryId,
            at: 9_000,
            track: 'session-message',
            payload: request.payload,
            state: 'delivered',
          }],
        },
        delivery: {
          deliveryId: request.deliveryId,
          at: 9_000,
          track: 'session-message',
          payload: request.payload,
          state: 'delivered',
        },
        outcome: 'sent',
      }
    },
    delivery: async () => ({ delivery: undefined, item: undefined }),
    dismiss: async () => {
      throw new Error('unused')
    },
    snooze: async () => {
      throw new Error('unused')
    },
    reopen: async () => {
      throw new Error('unused')
    },
    delete: async () => {
      throw new Error('unused')
    },
  }
  return Object.assign(transport, { calls })
}

/** The tab shape the seat hands the body (`useTabInfo`). */
export interface FakeTab {
  readonly id: string
  readonly kind: string
  readonly contentId: string
  readonly title: string
  readonly visible: boolean
  readonly navigation: { readonly address: string; readonly params?: { readonly itemId?: string }; readonly revision: number }
  readonly signal?: AbortSignal
  readonly actions?: { bindCommands?: (commands: { refresh: () => void }) => () => void }
}

/** One fake tab, visible by default (the usual on-screen case). */
export function fakeTab(overrides: Partial<FakeTab> = {}): FakeTab {
  return {
    id: 'tab-1',
    kind: 'open-items',
    contentId: 'sidebar://open-items',
    title: 'Open items',
    visible: true,
    navigation: { address: 'sidebar://open-items', revision: 0 },
    actions: { bindCommands: () => () => {} },
    ...overrides,
  }
}

/** Options one panel render accepts. */
export interface PanelOptions {
  readonly sessionId?: string
  readonly tab?: FakeTab
  readonly pollMs?: number
  readonly canRevealAsk?: boolean
  readonly clock?: () => number
  readonly openInbox?: (options?: OpenInboxOptions) => void
  readonly reveal?: OpenItemsPanelInjected['reveal']
  readonly handoff?: OpenItemsPanelInjected['handoff']
  readonly onConnectionReset?: (listener: () => void) => () => void
}

/** Assemble the framework seats for one panel render. */
export function panelProps(
  transport: InboxTransport,
  overrides: PanelOptions = {},
): OpenItemsPanelProps {
  const tab = overrides.tab ?? fakeTab()
  const props: OpenItemsPanelInjected = {
    transport,
    pollMs: overrides.pollMs ?? 0,
    openInbox: overrides.openInbox ?? (() => {}),
    onConnectionReset: overrides.onConnectionReset ?? (() => () => {}),
    reveal: overrides.reveal ?? (() => 'revealed'),
    handoff: overrides.handoff ?? (() => 'revealed'),
    canRevealAsk: overrides.canRevealAsk ?? false,
    ...(overrides.clock === undefined ? {} : { clock: overrides.clock }),
  }
  return {
    ...props,
    t,
    useTabInfo: () => ({ tab }),
    sessionId: (overrides.sessionId ?? SESSION) as never,
  } as unknown as OpenItemsPanelProps
}

/** An observable with no listeners, for `useSnap`-shaped props if ever needed. */
export function staticSource<T>(value: T): ObservableSnapshot<T> {
  return { getSnapshot: () => value, subscribe: () => () => {} }
}
