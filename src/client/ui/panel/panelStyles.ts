/**
 * Stylesheet of the session panel tab body.
 *
 * Round-4 consistency pass: the tab now follows the refined page anatomy in its
 * narrow seat — title first, one quiet meta line (kind mark · waiting · delivery
 * state), actions under the title, sentence-case section labels and the 8/12/16
 * rhythm. Filter capsules, the Menu overflow, the "Resolved here" disclosure and
 * the cross-session footer stay as they were (S-16); surfaces and materials
 * belong to the dock and the primitives, so this sheet owns rhythm, weights
 * <= 500 and the 13px scale only.
 *
 * The tab body is a fixed clipped box, so the body owns the scroll.
 *
 * @module dsh-open-items/client/ui/panel/panelStyles
 */
export const PANEL_STYLES = `
.dsh-oi-panel {
  box-sizing: border-box;
  color: var(--dsw-alias-label-primary);
  display: flex;
  flex-direction: column;
  font: var(--dsw-font-xs-13);
  height: 100%;
  min-height: 0;
}
.dsh-oi-panelHeader {
  display: flex;
  flex-direction: column;
  flex: none;
  gap: 8px;
  padding: 12px 12px 8px;
}
.dsh-oi-panelTitleRow {
  align-items: center;
  display: flex;
  gap: 8px;
  min-width: 0;
}
.dsh-oi-panelTitle {
  flex: 1 1 auto;
  font: var(--dsw-font-s-14);
  font-weight: 500;
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-oi-panelCount {
  flex: none;
  line-height: 0;
}
.dsh-oi-panelRefresh,
.dsh-oi-panelMore {
  flex: none;
}
.dsh-oi-panelFilters {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.dsh-oi-panelPill {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-oi-panelBanner {
  margin: 0 12px 8px;
}
.dsh-oi-panelBody {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0 8px 12px;
}
.dsh-oi-panelSkeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 0 0;
}
.dsh-oi-panelSections {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-top: 4px;
}
.dsh-oi-panelEmptyLine {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
  margin: 0 4px;
}
.dsh-oi-panelSection {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dsh-oi-panelSectionTitle {
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
  font-weight: 500;
  margin: 0;
  padding: 0 4px 4px;
}
.dsh-oi-panelList {
  display: flex;
  flex-direction: column;
  gap: 2px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.dsh-oi-panelRow {
  border-radius: var(--dsw-radius-md);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 8px;
}
@media (hover: hover) {
  .dsh-oi-panelRow:hover { background: var(--dsw-alias-interactive-bg-hover); }
}
.dsh-oi-panelRow[data-flash='true'] {
  animation: dsh-oi-panel-flash 1.2s ease-out;
}
@keyframes dsh-oi-panel-flash {
  0% { background-color: var(--dsw-alias-interactive-bg-hover); }
  100% { background-color: transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-oi-panelRow[data-flash='true'] { animation: none; background-color: var(--dsw-alias-interactive-bg-hover); }
}
.dsh-oi-panelRowHead {
  align-items: flex-start;
  display: flex;
  gap: 6px;
  min-width: 0;
}
.dsh-oi-panelRowState {
  align-items: center;
  display: inline-flex;
  flex: none;
  height: 20px;
}
.dsh-oi-panelRowDot {
  display: inline-flex;
}
.dsh-oi-panelRowGlyph {
  flex: none;
  line-height: 0;
}
.dsh-oi-panelRowTitle {
  background: none;
  border: 0;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  display: -webkit-box;
  flex: 1 1 auto;
  font: var(--dsw-font-xs-13);
  font-weight: 500;
  line-height: 20px;
  margin: 0;
  min-width: 0;
  overflow: hidden;
  padding: 0;
  text-align: start;
  white-space: normal;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.dsh-oi-panelRowTitle:focus-visible {
  border-radius: var(--dsw-radius-sm);
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.dsh-oi-panelRowMeta {
  align-items: center;
  color: var(--dsw-alias-label-tertiary);
  display: flex;
  flex-wrap: wrap;
  font: var(--dsw-font-xxs-12);
  gap: 0 6px;
  margin: 0;
  min-width: 0;
  padding-inline-start: 12px;
}
.dsh-oi-panelRowMeta > .dsh-oi-kindMark {
  color: var(--dsw-alias-label-secondary);
  flex: none;
}
.dsh-oi-panelRowTime {
  font: var(--dsw-font-xxxs-11);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dsh-oi-panelRowCandidate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-oi-panelActions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-inline-start: 12px;
}
.dsh-oi-panelOptions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-inline-start: 12px;
}
.dsh-oi-panelReply {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-inline-start: 12px;
}
.dsh-oi-panelInput {
  width: 100%;
}
.dsh-oi-panelReplyActions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.dsh-oi-panelRowNote {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
  margin: 0;
  padding-inline-start: 12px;
}
.dsh-oi-panelRowNote--failed {
  color: var(--dsw-alias-state-error-primary);
}
.dsh-oi-panelLimit {
  align-items: center;
  color: var(--dsw-alias-label-tertiary);
  display: flex;
  font: var(--dsw-font-xxs-12);
  gap: 8px;
  justify-content: space-between;
  padding: 8px 4px;
}
.dsh-oi-panelResolved {
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  padding-top: 12px;
}
.dsh-oi-panelResolvedAll {
  flex: none;
  white-space: nowrap;
}
.dsh-oi-panelFooter {
  align-items: center;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  display: flex;
  flex: none;
  gap: 8px;
  padding: 8px 12px 12px;
}
.dsh-oi-panelFooterCount {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
  margin-inline-end: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-oi-panelEmpty {
  margin-top: 16px;
}
@media (pointer: coarse) {
  .dsh-oi-panelInput input { font-size: 16px; }
}
`
