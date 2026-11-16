/**
 * The register's pure rules: filter → query mapping, the client-side mirror of
 * the Host's register semantics, ordering, day grouping, the in-flight band,
 * source indicators, acknowledgement honesty, reopen eligibility and the
 * header/export facts.
 *
 * No DOM and no transport: these functions are what the components render, so
 * testing them is testing the behaviour; the component suites then only check
 * that the words reach the DOM.
 */
import { describe, expect, it } from 'vitest'

import {
  INITIAL_REGISTER_FILTERS,
  acknowledgementOf,
  archivedCountQueryOf,
  dayHeadingOf,
  dayKeyOf,
  decisionOf,
  detectorCodeOf,
  detectorFamilyOf,
  exportSummaryOf,
  filterLabelOf,
  firstLineOf,
  groupRegisterByDay,
  inFlightOf,
  inFlightQueryOf,
  isFiltered,
  isRegisterRecord,
  matchesOutcome,
  matchesRegisterFilters,
  outcomeKey,
  periodStart,
  registerHeaderFacts,
  registerQueryOf,
  registerTimestampOf,
  reopenEligibilityOf,
  resolutionKindOf,
  selectRegisterItems,
  sortRegisterItems,
  sourceIndicatorOf,
  sourceKey,
  periodKey,
  type RegisterFilters,
} from '../../src/client/derive/register-view'
import type { OpenItemRecord } from '../../src/shared/schema'
import { t } from './fixtures'
import {
  NOW,
  at,
  makeAnswered,
  makeArchived,
  makeDetected,
  makeDismissed,
  makeInFlight,
  makeRecent,
  makeSuperseded,
  nonRegisterFixtures,
  registerFixtures,
} from './register-fixtures'

/** Filters with overrides. */
function filters(patch: Partial<RegisterFilters> = {}): RegisterFilters {
  return { ...INITIAL_REGISTER_FILTERS, ...patch }
}

describe('period windows and the Host query', () => {
  it('starts "today" at local midnight and the rolling windows at exact offsets', () => {
    expect(periodStart('today', NOW)).toBe(new Date(2026, 10, 13, 0, 0, 0).getTime())
    expect(periodStart('7d', NOW)).toBe(NOW - 7 * 86_400_000)
    expect(periodStart('30d', NOW)).toBe(NOW - 30 * 86_400_000)
    expect(periodStart('all', NOW)).toBeUndefined()
    expect(periodStart('archive', NOW)).toBeUndefined()
  })

  it('maps the period to the Host status: active register vs archive', () => {
    expect(registerQueryOf(filters({ period: 'today' }), NOW)).toMatchObject({ status: 'resolved' })
    expect(registerQueryOf(filters({ period: 'all' }), NOW).since).toBeUndefined()
    expect(registerQueryOf(filters({ period: 'archive' }), NOW)).toMatchObject({ status: 'archived' })
  })

  it('carries source, kind, search, session scope and paging into the query', () => {
    const query = registerQueryOf(filters({
      period: '7d',
      source: 'detector',
      kind: 'approval',
      search: ' registry ',
      sessionId: 'session-9',
    }), NOW, { limit: 50, cursor: 'cursor-1' })
    expect(query).toMatchObject({
      status: 'resolved',
      since: NOW - 7 * 86_400_000,
      sources: ['detector'],
      kinds: ['approval'],
      search: 'registry',
      scope: { sessionId: 'session-9' },
      limit: 50,
      cursor: 'cursor-1',
    })
  })

  it('omits filters that are set to all, and the archive period ignores the window', () => {
    const query = registerQueryOf(filters({ source: 'all', kind: 'all', search: '' }), NOW)
    expect(query).toEqual({ status: 'resolved', since: NOW - 30 * 86_400_000 })
    expect(Object.hasOwn(registerQueryOf(filters({ period: 'archive' }), NOW), 'since')).toBe(false)
  })

  it('asks the Host for the band separately (one status per register page)', () => {
    expect(inFlightQueryOf(filters({ period: 'today' }))).toMatchObject({ status: 'awaiting' })
    expect(Object.hasOwn(inFlightQueryOf(filters({ period: 'today' })), 'since')).toBe(false)
    expect(archivedCountQueryOf(filters()).status).toBe('archived')
    expect(archivedCountQueryOf(filters()).limit).toBe(1)
  })
})

