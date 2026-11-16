/**
 * Plugin-owned stylesheets for the inbox page, rows, nav row and register.
 *
 * rc2 style pass (WP-08): DSH tokens only, feature font-weight <= 500, the
 * 13px row/detail scale through the theme's typography roles, hover under
 * `(hover: hover)`, coarse-pointer field floor, and the role radii/material
 * system: inbox rows and register rows are content cards (R20 + settings-card
 * fill/stroke), grouped content is R16, controls stay at their primitive sizes.
 * The page shell is the Plugins-shaped two-band bar and the 960px content
 * column. The bar no longer shrinks on scroll (round-4: the inert compact state
 * was removed; see UI.md §2, an explicit S-01 deviation).
 *
 * @module dsh-open-items/client/styles
 */

/** Layout, page chrome and shared state rules. */
export const PAGE_STYLES = `
.dsh-oi-page {
  container-name: dsh-oi-page;
  container-type: inline-size;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  --oi-page-inset: clamp(24px, 4vw, 48px);
  --oi-page-top-inset: 28px;
  padding-top: var(--dsh-frame-top-clearance, 0px);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xs-13);
}
@media (width <= 767px) {
  .dsh-oi-page { --oi-page-inset: 20px; }
}
.dsh-oi-pageBar {
  background: var(--dsw-alias-bg-base);
  box-sizing: border-box;
  container-name: dsh-oi-pagebar;
  container-type: inline-size;
  flex: none;
  padding: var(--oi-page-top-inset) var(--oi-page-inset) 16px;
}
.dsh-oi-visually-hidden {
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}
.dsh-oi-tabsCell {
  min-width: 0;
}
.dsh-oi-listHeader {
  align-items: center;
  display: flex;
  flex: none;
  gap: 8px;
  padding: 0 0 8px;
}
.dsh-oi-listHeader .dsh-oi-searchWrap {
  flex: 1 1 auto;
  min-width: 0;
}
.dsh-oi-listHeader .dsh-oi-search {
  width: 100%;
}
.dsh-oi-listHeader .dsh-oi-controlButton {
  flex: none;
}
/* The trigger's value ("All workspaces" / a workspace name) already says what it
   is; dropping the redundant label gives the list search ~70px more width. The
   accessible name stays on the button. */
.dsh-oi-listHeader .dsh-oi-controlLabel {
  display: none;
}
.dsh-oi-pushedBar {
  align-items: center;
  display: flex;
  min-height: 28px;
}
.dsh-oi-pageHead {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-inline: auto;
  max-width: 960px;
  width: 100%;
}
.dsh-oi-header {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  justify-content: space-between;
  padding: 0;
  width: 100%;
}
.dsh-oi-heading {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  min-width: 0;
}
.dsh-oi-title {
  font: var(--dsw-font-l-20);
  margin: 0;
}
.dsh-oi-counts {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.dsh-oi-tabsRow {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  justify-content: space-between;
  width: 100%;
}
.dsh-oi-tabs {
  box-sizing: border-box;
  flex: 0 1 400px;
  max-width: 400px;
  min-width: 0;
  width: 400px;
}
.dsh-oi-tools {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-inline-start: auto;
}
.dsh-oi-searchWrap {
  display: inline-flex;
  flex: 0 1 240px;
  min-width: 160px;
  position: relative;
}
.dsh-oi-search {
  box-sizing: border-box;
  flex: 1 1 auto;
  min-width: 0;
  padding-inline-end: 28px;
  width: 240px;
}
.dsh-oi-searchClear {
  height: 24px;
  inset-inline-end: 4px;
  padding: 0;
  position: absolute;
  top: 4px;
  width: 24px;
}
.dsh-oi-controls {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  justify-content: flex-end;
}
.dsh-oi-controlLabel {
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.dsh-oi-controlButton {
  gap: 6px;
  justify-content: flex-start;
  max-width: 260px;
}
.dsh-oi-controlButton .dsh-oi-controlLabel {
  color: var(--dsw-alias-label-tertiary);
}
.dsh-oi-controlValue {
  color: var(--dsw-alias-label-primary);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-oi-banner {
  align-items: center;
  border-radius: var(--dsw-radius-sm);
  box-sizing: border-box;
  display: flex;
  flex-wrap: wrap;
  font: var(--dsw-font-xxs-12);
  gap: 8px;
  margin: 0 auto 8px;
  max-width: 960px;
  padding: 8px 10px;
  width: calc(100% - 2 * var(--oi-page-inset));
}
.dsh-oi-banner--offline {
  background: var(--dsw-alias-state-warn-tertiary, var(--dsw-alias-bg-layer-2));
  border: 1px solid var(--dsw-alias-state-warn-primary);
}
.dsh-oi-banner--error {
  border: 1px solid var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-secondary);
}
.dsh-oi-columns {
  box-sizing: border-box;
  display: flex;
  flex: 1;
  flex-direction: column;
  margin-inline: auto;
  max-width: calc(960px + 2 * var(--oi-page-inset));
  min-height: 0;
  padding: 16px var(--oi-page-inset) 0;
  width: 100%;
}
.dsh-oi-listColumn {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.dsh-oi-listScroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 0 48px;
  scrollbar-gutter: stable;
}
.dsh-oi-groups {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.dsh-oi-groups[hidden] { display: none; }
.dsh-oi-group {
  display: flex;
  flex-direction: column;
  min-width: 0;
  position: relative;
}
.dsh-oi-groupRows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
}
.dsh-oi-groupHeader {
  align-items: center;
  background: var(--dsw-alias-bg-base);
  box-sizing: border-box;
  display: flex;
  gap: 8px;
  min-height: 32px;
  padding: 2px 0;
  position: sticky;
  top: 0;
  z-index: 1;
}
.dsh-oi-group[data-nested='true'] .dsh-oi-groupHeader {
  top: 32px;
  z-index: 2;
}
.dsh-oi-groupMeta {
  align-items: center;
  color: var(--dsw-alias-label-tertiary);
  display: inline-flex;
  flex: none;
  font: var(--dsw-font-xxxs-11);
  gap: 6px;
  margin-inline-start: auto;
  white-space: nowrap;
}
.dsh-oi-groupCount {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.dsh-oi-groupUpdated {
  font-variant-numeric: tabular-nums;
}
.dsh-oi-groupOpen {
  flex: none;
  padding-inline: 6px;
  white-space: nowrap;
}
@container dsh-oi-page (min-width: 880px) {
  .dsh-oi-groupOpenLabel { display: none; }
}
@container dsh-oi-page (max-width: 479.98px) {
  .dsh-oi-groupOpenLabel { display: none; }
}
.dsh-oi-detailColumn {
  display: none;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  padding: 0 0 48px;
}
.dsh-oi-inlineDetail {
  background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg);
  box-sizing: border-box;
  display: none;
  list-style: none;
  margin: 4px 0 0;
  padding: 0 4px 8px;
}
.dsh-oi-back {
  align-self: flex-start;
  margin: 0 0 4px;
}
.dsh-oi-state {
  align-items: center;
  color: var(--dsw-alias-label-tertiary);
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 48px auto;
  max-width: 420px;
  padding: 0 16px;
  text-align: center;
}
.dsh-oi-stateTitle {
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-s-14);
  font-weight: 500;
  margin: 0;
}
.dsh-oi-stateBody {
  margin: 0;
}
.dsh-oi-stateMeta {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
  margin: 0;
}
.dsh-oi-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 16px;
}
.dsh-oi-skeletonRow {
  background: var(--dsw-alias-bg-skeleton);
  border-radius: var(--dsw-radius-xl);
  height: 64px;
  animation: dsh-oi-skeleton 2s cubic-bezier(0.36, 0, 0.64, 1) infinite;
}
@keyframes dsh-oi-skeleton {
  0% { opacity: 1; }
  40% { opacity: 0.6; }
  80%, 100% { opacity: 1; }
}
.dsh-oi-loadMore {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  padding: 10px 12px 0;
}
.dsh-oi-loadMoreError {
  color: var(--dsw-alias-state-error-primary);
  font: var(--dsw-font-xxs-12);
  margin: 8px 0 0;
  padding: 0 12px;
}
.dsh-oi-loadMoreNote {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
}
.dsh-oi-bulkBar {
  align-items: center;
  background: var(--dsw-alias-bg-layer-1);
  border-radius: var(--dsw-radius-md);
  display: flex;
  flex-wrap: wrap;
  font: var(--dsw-font-xxs-12);
  gap: 8px;
  margin-bottom: 8px;
  padding: 6px 8px;
}
.dsh-oi-bulkBar > span {
  color: var(--dsw-alias-label-secondary);
  margin-inline-end: auto;
}
.dsh-oi-rowCheck {
  flex: none;
  font-size: 0;
  gap: 0;
}
.dsh-oi-noticeLine {
  align-items: center;
  color: var(--dsw-alias-label-secondary);
  display: flex;
  flex-wrap: wrap;
  font: var(--dsw-font-xxs-12);
  gap: 8px;
  padding: 0 2px 12px;
}
.dsh-oi-fyi {
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  display: flex;
  flex-direction: column;
  margin-top: 16px;
  padding-top: 8px;
}
.dsh-oi-listCaption {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
  margin: 0;
  padding: 0 2px 10px;
}
.dsh-oi-shortcutHint {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxxs-11);
  margin: 0;
  padding: 12px 2px 0;
  text-align: center;
}
@container dsh-oi-page (min-width: 640px) {
  .dsh-oi-search { max-width: 260px; }
  .dsh-oi-back { display: none; }
  .dsh-oi-inlineDetail { display: block; padding: 12px 14px; }
}
@container dsh-oi-page (min-width: 880px) {
  .dsh-oi-columns {
    display: grid;
    grid-template-columns: minmax(320px, 400px) minmax(0, 1fr);
  }
  .dsh-oi-listColumn {
    border-inline-end: 0.5px solid var(--dsw-alias-border-l1);
  }
  .dsh-oi-detailColumn {
    display: block;
    padding-inline-start: 16px;
  }
  .dsh-oi-detail {
    height: 100%;
    min-height: 0;
  }
  .dsh-oi-detailScroll {
    flex: 1 1 auto;
    overflow-y: auto;
    padding-bottom: 16px;
  }
  .dsh-oi-detailColumn {
    padding-bottom: 0;
  }
  .dsh-oi-inlineDetail { display: none; }
}
@container dsh-oi-page (max-width: 639px) {
  .dsh-oi-page[data-selected='true'] .dsh-oi-listColumn { display: none; }
  /* The pushed detail owns the whole page: body scrolls, footer pinned. */
  .dsh-oi-page[data-selected='true'] .dsh-oi-detailColumn {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    padding-bottom: 0;
  }
  .dsh-oi-page[data-selected='true'] .dsh-oi-detail {
    height: 100%;
    min-height: 0;
  }
  .dsh-oi-page[data-selected='true'] .dsh-oi-detailScroll {
    flex: 1 1 auto;
    overflow-y: auto;
    padding-bottom: 16px;
  }
  .dsh-oi-page[data-pushed='true'] .dsh-oi-back { display: none; }
  .dsh-oi-inlineDetail { display: none; }
}
@container dsh-oi-page (min-width: 880px) {
  /* Column-aligned page bar (OD-17 exception, round-4): the second bar row uses
     the master-detail grid so the tab strip and the list header's filters sit
     over the list column, and the rule continues the list/detail divider. */
  .dsh-oi-tabsRow {
    display: grid;
    grid-template-columns: minmax(320px, 400px) minmax(0, 1fr);
  }
  .dsh-oi-tabsCell {
    border-inline-end: 0.5px solid var(--dsw-alias-border-l1);
    min-width: 0;
    padding-inline-end: 16px;
  }
  .dsh-oi-tabsCell .dsh-oi-tabs {
    flex: 1 1 auto;
    max-width: none;
    width: 100%;
  }
  .dsh-oi-controls {
    padding-inline-start: 16px;
  }
}
@container dsh-oi-pagebar (max-width: 639.98px) {
  .dsh-oi-tabs { max-width: 100%; }
  .dsh-oi-tabs [role='tab'] { padding-inline: 8px; }
}
@container dsh-oi-pagebar (max-width: 599.98px) {
  .dsh-oi-page[data-phone='true'] .dsh-oi-tabsRow > .dsh-oi-tabsCell {
    flex: 0 1 auto;
  }
  .dsh-oi-tabsRow { gap: 6px; }
  .dsh-oi-tabsRow > :first-child {
    flex: 1 0 100%;
    min-width: 0;
  }
  .dsh-oi-tools { margin-inline-start: auto; }
  .dsh-oi-controls { gap: 8px; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-oi-pageBar { transition: none; }
  .dsh-oi-skeletonRow { animation: none; }
}
@media (pointer: coarse) {
  .dsh-oi-search input { font-size: 16px; }
}
`

