/**
 * The `open_items` storage domain (DESIGN §7.1, PLAN M1 item 1).
 *
 * One record per document (`layout: 'per-record'`), a corrupt record is backed
 * up and skipped rather than disabling the feature (`invalidRecords:
 * 'backup-and-skip'`), and the tables are exactly the durable vocabulary:
 *
 * - `items`       id → OpenItemRecord        (authored + derived, the total truth)
 * - `cursors`     sessionId → DetectionCursor (backfill / fold watermarks)
 * - `suppressors` prefix → SuppressorRecord  ("the user said this is not an item")
 * - `meta`        row key → MetaRecord       (`install` install identity,
 *                                              `settings` the settings record,
 *                                              `backfill` the last pass report)
 *
 * The settings record and the durable backfill report deliberately share the
 * existing `meta` table instead of adding tables: a new table changes the
 * domain format, and the live install must keep opening unchanged. Rows are
 * dispatched by shape ({@link parseMetaRecord}) and the domain format version
 * therefore stays 1.
 *
 * The record schemas come from `../shared/records.ts`: the domain declares zod
 * schemas, but this package's manifest is frozen for this branch, so the
 * adapter supplies the one method the domain runtime calls (`parse`).
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

import type {
  DetectionCursor,
  InstallRecord,
  OpenItemId,
  OpenItemRecord,
  SessionId,
  SuppressorRecord,
} from '../shared/schema'
import {
  asDomainSchema,
  parseDetectionCursor,
  parseItemRecord,
  parseMetaRecord,
  parseSuppressorRecord,
  type MetaRecord,
} from '../shared/records'

/** Domain name; doubles as the backend unit name (`$DSH_HOME/storages/open_items`). */
export const OPEN_ITEMS_DOMAIN_NAME = 'open_items'

/** Domain format version (record `schemaVersion` is tracked separately). */
export const OPEN_ITEMS_DOMAIN_VERSION = 1

/** The domain declaration handed to `ctx.storageDomain.open`. */
export const openItemsDomain = defineDomain({
  name: OPEN_ITEMS_DOMAIN_NAME,
  version: OPEN_ITEMS_DOMAIN_VERSION,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    items: domainTable<OpenItemId, OpenItemRecord>(asDomainSchema(parseItemRecord)),
    cursors: domainTable<SessionId, DetectionCursor>(asDomainSchema(parseDetectionCursor)),
    suppressors: domainTable<string, SuppressorRecord>(asDomainSchema(parseSuppressorRecord)),
    // `install` (InstallRecord), `settings` (SettingsRecord) and `backfill`
    // (BackfillReportRecord) share this table; `parseMetaRecord` dispatches.
    meta: domainTable<string, MetaRecord>(asDomainSchema(parseMetaRecord)),
  },
})

/** Opened domain handle type. */
export type OpenItemsDomain = typeof openItemsDomain

/** The install-identity key of the `meta` table. */
export const INSTALL_META_KEY = 'install' as const

/** The settings key of the `meta` table (see `parseMetaRecord`). */
export const SETTINGS_META_KEY = 'settings' as const

/** The durable last-backfill-report key of the `meta` table (contract §12.5). */
export const BACKFILL_META_KEY = 'backfill' as const

/** The record types the two `meta` keys hold (compile-time documentation). */
export type { InstallRecord, MetaRecord }
