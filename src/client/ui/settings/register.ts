/**
 * Settings registration entry point (WP-C).
 *
 * The composition root (`src/client/index.ts`) calls this one function; the
 * shared controller, the `settings.section` registration and the freshness
 * listener are created and owned here. The stylesheet is part of the module's
 * single client stylesheet (`styles.ts`, `SETTINGS_STYLES`), already installed
 * by the composition root.
 *
 * No request happens at registration: the controller stays `idle` until the
 * page mounts and calls `ensure()`. A reconnect re-reads Host truth only when the
 * page has already loaded, so an untouched Settings page stays request-free.
 *
 * @module dsh-open-items/client/ui/settings/register
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

import { LOCALE_NAMESPACE } from '../../locales'
import { createSettingsController, type SettingsController } from './controller'
import { SettingsPage } from './SettingsPage'
import type { SettingsTransport } from '../../data/transport'
import './slot-contracts'

/** Registration id of the settings page (its nav key). */
export const SETTINGS_SECTION_ID = 'open-items'

/** Order of the page in the Settings nav: after shipped sections (0-30). */
export const SETTINGS_SECTION_ORDER = 40

/** Injection points for tests. */
export interface SettingsSurfaceDeps {
  /** Settings face of the route transport (tests inject a fake). */
  readonly transport?: SettingsTransport
}

/**
 * Register the Open Items settings surface.
 * @param ctx - client root context owning every contribution.
 * @param deps - transport override (tests); the default is unused in production
 *   because the composition root passes its one shared route transport.
 */
export function registerSettingsSurface(ctx: Context, deps: SettingsSurfaceDeps): void {
  const transport = deps.transport
  if (transport === undefined) {
    throw new Error('open-items settings surface needs the shared route transport')
  }
  const controller: SettingsController = createSettingsController({ transport })
  ctx.effect(() => () => { controller.dispose() }, 'open-items: settings controller')

  // Nav label is read at render time, so it follows the active locale without
  // re-registering (SlotLabel thunk contract).
  const translate = ctx.locale.bind(LOCALE_NAMESPACE) as unknown as (key: string, params?: Record<string, string | number>) => string

  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SETTINGS_SECTION_ID,
    order: SETTINGS_SECTION_ORDER,
    label: () => translate('settings.nav.label'),
    locale: LOCALE_NAMESPACE,
    inject: () => ({ controller }),
  }, SettingsPage)), 'open-items: settings section')

  // A reconnect re-reads the Host truth a loaded page already showed; an
  // untouched page stays unloaded (no request at boot).
  ctx.effect(() => ctx.on('connection/reset', () => {
    const snapshot = controller.getSnapshot()
    if (snapshot.status !== 'idle') controller.refresh()
  }), 'open-items: settings freshness')
}
