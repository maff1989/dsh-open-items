/**
 * Local slot-contract declaration for the Settings seat this plugin fills
 * (`settings.section`).
 *
 * The runtime declares the slot — the shipped Web composition mounts
 * `ui-settings` — but its TypeScript contract lives in
 * `@deepseek-ai/dsh-client-ui-settings`, a package this plugin does not depend
 * on (same reasoning and shape as the in-repo `dsh-highlights` precedent, its
 * workaround W15). The published contract is restated here instead: a
 * root-scoped ordered list whose section receives the shell's `close`
 * affordance.
 *
 * @module dsh-open-items/client/ui/settings/slot-contracts
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One settings page per list entry (shell owns nav and modal state). */
    'settings.section': {
      kind: 'list'
      scope: 'root'
      owner: {
        /** Close the settings panel (the shell owns the open state). */
        readonly close: () => void
      }
    }
  }
}

export {}
