# ADR 001 — Compose published seams; never fork the harness

**Date:** 2026-11-15 · **Context(s):** all contexts (Surfaces, Capture, Answering & Delivery)

## Context

The product needs cross-session memory and in-place answering inside a harness that offers
public extension points — UI slots, services, a fetch route, a tool registry, a storage domain,
prompt sections, ask/approval waterfalls — but not every capability the product wants. Some
seams are private, undocumented, or closed (the pending-interaction indicator accepts only its
own kinds; a generic RPC channel needs a service an out-of-tree plugin cannot reach; the session
log's event vocabulary is a static in-repo allow-list).

An in-tree fork would make every seam available and would also make the plugin a different
product: it would ship a patched harness, own the upgrade burden, and break the install story
("install into the current profile, no fork").

## Decision

We will ship as an out-of-tree package and compose only published seams. When a capability
requires a private seam, we refuse it, defer it behind the seam that would make it honest, or
build a smaller in-product behaviour — we never patch or replace the harness.

## Why

- An out-of-tree plugin can be installed, upgraded and uninstalled without touching the
  harness; that is the adoption model and the safety model at once.
- Reaching into private seams is how plugins corrupt sessions and break on upgrade; the one
  capability we could not get honestly (a custom attention kind) would also have silently
  suppressed Escape-to-stop for other users.
- The trade-off is real: some capabilities wait for an upstream seam instead of shipping. We
  accept the wait because the alternative is a product that cannot be trusted with a user's
  sessions.

## Alternatives considered

- **Fork the harness in-tree** — rejected: different product, upgrade burden, install model lost.
- **Patch the harness's own UI or publish a custom pending-interaction kind** — rejected: the indicator is
  a closed switch; repurposing another kind to light it would be a lie, and publishing one
  suppresses one of the harness's built-in safety behaviours.
- **Use a private RPC/remote channel for the browser half** — rejected: not reachable from an
  out-of-tree fiber; the proven pattern is one exact fetch route.
- **Write plugin events into the session log** — rejected separately (ADR 002).

## Consequences

- Every optional seam must be feature-detected, and its absence must degrade visibly rather
  than fabricate state.
- Surface composition is constrained to additive slots; where no slot exists, the capability is
  deferred (workspace entry points, session pip, header chip).
- The plugin's contract with the harness is version-sensitive: it declares the runtime it
  targets, tolerates client/host skew, and reports incompatibility honestly instead of pretending.
- A future capability that truly needs a private seam is a product decision to lobby upstream,
  not a licence to patch.
