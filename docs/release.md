# Release procedure

This package ships as a **profile-installed plugin**, not an npm publish: the
user adds the built package directory to their DSH profile, and the user data
lives under `$DSH_HOME/storages/open_items/`. The sandbox that builds and tests
the package cannot write `~/.dsh`, so the install step is a documented handoff
(see [`docs/install.md`](install.md)).

## Versioning

- `package.json` `version` is the release version (semver). **Current release: `0.1.0-rc.2` (tag `v0.1.0-rc.2`, 2026-11-14)** — rc2, the conformance-and-truth release; evidence in [`VERIFY.md`](../VERIFY.md). Previous baseline: `0.1.0-rc.1` (tag `v0.1.0-rc.1`). `v0.1.0-rc.2` was re-tagged onto `main` at the owner's decision on 2026-11-14 (superseding the pre-merge rc2-line tag location); do not re-point it without a new owner decision.
- **Remediation build (2026-11-14):** the founding-goal fix (D1–D6) is recorded under `CHANGELOG.md` `[Unreleased]` and keeps the `0.1.0-rc.2` version on `main` — tagged **v0.1.0-rc.2** (owner re-tag 2026-11-14; D6 superseded by owner decision). It ships built `lib/` to the linked profile and needs one app restart (fold-version replay + one-time team-task retirement). Future releases use the bump procedure below with a proper CHANGELOG version section; do not re-point `v0.1.0-rc.2` without an owner decision.
- **Round-2 addendum (same unreleased build):** a durable backfill report (`meta` key `backfill`; no domain bump) and **opt-in, deployment-configured model-assisted extraction**. Extraction is **off by default**; it cannot run unless the deployment sets both `extractionProvider` and `extractionModel` **and** the user enables the Settings toggle. With either missing, nothing leaves the machine. It was **not exercised against a live provider** in this work, so do not describe it as validated end-to-end. Config keys/defaults/bounds are in [`install.md`](install.md) §1 and the plugin README config table; privacy/egress is in `DESIGN.md` §7.2 and `VERIFY.md` §9.
- `src/client/version.ts` `PLUGIN_VERSION` is stamped into deterministic export
  headers and **must equal** the package version.
- `CHANGELOG.md` must carry a section for the version.
- `scripts/package-check.mjs` fails when those three disagree.

The store format is versioned separately and independently:

| Knob | Where | Rule |
| --- | --- | --- |
| Domain format version | `src/host/domain.ts` (`OPEN_ITEMS_DOMAIN_VERSION`, currently 1) | bump only for a storage-layout change; readers reject newer units |
| Record schema version | `src/shared/schema.ts` (`STORE_SCHEMA_VERSION`, currently 3) | bump for a record-shape change; the durable boundary validates every record |
| Wire protocol version | `src/shared/protocol.ts` (`PROTOCOL_VERSION`, currently 1) | bump for a breaking route/wire change; both sides tolerate skew of additive fields |
| Fold version | `src/host/folds/limits.ts` (`OPEN_ITEMS_FOLD_VERSION`, currently **2** since the remediation) | bump whenever fold semantics change; a bump replays each session's log once |
| Projection version | `src/host/projection.ts` (`OPEN_ITEMS_PROJECTION_VERSION`, currently **2**) | **must move together with the fold version** in the same change (a mismatch makes the checkpoint/ledger semantics disagree) |
| `meta` table keys | `install`, `settings`, `backfill` (`parseMetaRecord` dispatches on shape) | additive keys need no domain bump; a record-shape change needs the record parser/version touched in the same change |

The remediation added the `settings` record to the **existing `meta` table**, so
the storage-domain version stays 1; no record/domain migration is required.

A release must never silently change a durable shape: additive record fields are
fine (old records load), removals/renames need a schema bump plus a migration in
`src/host/migration.ts` or a documented breaking release.

## Pre-release checklist

Run from the package root with direct binaries (`pnpm` fails in worktrees):

```bash
# 1. Types, unit + client + capture + e2e suites, builds, fake-domain smoke
./node_modules/.bin/tsc -p tsconfig.json --noEmit \
  && ./node_modules/.bin/vitest run \
  && node scripts/build.mjs \
  && node scripts/smoke.mjs

# 2. Performance budgets at the design cap (records the numbers in docs/perf.md)
OI_PERF=1 ./node_modules/.bin/vitest run tests/perf

# 3. Real-corpus acceptance (items open at log end + per-family closure map)
node scripts/acceptance.mjs            # report; add --strict to gate the ≤20 target
#    round-2 reference: 1 open structural item + 18 candidates, 0 fold errors (VERIFY §9)
#    extraction is off by default, so it cannot change these fold counts

# 4. Static DSH style conformance (rc2 gate, WP-08) — green at 0.1.0-rc.2
node scripts/style-audit.mjs          # expected exit 0: 0/0/0 + written justifications only

# 5. Package/release readiness (no npm pack: the npm cache is read-only here)
node scripts/package-check.mjs

# 6. Static accessibility contracts as a gate
node scripts/a11y-audit.mjs --strict  # expected exit 0, 0 high findings
```

