/**
 * The tab -> list-read mapping: every section asks the Host for the population
 * its tab renders, so Snoozed can show a snoozed item and Candidates cannot see
 * structural rows.
 */
import { describe, expect, it } from 'vitest'

import { inboxQueryForTab } from '../../src/client/data/tab-query'

describe('inbox section reads', () => {
  it('reads the needs-you states for the default section', () => {
    expect(inboxQueryForTab('needs-you')).toEqual({ status: 'all', states: ['open', 'stale'] })
  })

  it('reads snoozed rows for Snoozed (never the default needs-you window)', () => {
    expect(inboxQueryForTab('snoozed')).toEqual({ status: 'all', states: ['snoozed'] })
  })

  it('reads only candidates for Candidates', () => {
    expect(inboxQueryForTab('candidates')).toEqual({ status: 'all', states: ['open', 'stale'], tiers: ['candidate'] })
  })

  it('keeps the inbox read on the needs-you window while Resolved uses the register', () => {
    expect(inboxQueryForTab('resolved')).toEqual({ status: 'all', states: ['open', 'stale'] })
  })
})
