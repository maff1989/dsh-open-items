/**
 * Host plugin configuration v2 (Schemastery, as Cordis requires for `Config`).
 *
 * The durable data moved to the storage domain (`$DSH_HOME/storages/open_items`)
 * in M1, so `storePath` is no longer the store: it is the *legacy* P0 document
 * path, imported once and then renamed aside. Retention knobs are deployment
 * config; their defaults come from the shared `LIMITS` so copy and behaviour
 * agree.
 * @module dsh-open-items/host/config
 */
import { join, resolve } from 'node:path'

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import Schema from '@deepseek-ai/schemastery'

import { LIMITS } from '../shared/protocol'

/** Host plugin configuration. */
export interface Config {
  /**
   * Absolute (or `~`-prefixed) path of the **P0 legacy document** to import
   * once. Empty means `<DSH_HOME>/open-items/store.json`; a missing file is
   * simply no migration. The domain store itself lives under
   * `$DSH_HOME/storages/open_items`.
   */
  storePath: string
  /** Cap on live (open/stale/snoozed) items; a breach archives the oldest, never deletes. */
  maxLiveItems: number
  /** Page size the `open_items` list action uses when the model omits `limit`. */
  listLimit: number
  /** Resolved items leave the active register after this many days, then archive (text dropped). */
  activeResolveDays: number
  /** Safety cap on stored resolutions; oldest archived rows prune first, with a visible flag. */
  maxResolvedRecords: number
  /** Unacknowledged deliveries become "no acknowledgement observed" after this many hours. */
  acknowledgementWindowHours: number
  /**
   * Minutes between bounded periodic re-scans of the session logs (contract §8:
   * a live driver cannot see a decision closed outside the live path, so the
   * backfill is repeated on this interval in addition to activation).
   */
  rescanIntervalMinutes: number
  /**
   * Provider route id for opt-in prose extraction (contract §12.2). Empty
   * disables extraction entirely: nothing leaves the machine.
   */
  extractionProvider: string
  /** Exact model id for opt-in prose extraction; empty disables extraction. */
  extractionModel: string
  /** Max extraction calls per UTC day (in-memory counter, resets at UTC midnight). */
  extractionDailyBudget: number
  /** End-to-end deadline for one extraction call, in milliseconds. */
  extractionTimeoutMs: number
  /** Hard cap on the assistant-text bytes sent in one extraction prompt. */
  extractionMaxInputBytes: number
}

/** Validated Host plugin configuration. */
export const Config: Schema<Config> = Schema.object({
  storePath: Schema.string().default('')
    .description(
      'Legacy P0 JSON document to import once; empty means <DSH_HOME>/open-items/store.json. '
      + 'The domain store itself lives under $DSH_HOME/storages/open_items.',
    ),
  maxLiveItems: Schema.number().min(10).max(10_000).default(LIMITS.maxLiveItems)
    .description('Cap on live (open/stale/snoozed) items; a breach archives the oldest, never deletes.'),
  listLimit: Schema.number().min(1).max(LIMITS.listPageMax).default(20)
    .description('Default page size of the open_items list action.'),
  activeResolveDays: Schema.number().min(1).max(3650).default(LIMITS.activeResolveDays)
    .description('Days a resolution stays in the active register before archiving (body/quote dropped).'),
  maxResolvedRecords: Schema.number().min(100).max(100_000).default(LIMITS.maxResolvedRecords)
    .description('Safety cap on stored resolutions; oldest archived rows prune first, never silently.'),
  acknowledgementWindowHours: Schema.number().min(1).max(720).default(LIMITS.acknowledgementWindowHours)
    .description('Hours to wait for session acknowledgement before recording "no acknowledgement observed".'),
  rescanIntervalMinutes: Schema.number().min(1).max(1440).default(15)
    .description('Minutes between bounded periodic re-scans of session logs (1-1440; after activation).'),
  extractionProvider: Schema.string().default('')
    .description(
      'LLM provider route for opt-in prose extraction; empty disables extraction (no egress). '
      + 'Model-assisted extraction also requires the Settings toggle to be on.',
    ),
  extractionModel: Schema.string().default('')
    .description('Exact model id for opt-in prose extraction; empty disables extraction (no egress).'),
  extractionDailyBudget: Schema.number().min(0).max(500).default(20)
    .description('Max extraction calls per UTC day (in-memory counter); 0 disables calls without changing the settings toggle.'),
  extractionTimeoutMs: Schema.number().min(1_000).max(60_000).default(8_000)
    .description('End-to-end deadline per extraction call in milliseconds (1000-60000).'),
  extractionMaxInputBytes: Schema.number().min(1_024).max(65_536).default(8_192)
    .description('Hard cap on the assistant-text bytes sent in one extraction prompt (1024-65536).'),
})

/**
 * Resolve the legacy P0 document path for one configuration.
 *
 * Precedence: an explicit `storePath` (with `~` expanded), then the DSH home
 * (`$DSH_HOME`, else `~/.dsh`) plus `open-items/store.json`. The file is only
 * read when it exists, so a fresh install does nothing here.
 * @param config - validated plugin configuration.
 * @param environment - environment mapping used for `$DSH_HOME` (injectable for tests).
 * @returns the absolute legacy-document path.
 */
export function resolveStorePath(
  config: Pick<Config, 'storePath'>,
  environment: Record<string, string | undefined> = process.env,
): string {
  const configured = config.storePath.trim()
  if (configured !== '') return resolve(expandTilde(configured, environment))
  return join(resolveDshHome(undefined, environment), 'open-items', 'store.json')
}

/**
 * Expand a leading `~` using the host's home directory.
 *
 * `@deepseek-ai/dsh-home-paths` exports the canonical helper; it is used there
 * for the DSH home itself, while this small expansion keeps the explicit
 * `storePath` acceptance independent of `$DSH_HOME`.
 * @param path - configured path.
 * @param environment - environment mapping (used for `HOME`/`USERPROFILE`).
 * @returns the path with a leading `~` replaced.
 */
function expandTilde(path: string, environment: Record<string, string | undefined>): string {
  if (!path.startsWith('~')) return path
  const home = environment['HOME'] ?? environment['USERPROFILE']
  if (home === undefined || home === '') return path
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}