/** Item row and detail-pane rules. */
export const ROW_STYLES = `
.dsh-oi-row {
  background: var(--dsw-alias-settings-card-fill);
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  box-sizing: border-box;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
  justify-content: center;
  min-height: 76px;
  padding: 10px 14px;
}
@media (hover: hover) {
  .dsh-oi-row:not([data-selected='true']):hover {
    border-color: var(--dsw-alias-border-l3);
  }
}
.dsh-oi-row[data-selected='true'] {
  border-color: var(--dsw-alias-state-business-primary);
  box-shadow: inset 2px 0 0 var(--dsw-alias-state-business-primary);
}
.dsh-oi-rowTop {
  align-items: center;
  display: flex;
  gap: 8px;
  min-height: 20px;
  min-width: 0;
}
.dsh-oi-grade {
  align-items: center;
  display: inline-flex;
  flex: 0 0 6px;
  justify-content: center;
  width: 6px;
}
.dsh-oi-grade[data-severity='2'] .dsh-oi-gradeDot {
  color: var(--dsw-alias-state-business-primary);
}
.dsh-oi-rowSelect {
  background: none;
  border: 0;
  color: inherit;
  cursor: pointer;
  display: block;
  flex: 1 1 auto;
  font: inherit;
  min-width: 0;
  padding: 0;
  text-align: start;
}
.dsh-oi-rowSelect:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dsh-oi-rowTitle {
  color: var(--dsw-alias-label-primary);
  display: block;
  font: var(--dsw-font-xs-13);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-oi-waiting {
  color: var(--dsw-alias-label-tertiary);
  flex: none;
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: tabular-nums;
  margin-inline-start: auto;
  white-space: nowrap;
}
.dsh-oi-rowBottom {
  align-items: center;
  display: flex;
  gap: 8px;
  min-height: 28px;
  min-width: 0;
}
.dsh-oi-rowMeta {
  align-items: center;
  color: var(--dsw-alias-label-tertiary);
  display: flex;
  flex: 1 1 auto;
  font: var(--dsw-font-xxs-12);
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.dsh-oi-kindMark {
  align-items: center;
  color: var(--dsw-alias-label-secondary);
  display: inline-flex;
  flex: none;
  gap: 4px;
}
.dsh-oi-kindTag {
  gap: 4px;
}
.dsh-oi-kindGlyph {
  align-items: center;
  color: inherit;
  display: inline-flex;
}
.dsh-oi-rowTurn {
  color: var(--dsw-alias-label-tertiary);
  flex: none;
  font: var(--dsw-font-xxxs-11);
  white-space: nowrap;
}
.dsh-oi-rowActions {
  align-items: center;
  display: flex;
  flex: none;
  gap: 6px;
  margin-inline-start: auto;
}
.dsh-oi-rowChevron {
  align-items: center;
  color: var(--dsw-alias-label-tertiary);
  display: inline-flex;
  flex: none;
  margin-inline-start: auto;
}
.dsh-oi-optionList {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dsh-oi-option {
  align-items: center;
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-md);
  cursor: pointer;
  display: flex;
  gap: 8px;
  padding: 8px 10px;
}
@media (hover: hover) {
  .dsh-oi-option:not([data-selected='true']):hover {
    background: var(--dsw-alias-bg-layer-1);
  }
}
.dsh-oi-option[data-selected='true'] {
  background: var(--dsw-alias-bg-layer-1);
  border-color: var(--dsw-alias-state-business-primary);
}
.dsh-oi-option[data-disabled='true'] {
  cursor: default;
  opacity: 0.6;
}
.dsh-oi-optionInput {
  height: 1px;
  opacity: 0;
  position: absolute;
  width: 1px;
}
.dsh-oi-optionDot {
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 50%;
  box-sizing: border-box;
  corner-shape: round;
  flex: none;
  height: 16px;
  width: 16px;
}
.dsh-oi-option[data-selected='true'] .dsh-oi-optionDot {
  background: var(--dsw-alias-state-business-primary);
  border-color: var(--dsw-alias-state-business-primary);
  box-shadow: inset 0 0 0 3px var(--dsw-alias-bg-base);
}
.dsh-oi-optionInput:focus-visible + .dsh-oi-optionDot {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
}
.dsh-oi-optionText {
  color: var(--dsw-alias-label-primary);
  flex: 1 1 auto;
  font: var(--dsw-font-xs-13);
  overflow-wrap: anywhere;
}
.dsh-oi-optionRecommended {
  flex: none;
}
.dsh-oi-rowEvidence {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 0 0 20px;
}
.dsh-oi-rowQuote {
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  border-inline-start: 2px solid var(--dsw-alias-label-caption);
  color: var(--dsw-alias-label-secondary);
  display: -webkit-box;
  font: var(--dsw-font-xxs-12);
  margin: 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  padding-inline-start: 8px;
}
.dsh-oi-delivery {
  align-items: center;
  display: inline-flex;
  flex: none;
  font: var(--dsw-font-xxxs-11);
  gap: 4px;
}
.dsh-oi-delivery--ok { color: var(--dsw-alias-state-success-primary); }
.dsh-oi-delivery--pending { color: var(--dsw-alias-state-business-primary); }
.dsh-oi-delivery--failed { color: var(--dsw-alias-state-error-primary); }
.dsh-oi-detail {
  display: flex;
  flex-direction: column;
  max-width: 600px;
}
.dsh-oi-detailScroll {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
}
.dsh-oi-detailHeader {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dsh-oi-detailHead {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.dsh-oi-detailTitle {
  font: var(--dsw-font-base-strong-16);
  margin: 0;
}
.dsh-oi-detailMeta {
  color: var(--dsw-alias-label-tertiary);
  display: flex;
  flex-wrap: wrap;
  font: var(--dsw-font-xxs-12);
  gap: 4px 10px;
  margin: 0;
}
.dsh-oi-detailBody {
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xs-13);
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.dsh-oi-detailQuote {
  border-inline-start: 2px solid var(--dsw-alias-label-caption);
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xs-13);
  margin: 0;
  overflow-wrap: anywhere;
  padding-inline-start: 12px;
  white-space: pre-wrap;
}
.dsh-oi-inlineCode {
  background: var(--dsw-alias-markdown-inline-code);
  border-radius: var(--dsw-radius-sm);
  font: var(--dsw-font-markdown-code);
  padding: 0 3px;
}
.dsh-oi-detailSection {
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 16px;
}
.dsh-oi-detailLabel {
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
  font-weight: 500;
  margin: 0;
}
.dsh-oi-detailNote {
  min-height: 72px;
  width: 100%;
}
.dsh-oi-detailActions {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.dsh-oi-detailFooter {
  background: var(--dsw-alias-bg-base);
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  display: flex;
  flex-direction: column;
  flex: none;
  gap: 8px;
  padding: 12px 0;
}
.dsh-oi-detailFooterActions {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: space-between;
}
.dsh-oi-detailFooterQuiet {
  align-items: center;
  display: flex;
  gap: 4px;
}
.dsh-oi-detailWake {
  margin: 0;
}
.dsh-oi-detailFailure {
  color: var(--dsw-alias-state-error-primary);
  font: var(--dsw-font-xxs-12);
}
`

