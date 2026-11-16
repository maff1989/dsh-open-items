# Client foundation and browser-half contract

The browser half of `dsh-open-items`: the build/load contract, the shipped
composition, and the constraints the next changes build on. Screens are
[`../../UI.md`](../../UI.md); architecture is [`../../DESIGN.md`](../../DESIGN.md)
§5. This document describes the **shipped rc2 foundation (`0.1.0-rc.2`)** plus
the unreleased remediation's client surfaces (candidates, Settings page with its
round-2 third toggle) and the remaining deferred items.

## What ships

| Surface | Registration | State |
|---|---|---|
| Global **Open items** page | root `main` keyed slot, key `open-items` | rc1 shell/tabs/lens/detail; rc2 WP-06/07 adds the `SegmentedControl`/`Menu`/`Pill` filter set, session filter, paging, keyboard subset and page-title count; WP-08 phase 1 ships typography/material, the Plugins-page shell is phase 2 |
| Left-nav row | `sidebar.panellist`, id `open-items`, order `30` | rc1: icon + count pill. **rc2:** dot-only new indicator; the count lives in the page title (OD-16) |
| In-session card | `tool.call.toolview` keyed `open_items` | rc1: rendered + hydrated; rc2 phase 1: R16/`bg-base`/hairline material and shipped answer primitives |
| Per-session right-panel tab | right-panel tab registration + keyed body | rc1: shipped; rc2: `Pill`/`Menu`/`DisclosureRow`, footer/Show more and session-filtered *View all* shipped; evidence reveal/`loadThrough` deferred |
| **Candidates tab + candidate row/detail** | existing page tabs/rows | **remediation:** prose-gate evidence (quote + turn), **It's an item** (promote) / **Not an item** (suppress), CAS pending/conflict/failure states, never in Needs you |
| **Settings → Open Items** | `settings.section`, id `open-items`, order `40`, locale `openItems` | **remediation + round 2:** three `Switch` rows — `modelNudge` (default off), `proseCandidates` (default on), `llmExtraction` (default off; deployment-configured, exact copy in UI.md §14.2); CAS via the `settings` endpoint, Host truth, no Save button, no read until mount, refresh on `connection/reset` |
| Locale namespace `openItems` | `ctx.locale.register` | `en` + `zh` baselines, key-for-key |
| Plugin stylesheet | `<style data-plugin-css="dsh-open-items">` in a `ctx.effect` | tokens only, 300px-first container queries |

Deferred (V1.1/M5, not in this foundation): team-task actions + the liveness-gate
redesign, session pip/header chip, workspace context-menu entry, panel evidence
reveal/`loadThrough`, page kind/age filters, the rest of the keyboard map, the
runtime-context line. The canonical register is
[`../../PLAN.md`](../../PLAN.md) §7.

## The client-bundle contract

The DSH client module system is a **lazy CommonJS table**: a classic script calls
`window.__ModuleLoader__.load({ id, factory })` and the factory receives a
synchronous `require` over the shell's frozen platform module table
(`@deepseek-ai/dsh-client-modules`). The build therefore emits CommonJS, keeps
platform modules external, inlines everything else, and wraps the result.
`scripts/build.mjs` **fails the build** unless the produced `lib/client.js`:

1. registers under `id: "dsh-open-items"` through `window.__ModuleLoader__.load`;
2. is a `factory: (require) => …` that returns `module.exports`;
3. requires only specifiers from `PLATFORM_MODULES` (mirrors
   `packages/client/web/src/platform.ts` in rc.1 — react, react/jsx-runtime,
   react-dom, cordis, zod, tanstack-virtual, dsh-client-store, -ui-slots,
   -ui-primitives, -ui-dockkit);
4. requires both `react` and `react/jsx-runtime` (JSX must not be inlined), and
   never inlines a React build;
5. imports no `node:` builtin (the browser half has none);
6. stays under the 400 KiB budget (rc2 release: **229.5 KiB** `lib/client.js`,
   plus the source map) and emits `lib/client.js.map`.

The host half keeps its contract assertions unchanged (exports `apply`/`inject`,
Cordis external, **no Session-log write path** — see
[`session-log-policy.md`](session-log-policy.md)).

Determinism: two consecutive builds produce byte-identical `lib/index.js` and
`lib/client.js` (no timestamps or generated comments in either artifact).

## Styling constraint (out-of-tree)

