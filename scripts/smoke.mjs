#!/usr/bin/env node
/**
 * Smoke-test the *built* host bundle against a real Cordis context.
 *
 * The unit suites exercise `src/` with vitest; this script exercises the
 * artifact a profile actually loads (`lib/index.js`): it imports the bundle,
 * mounts it with fake `tools` and `storageDomain` services, and drives the
 * registered tool once. It is the closest verification this branch can make
 * without installing into a live profile (which the task forbids).
 *
 * Usage: node scripts/smoke.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'

import { Config, apply, inject, name, OPEN_ITEMS_DOMAIN_NAME } from '../lib/index.js'

const failures = []
/**
 * Record one assertion.
 * @param condition - whether it holds.
 * @param message - failure description.
 */
function check(condition, message) {
  if (!condition) failures.push(message)
}

check(name === 'dsh-open-items', `bundle name is ${String(name)}`)
check(Array.isArray(inject) && inject.includes('tools'), 'bundle inject metadata does not include "tools"')
check(Array.isArray(inject) && inject.includes('storageDomain'), 'bundle inject metadata does not include "storageDomain"')
check(typeof apply === 'function', 'bundle exports no apply()')

/**
 * Minimal in-memory storage-domain facility for the smoke mount.
 * @returns a facility whose `open()` yields one fake domain.
 */
function fakeStorageDomain() {
  const tables = new Map()
  /** One in-memory KV table with a serialised write chain. */
  class Table {
    constructor() {
      this.map = new Map()
      this.chain = Promise.resolve()
    }
    get(key) { return this.map.get(key) }
    *entries() { yield* [...this.map.entries()] }
    *keys() { yield* [...this.map.keys()] }
    get size() { return this.map.size }
    put(key, value) {
      this.chain = this.chain.then(() => { this.map.set(key, value) })
      return this.chain
    }
    delete(key) {
      this.chain = this.chain.then(() => this.map.delete(key))
      return this.chain
    }
    deleteMany(keys) {
      this.chain = this.chain.then(() => {
        let removed = 0
        for (const key of keys) if (this.map.delete(key)) removed += 1
        return removed
      })
      return this.chain
    }
    update(key, fn) {
      this.chain = this.chain.then(() => {
        if (!this.map.has(key)) throw new Error(`missing-key: ${String(key)}`)
        const next = fn(this.map.get(key))
        this.map.set(key, next)
        return next
      })
      return this.chain
    }
  }
  const domain = {
    name: OPEN_ITEMS_DOMAIN_NAME,
    global: undefined,
    table(tableName) {
      const existing = tables.get(tableName)
      if (existing !== undefined) return existing
      const table = new Table()
      tables.set(tableName, table)
      return table
    },
    async close() {},
    tables,
  }
  return {
    tables,
    open: async () => domain,
  }
}

const caseDirectory = await mkdtemp(join(tmpdir(), 'dsh-open-items-smoke-'))
const filePath = join(caseDirectory, 'legacy.json')
/** Tools the fake registry received. */
const registered = []
/** Session-log appends the fake agent recorded; the plugin must leave this at zero. */
let sessionAppends = 0

const storage = fakeStorageDomain()
const ctx = new Context()
ctx.provide('storageDomain', storage)
ctx.provide('tools', {
  /**
   * Capture the registered definition.
   * @param definition - the tool definition.
   * @returns the disposer.
   */
  register(definition) {
    registered.push(definition)
    return () => undefined
  },
})

const config = Config({
  storePath: filePath,
  maxLiveItems: 500,
  listLimit: 20,
  activeResolveDays: 365,
  maxResolvedRecords: 5000,
  acknowledgementWindowHours: 24,
})
await apply(ctx, config)

check(ctx.openItems !== undefined, 'apply() did not publish ctx.openItems')
check(ctx.openItems?.schemaVersion === 3, 'ctx.openItems does not expose schema v3')
check(typeof ctx.openItems?.list === 'function', 'ctx.openItems has no list()')
check(registered.length === 1, `expected 1 registered tool, saw ${registered.length}`)

if (registered.length === 1) {
  const definition = registered[0]
  check(definition.name === 'open_items', `tool name is ${String(definition.name)}`)
  const exec = {
    callId: 'smoke-call',
    agent: {
      id: 'smoke-session',
      session: {
        id: 'smoke-session',
        append() {
          sessionAppends += 1
          throw new Error('dsh-open-items must not append session events (see docs/session-log-policy.md)')
        },
      },
    },
  }
  const raised = await definition.execute({ action: 'raise', kind: 'decision', title: 'Smoke: ship it?' }, exec)
  check(raised.items.length === 1, 'raise returned no item')
  check(raised.items[0]?.state === 'open', `raise state is ${String(raised.items[0]?.state)}`)

  const listed = await definition.execute({ action: 'list' }, exec)
  check(listed.items.length === 1, `list returned ${String(listed.items.length)} items`)

  const resolved = await definition.execute({ action: 'resolve', id: raised.items[0].id, answer: 'yes' }, exec)
  check(resolved.items[0]?.state === 'awaiting', 'resolve did not move the item to awaiting')

  const reopened = await ctx.openItems.reopen(raised.items[0].id)
  check(reopened.state === 'open', 'ctx.openItems.reopen did not restore the item')
  const dismissed = await definition.execute({ action: 'dismiss', id: raised.items[0].id, reason: 'smoke' }, exec)
  check(dismissed.items[0]?.state === 'resolved', 'dismiss did not resolve the item')

  const items = storage.tables.get('items')
  check(items !== undefined && items.size === 1, 'the domain store does not hold the item')
  const meta = storage.tables.get('meta')
  check(meta !== undefined && meta.size === 1, 'the install identity row is missing')
  check(sessionAppends === 0, `the plugin wrote ${String(sessionAppends)} Session-log event(s); it must write none`)
  const history = ctx.openItems.get(raised.items[0].id)?.history.map(entry => entry.action)
  check(JSON.stringify(history) === JSON.stringify(['raised', 'answered', 'reopened', 'dismissed']),
    `unexpected audit history: ${JSON.stringify(history)}`)
}

await ctx.openItems?.close?.()
await rm(caseDirectory, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`smoke check FAILED (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('smoke check OK: mounted the built host bundle on a fake storage domain, published ctx.openItems, ran open_items raise/list/resolve/dismiss, 0 session-log writes')