/**
 * Settings → Open Items sheet: one section column and the two preference rows.
 * The Settings shell owns the panel, nav and content padding; this sheet follows
 * the native settings row rhythm (label/description left, control right, 0.5px
 * l1 separators) and the theme's typography roles (no literal weights above the
 * token's own).
 */
export const SETTINGS_STYLES = `
.dsh-oi-settings {
  color: var(--dsw-alias-label-primary);
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
  padding: 8px 0;
}
.dsh-oi-settings__title {
  font: var(--dsw-font-l-20);
  margin: 0;
}
.dsh-oi-settings__intro {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xs-13);
  margin: 0;
}
.dsh-oi-settings__group {
  display: flex;
  flex-direction: column;
  margin-top: 8px;
}
.dsh-oi-settings__row {
  align-items: center;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  display: flex;
  gap: 8px;
  padding: 16px 0;
}
.dsh-oi-settings__row:last-child { border-bottom: none; }
.dsh-oi-settings__rowText {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding-right: 48px;
}
@media (max-width: 767px) {
  .dsh-oi-settings__rowText { padding-right: 16px; }
}
.dsh-oi-settings__rowTitle {
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-s-14);
}
.dsh-oi-settings__rowDesc {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
}
.dsh-oi-settings__control {
  align-items: center;
  display: inline-flex;
  flex: none;
  gap: 8px;
}
.dsh-oi-settings__status {
  align-items: center;
  color: var(--dsw-alias-label-tertiary);
  display: flex;
  font: var(--dsw-font-xxs-12);
  gap: 8px;
  margin: 4px 0 0;
}
.dsh-oi-settings__status--warn { color: var(--dsw-alias-state-warn-primary); }
.dsh-oi-settings__status--error { color: var(--dsw-alias-state-error-primary); }
`

