/**
 * The Resolved tab (UI.md §4.6-§4.7): the register as a read-only journal.
 *
 * Layout, top to bottom: the honest header line, the filter bar, the in-flight
 * band (answers sent but not acknowledged), day groups with per-day counts, and
 * the read-only detail under the selected row (the page's wide detail column
 * renders the same component; CSS decides which is visible).
 *
 * The tab applies the *current* filter to everything it shows and to the export
 * dialog's summary. Filters live in the register store so navigating away and
 * back keeps them, as the page spec requires.
 *
 * Filters are shipped `Menu` selectors (S-02): the trigger names the current
 * value and the primitive owns Escape / outside-click / viewport fit. The tab
 * re-reads on window focus, on a visibility return and on a carrier reconnect
 * while it is mounted (ACCEPTANCE §5.2), and after every write.
 *
 * @module dsh-open-items/client/ui/register/register-tab
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AnimatedRows,
  Button,
  IconChevronDownOutlineRegular,
  IconSearchOutlineRegular,
  Input,
  Menu,
  Pill,
  Tooltip,
  type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives'

import type { OpenItemRecord } from '../../../shared/schema'
import type { ExportOptions, ExportFormat } from '../../../shared/export'
import type { RegisterDownloadResult, RegisterState, RegisterStore } from '../../data/register-store'
import { pageGroups } from '../../data/register-store'
import {
  REGISTER_KINDS,
  REGISTER_OUTCOMES,
  REGISTER_PERIODS,
  REGISTER_SOURCES,
  filterLabelOf,
  isFiltered,
  outcomeKey,
  periodKey,
  sourceKey,
} from '../../derive/register-view'
import { relativeLabel, type PageTranslate, type SessionTitleResolver } from '../../format'
import { ExportDialog } from './export-dialog'
import { RegisterRow } from './register-row'
import { ResolvedDetail, type ResolvedDetailProps } from './resolved-detail'
import { acknowledgementPhraseOf } from './present'

/** Props of the Resolved tab. */
export interface RegisterTabProps {
  readonly t: PageTranslate
  readonly now: number
  /** Register store; absent when the page was composed without the seam. */
  readonly store?: RegisterStore
  readonly state?: RegisterState
  /** Inbox refresh after a reopen (the item is back in Needs you). */
  readonly onReopened?: () => void
  readonly openSession?: (sessionId: string) => void
  /** Live catalogue lookup for a Session label the records' snapshots lack. */
  readonly sessionTitle?: SessionTitleResolver
  /** Render the read-only detail inline (medium layout); wide/narrow use the page column. */
  readonly inlineDetail?: boolean
  /** Carrier reconnect seam; the page supplies its `connection/reset` subscription. */
  readonly onConnectionReset?: (listener: () => void) => () => void
}

/** Search debounce: typing must not fire one route read per keystroke. */
const SEARCH_DEBOUNCE_MS = 250

/** Kind label key per kind (typed translator keys). */
const KIND_LABEL = {
  decision: 'kind.decision',
  approval: 'kind.approval',
  question: 'kind.question',
  'plan-review': 'kind.plan-review',
  blocker: 'kind.blocker',
  risk: 'kind.risk',
  'follow-up': 'kind.follow-up',
  task: 'kind.task',
} as const

/**
 * One filter selector as a shipped `Menu` (S-02): the trigger names the current
 * value, the primitive owns Escape / outside-click / fit, and the selection maps
 * straight to the store filter.
 * @param props - localized label, current value, options and the change handler.
 * @returns the anchored menu.
 */
