# ADR 001 — Model-facing surfaces are opt-in and default-off

**Date:** 2026-11-15 · **Context(s):** Model Contract & Consent (owns) · Capture · Surfaces

## Context

Open Items has one model-facing capability that must always be available: the `open_items` tool,
the only way an agent can declare what is waiting on the user. Everything else is a change of
behaviour: an instruction section telling the agent when to declare (the nudge), a context line
telling a fresh session what waits elsewhere (the runtime-context line), and a model-assisted
second opinion on inferred candidates (extraction). Those three differ in kind — instruction,
state, egress — but share one property: they change what the agent does or send bytes off the
machine, and the user did not ask for them by installing a register.

Four forces are real. Model-facing text is paid for on every turn of every session, so a plugin
that adds instruction by default taxes work it was not invited into. Egress is irreversible, and
the user may not control the deployment that configured the provider. A plugin that silently
changes model behaviour is indistinguishable from a prompt injection — the failure users are told
to watch for. Against all this stands one product fact: the register's value depends on capture
being on, and the candidate gate is what makes the founding failure — decisions buried in prose —
visible at all.

## Decision

We will keep every model-facing surface that changes what the agent does or sends bytes off-machine
off unless the user turns it on — and, for the one egressing path, unless the deployment also
configures it: the nudge defaults off, the runtime-context line would follow the same rule, and
extraction defaults off and requires both the preference and a deployment-configured provider and
model before any request is made. The declaration tool is always available because it is an offer
to declare, not an instruction to behave. The one deliberate exception is the candidate gate,
which defaults on: it is local, sends nothing, tells the agent nothing, and its output is a
candidate that never counts as attention until the user confirms it. The consent-gated set is
therefore the nudge, the runtime-context line and extraction; the always-available set is the
declaration tool, which is an offer to declare rather than an instruction; and the default-on set
is the local, confirm-first gate. The contract this decision creates is published in the
[agent-declared contract](../specs/agent-declared-contract.md) and the
[consent and egress spec](../specs/consent-and-egress.md).

## Why

The trade-off is **discoverability against surprise**, and surprise is the expensive side. A user
who never opens Settings gets a register that still learns from evidence and declarations, with no
new behaviour and no bytes leaving the machine; a user who wants more turns it on and sees the
effect immediately. The cost is discoverability — a copy and placement problem, not a reason to
make the private path the default.

The second trade-off is **precision against the founding goal**. Extraction would improve candidate
precision, but the gate must default on or the product does not address its founding failure. The
decision resolves the tension by treating inference and declaration differently from instruction
and egress: inference is local, confirm-first and visible; instruction and egress are neither, so
they are off by default. The line is drawn at what changes the agent's behaviour or sends bytes,
not at everything model-adjacent.

The third trade-off is **two keys for one path**: requiring the user's preference *and* deployment
configuration is less convenient than either alone, but a deployment that configured a provider
cannot then spend the user's conversation text, and a preference carried from another install
cannot send from a deployment that never configured a model.

## Alternatives considered

- **All model-facing surfaces default-on.** Best discoverability, lowest configuration burden.
  Rejected: it surprises the user with changed model behaviour, adds instruction tokens to every
  turn, and makes egress happen because an install exists rather than because a person said yes.
- **Everything default-off, including the candidate gate.** The purest reading of the posture.
  Rejected: it defeats the product's founding purpose, because capture is the feature; the gate is
  local, sends nothing and produces only confirm-first candidates, so the surprise it creates is
  the user's own "it's an item" choice.
- **A first-run consent dialog.** Rejected: no durable record to inspect or reverse, no honest
  defaults, no way to resolve a race, and one answer for a permission that must hold forever.

## Consequences

- Settings → Open Items must exist and be discoverable; its copy is the consent, and the extraction
  row must state the two conditions and that nothing leaves the machine while it is off.
- Every new model-facing surface must come with its own preference and a decision recorded here or
  in a successor ADR; it may not piggyback on the always-on declaration tool.
- The register must work, visibly and honestly, with every optional surface off: capture, the
  candidate gate and declarations may not depend on the nudge or on extraction. Failures of an
  opted-out surface are invisible by design; failures of an opted-in surface fail closed and never
  escalate into more sending. The one egress path stays auditable: every way bytes could leave is
  one preference plus one deployment configuration.
- Tests must prove absence, not just tolerance: defaults, missing configuration, missing preference
  and missing runtime each assert that no call was made.