describe('client-side filter mirror', () => {
  it('keeps the active register and the in-flight answers, drops archives outside their period', () => {
    const all = registerFixtures()
    const selected = selectRegisterItems(all, filters({ period: 'all' }), NOW).map(item => item.id)
    expect(selected).toContain('reg-answered')
    expect(selected).toContain('reg-inflight')
    expect(selected).toContain('reg-recent')
    expect(selected).not.toContain('reg-archived')
  })

  it('narrows by period, source, kind, outcome, search and session', () => {
    const all = registerFixtures()
    const ids = (patch: Partial<RegisterFilters>): string[] =>
      selectRegisterItems(all, filters(patch), NOW).map(item => item.id)

    expect(ids({ period: 'today' })).toEqual(['reg-inflight', 'reg-answered', 'reg-dismissed'])
    expect(ids({ source: 'detector' })).not.toContain('reg-answered')
    expect(ids({ source: 'detector' })).toContain('reg-detected')
    expect(ids({ kind: 'approval' })).toEqual(['reg-answered'])
    expect(ids({ outcome: 'dismissed' })).toEqual(['reg-dismissed'])
    expect(ids({ outcome: 'superseded' })).toEqual(['reg-superseded'])
    expect(ids({ outcome: 'acknowledged' })).toEqual(['reg-answered'])
    expect(ids({ outcome: 'no-acknowledgement' })).toEqual(['reg-recent'])
    expect(ids({ search: 'palette' })).toEqual(['reg-superseded'])
    // The decision text is searchable, not only the title.
    expect(ids({ search: 'before friday' })).toEqual(['reg-inflight'])
    expect(ids({ search: 'corporate registry only' })).toEqual(['reg-answered'])
    expect(ids({ sessionId: 'session-1' }).length).toBeGreaterThan(0)
    expect(ids({ sessionId: 'other-session' })).toEqual([])
  })

  it('treats the archive period as the archive only', () => {
    const ids = selectRegisterItems(registerFixtures(), filters({ period: 'archive' }), NOW).map(item => item.id)
    expect(ids).toEqual(['reg-archived'])
  })

  it('ignores deleted records and anything that never settled', () => {
    const all = [...registerFixtures(), ...nonRegisterFixtures()]
    const ids = selectRegisterItems(all, filters({ period: 'all' }), NOW).map(item => item.id)
    expect(ids).not.toContain('reg-deleted')
    expect(ids).not.toContain('reg-open')
    expect(ids).not.toContain('reg-snoozed')
    expect(ids).toContain('reg-answered')
  })

  it('mirrors the Host outcome buckets', () => {
    expect(matchesOutcome(makeAnswered(), 'acknowledged')).toBe(true)
    expect(matchesOutcome(makeAnswered(), 'no-acknowledgement')).toBe(false)
    expect(matchesOutcome(makeRecent(), 'no-acknowledgement')).toBe(true)
    expect(matchesOutcome(makeDismissed(), 'dismissed')).toBe(true)
    expect(matchesOutcome(makeSuperseded(), 'superseded')).toBe(true)
    expect(matchesOutcome(makeDetected(), 'all')).toBe(true)
    // A detector close is neither an acknowledged answer nor a dismissal.
    expect(matchesOutcome(makeDetected(), 'acknowledged')).toBe(false)
    expect(matchesOutcome(makeDetected(), 'dismissed')).toBe(false)
  })

  it('knows when filters differ from the initial state', () => {
    expect(isFiltered(INITIAL_REGISTER_FILTERS)).toBe(false)
    expect(isFiltered(filters({ search: 'x' }))).toBe(true)
    expect(isFiltered(filters({ sessionId: 's' }))).toBe(true)
  })
})