The DSH style reference prescribes CSS Modules + `clsx` for feature packages, but
the out-of-tree build does not publish the client CSS-Modules preset, so this
package **cannot use CSS Modules** (K-10). It ships one plugin-owned namespaced
stylesheet (`.dsh-oi-*`) injected through `ctx.effect`, written for 300px-first
container queries, and it must pass the equivalent static style audit instead:
tokens only (`--dsw-*`/`--dsh-*`, no literal colours), every `:hover` under
`@media (hover: hover)`, `font-weight ≤ 500` in feature CSS, role radii from the
shared scale (R20 content cards/settings-card material, R28 dialogs/panels,
R12/R8 controls, `corner-shape: round` for full rounds), no neutral
border + elevation pairing, and no custom replacement of a catalog control. In
rc2 this is enforced by `scripts/style-audit.mjs` (WP-08) in addition to review; the audit is wired into `verify` and currently reports two findings (the `SendConfirm` duplicate of `RiskConfirmation` and the register resolved-detail hand-rolled `<details>`) that must close before the style gate passes.
The constraint is a build limitation, **not** a licence to custom-style
controls: shipped `@deepseek-ai/dsh-client-ui-primitives` remain the first
choice.

## Data and view state

- `src/client/data/transport.ts` — `POST /api/open-items` envelope client typed
  against `src/shared/protocol.ts`; business failures become typed
  `OpenItemsRpcError` values, only a broken carrier is `transport`.
- `src/client/data/inbox-store.ts` — one app-scoped snapshot (`hello` + `list`),
  single-flight reads, freshness window, last-good snapshot kept offline.
  Freshness triggers: window focus, `visibilitychange`, `connection/reset`, and
  the shipped 60 s visible-window poll (K-03). rc2 ships cursor paging and the global-counts honesty note.
- `src/client/data/register-store.ts` — the Resolved register: paged reads,
  in-flight band, filters, `earlierRecordsPruned`, export data and delete/reopen
  writes.
- `src/client/data/page-store.ts` — tab, grouping, workspace lens, search,
  selection and list scroll. App-scoped so opening a session and returning
  restores the reader's place; the `main` page unmounts on navigation. rc2 adds
  the session filter.
- `src/client/data/settle.ts` — the answer write path: routes a reply to a track,
  carries `deliveryId`/`expectedVersion`, requests `confirmedWake` when needed,
  and surfaces the honest outcome (`applied`/`sent`/`recorded`/failed reason).
- `src/client/derive/inbox-view.ts` — pure section filtering, session and
  workspace grouping, facet counts (including empty workspaces and Ungrouped),
  and the tested counts invariant (one predicate for page/tab/facet counts).

## Layout

Container queries on the page root, base rules written for 300px:

- **narrow (<640px)**: list, or the selected item as a pushed full page (back
  control in the detail header);
- **medium (640–879px)**: one column, selected row expands in place;
- **wide (≥880px)**: list column + independently scrolling detail column.

The top inset pads by `--dsh-frame-top-clearance`; rc1 used a static 28px resting
inset and did **not** implement the Plugins-page compact header. **rc2 phase 2A ships** the Plugins-page shell: inline inset
`clamp(24px,4vw,48px)` (20px <768), sticky page bar compacting 28px→16px, content
max 960px, 32px section rhythm, 48px bottom padding (S-01, OD-17). Phase 1 also
ships the theme typography roles, content-card material, hover/pointer rules and
the static style audit; the remaining phase 2 (`AnimatedRows`, page
`DisclosureRow`/`StateDot`, single detail mount, shortcut hints) is pending.

## Tests

`tests/client/**` with vitest (full release suite: **69 files, 888 passed,
3 skipped**): page store, derivations + counts invariant,
transport envelope/error mapping, every row variant, page loading/empty/offline
states and the workspace lens, nav badge, register paging/filters/export, card
and panel suites, and the `en`/`zh` dictionary parity. Component suites are jsdom
(`// @vitest-environment jsdom`) and mock
`@deepseek-ai/dsh-client-ui-primitives` with a local stand-in
(`tests/client/primitives-mock.tsx`): at runtime the real package is a platform
module whose published entry imports `clsx`, which this package does not install
(the precedent plugin solves the same boundary the same way). rc2 ships
primitive-usage DOM assertions, paging/counts/keyboard/nav-since/empty-scan and
single-detail suites.

`tsconfig.json` has `DOM`/`DOM.Iterable` lib, `jsx: "react-jsx"` and the
`src/**/*.tsx` / `tests/**/*.tsx` includes; the host half is unaffected.

## Verification (rc2 `0.1.0-rc.2`)

```sh
./node_modules/.bin/tsc -p tsconfig.json --noEmit
./node_modules/.bin/vitest run     # 69 files, 888 passed, 3 skipped
node scripts/build.mjs             # host 227.2 KiB, client 229.5 KiB
node scripts/smoke.mjs             # 0 session-log writes
node scripts/style-audit.mjs --strict   # 0/0/0 + written justifications (part of `verify`)
node scripts/a11y-audit.mjs --strict    # 0 findings (49 browser files)
```

The rendered visual review (S-19) is a required post-release manual sign-off and
is not claimed passed. The gate record is [`../VERIFY.md`](../VERIFY.md).
