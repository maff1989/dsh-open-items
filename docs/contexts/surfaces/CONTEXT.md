# Surfaces — context

**Kind:** supporting · **Date:** 2026-11-15

## Purpose

Surfaces answers the question the user actually asks: *where do I meet the register, and what
must that place never lie about?* The work happens in conversations, but a conversation scrolls,
is one of many, and is a poor place to hold decisions that outlive it. This context owns the
places where those decisions are made visible and can be acted on — the Open Items page, the
card raised inside a conversation, the per-session panel, and the settings section — and the
standard of honesty they are held to: what a surface may claim, when it must say "I cannot
tell", and why an empty list is a statement that must be explained rather than a blank.

Surfaces is the product's edge. It holds no item semantics of its own: it renders one published
read model, sends intents through one published reply contract, and turns every refusal into
words the user can act on. A reader should be able to trust what a surface says at a glance,
including when it says that something is unknown.

## Position in the map

Surfaces is a **supporting context** at the outside of the map. It is a **customer** of the
Attention Register's published read model, of Answering & Delivery's published reply contract,
and of Model Contract & Consent's settings contract; it consumes the route protocol published
by the host half. Nothing inside the domain depends on a surface: no inner context may use a
page, row, tab or toast concept. The graph is in [CONTEXT_MAP.md](../../CONTEXT_MAP.md); the
session/turn/workspace facts are its shared kernel.

- **The browser half is authoritative for rendering and interaction.** The host half exposes the
  read model and one write route; section composition, grouping, focus, copy, layout and export
  UX belong to this context.
- **The browser half can be newer than the host half.** It reloads independently, so a surface
  must tolerate a host that answers a different protocol or data version and say so truthfully
  instead of rendering a confident stale list.
- **The DSH Web client shell is outside the domain.** It owns navigation, the settings container,
  locale and keyboard services and the UI primitives. Surfaces composes those; it does not
  replace them or their focus, motion and modal behaviour.

## What this context owns

- **The surface set and where each one lives:** the page in the main content area, the navigation
  row and its new-item dot, the in-session card at the tool row, the per-session right-panel tab,
  the settings section, and the export dialog.
- **Surface vocabulary:** *surface, inbox, page, nav row, dot, section, grouping, lens, facet,
  row, detail pane, in-flight band, card, panel, settings section, freshness, revision, degrade
  truthfully, export* (meanings in [UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md)).
- **The interaction contract of each surface:** what selecting does versus opening; what a click
  sends; which control is the single answer control on a screen; which decisions are one click
  and which require explicit confirmation; where a handoff leaves one surface for another.
- **The page's four sections, grouping, the workspace lens and the workspace facet**, and the rule
  that all of them are views over one shared list/detail region.
- **Freshness policy for the browser half:** which events cause a re-read, how a surface keeps a
  last-good snapshot readable offline, and that a surface never patches its list locally.
- **The presentation contract for a claim:** the difference between applied, sent, recorded,
  failed and unknown, and that a claim is made only when the evidence exists.
- **The export surface:** the dialog, the options it offers, and the determinism contract.
- **Accessibility and internationalisation as contracts:** keyboard reachability, focus after an
  action, status never carried by colour alone, live-region announcements, one locale namespace
  with complete dictionaries, and no concatenated sentences.
- **The settings section's presentation:** immediate compare-and-set writes, no Save button, no
  optimistic UI, Host truth shown — recorded in
  [specs/settings-section.md](specs/settings-section.md). *What a permission means* belongs to Model
  Contract & Consent.

## What this context does not own

- **Item semantics** — kinds, tier, severity, blocking, state, resolution, acknowledgement, dedupe,
  the Needs-you predicate's definition, retention and caps: Attention Register. Surfaces applies
  the predicate and renders records; it never reinterprets them.
- **What a reply may claim and how it travels** — the answer matrix, delivery tracks, delivery
  state, failure codes, wake rules and approval outcomes: Answering & Delivery. A surface shows
  the control and the claim; it never chooses a track.
- **Permission, consent, defaults and the settings record's fields:** Model Contract & Consent.
- **Record formats, versions, compare-and-set mechanics, migration and prune:** Durability &
  Integrity.
- **Capture evidence, detector vocabulary and the candidate gate:** Capture. A surface shows the
  evidence a record carries; it never invents one.
- **The harness shell, its own question and approval cards and its UI primitives:** outside the
  domain. A surface may not create a second answer surface for an ask those cards own.
- **Acting on a session:** only Answering & Delivery settles, wakes or steers. A surface reports
  what it was told.

## Invariants

