/**
 * Settings → Open Items: the capture-consent page.
 *
 * Three decisions the user owns, all opt-in choices rather than deployment
 * config: whether the agent is nudged to declare decisions as open items
 * (default off, user decision D4), whether the strict end-of-turn prose gate may
 * surface inferred decisions as candidates (default on, D1/D2), and whether a
 * deployment-configured model may confirm or refine those candidates (default
 * off, D4 spirit — nothing leaves the machine while it is off). All three write
 * immediately with compare-and-set; there is no Save button because every
 * accepted change is already durable, and a rejected one leaves the controls
 * showing Host truth.
 *
 * The page reads nothing until it mounts (`ensure` in an effect): a profile that
 * never opens Settings never writes or reads a settings record.
 *
 * @module dsh-open-items/client/ui/settings/SettingsPage
 */
import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

import type { OpenItemsNamespace } from '../../locales'
import type { SettingsController } from './controller'
import './slot-contracts'

/** What the composition root injects into the page. */
export interface SettingsPageInjected {
  /** The one shared settings controller. */
  readonly controller: SettingsController
}

/** Props the renderer assembles for this registration. */
export type SettingsPageProps = PropsRuntime<'settings.section'> & PropsLocale<OpenItemsNamespace> & InjectFace<SettingsPageInjected>

/**
 * Render the capture settings page.
 * @param props - the injected controller and localized copy.
 * @returns the settings section.
 */
export function SettingsPage({ controller, t }: SettingsPageProps): ReactNode {
  const state = useSyncExternalStore(controller.source.subscribe, controller.getSnapshot)
  useEffect(() => {
    controller.ensure()
  }, [controller])

  const settings = state.settings
  const loading = state.status === 'idle' || state.status === 'loading'

  return (
    <section className="dsh-oi-settings" aria-label={t('settings.page.title')}>
      <h2 className="dsh-oi-settings__title">{t('settings.page.title')}</h2>
      <p className="dsh-oi-settings__intro">{t('settings.page.intro')}</p>

      {loading && (
        <p className="dsh-oi-settings__status" role="status">{t('settings.loading')}</p>
      )}

      {state.status === 'error' && (
        <p className="dsh-oi-settings__status dsh-oi-settings__status--error" role="status">
          <span>{t('settings.loadFailed')}</span>
          <Button size="sm" variant="outline" onClick={() => { controller.refresh() }}>
            {t('settings.retry')}
          </Button>
        </p>
      )}

      {state.saving && (
        <p className="dsh-oi-settings__status" role="status" aria-busy="true">
          {t('settings.saving')}
        </p>
      )}
      {state.saveFailed && (
        <p className="dsh-oi-settings__status dsh-oi-settings__status--error" role="status">{t('settings.saveFailed')}</p>
      )}
      {state.conflicted && (
        <p className="dsh-oi-settings__status dsh-oi-settings__status--warn" role="status">{t('settings.conflict')}</p>
      )}
      {settings !== undefined && (
        <div className="dsh-oi-settings__group">
          <div className="dsh-oi-settings__row">
            <div className="dsh-oi-settings__rowText">
              <div className="dsh-oi-settings__rowTitle">{t('settings.modelNudge.title')}</div>
              <div className="dsh-oi-settings__rowDesc">{t('settings.modelNudge.desc')}</div>
            </div>
            <div className="dsh-oi-settings__control">
              <Switch
                checked={settings.modelNudge}
                label={t('settings.modelNudge.title')}
                disabled={state.saving}
                onChange={(next) => { void controller.update({ modelNudge: next }) }}
              />
            </div>
          </div>

          <div className="dsh-oi-settings__row">
            <div className="dsh-oi-settings__rowText">
              <div className="dsh-oi-settings__rowTitle">{t('settings.proseCandidates.title')}</div>
              <div className="dsh-oi-settings__rowDesc">{t('settings.proseCandidates.desc')}</div>
            </div>
            <div className="dsh-oi-settings__control">
              <Switch
                checked={settings.proseCandidates}
                label={t('settings.proseCandidates.title')}
                disabled={state.saving}
                onChange={(next) => { void controller.update({ proseCandidates: next }) }}
              />
            </div>
          </div>

          <div className="dsh-oi-settings__row">
            <div className="dsh-oi-settings__rowText">
              <div className="dsh-oi-settings__rowTitle">{t('settings.llmExtraction.title')}</div>
              <div className="dsh-oi-settings__rowDesc">{t('settings.llmExtraction.desc')}</div>
            </div>
            <div className="dsh-oi-settings__control">
              <Switch
                checked={settings.llmExtraction}
                label={t('settings.llmExtraction.title')}
                disabled={state.saving}
                onChange={(next) => { void controller.update({ llmExtraction: next }) }}
              />
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
