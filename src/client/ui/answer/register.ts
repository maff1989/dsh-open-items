/**
 * Registration of the answer Toast host in the root overlay seat.
 *
 * `shell.overlay` is a root-scoped list slot, the same seat the shipped
 * plugin-manager uses for its refresh toast, so the banner is app-wide rather
 * than owned by the page panel. The store is module-scoped, so the page can
 * publish whether or not the host is mounted yet.
 *
 * @module dsh-open-items/client/ui/answer/register
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

import { AnswerToastHost } from './ToastHost'

/**
 * Register the app-surviving Toast host.
 * @param ctx - client root context owning the slot registry.
 */
export function registerAnswerToastHost(ctx: Context): void {
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'open-items.answer-toast',
    inject: () => ({}),
  }, AnswerToastHost)), 'open-items: answer toast host')
}