1. **Needs-you numbers are global and use one predicate.** Every Needs-you number a surface states
   — page badge, navigation label, panel heading, workspace and session counts — comes from the
   published predicate; the Candidates count is its own count, never folded into Needs you, and the
   page head states exactly those two actionable counts with a zero count hidden. Filters,
   grouping, search and the workspace lens change the list, never the counts, and two surfaces
   must never show different Needs-you numbers under the same words. *Why:* a count that moves
   when a filter moves teaches the user to distrust all of them — and a count given the wrong
   meaning teaches the same lesson more quietly.
2. **The nav dot is not a count.** The dot means "items are new since your last visit" and clears
   when the page opens; the number lives where it can be read without inventing chrome. *Why:* a
   badge and a newness marker answer different questions; conflating them makes either one wrong.
3. **An empty list is explained.** An empty section states what has been scanned, whether capture
   is still catching up, or that the surface cannot tell. A bare "nothing here" is a defect,
   because it is indistinguishable from a broken capture. *Why:* silence is the most expensive lie
   this product can tell — it looks like good news.
4. **Every claim is evidenced, and a durable claim is narrower than an immediate one.** The result
   of a write may state *applied*, *sent* or *recorded* — the outcome the host returned for that
   attempt. A later rendering — a reload, a replayed transcript row, another surface — may state
   only what the durable record proves; where the record cannot distinguish an applied answer from
   one that was only recorded, the honest rendering is the neutral in-flight state *waiting on the
   work*, never *applied* or *sent*. *Recorded* is never inferred from a delivery state, and a
   failure is named with its reason. Pending work is never presented as success. *Why:* the user's
   decision can be expensive, and a claim repeated after a reload is indistinguishable from a
   fresh lie.
5. **No local patching.** A surface renders one snapshot and re-reads; it never edits its list from
   a partial or optimistic response, and a section whose read has not landed shows loading rather
   than the previous section's rows or its empty copy. *Why:* an optimistic row is a claim without
   evidence, and a cross-section leak is a lie about which record exists.
6. **Degrade truthfully.** An unreachable host, a mismatched half, a missing capability or a failed
   download is described as what it is, with a retry, while the last good view stays readable. A
   surface never turns "unknown" into an empty list or a fake success. *Why:* a confident screen
   that is wrong is worse than an honest one that is partial.
7. **There is no second answer surface.** Each live ask or approval has exactly one place that can
   answer it, and that place owns the live request. A surface may point at it, reveal it or hand
   off to it — never duplicate its control, and never publish a custom pending-interaction kind.
   *Why:* two controls over one request is a race, and a duplicated grant is a lie about ownership.
   See [ADR 001](adrs/001-no-custom-pending-interaction-kind.md).
8. **A surface never invents domain meaning.** It does not decide that a candidate is an item, that
   a resolved record is open again, that an acknowledgement is a failure, or that a missing session
   title means the session was deleted. *Why:* rendering is the last place a rule can be silently
   changed; keep the change in the context that owns it.
9. **Accessibility and internationalisation are contracts, not polish.** Every control is keyboard
   reachable, status is carried by words or icons as well as colour, async results are announced,
   focus survives an action, and every string is locale-owned with complete dictionaries. *Why:* a
   user who cannot reach the control or read the state cannot triage.
10. **Export determinism is a promise to the reader.** The same register filter, options and export
    time produce a byte-identical file, generated locally with no network and no environment
    dependence. *Why:*
    a file that changes when nothing changed cannot be diffed or trusted, and a kept record must
    not carry traces of the browser that produced it.

## Inbound contracts

- **Read model** (Attention Register → Surfaces). One snapshot: records for the requested section,
  session and workspace rows, global counts, a revision, a paging cursor, plus capability and
  capture diagnostics. The Needs-you predicate applies identically everywhere and counts are
  independent of filters. *If the guarantee is missing* — host unreachable, version skew, absent
  capability — the surface keeps the last good snapshot readable, marks when it was read, refuses
  actions that would be false, and offers a retry. It never fabricates records or counts.
- **Reply contract** (Answering & Delivery → Surfaces). The reply payload vocabulary, the reply
  descriptor a row needs to be answerable, the click plan (settle/send plus wake cost), the outcome
  vocabulary and the failure codes. The click plan states the wake cost on **every** path that
  would resume a cold session — including the settle of a continued ask — and that resume always
  requires the user's explicit confirmation; a surface may not suppress the wake line because the
  path is a settle. *If missing* — no delivery layer, no live carrier, no capability — the controls
  are disabled **with the reason stated on the surface**, never silently inert and never optimistic.
- **Settings contract** (Model Contract & Consent → Surfaces). One versioned record, compare-and-set
  writes, defaults served without a row, a lost race returned as a value. *If missing:* a load
  failure with Retry; a write failure leaves the controls showing the last saved values.
- **Route protocol** (Host half → Browser half). One envelope, a versioned endpoint set, stable
  error codes and capability flags, with skew tolerance. *If violated:* the surface names the skew
  and asks for a restart; it does not pretend the list is current.
