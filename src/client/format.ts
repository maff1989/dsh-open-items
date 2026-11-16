/**
 * Pure display formatting for the inbox: relative times and counted copy.
 *
 * Kept separate from React so every derivation stays testable without a DOM.
 * The clock is always injected (`now`) — components pass one 60 s tick, so two
 * labels rendered in the same pass never disagree.
 *
 * @module dsh-open-items/client/format
 */
import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import type { OpenItemRecord } from '../shared/schema'
import type { OpenItemsKey, OpenItemsNamespace } from './locales'

/** Translate function of this plugin's dictionary. */
export type PageTranslate = TranslateNS<OpenItemsNamespace>

/**
 * Resolve one Session's display title from the browser's Session catalogue.
 *
 * Optional plumbing: a composition without the catalogue (or with a Session the
 * catalogue has not loaded) returns `undefined`, and the surface falls back to
 * the item's own snapshot or the honest untitled copy.
 */
export type SessionTitleResolver = (sessionId: string) => string | undefined

/** Counted dictionary key pair. */
export interface PluralKeys {
  readonly one: OpenItemsKey
  readonly other: OpenItemsKey
}

/** Pick the `.one` / `.other` key for a count. */
function pluralOf(keys: PluralKeys, count: number): OpenItemsKey {
  return count === 1 ? keys.one : keys.other
}

/**
 * Translate a counted sentence.
 * @param t - namespace-bound translator.
 * @param keys - singular/plural key pair.
 * @param count - the number that selects the form and fills `{count}`.
 * @returns localized copy.
 */
export function tCount(t: PageTranslate, keys: PluralKeys, count: number): string {
  return t(pluralOf(keys, count), { count })
}

/** Copy key pairs used across surfaces. */
export const COUNT_KEYS = {
  items: { one: 'group.items.one', other: 'group.items.other' },
  sessions: { one: 'group.sessions.one', other: 'group.sessions.other' },
  navWaiting: { one: 'nav.waiting.one', other: 'nav.waiting.other' },
  needsYou: { one: 'page.count.needsYou.one', other: 'page.count.needsYou.other' },
  candidates: { one: 'page.count.candidates.one', other: 'page.count.candidates.other' },
} satisfies Record<string, PluralKeys>

/**
 * Compact relative time for an item's waiting label.
 * @param t - namespace-bound translator.
 * @param at - epoch milliseconds of the dated moment.
 * @param now - current epoch milliseconds.
 * @returns "just now", "5m ago", "3h ago", …
 */
export function relativeLabel(t: PageTranslate, at: number, now: number): string {
  if (!Number.isFinite(at) || at <= 0) return t('time.now')
  const bucket = relativeTime(at, now)
  switch (bucket.unit) {
    case 'now':
      return t('time.now')
    case 'minutes':
      return t('time.minutes', { count: bucket.n })
    case 'hours':
      return t('time.hours', { count: bucket.n })
    case 'days':
      return t('time.days', { count: bucket.n })
    case 'months':
      return t('time.months', { count: bucket.n })
    case 'years':
      return t('time.years', { count: bucket.n })
  }
}

/**
 * Absolute timestamp for a tooltip, using the reader's locale.
 * @param at - epoch milliseconds.
 * @returns formatted date and time, or an empty string for an absent value.
 */
export function absoluteLabel(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at) || at <= 0) return ''
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
}

/**
 * The label for the Session an item belongs to: the item's own snapshot title,
 * then the live catalogue, then the honest "(untitled session)" fallback.
 *
 * A missing title proves nothing about the Session — authored raises never
 * stamp one, and an untitled Session is just untitled — so this helper never
 * claims the Session was deleted (DESIGN §6.4 honesty rules).
 * @param t - namespace-bound translator.
 * @param item - record whose Session is being labelled.
 * @param resolve - optional catalogue lookup, read per call.
 * @returns the label to render (never empty).
 */
export function sessionLabelOf(
  t: PageTranslate,
  item: Pick<OpenItemRecord, 'source'>,
  resolve?: SessionTitleResolver,
): string {
  const own = item.source.sessionTitle
  if (own !== undefined && own.trim() !== '') return own
  const resolved = resolve?.(item.source.sessionId)
  if (resolved !== undefined && resolved.trim() !== '') return resolved
  return t('detail.untitledSession')
}

/** Translation function used by row/group copy helpers. */
export type Translate = (key: OpenItemsKey, params?: Record<string, string | number>) => string