function FilterMenu<Value extends string>(props: {
  readonly label: string
  readonly value: Value
  readonly options: readonly { readonly value: Value; readonly label: string }[]
  readonly onSelect: (value: Value) => void
}): ReactNode {
  const { label, value, options, onSelect } = props
  const [open, setOpen] = useState(false)
  const current = options.find(option => option.value === value)
  const items: readonly MenuItem[] = options.map(option => ({ id: option.value, label: option.label }))
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      selectedId={value}
      items={items}
      onSelect={(id) => {
        setOpen(false)
        onSelect(id as Value)
      }}
      anchor={(
        <Button
          size="sm"
          variant="outline"
          className="dsh-oi-controlButton"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => { setOpen(previous => !previous) }}
        >
          <span className="dsh-oi-controlLabel">{label}</span>
          <span className="dsh-oi-controlValue">{current?.label ?? value}</span>
          <IconChevronDownOutlineRegular size={12} />
        </Button>
      )}
    />
  )
}

/** The header line: counts and the completeness claim, never silent. */
function summaryOf(t: PageTranslate, state: RegisterState): string {
  const parts = [t('register.summary', {
    resolved: state.total,
    inFlight: state.inFlight.length,
    archived: state.archived,
  })]
  parts.push(state.earlierRecordsPruned ? t('register.pruned.flagged') : t('register.pruned.none'))
  const compacted = state.items.filter(record => record.retention.class === 'archived').length
  if (compacted > 0) parts.push(t('register.compacted', { count: compacted }))
  return parts.join(' · ')
}

/**
 * Render the Resolved tab.
 * @param props - copy, clock, store and the page seams.
 * @returns the tab element.
 */