- **Harness client shell** (outside the domain). Additive slots, navigation, locale and keyboard
  services, and primitives that own their own focus, trap and motion behaviour. *If a seat is
  absent:* the surface has no doorway there; it does not hack around the shell.

## Outbound contracts

- **User intents.** Reply payloads with the compare-and-set version the user acted on and one
  idempotency key per attempt; dismiss/snooze/reopen/delete-forever; candidate promote/suppress;
  settings patches. *Guarantee:* one deliberate action produces at most one durable attempt, and
  every refusal becomes visible copy with a named reason and a recovery. A second click while a
  write is in flight is a no-op.
- **Surface claims.** The immediate outcome a row, detail or card may state after an action — applied
  / sent / recorded / failed — plus the delivery state and its reason; and the narrower claim a
  later rendering may repeat from the durable record. *Guarantee:* no rendering claims more than its
  evidence, the immediate outcome and the durable claim are kept distinct, and the same words are
  used on every surface.
- **Export files.** A deterministic, local CSV, JSONL or HTML rendering of the current register
  filter, with an honest header naming the filter, record count, completeness and versions.
  *Guarantee:* byte-identical for identical input; the file layout is versioned, and rewriting or
  reordering it is a deliberate announced change.
- **Freshness signals.** The reads a surface performs: after its own writes, on focus and
  visibility return, on carrier reset, and on a slow poll while visible. *Guarantee:* no read loop
  while hidden or offline-thrashing; a hidden surface costs nothing.
- **Navigation handoffs.** "Open session", "View all in Open items", "Open in Open items" and the
  session-scoped handoffs. *Guarantee:* a handoff lands on a surface that can contain the target —
  the correct section and item, or the correct session scope — never a detail with nothing to show.

## Key concepts

Canonical definitions are in [UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md); this context is
read for the *surface* senses of them.

