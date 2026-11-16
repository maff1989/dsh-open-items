import { describe, expect, it } from 'vitest'

import { skewOf } from '../../src/client/data/compat'
import { PROTOCOL_VERSION } from '../../src/shared/protocol'

/** Minimal hello probe. */
function hello(overrides: Record<string, unknown>): never {
  return {
    protocol: PROTOCOL_VERSION, domainVersion: 1, schemaVersion: 3, installId: 'i',
    capabilities: { canSettleClient: false, canHostSettle: false, canDeliver: false, canRegister: true, hasContextLine: false },
    counts: { needsYou: 0, candidates: 0, awaiting: 0 },
    earlierRecordsPruned: false,
    ...overrides,
  } as never
}

describe('protocol skew', () => {
  it('reports protocol and newer-domain skews and tolerates an older domain', () => {
    expect(skewOf(undefined)).toBe('none')
    expect(skewOf(hello({}))).toBe('none')
    expect(skewOf(hello({ protocol: PROTOCOL_VERSION + 1 }))).toBe('protocol')
    expect(skewOf(hello({ domainVersion: 2 }))).toBe('domain')
    expect(skewOf(hello({ domainVersion: 0 }))).toBe('none')
  })
})
