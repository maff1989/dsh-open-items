/**
 * Plugin configuration v2: defaults, range validation and legacy-document path
 * resolution (PLAN M1 item 7).
 */
import { describe, expect, it } from 'vitest'

import { Config, resolveStorePath, type Config as ConfigValues } from '../src/host/config'
import { LIMITS } from '../src/shared/protocol'

/** Schemastery's call signature is over the validated type; the Loader passes a partial object. */
const validate = Config as unknown as (input: unknown) => ConfigValues

describe('Config', () => {
  it('applies the documented defaults from LIMITS', () => {
    const config = validate({})
    expect(config).toEqual({
      storePath: '',
      maxLiveItems: LIMITS.maxLiveItems,
      listLimit: 20,
      activeResolveDays: LIMITS.activeResolveDays,
      maxResolvedRecords: LIMITS.maxResolvedRecords,
      acknowledgementWindowHours: LIMITS.acknowledgementWindowHours,
      rescanIntervalMinutes: 15,
      extractionProvider: '',
      extractionModel: '',
      extractionDailyBudget: 20,
      extractionTimeoutMs: 8_000,
      extractionMaxInputBytes: 8_192,
    })
    expect(config.maxLiveItems).toBe(500)
    expect(config.rescanIntervalMinutes).toBe(15)
    expect(config.activeResolveDays).toBe(365)
    expect(config.maxResolvedRecords).toBe(5000)
    expect(config.acknowledgementWindowHours).toBe(24)
  })

  it('rejects out-of-range values instead of clamping silently', () => {
    expect(() => validate({ maxLiveItems: 9 })).toThrow()
    expect(() => validate({ maxLiveItems: 10_001 })).toThrow()
    expect(() => validate({ listLimit: 0 })).toThrow()
    expect(() => validate({ listLimit: LIMITS.listPageMax + 1 })).toThrow()
    expect(() => validate({ activeResolveDays: 0 })).toThrow()
    expect(() => validate({ maxResolvedRecords: 99 })).toThrow()
    expect(() => validate({ acknowledgementWindowHours: 0 })).toThrow()
    expect(() => validate({ acknowledgementWindowHours: 721 })).toThrow()
    expect(() => validate({ rescanIntervalMinutes: 0 })).toThrow()
    expect(() => validate({ rescanIntervalMinutes: 1_441 })).toThrow()
    expect(() => validate({ storePath: 42 })).toThrow()
    expect(validate({ rescanIntervalMinutes: 1 }).rescanIntervalMinutes).toBe(1)
    expect(validate({ rescanIntervalMinutes: 1_440 }).rescanIntervalMinutes).toBe(1_440)
  })
})

describe('extraction knobs (contract §12.2)', () => {
  it('defaults to off with conservative bounds', () => {
    const config = validate({})
    // Empty provider/model is the privacy default: extraction cannot egress.
    expect(config.extractionProvider).toBe('')
    expect(config.extractionModel).toBe('')
    expect(config.extractionDailyBudget).toBe(20)
    expect(config.extractionTimeoutMs).toBe(8_000)
    expect(config.extractionMaxInputBytes).toBe(8_192)
  })

  it('accepts a configured deployment and rejects out-of-range values', () => {
    const configured = validate({
      extractionProvider: 'deepseek',
      extractionModel: 'deepseek-chat',
      extractionDailyBudget: 0,
      extractionTimeoutMs: 1_000,
      extractionMaxInputBytes: 1_024,
    })
    expect(configured).toMatchObject({
      extractionProvider: 'deepseek',
      extractionModel: 'deepseek-chat',
      extractionDailyBudget: 0,
      extractionTimeoutMs: 1_000,
      extractionMaxInputBytes: 1_024,
    })
  })

  it('throws for every violated bound instead of clamping silently', () => {
    expect(() => validate({ extractionDailyBudget: -1 })).toThrow()
    expect(() => validate({ extractionDailyBudget: 501 })).toThrow()
    expect(() => validate({ extractionTimeoutMs: 999 })).toThrow()
    expect(() => validate({ extractionTimeoutMs: 60_001 })).toThrow()
    expect(() => validate({ extractionMaxInputBytes: 1_023 })).toThrow()
    expect(() => validate({ extractionMaxInputBytes: 65_537 })).toThrow()
    expect(() => validate({ extractionProvider: 42 })).toThrow()
  })
})

describe('resolveStorePath (legacy P0 document)', () => {
  it('uses the DSH home when no path is configured', () => {
    expect(resolveStorePath({ storePath: '' }, { DSH_HOME: '/srv/dsh-home' }))
      .toBe('/srv/dsh-home/open-items/store.json')
  })

  it('honours an explicit path and expands a leading tilde', () => {
    expect(resolveStorePath({ storePath: '/var/lib/dsh/items.json' }, {}))
      .toBe('/var/lib/dsh/items.json')
    expect(resolveStorePath({ storePath: '~/inbox/items.json' }, { HOME: '/home/tester' }))
      .toBe('/home/tester/inbox/items.json')
    expect(resolveStorePath({ storePath: './relative.json' }, {}))
      .toBe(`${process.cwd()}/relative.json`)
  })
})
