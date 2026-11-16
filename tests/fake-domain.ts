/**
 * In-memory `Domain<OpenItemsDomain>` fake for store/migration/retention tests.
 *
 * The real domain is an in-memory KV with one write chain and zod validation at
 * the durable read boundary. Faking it at the `Domain` interface keeps these
 * tests about store policy (CAS, dedupe, retention, migration) and fast enough
 * to run per change; the domain declaration itself is asserted separately in
 * `domain.spec.ts`.
 *
 * `loadFakeDomain` emulates `invalidRecords: 'backup-and-skip'`: a record that
 * fails the declared table schema is moved to `quarantined` and skipped, which
 * is what the real facility does to the offending document.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Domain, DomainTableSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'

import { openItemsDomain, type OpenItemsDomain } from '../src/host/domain'

/** One quarantined record (as `backup-and-skip` would report it). */
export interface QuarantinedRecord {
  readonly table: string
  readonly key: string
  readonly reason: string
}

/** The fake handle plus the raw maps the tests may inspect. */
export interface FakeDomain extends Domain<OpenItemsDomain> {
  readonly tables: Map<string, Map<string, unknown>>
  readonly quarantined: QuarantinedRecord[]
  /** Number of durable writes so far (proves no-op paths wrote nothing). */
  readonly writes: () => number
}

/** A KV table over a shared map with a serialised write chain. */
class FakeTable<K extends string, V> implements KvTable<K, V> {
  private chain: Promise<unknown> = Promise.resolve()
  private writeCount = 0

  constructor(
    private readonly map: Map<string, unknown>,
    private readonly onWrite: () => void,
  ) {}

  get(key: K): V | undefined {
    return this.map.get(key) as V | undefined
  }

  *entries(): IterableIterator<[K, V]> {
    yield* [...this.map.entries()] as [K, V][]
  }

  *keys(): IterableIterator<K> {
    yield* [...this.map.keys()] as K[]
  }

  get size(): number {
    return this.map.size
  }

  put(key: K, value: V): Promise<void> {
    return this.enqueue(async () => {
      this.map.set(key, value)
      this.writeCount += 1
      this.onWrite()
    })
  }

  delete(key: K): Promise<boolean> {
    return this.enqueue(async () => {
      const existed = this.map.delete(key)
      if (existed) {
        this.writeCount += 1
        this.onWrite()
      }
      return existed
    })
  }

  deleteMany(keys: readonly K[]): Promise<number> {
    return this.enqueue(async () => {
      let removed = 0
      for (const key of keys) if (this.map.delete(key)) removed += 1
      if (removed > 0) {
        this.writeCount += 1
        this.onWrite()
      }
      return removed
    })
  }

  update(key: K, fn: (current: V) => V): Promise<V> {
    return this.enqueue(async () => {
      if (!this.map.has(key)) throw new Error(`missing-key: ${key}`)
      const current = this.map.get(key) as V
      const next = fn(current)
      this.map.set(key, next)
      this.writeCount += 1
      this.onWrite()
      return next
    })
  }

  /** Expose the write count for assertions. */
  get writes(): number {
    return this.writeCount
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work)
    this.chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

/** Options for {@link createFakeDomain}. */
export interface FakeDomainOptions {
  /** Raw stored records keyed by table name (validated like a durable load). */
  readonly records?: Readonly<Record<string, readonly unknown[]>>
}

/**
 * Create an empty (or pre-loaded) fake domain.
 * @param options - raw records to load through the declared schemas.
 * @returns the fake domain handle.
 */
export function createFakeDomain(options: FakeDomainOptions = {}): FakeDomain {
  const tables = new Map<string, Map<string, unknown>>()
  const quarantined: QuarantinedRecord[] = []
  const tableWrites = new Map<string, () => number>()
  let totalWrites = 0
  for (const tableName of Object.keys(openItemsDomain.tables)) tables.set(tableName, new Map())

  const declared = openItemsDomain.tables as unknown as Record<string, DomainTableSpec<string, unknown>>
  for (const [tableName, rawRecords] of Object.entries(options.records ?? {})) {
    const table = tables.get(tableName)
    if (table === undefined) throw new Error(`fake domain has no table ${tableName}`)
    const spec = declared[tableName]
    if (spec === undefined) throw new Error(`fake domain spec has no table ${tableName}`)
    for (const [index, raw] of rawRecords.entries()) {
      const key = keyOf(raw, index)
      try {
        const parsed = spec.valueSchema.parse(raw)
        table.set(key, parsed)
      } catch (error) {
        quarantined.push({
          table: tableName,
          key,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  const handles = new Map<string, FakeTable<string, unknown>>()
  const domain = {
    name: openItemsDomain.name,
    global: undefined as never,
    table(name: string): KvTable<string, never> {
      const existing = handles.get(name)
      if (existing !== undefined) return existing as unknown as KvTable<string, never>
      const map = tables.get(name)
      if (map === undefined) throw new Error(`undeclared table ${name}`)
      const handle = new FakeTable<string, unknown>(map, () => {
        totalWrites += 1
      })
      handles.set(name, handle)
      tableWrites.set(name, () => handle.writes)
      return handle as unknown as KvTable<string, never>
    },
    async close(): Promise<void> {
      // Nothing to release in memory.
    },
    tables,
    quarantined,
    writes: () => totalWrites,
  }
  void tableWrites
  return domain as unknown as FakeDomain
}

/** Derive a stable key for a raw record loaded into a table. */
function keyOf(raw: unknown, index: number): string {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>
    const candidate = record['id'] ?? record['sessionId'] ?? record['installId'] ?? record['dedupePrefix']
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return `record-${index}`
}

/**
 * Minimal Host context whose only used surface is `storageDomain`.
 * @param domain - fake domain to return from `open`.
 * @returns the context cast.
 */
export function fakeContext(domain: FakeDomain): Context {
  return {
    storageDomain: {
      open: async () => domain,
    },
  } as unknown as Context
}
