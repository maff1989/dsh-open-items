/**
 * Plugin-owned stylesheet for the in-session card.
 *
 * rc2 style pass (S-15): the card uses the shipped action-card material and
 * tool-card rhythm — 0.5px hairline, R16 enclosure, base surface, 4px tool-row
 * margin, 13px content scale, section dividers from the tool-card language.
 * No accent border, no elevation, no colour literals.
 *
 * Round-4 consistency pass: the answer choices are the shared native-radio list
 * (its geometry lives in the client stylesheet because the page and the panel
 * own it, not the card), the action row follows the page's answer form — quiet
 * decision left, navigation/write actions right with the primary last — and the
 * card's internal rhythm moved to the 8/12 steps so it reads as the same
 * product as the page.
 *
 * @module dsh-open-items/client/ui/card/card-styles
 */

/** Card frame, item blocks, controls and receipt/fallback lines. */
export const CARD_STYLES = `
.dsh-oi-card {
  background: var(--dsw-alias-bg-base);
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg);
  box-sizing: border-box;
  color: var(--dsw-alias-label-primary);
  display: flex;
  flex-direction: column;
  font: var(--dsw-font-xs-13);
  gap: 12px;
  margin: 4px 0 4px 4px;
  max-width: 100%;
  padding: 12px 16px;
}
.dsh-oi-card--fallback {
  gap: 4px;
}
.dsh-oi-cardHead {
  align-items: baseline;
  display: flex;
  gap: 8px;
  min-height: 18px;
}
.dsh-oi-cardTool {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxxs-11);
  font-weight: 500;
  letter-spacing: 0.01em;
}
.dsh-oi-cardCount {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxxs-11);
  margin-inline-start: auto;
  white-space: nowrap;
}
.dsh-oi-cardItems {
  display: flex;
  flex-direction: column;
  gap: 0;
  list-style: none;
  margin: 0;
  padding: 0;
}
.dsh-oi-cardItem {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 0;
}
.dsh-oi-cardItem:first-child {
  border-top: 0;
  padding-top: 2px;
}
.dsh-oi-cardItemHead {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.dsh-oi-cardTitle {
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xs-13);
  font-weight: 500;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dsh-oi-cardDetail {
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
  margin: 0;
  overflow-wrap: anywhere;
}
.dsh-oi-cardControls,
.dsh-oi-cardConflict,
.dsh-oi-cardDisabled {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dsh-oi-cardTextField {
  width: 100%;
}
.dsh-oi-cardActions {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.dsh-oi-cardActionsPrimary {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-inline-start: auto;
}
.dsh-oi-cardNote {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
  overflow-wrap: anywhere;
}
.dsh-oi-cardNote--warn { color: var(--dsw-alias-state-warn-label); }
.dsh-oi-cardNote--failed { color: var(--dsw-alias-state-error-primary); }
.dsh-oi-cardReceipt {
  align-items: baseline;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
}
.dsh-oi-cardReceiptText {
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
  overflow-wrap: anywhere;
}
.dsh-oi-cardReceiptAnswer {
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xxs-12);
  overflow-wrap: anywhere;
}
.dsh-oi-cardReceiptOpen {
  flex: none;
  margin-inline-start: auto;
}
.dsh-oi-cardFooter {
  align-items: center;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 8px;
}
.dsh-oi-cardFooterText {
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxxs-11);
}
.dsh-oi-cardFooterActions {
  display: flex;
  gap: 8px;
  margin-inline-start: auto;
}
.dsh-oi-cardSummary {
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
  margin: 0;
  overflow-wrap: anywhere;
}
@media (pointer: coarse) {
  .dsh-oi-cardTextField { font-size: 16px; }
}
`