- **[Surface](../../UBIQUITOUS_LANGUAGE.md#6-surface-vocabulary)** — one place the user meets the
  register. Page, card, panel and settings section are four surfaces; they share a read model, not
  a component tree.
- **[Page](../../UBIQUITOUS_LANGUAGE.md#6-surface-vocabulary)** — the cross-session view; the only
  surface that shows items from more than one session at once.
- **[Nav row and dot](../../UBIQUITOUS_LANGUAGE.md#6-surface-vocabulary)** — the page's entry point;
  the dot answers "is there anything new?", never a number.
- **[Sections](../../UBIQUITOUS_LANGUAGE.md#6-surface-vocabulary)** — Needs you, Candidates,
  Snoozed, Resolved: partitions of one register by lifecycle and tier, each reading its own
  population.
- **[Grouping, lens, facet](../../UBIQUITOUS_LANGUAGE.md#6-surface-vocabulary)** — grouping by
  Session (default) or Workspace (the lens); a facet is a single-select filter over a grouping
  dimension (the workspace facet, including Ungrouped). The lens is a view mode of the page, never
  a separate route or surface.
- **[Row and detail pane](../../UBIQUITOUS_LANGUAGE.md#6-surface-vocabulary)** — the row is a
  projection for scanning; the detail owns the one answer form. Selecting is not navigating.
- **[In-flight band](../../UBIQUITOUS_LANGUAGE.md#6-surface-vocabulary)** — the top region of
  Resolved for replies that left the user with no terminal acknowledgement; period-independent,
  because a waiting answer is always relevant.
- **[Card](../../UBIQUITOUS_LANGUAGE.md#6-surface-vocabulary)** — the in-session surface at the
  `open_items` tool row: raised from a durable snapshot, hydrated to the live record. The snapshot
  is not truth; the record is.
- **[Panel](../../UBIQUITOUS_LANGUAGE.md#6-surface-vocabulary)** — the per-session right-panel tab.
  Its session scope is structural: it is handed one session and can render no other.
- **[Settings section](../../UBIQUITOUS_LANGUAGE.md#6-surface-vocabulary)** — Settings → Open Items:
  edits permission immediately; does not implement the permissioned behaviour.
- **[Freshness](../../UBIQUITOUS_LANGUAGE.md#6-surface-vocabulary)** and
  **[revision](../../UBIQUITOUS_LANGUAGE.md#6-surface-vocabulary)** — pull-based re-reads plus a
  monotonic snapshot identity, so a client can be told it holds something older than the host's
  latest. A surface renders snapshots; it never patches locally.
- **[Degrade truthfully](../../UBIQUITOUS_LANGUAGE.md#6-surface-vocabulary)** and
  **[export](../../UBIQUITOUS_LANGUAGE.md#6-surface-vocabulary)** — unavailable is described as
  unavailable with a retry, never as an empty register; export is a deterministic local rendering
  of the current register filter.
- **[Zero-item state](../../UBIQUITOUS_LANGUAGE.md#9-measures-and-predicates)** and **[honest
  failure](../../UBIQUITOUS_LANGUAGE.md#9-measures-and-predicates)** — the two rules that make the
  empty screen and the failed screen trustworthy.

## Design decisions in force

- [ADR 001 — no custom pending-interaction kind](adrs/001-no-custom-pending-interaction-kind.md):
  attention is advertised through the plugin's own surfaces, never by extending the session status
  vocabulary or by reusing a session-status kind to light a dot.
- **Four sections, one predicate, one list** — the page is one shared list/detail region filtered by
  four sections, and candidates are their own section, never counted as Needs you:
  [specs/inbox-page.md](specs/inbox-page.md).
- **The card is a view and the panel is a filtered scope** — the panel is an All / Needs you /
  Waiting filter row over its sections, with a Candidates hand-off row and a collapsed Resolved-here
  disclosure; neither surface competes with the other or with the harness-owned question and
  approval cards: [specs/in-session-surfaces.md](specs/in-session-surfaces.md).
- **The register is a journal and the export is its deterministic shadow** — read-only history,
  in-flight first, acknowledgement stated per row, a versioned file layout:
  [specs/resolved-register-and-export.md](specs/resolved-register-and-export.md).
- **A preference change is one compare-and-set write, never a staged form** — the settings section
  shows Host truth and never an optimistic value; permission semantics stay with Model Contract &
  Consent: [specs/settings-section.md](specs/settings-section.md).
- **Claims use Answering & Delivery's words everywhere** — a surface may not invent a friendlier
  synonym for applied, sent, recorded or failed.

## Deferred and open

Decisions this context deliberately has not made, each with the seam that keeps it open. The
per-spec lists hold the detail; these are the cross-surface ones.

- **Per-session doorway surfaces** — a session-row pip and a session-header chip were designed as
  doorways into the session-scoped view. No additive seat with a truthful signal exists, and the
  pending-interaction path is deliberately closed (ADR 001). *Seam:* the panel is reachable from its
  tab strip and the page from the navigation row; if the harness publishes a session-row trailing
  seat, the doorway is decided then. See [specs/in-session-surfaces.md](specs/in-session-surfaces.md).
- **Workspace entry points** — a workspace context-menu entry ("Open in Open Items") and a
  workspace-row badge. The workspace lens and facet are the supported way in. *Seam:* the lens
  already accepts a workspace scope; adding an entry point is a doorway change, not a data change.
- **A live delta channel from host to browser** — freshness is pull-based; a pushed channel would
  change the read-model contract for every surface. *Seam:* the snapshot already carries a
  revision, so a delta or staleness check can be added without changing what a surface renders.
- **Additional filters** — kind and age filters on the page, and a host-side acknowledgement/outcome
  query plus a dedupe-key lookup in the register. *Seam:* the queries already accept structured
  filters; the filter bar and the register filter row are where they would appear.
- **The rest of the keyboard map and its hint row** — option keys, open-session, focus-filter and a
  shortcut sheet are designed but not decided. *Seam:* the fixed application-key registration is one
  seam; adding a binding or a hint does not change behaviour.
- **Card and evidence presentation refinements** — card density variants, evidence reveal and
  scroll-to-transcript. *Seam:* the card payload is versioned and the panel already reveals through
  the session view; presentation can change without changing a record.

## Reading

- [specs/inbox-page.md](specs/inbox-page.md) — the cross-session page and what a reader can do there.
- [specs/in-session-surfaces.md](specs/in-session-surfaces.md) — the card and the panel, and the races
  between a model's resolution and a user's reply.
- [specs/resolved-register-and-export.md](specs/resolved-register-and-export.md) — the read-only
  register and the deterministic export.
- [specs/settings-section.md](specs/settings-section.md) — Settings → Open Items: three preference
  rows, immediate compare-and-set writes and no Save step, with permission semantics delegated to
  [Consent and egress](../model-contract/specs/consent-and-egress.md).
- [ADR 001](adrs/001-no-custom-pending-interaction-kind.md) — why the plugin does not extend the
  pending-interaction vocabulary.
- The packet's [UI.md](../../../../UI.md) is the screen-level record of these surfaces and
  [DESIGN.md](../../../../DESIGN.md) §5 their architecture; both are history and mechanics, this
  context is the intent. [a11y.md](../../a11y.md) and
  [client-foundation.md](../../client-foundation.md) are the verification and browser-half context.
- Read first in the glossary: *surface, inbox, page, nav row/dot, section, grouping/lens/facet, row,
  detail pane, in-flight band, card, panel, settings section, freshness, revision, degrade
  truthfully, export, Needs you, global counts, zero-item state, honest failure*.
- The sibling context that supplies most of this context's data is
  [Attention Register](../attention-register/CONTEXT.md).
