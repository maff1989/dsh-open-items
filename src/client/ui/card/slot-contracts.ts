/**
 * Local restatement of the `tool.call.toolview` slot contract.
 *
 * The runtime declares the slot (the shipped Web composition mounts
 * `client-ui-tool`, which renders every atomic tool call through it), but the
 * contract type lives in `@deepseek-ai/dsh-client-ui-tool`, a package this
 * plugin does not depend on. Exactly like the installed precedent's
 * `ui/tools/slot-contracts.ts`, the published contract is restated here: one
 * session-scoped keyed slot whose owner props are the call identity plus the
 * stage-specific block. Only the fields this card reads are declared, so an
 * upstream addition is invisible here rather than wrongly typed, and drift is
 * caught by the live card.
 *
 * Workaround W15, ledger entry `docs/workaround-ledger.md` (upstream ask #12):
 * a publishable client slot-contract package would delete this file.
 *
 * @module dsh-open-items/client/ui/card/slot-contracts
 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

import type { ListRequest, ListValue, ReplyRequest, ReplyValue } from '../../../shared/protocol'
import type { InboxTransport } from '../../data/transport'
import type { DeliveryRequest, DeliveryValue } from '../../../shared/protocol'
import type { OpenItemsCardNamespace } from './card-locales'

/** The wire tool name this registration owns (mirrors `host/tools.ts`). */
export const OPEN_ITEMS_TOOL_NAME = 'open_items'

/** One content block as the recorded result carries it (only text is read). */
export interface RecordedContentBlock {
  readonly type?: string
  readonly text?: string
}

/** The recorded `tool/result` material this card reads. */
export interface OpenItemsToolBlock {
  /** `tool-result` on the settled stage. */
  readonly kind?: string
  readonly callId?: string
  /** The `output.presentationMeta` payload persisted on `tool/result.meta`. */
  readonly meta?: unknown
  readonly isError?: boolean
  readonly error?: {
    readonly name?: string
    readonly code?: string
    readonly reason?: string
  }
  readonly content?: readonly RecordedContentBlock[]
}

/** Owner currency of one atomic tool call, per stage (the fields we consume). */
export type OpenItemsToolOwnerProps =
  | { readonly callId: string; readonly toolName: string; readonly phase: 'preparing'; readonly block: unknown }
  | { readonly callId: string; readonly toolName: string; readonly phase: 'start'; readonly block: unknown }
  | { readonly callId: string; readonly toolName: string; readonly phase: 'result'; readonly block: OpenItemsToolBlock }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One atomic tool call's row, dispatched by wire tool name. */
    'tool.call.toolview': {
      kind: 'keyed'
      scope: 'session'
      owner: OpenItemsToolOwnerProps
    }
  }
}

/** The route face the card needs (a subset of {@link InboxTransport}). */
export type CardTransport = Pick<InboxTransport, 'list' | 'reply' | 'delivery'>

/** Route calls the card makes, restated so tests can assert exact shapes. */
export type CardListRequest = ListRequest
export type CardListValue = ListValue
export type CardReplyRequest = ReplyRequest
export type CardReplyValue = ReplyValue
export type CardDeliveryRequest = DeliveryRequest
export type CardDeliveryValue = DeliveryValue

/** Business face injected by {@link registerOpenItemsCard}. */
export interface OpenItemsCardInjected {
  /** Session the rendered row belongs to (the inject factory's session id). */
  readonly sessionId: string
  /** Typed route client; the composition root owns the instance. */
  readonly transport: CardTransport
  /** Show the inbox with this item selected. Never changes the selected Session. */
  readonly openInbox: (itemId?: string) => void
  /** Injected clock so receipt times are deterministic in tests. */
  readonly now: () => number
  /**
   * Fallback subagent probe for a composition that injects it. The card now
   * prefers the session catalogue standard hook (see {@link OpenItemsCardStandardHooks}).
   */
  readonly isSubagent: () => boolean
  /**
   * Fallback read-only probe for a composition that injects it. The card now
   * prefers the session access standard hook `useAccess('session/prompt')`.
   */
  readonly peerReadOnly: () => boolean
}

/** One session-catalogue row the card reads for the subagent check. */
export interface SessionSummaryLike {
  /** Coarse durable origin; `'subagent'` means a child conversation. */
  readonly origin?: string
  /** Parent session id: a child conversation always carries one. */
  readonly parentId?: string
}

/** The slice of the session catalogue the card needs. */
export interface SessionCatalogue {
  readonly byId: Readonly<Record<string, SessionSummaryLike>>
}

/**
 * Session-scoped standard hooks the card reads at render time.
 *
 * Declared optional so a partial composition (and the component tests) can
 * render without a live provider; the live Web composition always supplies them
 * from `@deepseek-ai/dsh-client-ui-session/client`'s standard-prop merge. Reading
 * them at render replaces the apply-time `ctx.get('sessions')` lookup and its
 * cold-boot load-order race.
 */
export interface OpenItemsCardStandardHooks {
  /** Whether the current Peer may call `action` on this Session resource. */
  readonly useAccess?: (action: string) => boolean
  /** Session catalogue selector (the session standard `useSessions`). */
  readonly useSessions?: <Selected>(selector: (state: SessionCatalogue) => Selected) => Selected
}

/** Props the renderer assembles for this registration. */
export type OpenItemsCardProps =
  PropsRuntime<'tool.call.toolview'>
  & PropsLocale<OpenItemsCardNamespace>
  & InjectFace<OpenItemsCardInjected>
  & OpenItemsCardStandardHooks