The normal `vitest run` stays hermetic: perf (`OI_PERF=1`) and acceptance
(`OI_ACCEPTANCE=1`) are environment-gated and skip with a message otherwise.
`package-check` prints the exact payload it would ship.

Also confirm the docs still match the build:

- `docs/install.md` — user-run install for `dev` and `web` profiles.
- `docs/perf.md` — measured numbers for this release candidate.
- `docs/a11y.md` — static findings + manual browser checklist.
- `docs/session-log-policy.md` — the no-Session-log-writes rule (unchanged).

## Version bump procedure

1. Decide the bump from `CHANGELOG.md` (feature → minor, fix → patch).
2. Update `package.json` `version`.
3. Update `src/client/version.ts` `PLUGIN_VERSION` to the same string.
4. Add a `## [x.y.z] — YYYY-MM-DD` section to `CHANGELOG.md` (Added/Changed/
   Fixed/Security/known limitations).
5. Rebuild: `node scripts/build.mjs`.
6. Run the whole pre-release checklist above.
7. Commit, then tag `v<x.y.z>` on the release commit (pre-release strings keep
   the form `v0.1.0-rc.2`; the rc1 tags are `v0.1.0-rc.1` and `v0.1.0-rc.2` — do
   not reuse or force-move a tag), no merge/rebase of in-flight branches; the
   release is cut from `main` after the release owner merges the remaining
   packages and re-runs the checklist.
8. Hand the install step to the user (below) and record the result.

## Install handoff (user-run)

The agent cannot do this step: `~/.dsh` is read-only in the build sandbox.
Give the user the built package path and the commands from `docs/install.md`:

```bash
# dev profile first (scratch, safe)
dsh plugin --profile dev add /abs/path/to/dsh-open-items
dsh --profile dev --dump-config | grep -A8 "open-items"
dsh --profile dev                      # expect: open items ready at open_items

# live web profile
dsh plugin --profile web add /abs/path/to/dsh-open-items
# restart the web app (a new Loader row needs a process restart)
```

Post-install checks (full list in `docs/install.md` §4): bundle row composed,
boot log line present, `$DSH_HOME/storages/open_items/` created, the **page**
opens with its empty/count state, the **card** renders at an `open_items` tool
row, the **panel** lists only its session's items, one answer cycle reports an
honest outcome, `hello.capture` reports `mounted/projection/live/backfill: true`,
and sessions still resume. The rc2 release record (gates, numbers, live
storage-domain check) is [`VERIFY.md`](../VERIFY.md); the **S-19 rendered visual
review remains a required post-release manual sign-off** and is not claimed
passed.

## Rollback

The release is a plugin row plus data, so rollback has two independent halves.

**Plugin rollback (always safe for data):**

```bash
# stop the app first
dsh plugin --profile web remove dsh-open-items
# rebuild/check out the previous release commit, then re-add it
node scripts/build.mjs
dsh plugin --profile web add /abs/path/to/dsh-open-items
# restart the app
```

Uninstalling never deletes `$DSH_HOME/storages/open_items/`; re-installing the
previous build reopens the same store. If the new build stamped a **newer**
record schema/domain version, the previous build will refuse those records
loudly (by design) — restore the pre-release data backup first:

```bash
# before upgrading (DSH stopped)
cp -a "${DSH_HOME:-$HOME/.dsh}/storages/open_items" ~/open-items-backup-$(date +%F)

# rollback with data
mv "${DSH_HOME:-$HOME/.dsh}/storages/open_items" "${DSH_HOME:-$HOME/.dsh}/storages/open_items.failed"
mv ~/open-items-backup-YYYY-MM-DD "${DSH_HOME:-$HOME/.dsh}/storages/open_items"
```

A record the durable boundary cannot validate is quarantined
(`invalidRecords: 'backup-and-skip'`) rather than disabling the feature, so a
rollback with a corrupted record loses that record, not the inbox.

**Full rollback** (also resetting data) is the uninstall above plus moving the
`storages/open_items` directory aside while DSH is stopped.

## Release artifacts

The shipped payload is declared by `package.json` `files` and enforced by
`scripts/package-check.mjs`:

```
lib/index.js            host bundle (ESM, @deepseek-ai/* external)
lib/index.js.map
lib/client.js           client bundle (module-loader wrapped)
lib/client.js.map
cordis.patch.yml        Loader row + config
README.md               shipped feature set and limitations
CHANGELOG.md            this release's notes
LICENSE                 MIT
docs/                   install, release, perf, a11y, session-log policy, client foundation
VERIFY.md               rc2 release evidence record (0.1.0-rc.2 gate ladder, acceptance, style, live profile)
```

`tests/acceptance/last-run.json` is local output and must never ship; the
package-check asserts it is not covered by `files`.