describe('ordering and day grouping', () => {
  it('orders by resolvedAt (awaiting: updatedAt) descending, id ascending on ties', () => {
    const a = makeAnswered({ id: 'b', resolvedAt: at(0, 10, 0) })
    const b = makeAnswered({ id: 'a', resolvedAt: at(0, 10, 0) })
    const c = makeAnswered({ id: 'c', resolvedAt: at(0, 11, 0) })
    const sorted = sortRegisterItems([a, b, c]).map(item => item.id)
    expect(sorted).toEqual(['c', 'a', 'b'])
  })

  it('uses resolvedAt first and updatedAt for in-flight rows', () => {
    expect(registerTimestampOf(makeAnswered())).toBe(makeAnswered().resolvedAt)
    expect(registerTimestampOf(makeInFlight())).toBe(makeInFlight().updatedAt)
  })

  it('groups by the reader calendar day, newest first, with per-day order kept', () => {
    const groups = groupRegisterByDay([
      makeAnswered(),
      makeDismissed(),
      makeSuperseded(),
      makeDetected(),
    ])
    expect(groups.map(group => group.dayKey)).toEqual([dayKeyOf(at(0, 12)), dayKeyOf(at(-1, 12)), dayKeyOf(at(-2, 12))])
    expect(groups[0]?.items.map(item => item.id)).toEqual(['reg-answered', 'reg-dismissed'])
    expect(groups[1]?.items.map(item => item.id)).toEqual(['reg-superseded'])
  })

  it('labels today and yesterday relative to now, everything else by date', () => {
    expect(dayHeadingOf(new Date(2026, 10, 13).getTime(), NOW)).toBe('today')
    expect(dayHeadingOf(new Date(2026, 10, 12).getTime(), NOW)).toBe('yesterday')
    expect(dayHeadingOf(new Date(2026, 10, 11).getTime(), NOW)).toBe('date')
  })
})

describe('in-flight band', () => {
  it('holds only answers awaiting acknowledgement, newest first', () => {
    const band = inFlightOf([makeInFlight(), makeAnswered(), makeDismissed()], filters({ period: 'all' }))
    expect(band.map(item => item.id)).toEqual(['reg-inflight'])
  })

  it('is independent of the period but hidden in the archive period', () => {
    expect(inFlightOf([makeInFlight()], filters({ period: 'today' }))).toHaveLength(1)
    expect(inFlightOf([makeInFlight()], filters({ period: '7d' }))).toHaveLength(1)
    expect(inFlightOf([makeInFlight()], filters({ period: 'archive' }))).toHaveLength(0)
  })

  it('still honours source, kind, search and session', () => {
    expect(inFlightOf([makeInFlight()], filters({ source: 'detector' }))).toHaveLength(0)
    expect(inFlightOf([makeInFlight()], filters({ kind: 'approval' }))).toHaveLength(0)
    expect(inFlightOf([makeInFlight()], filters({ search: 'friday' }))).toHaveLength(1)
    expect(inFlightOf([makeInFlight()], filters({ sessionId: 'other' }))).toHaveLength(0)
  })
})