/** Sidebar nav icon rules: the icon owns its new-items dot (OD-16: dot only). */
export const NAV_STYLES = `
.dsh-oi-nav {
  align-items: center;
  display: inline-flex;
  justify-content: center;
  position: relative;
}
.dsh-oi-navDot {
  background: var(--dsw-alias-state-warn-primary);
  border-radius: 50%;
  corner-shape: round;
  height: 6px;
  position: absolute;
  right: -4px;
  top: -2px;
  width: 6px;
}
`

/** Styles of the Resolved tab (register), the resolved detail and the export dialog content. */
export const REGISTER_STYLES = `
.dsh-oi-register {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 24px;
}
.dsh-oi-register .dsh-oi-banner {
  margin-inline: 0;
  max-width: none;
  width: auto;
}
.dsh-oi-registerSummary {
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
  margin: 0;
  padding: 0 2px;
}
.dsh-oi-registerBar {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 2px;
}
.dsh-oi-registerBar .dsh-oi-search {
  flex: 1 1 180px;
  max-width: 260px;
  min-width: 140px;
  width: auto;
}
.dsh-oi-registerChip {
  flex: none;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-oi-regBand {
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: relative;
}
.dsh-oi-regBandTitle {
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
  font-weight: 500;
  letter-spacing: 0.04em;
  margin: 0;
  padding: 0 2px;
  text-transform: uppercase;
}
.dsh-oi-regBandNote {
  color: var(--dsw-alias-label-tertiary);
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
}
.dsh-oi-regDay {
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: relative;
}
.dsh-oi-regDayTitle {
  align-items: baseline;
  color: var(--dsw-alias-label-secondary);
  display: flex;
  font: var(--dsw-font-xxs-12);
  font-weight: 500;
  letter-spacing: 0.04em;
  margin: 12px 0 0;
  padding: 0 2px;
  text-transform: uppercase;
}
.dsh-oi-regDayCount {
  color: var(--dsw-alias-label-tertiary);
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
}
.dsh-oi-regRows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.dsh-oi-regRow {
  background: var(--dsw-alias-settings-card-fill);
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 9px 11px;
}
@media (hover: hover) {
  .dsh-oi-regRow:not([data-selected='true']):hover {
    border-color: var(--dsw-alias-border-l3);
  }
}
.dsh-oi-regRow[data-selected='true'] {
  border-color: var(--dsw-alias-state-business-primary);
}
.dsh-oi-regRowTop {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.dsh-oi-regGlyph {
  align-items: center;
  color: var(--dsw-alias-label-secondary);
  display: inline-flex;
}
.dsh-oi-regGlyph[data-tone='dismissed'] { opacity: 0.6; }
.dsh-oi-regGlyph[data-tone='in-flight'] { color: var(--dsw-alias-state-business-primary); }
.dsh-oi-regGlyph[data-tone='automatic'] { color: var(--dsw-alias-label-tertiary); }
.dsh-oi-regSource {
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
}
.dsh-oi-regTime {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
  font-variant-numeric: tabular-nums;
}
.dsh-oi-regSelect {
  background: none;
  border: 0;
  color: inherit;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0;
  text-align: left;
  width: 100%;
}
.dsh-oi-regSelect:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dsh-oi-regDecision {
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xs-13);
  font-weight: 500;
  overflow-wrap: anywhere;
}
.dsh-oi-regTitle {
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xs-13);
  overflow-wrap: anywhere;
}
.dsh-oi-regMeta {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
  margin: 2px 0 0;
  overflow-wrap: anywhere;
}
.dsh-oi-regSession,
.dsh-oi-regOpen {
  background: none;
  border: 0;
  color: var(--dsw-alias-state-business-primary);
  cursor: pointer;
  font: inherit;
  padding: 0;
  text-decoration: none;
}
@media (hover: hover) {
  .dsh-oi-regSession:hover,
  .dsh-oi-regOpen:hover { text-decoration: underline; }
}
.dsh-oi-regSession:focus-visible,
.dsh-oi-regOpen:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.dsh-oi-regDetector code,
.dsh-oi-regFactValue code,
.dsh-oi-regAckLine code,
.dsh-oi-detailMeta code {
  font-family: var(--ds-font-family-code);
  font-size: inherit;
}
.dsh-oi-regDetector {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
  margin: 2px 0 0;
}
.dsh-oi-regAck {
  font: var(--dsw-font-xxs-12);
  margin: 2px 0 0;
}
.dsh-oi-regAck--ok { color: var(--dsw-alias-state-success-primary); }
.dsh-oi-regAck--pending { color: var(--dsw-alias-state-business-primary); }
.dsh-oi-regAck--none { color: var(--dsw-alias-label-tertiary); }
.dsh-oi-regMore {
  display: flex;
  justify-content: center;
  padding: 12px 0;
}
.dsh-oi-regDetail {
  overflow-wrap: anywhere;
}
.dsh-oi-regOutcome {
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
  font-weight: 500;
}
.dsh-oi-regDetailSource {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
}
.dsh-oi-regBanner {
  border-radius: var(--dsw-radius-sm);
  font: var(--dsw-font-xxs-12);
  margin: 8px 0;
  padding: 8px 10px;
}
.dsh-oi-regBanner--archived {
  background: var(--dsw-alias-bg-layer-2);
  border: 0.5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
}
.dsh-oi-regBanner--inFlight {
  border: 1px solid var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-label-secondary);
}
.dsh-oi-regDecisionText {
  font: var(--dsw-font-s-14);
  margin: 0;
  white-space: pre-wrap;
}
.dsh-oi-regAckLine {
  color: var(--dsw-alias-label-secondary);
  margin: 0;
}
.dsh-oi-regFact {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin: 0;
}
.dsh-oi-regFactLabel {
  color: var(--dsw-alias-label-tertiary);
  flex: 0 0 96px;
  font: var(--dsw-font-xxxs-11);
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.dsh-oi-regFactValue {
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
  min-width: 0;
}
.dsh-oi-regNotice {
  border-radius: var(--dsw-radius-sm);
  cursor: pointer;
  font: var(--dsw-font-xxs-12);
  margin: 8px 0;
  padding: 8px 10px;
}
.dsh-oi-regNotice--ok {
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-state-success-primary);
}
.dsh-oi-regNotice--error {
  border: 1px solid var(--dsw-alias-state-error-primary);
}
.dsh-oi-regHistory {
  margin-top: 12px;
}
.dsh-oi-regHistoryList {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
  margin: 6px 0 0;
  padding-left: 18px;
}
.dsh-oi-regHistoryDetail {
  color: var(--dsw-alias-label-tertiary);
}
.dsh-oi-dialogLegend {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxxs-11);
  font-weight: 500;
  letter-spacing: 0.04em;
  margin: 0;
  text-transform: uppercase;
}
.dsh-oi-dialogCheck {
  align-self: flex-start;
}
.dsh-oi-dialogNote {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
  margin: 4px 0 0;
}
.dsh-oi-dialogNote--deterministic {
  color: var(--dsw-alias-label-secondary);
}
.dsh-oi-dialogResult {
  border-radius: var(--dsw-radius-sm);
  font: var(--dsw-font-xxs-12);
  margin: 4px 0 0;
  padding: 8px 10px;
}
.dsh-oi-dialogResult--ok {
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-state-success-primary);
}
.dsh-oi-dialogResult--error {
  border: 1px solid var(--dsw-alias-state-error-primary);
}
`

/** Every stylesheet the client half installs. */
export const CLIENT_STYLES = `${PAGE_STYLES}\n${ROW_STYLES}\n${SETTINGS_STYLES}\n${NAV_STYLES}\n${REGISTER_STYLES}`