export function RegisterTab(props: RegisterTabProps): ReactNode {
  const { t, now, store, state } = props
  const showInlineDetail = props.inlineDetail !== false
  const [searchDraft, setSearchDraft] = useState(state?.filters.search ?? '')
  const [exportOpen, setExportOpen] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportResult, setExportResult] = useState<RegisterDownloadResult | undefined>(undefined)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // First open of the tab loads the register; later opens reuse the store.
  useEffect(() => {
    if (store === undefined) return
    if (store.getSnapshot().status === 'idle') void store.actions.refresh()
  }, [store])

  // Freshness (ACCEPTANCE §5.2): the register is a live journal, so returning to
  // the window or tab, and a carrier reconnect, re-read the current filter while
  // this tab is mounted. The page supplies the reconnect seam; absent it, the
  // two DOM events still refresh.
  useEffect(() => {
    if (store === undefined) return
    const reread = (): void => { void store.actions.refresh() }
    const onVisibility = (): void => {
      if (!document.hidden) reread()
    }
    window.addEventListener('focus', reread)
    document.addEventListener('visibilitychange', onVisibility)
    const disposeReset = props.onConnectionReset?.(reread)
    return () => {
      window.removeEventListener('focus', reread)
      document.removeEventListener('visibilitychange', onVisibility)
      disposeReset?.()
    }
  }, [store, props.onConnectionReset])

  useEffect(() => () => {
    if (debounce.current !== undefined) clearTimeout(debounce.current)
  }, [])

  // Keep the draft in sync when the filter is cleared from elsewhere.
  useEffect(() => {
    setSearchDraft(state?.filters.search ?? '')
  }, [state?.filters.search])

  if (store === undefined || state === undefined) {
    return (
      <div className="dsh-oi-state" role="status">
        <p className="dsh-oi-stateTitle">{t('register.error.unavailable.title')}</p>
        <p className="dsh-oi-stateBody">{t('register.error.unavailable.body')}</p>
      </div>
    )
  }

  const filters = state.filters
  const parsed = pageGroups(state.items, now)
  const sessionTitle = [...state.items, ...state.inFlight]
    .find(record => record.source.sessionId === filters.sessionId)?.source.sessionTitle
    ?? (filters.sessionId === undefined ? undefined : props.sessionTitle?.(filters.sessionId))
  const label = filterLabelOf(t, filters, sessionTitle)
  const selected = [...state.items, ...state.inFlight].find(record => record.id === state.selectedId)
  const unavailable = state.error === 'register-unavailable'
  const loading = state.status === 'loading' && state.items.length === 0 && state.inFlight.length === 0
  const hardError = state.status === 'error' && state.items.length === 0 && !unavailable
  const empty = state.items.length === 0 && state.inFlight.length === 0
  const filtered = isFiltered(filters) || filters.sessionId !== undefined

  const commitSearch = (value: string): void => {
    setSearchDraft(value)
    if (debounce.current !== undefined) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => {
      store.actions.setFilters({ search: value })
    }, SEARCH_DEBOUNCE_MS)
  }
  const applySearchNow = (): void => {
    if (debounce.current !== undefined) clearTimeout(debounce.current)
    store.actions.setFilters({ search: searchDraft })
  }

  const openExport = (): void => {
    setExportResult(undefined)
    setExportOpen(true)
  }

  const submitExport = async (selection: {
    readonly format: ExportFormat
    readonly includeExcerpts: boolean
    readonly includeArchive: boolean
  }): Promise<void> => {
    const current = store.getSnapshot()
    const options: ExportOptions = {
      format: selection.format,
      includeArchive: selection.includeArchive,
      includeExcerpts: selection.includeExcerpts,
      filterLabel: filterLabelOf(props.t, current.filters, sessionTitle),
      generatedAt: store.now(),
      pluginVersion: store.pluginVersion,
      schemaVersion: store.schemaVersion,
      earlierRecordsPruned: current.earlierRecordsPruned,
    }
    setExportBusy(true)
    const result = await store.actions.downloadArchive(options)
    setExportBusy(false)
    setExportResult(result)
  }

  const reopen = async (itemId: string): Promise<void> => {
    await store.actions.reopen(itemId)
    if (store.getSnapshot().notice?.tone === 'ok') props.onReopened?.()
  }

  const exportCount = filters.outcome === 'all' ? state.total : state.items.length

  /** Shared props of the inline detail (the page's wide column builds its own). */
  const detailProps = {
    t,
    now,
    onBack: () => store.actions.select(null),
    onReopen: (itemId: string) => { void reopen(itemId) },
    onSessionFilter: (sessionId: string) => store.actions.setFilters({ sessionId }),
    ...(props.openSession === undefined ? {} : { openSession: props.openSession }),
    ...(props.sessionTitle === undefined ? {} : { sessionTitle: props.sessionTitle }),
    ...(state.notice === undefined ? {} : { notice: state.notice }),
    onDismissNotice: () => store.actions.dismissNotice(),
    onDelete: (itemId: string, expectedVersion: number) => store.actions.delete(itemId, expectedVersion),
  }

  return (
    <div className="dsh-oi-register">
      <p className="dsh-oi-registerSummary" role="status">{summaryOf(t, state)}</p>

      <div className="dsh-oi-registerBar" role="group" aria-label={t('register.filters')}>
        <FilterMenu
          label={t('register.filter.period')}
          value={filters.period}
          options={REGISTER_PERIODS.map(period => ({ value: period, label: t(periodKey(period)) }))}
          onSelect={value => { store.actions.setFilters({ period: value }) }}
        />
        <FilterMenu
          label={t('register.filter.source')}
          value={filters.source}
          options={REGISTER_SOURCES.map(source => ({ value: source, label: t(sourceKey(source)) }))}
          onSelect={value => { store.actions.setFilters({ source: value }) }}
        />
        <FilterMenu
          label={t('register.filter.kind')}
          value={filters.kind}
          options={[
            { value: 'all' as const, label: t('register.filter.kindAll') },
            ...REGISTER_KINDS.map(kind => ({ value: kind, label: t(KIND_LABEL[kind]) })),
          ]}
          onSelect={value => { store.actions.setFilters({ kind: value }) }}
        />
        <FilterMenu
          label={t('register.filter.outcome')}
          value={filters.outcome}
          options={REGISTER_OUTCOMES.map(outcome => ({ value: outcome, label: t(outcomeKey(outcome)) }))}
          onSelect={value => { store.actions.setFilters({ outcome: value }) }}
        />
        <Input
          className="dsh-oi-search"
          icon={<IconSearchOutlineRegular size={14} />}
          aria-label={t('register.filter.search')}
          placeholder={t('register.filter.searchPlaceholder')}
          value={searchDraft}
          onChange={event => commitSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') applySearchNow()
          }}
          onBlur={applySearchNow}
        />
        {filters.sessionId !== undefined && (
          <Pill
            active
            className="dsh-oi-registerChip"
            aria-label={`${t('register.filter.sessionValue', { title: sessionTitle ?? filters.sessionId })} ×`}
            onClick={() => { store.actions.setFilters({ sessionId: undefined }) }}
          >
            {t('register.filter.sessionValue', { title: sessionTitle ?? filters.sessionId })} ×
          </Pill>
        )}
        {filtered && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSearchDraft('')
              store.actions.clearFilters()
            }}
          >
            {t('register.filter.clear')}
          </Button>
        )}
        <Tooltip label={t('export.open')} side="bottom">
          <Button
            size="sm"
            variant="outline"
            onClick={openExport}
            disabled={state.items.length === 0 || state.status === 'loading'}
          >
            {t('export.open')}
          </Button>
        </Tooltip>
      </div>

      {state.offline && state.items.length > 0 && (
        <div className="dsh-oi-banner dsh-oi-banner--offline" role="status">
          <span>{t('banner.offline', { time: relativeLabel(t, state.lastReadAt, now) })}</span>
          <Button size="sm" variant="outline" onClick={() => { void store.actions.refresh() }}>{t('banner.offline.retry')}</Button>
        </div>
      )}

      {unavailable && (
        <div className="dsh-oi-state" role="status">
          <p className="dsh-oi-stateTitle">{t('register.error.unavailable.title')}</p>
          <p className="dsh-oi-stateBody">{t('register.error.unavailable.body')}</p>
        </div>
      )}
      {hardError && (
        <div className="dsh-oi-state" role="alert">
          <p className="dsh-oi-stateTitle">{t('register.error.title')}</p>
          <p className="dsh-oi-stateBody">{state.error ?? ''}</p>
          <Button size="sm" variant="outline" onClick={() => { void store.actions.refresh() }}>{t('register.retry')}</Button>
        </div>
      )}
      {loading && (
        <div className="dsh-oi-skeleton" role="status" aria-label={t('register.loading')}>
          <span className="dsh-oi-visually-hidden">{t('register.loading')}</span>
          <div className="dsh-oi-skeletonRow" />
          <div className="dsh-oi-skeletonRow" />
          <div className="dsh-oi-skeletonRow" />
        </div>
      )}

      {!unavailable && !hardError && !loading && (
        <>
          {state.inFlight.length > 0 && (
            <section className="dsh-oi-regBand" aria-label={t('register.band.title', { count: state.inFlight.length })}>
              <h2 className="dsh-oi-regBandTitle">
                {t('register.band.title', { count: state.inFlight.length })}
                <span className="dsh-oi-regBandNote"> · {t('register.band.note')}</span>
              </h2>
              <AnimatedRows
                className="dsh-oi-regRows"
                role="list"
                label={t('register.band.title', { count: state.inFlight.length })}
                rowKeys={state.inFlight.map(record => record.id)}
                ready={state.status === 'ready'}
                resetKey={`${filters.period}:${filters.source}:${filters.kind}:${filters.outcome}:${filters.search}:${filters.sessionId ?? ''}`}
              >
                {state.inFlight.map(record => (
                  <RegisterRow
                    key={record.id}
                    record={record}
                    t={t}
                    now={now}
                    selected={record.id === state.selectedId}
                    onSelect={itemId => store.actions.select(itemId)}
                    onSessionFilter={sessionId => store.actions.setFilters({ sessionId })}
                    {...(props.openSession === undefined ? {} : { openSession: props.openSession })}
                    {...(props.sessionTitle === undefined ? {} : { sessionTitle: props.sessionTitle })}
                    {...(showInlineDetail && record.id === state.selectedId
                      ? { detail: <DetailFor record={record} busy={state.busyId === record.id} {...detailProps} /> }
                      : {})}
                  />
                ))}
              </AnimatedRows>
            </section>
          )}

          {empty && !filtered && (
            <div className="dsh-oi-state">
              <p className="dsh-oi-stateTitle">{t('register.empty.title')}</p>
              <p className="dsh-oi-stateBody">{t('register.empty.body')}</p>
            </div>
          )}
          {empty && filtered && (
            <div className="dsh-oi-state">
              <p className="dsh-oi-stateTitle">{t('register.empty.filtered.title')}</p>
              <p className="dsh-oi-stateBody">{t('register.empty.filtered.body')}</p>
            </div>
          )}

          {parsed.map(({ group, heading }) => (
            <section className="dsh-oi-regDay" key={group.dayKey} data-day={group.dayKey}>
              <h2 className="dsh-oi-regDayTitle">
                {heading === 'today'
                  ? t('register.day.today')
                  : heading === 'yesterday'
                    ? t('register.day.yesterday')
                    : new Date(group.start).toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                <span className="dsh-oi-regDayCount">
                  {' · '}
                  {t(group.items.length === 1 ? 'register.day.count.one' : 'register.day.count.other', { count: group.items.length })}
                </span>
              </h2>
              <AnimatedRows
                className="dsh-oi-regRows"
                role="list"
                label={t('register.day.count.other', { count: group.items.length })}
                rowKeys={group.items.map(record => record.id)}
                ready={state.status === 'ready'}
                resetKey={`${filters.period}:${filters.source}:${filters.kind}:${filters.outcome}:${filters.search}:${filters.sessionId ?? ''}`}
              >
                {group.items.map(record => (
                  <RegisterRow
                    key={record.id}
                    record={record}
                    t={t}
                    now={now}
                    selected={record.id === state.selectedId}
                    onSelect={itemId => store.actions.select(itemId)}
                    onSessionFilter={sessionId => store.actions.setFilters({ sessionId })}
                    {...(props.openSession === undefined ? {} : { openSession: props.openSession })}
                    {...(props.sessionTitle === undefined ? {} : { sessionTitle: props.sessionTitle })}
                    {...(showInlineDetail && record.id === state.selectedId
                      ? { detail: <DetailFor record={record} busy={state.busyId === record.id} {...detailProps} /> }
                      : {})}
                  />
                ))}
              </AnimatedRows>
            </section>
          ))}

          {state.nextCursor !== undefined && (
            <div className="dsh-oi-regMore">
              <Button
                size="sm"
                variant="outline"
                disabled={state.loadingMore}
                onClick={() => { void store.actions.loadMore() }}
              >
                {t('register.loadMore')}
              </Button>
            </div>
          )}
        </>
      )}

      {exportOpen && (
        <ExportDialog
          t={t}
          recordCount={exportCount}
          filterLabel={label}
          inFlight={state.inFlight.length}
          earlierRecordsPruned={state.earlierRecordsPruned}
          defaultIncludeArchive={filters.period === 'archive'}
          busy={exportBusy}
          {...(exportResult === undefined ? {} : { result: exportResult })}
          onCancel={() => setExportOpen(false)}
          onSubmit={selection => { void submitExport(selection) }}
        />
      )}
    </div>
  )
}

/** The inline detail of one selected row (medium and narrow layouts). */
function DetailFor({ record, busy, ...rest }: Omit<ResolvedDetailProps, 'record' | 'busy'> & {
  readonly record: OpenItemRecord
  readonly busy: boolean
}): ReactNode {
  return (
    <div className="dsh-oi-inlineDetail">
      <ResolvedDetail record={record} busy={busy} {...rest} />
    </div>
  )
}

/** Re-exported for the page: acknowledgement copy of one row (used by list tests). */
export { acknowledgementPhraseOf }