describe('row facts', () => {
  it('classifies the two-channel source indicator', () => {
    expect(sourceIndicatorOf(makeAnswered())).toBe('answered')
    expect(sourceIndicatorOf(makeDismissed())).toBe('dismissed')
    expect(sourceIndicatorOf(makeDetected())).toBe('automatic')
    expect(sourceIndicatorOf(makeInFlight())).toBe('in-flight')
  })

  it('reads the decision verbatim', () => {
    expect(decisionOf(makeAnswered())).toEqual({ kind: 'approval', outcome: 'allow-once', note: 'corporate registry only' })
    expect(decisionOf(makeDismissed())).toEqual({ kind: 'dismiss', reason: 'not an item, docs follow-up' })
    expect(decisionOf(makeSuperseded())).toEqual({ kind: 'detector', code: 'session/new-turn' })
    expect(decisionOf(makeItemWithoutResolution())).toEqual({ kind: 'none' })
  })

  it('keeps the first line of a long decision for the row', () => {
    expect(firstLineOf('Yes, before Friday.\nThen verify.')).toBe('Yes, before Friday.')
    expect(firstLineOf('x'.repeat(300))).toHaveLength(201)
  })

  it('reports acknowledgement honestly: answers vs dismissals vs in-flight', () => {
    expect(acknowledgementOf(makeAnswered())).toEqual({ state: 'observed', evidence: 'call-retried', at: expect.any(Number) })
    expect(acknowledgementOf(makeRecent())).toEqual({ state: 'none' })
    expect(acknowledgementOf(makeInFlight())).toEqual({ state: 'pending' })
    expect(acknowledgementOf(makeDismissed())).toEqual({ state: 'not-applicable' })
    expect(acknowledgementOf(makeSuperseded())).toEqual({ state: 'not-applicable' })
  })

  it('names the detector family and keeps the raw code', () => {
    expect(detectorCodeOf(makeDetected())).toBe('goal/change:resumed')
    expect(detectorFamilyOf('goal/change:resumed')).toBe('goal')
    expect(detectorFamilyOf('approval/decided:unavailable')).toBe('approval')
    expect(detectorFamilyOf('team/task:completed')).toBe('task')
    expect(detectorFamilyOf('user-questions:continued')).toBe('question')
    expect(detectorFamilyOf('session/new-turn')).toBe('session')
    expect(detectorFamilyOf('something-else')).toBe('other')
    expect(detectorCodeOf(makeAnswered())).toBeUndefined()
  })

  it('mirrors the Host reopen guard', () => {
    expect(reopenEligibilityOf(makeRecent())).toEqual({ ok: true })
    expect(reopenEligibilityOf(makeDismissed())).toEqual({ ok: true })
    expect(reopenEligibilityOf(makeInFlight())).toEqual({ ok: true })
    // A permission already exercised cannot be un-exercised: the answered
    // approval fixture was acknowledged by the retried call, so Reopen is refused.
    expect(reopenEligibilityOf(makeAnswered())).toEqual({ ok: false, reason: 'approval-executed' })
  })

  it('tells register records from everything else', () => {
    expect(isRegisterRecord(makeAnswered())).toBe(true)
    expect(isRegisterRecord(makeInFlight())).toBe(true)
    expect(isRegisterRecord(makeItemWithoutResolution())).toBe(false)
    expect(resolutionKindOf(makeAnswered())).toBe('answered')
    expect(resolutionKindOf(makeDetected())).toBe('detected-closed')
  })
})

describe('header facts and export summary', () => {
  it('states counts and the completeness claim', () => {
    const facts = registerHeaderFacts(24, [makeInFlight()], 3, false)
    expect(facts).toEqual({ resolved: 24, inFlight: 1, archived: 3, earlierRecordsPruned: false, compacted: 0 })
    const pruned = registerHeaderFacts(24, [], 3, true)
    expect(pruned.earlierRecordsPruned).toBe(true)
  })

  it('separates what an export can contain from what is still in flight', () => {
    const summary = exportSummaryOf([makeAnswered(), makeDismissed(), makeArchived()], [makeInFlight()], true)
    expect(summary).toMatchObject({ inFlight: 1, archived: 1, earlierRecordsPruned: true })
    // Archived rows are exportable only with the archive option; the summary counts them.
    expect(summary.exportable).toBe(3)
  })

  it('describes the filter for the header and the export file', () => {
    expect(filterLabelOf(t, INITIAL_REGISTER_FILTERS)).toBe('30 days · All sources')
    expect(filterLabelOf(t, filters({ period: 'archive', source: 'user', kind: 'approval' })))
      .toBe('Archive · By you · Approval')
    expect(filterLabelOf(t, filters({ outcome: 'acknowledged', search: 'registry' })))
      .toBe('30 days · All sources · Acknowledged · search: registry')
    expect(filterLabelOf(t, filters({ sessionId: 's-1' }), 'Hookshot review'))
      .toBe('30 days · All sources · session: Hookshot review')
  })

  it('exposes the dictionary keys of every filter option', () => {
    expect(periodKey('archive')).toBe('register.period.archive')
    expect(sourceKey('detector')).toBe('register.source.detector')
    expect(outcomeKey('no-acknowledgement')).toBe('register.outcome.noAck')
  })
})

/** A record with no resolution at all (used for the "none" decision). */
function makeItemWithoutResolution(): OpenItemRecord {
  return makeItemBase()
}

/** Minimal open record; kept local so the fixture file stays focused on the register. */
function makeItemBase(): OpenItemRecord {
  const [first] = registerFixtures()
  /* c8 ignore next -- the fixture always has a first record */
  if (first === undefined) throw new Error('fixtures empty')
  return {
    ...first,
    id: 'reg-open-only',
    state: 'open',
    resolution: undefined,
    resolvedAt: undefined,
    acknowledgement: undefined,
    deliveries: [],
    retention: { class: 'active' },
  }
}
