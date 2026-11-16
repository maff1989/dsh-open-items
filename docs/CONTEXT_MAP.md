# Context map — Open Items

**Date:** 2026-11-15
**Companions:** [ARCHITECTURE.md](ARCHITECTURE.md), [UBIQUITOUS_LANGUAGE.md](UBIQUITOUS_LANGUAGE.md)

This file is the map of the domain: which bounded contexts exist, what each owns, and how
they may depend on each other. The per-context detail is in `contexts/<name>/CONTEXT.md`;
the vocabulary is authoritative in [UBIQUITOUS_LANGUAGE.md](UBIQUITOUS_LANGUAGE.md).

## The system in one paragraph

Open Items keeps a durable, install-wide register of the decisions, approvals, questions,
blockers, risks and follow-ups that are waiting on the user, so they survive the chat that
raised them. It learns about them by reading committed session evidence (a fold over the
session log, live asks, and the final prose of a turn), by the agent declaring them, or — only
with consent — by a bounded model second opinion. It keeps them honest through a lifecycle
with a closing detector for every artifact, a confirmation gate for anything inferred, and a
register that records what happened. And it closes the loop: the user answers from any
surface, and the answer travels back into the work on an evidenced delivery track, so the
register can say what was sent, what was applied, and whether the work acted on it.

## The contexts

| # | Context | Kind | Intent (the question it answers) | Changes when | Detail |
|---|---|---|---|---|---|
| 1 | **Attention Register** | core | *What is waiting on the user, and what did it become?* Owns the item entity, kinds, tier, severity, state and resolution lifecycle, identity/dedupe/suppression, the Needs-you predicate, global counts, retention policy, and the register memory itself. | the product definition of attention changes | [CONTEXT](contexts/attention-register/CONTEXT.md) |
| 2 | **Capture** | core | *How does the system learn what is waiting, without guessing its way into attention?* Owns detectors and closing detectors, the projection/fold/backfill pipeline, the candidate gate, authored raises and roll-up, extraction's execution, and capture evidence. | observable harness artifacts or detection policy change | [CONTEXT](contexts/capture/CONTEXT.md) |
| 3 | **Answering & Delivery** | core | *How does the user's decision reach the work, and what may we claim happened?* Owns answerability, the answer matrix, the three delivery tracks, delivery state and evidence, acknowledgement, approval parity, wake rules and refusals. | the harness's ability to settle, wake or receive changes | [CONTEXT](contexts/answering/CONTEXT.md) |
| 4 | **Surfaces** | supporting | *Where does the user meet the register, and what must that place never lie about?* Owns the page, in-session card, per-session panel, register view, settings section, navigation, grouping, keyboard/a11y/i18n, freshness and export. | the client's interaction or presentation conventions change | [CONTEXT](contexts/surfaces/CONTEXT.md) |
| 5 | **Durability & Integrity** | generic | *How does the register survive restarts, upgrades and races — and how does the plugin avoid corrupting the harness?* Owns the store, record schemas and their three versions, CAS, migration, tombstone mechanics, the single-writer rule and the no-session-log-writes constraint. | the storage platform or compatibility contract changes | [CONTEXT](contexts/durability/CONTEXT.md) |
| 6 | **Model Contract & Consent** | supporting | *What is the agent told and allowed to declare, and what may leave the machine?* Owns the `open_items` tool contract and wording, the opt-in nudge, the runtime-context line, consent, egress, and the settings record and its defaults. | the model-facing posture or privacy policy changes | [CONTEXT](contexts/model-contract/CONTEXT.md) |

**Session Topology** is a shared kernel, not a context: the facts about root vs subagent
sessions, turns, workspaces and messages that every context keys on. It is defined once, in
[§ Shared kernel](#shared-kernel-session-topology) below.

## The map

```
                  ┌────────────────────────────────────┐
                  │ Model Contract & Consent           │
                  │ tool · nudge · consent · egress    │
                  └───────┬───────────────────┬────────┘
       declared raises    │                   │  settings: permission + defaults
       and the contract   │                   │
                          ▼                   ▼
┌───────────────┐  drafts   ┌─────────────────────────┐  read model  ┌─────────────────┐
│    Capture    │──────────►│   Attention Register    │◄─────────────│    Surfaces     │
│ evidence in,  │           │ identity · lifecycle ·  │              │ page · card ·   │
│ drafts out    │           │ register · counts       │              │ panel · settings│
└──────┬────────┘           └───────────┬─────────────┘              └───────┬─────────┘
       │ read-only                      │ transitions, records             │ reply intents,
       ▼                                ▼                                  │ settings writes
┌──────────────────────┐    ┌─────────────────────────┐                     │
│ Session log, live    │    │  Answering & Delivery   │◄────────────────────┘
│ asks (DSH harness)   │    │ answer matrix · tracks  │
└──────────────────────┘    │ evidence · refusals     │
                            └───────────┬─────────────┘
                                        │ settle · steer · wake · send
                                        ▼
                            ┌─────────────────────────┐
                            │ DSH sessions (harness)  │
                            └─────────────────────────┘

  every writer of records goes through:  Durability & Integrity  (store · versions · CAS)
  shared kernel under all of it:         Session Topology        (session · turn · workspace)
```

Reading the arrows: an arrow means "depends on / is fed by". The harness sits outside the
domain at both ends — the register's *senses* (session log, live asks) and its *hands*
(sessions it can settle, wake or message). The domain's job is the memory and the honesty in
between.

## Context relationships

| Upstream | Downstream | Pattern | Why the boundary exists |
|---|---|---|---|
| DSH harness (session log, live asks) | Capture | **Conformist, read-only**, with the fold as the anti-corruption layer | We must adapt to the harness's event vocabulary; the harness must never be adapted to ours. Capture reads; it never writes. |
| Capture | Attention Register | **Supplier/customer** on a published *draft* contract | Detection must not mint identities or decide lifecycle; the register must not know what a fold is. The draft is the only thing that crosses. |
| Model Contract & Consent | Capture | **Upstream constraint** (permission), with a partnership on the declared-ingress and extraction contracts | Consent may not know how detection works; Capture may not decide what is permitted. Capture executes; Consent permits. |
| Attention Register | Answering & Delivery | **Published transitions and record shapes** | Delivery commands the lifecycle only through the register's published transitions; it never edits an item's state directly. |
| Attention Register | Surfaces | **Published read model** | Surfaces render one merged snapshot and one count predicate; they hold no item semantics of their own. |
| Answering & Delivery | Surfaces | **Published reply contract** (payload, descriptor, outcome, delivery state) | The surface shows the control; the host picks the track and owns the claim. |
| Answering & Delivery | DSH sessions | **Remote but owned** (harness services), behind an in-process bridge | The only code allowed to act on a session; it exists in exactly one place. |
| Surfaces | Model Contract & Consent | **Customer** on the settings contract | The settings section edits permission; it does not implement the permissioned behaviour. |
| all writers | Durability & Integrity | **Published persistence contract** (validated records, CAS versions, migration) | Exactly one place knows record formats and write mechanics. |

## Shared kernel: Session Topology

Every context needs the same facts about where an item lives. These are defined here and
must not be redefined locally.

- **Root vs subagent.** A session is a subagent session when the harness says so
  (`origin: 'subagent'` or delegation depth > 0). The presence of a parent session id alone
  does **not** classify a session as non-root: an ordinary fork can carry one. Capture
  produces cross-session items from root sessions only; the `open_items` tool is the one path
  that accepts a raise from a subagent and rolls it up.
- **Turn boundary.** The turn is the durable unit of progress: it starts at `turn/start` and
  ends at `turn/end`. There is no session-end event; the turn is where inference and
  checkpointing happen, and whether the turn is running is an input to the answer matrix.
- **Workspace identity.** An item stores the workspace *id* (identity), its *title*
  (display snapshot) and its *path* (display only). Grouping is by workspace id membership
  of the session in the workspace's session ids — never by path, never by the session's
  current cwd.
- **Session state.** A session can be running, cold, or archived. "Cold" means waking it
  costs residency and a turn; "archived" means a delivered message is silently destroyed. Both
  are delivery inputs, not display trivia.
- **Message provenance.** Transcript entries have a source; the plugin's own messages are
  notices under a plugin-owned source kind. Reusing the user's source kind is forbidden
  because the harness treats it as direct human input in nine places.
- **Identifiers.** The session id, turn number, sequence, call id, message id, approval id,
  goal id, task id and job id are the join keys an item keeps. They are pointers, not foreign
  keys: nothing is joined across contexts at read time.

Changes to the shared kernel require a change here first, then in the consuming contexts.

## Dependency rules

The map is not a folder layout. It is a set of rules about who may know what. They are stated
as obligations, with the reason:

1. **Dependencies point inward, toward the more stable context.** Surfaces may depend on the
   three inner contexts; no inner context may use a surface concept (a *tab*, a *toast*, a
   *row*'s shape). Inner modules receive data in the form most convenient for the inner
   module, never in a wire or view shape.
2. **Capture produces drafts; it never writes records.** Identity, dedupe and lifecycle belong
   to the register. A capture change must not be able to change what an item *is*.
3. **Only Answering & Delivery acts on a session.** No fold, no surface and no read model may
   settle an ask, wake a session, send a message or steer a turn. One place to audit, one place
   to refuse.
4. **Only Durability & Integrity writes a record.** Every mutation is a validated,
   version-checked write through the persistence contract. No context holds its own copy of a
   record format.
5. **Nothing writes the session log.** This is a hard constraint on the whole domain (see the
   ADR); it is repeated here because it outranks every other requirement in this file.
6. **Consent is inverted from capture.** Consent publishes what is permitted and what the
   settings mean; Capture implements and consumes it. Capture may not make an egress decision,
   and Consent may not depend on how detection works.
7. **Context-local mechanism names stay local.** *Fold*, *ledger*, *projection*, *route*,
   *endpoint* and *extractor* are Capture's or the halves' vocabulary. (*Artifact* is shared
   vocabulary: the draft contract and the register's evidence fields both name the observed fact.) Other contexts
   describe the concept — "what the register contains", "what the user's surface can do" — and
   never the mechanism.
8. **No silent cross-context writes.** A context that needs another context's state to change
   sends a command to that context's published contract; it never reaches into the other
   context's records.

## Cross-context contracts

| Contract | Published by | Consumed by | It guarantees |
|---|---|---|---|
| **Draft ingest** | Attention Register | Capture | A draft carries kind, tier, severity, title, body, capture evidence (artifact id, session, seq/turn/call ids, quote where the artifact carries text), the workspace snapshot and a reply descriptor. The register alone mints identity, applies dedupe, and decides the initial state. |
| **Lifecycle transitions** | Attention Register | Answering & Delivery, Surfaces | The legal transitions (open/snoozed/awaiting/stale/archived/resolved, reopen, delete forever) and what each requires. A reply that would violate them is refused as a value. |
| **Read model** | Attention Register | Surfaces | One snapshot: items page, session rows, workspace rows, global counts, revision, paging cursor, plus the Needs-you predicate applied identically everywhere. Counts are global and independent of filters. |
| **Reply contract** | Answering & Delivery | Surfaces | The reply payload vocabulary, the answer matrix outcome, the delivery state and failure codes, and the rule that a surface never chooses the track. |
| **Settings contract** | Model Contract & Consent | Surfaces, Capture | One versioned record (model nudge, prose candidates, model-assisted extraction) with defaults served without a write; a write is a compare-and-set patch; a conflict is a value. |
| **Persistence contract** | Durability & Integrity | every writer | Record schemas and their versions, CAS semantics, migration rules, tombstone mechanics, and the guarantee that the domain never writes the session log. |
| **Route protocol** | Host half | Browser half | One envelope, a versioned endpoint set, stable error codes, capability flags, and skew tolerance (the client may legitimately be newer than the host). |
| **Consent / egress** | Model Contract & Consent | Capture, Surfaces | What may leave the machine, under what conditions, and that the default is nothing. |

## What is outside the domain

Named so the map is not mistaken for the whole system:

- **The DSH harness** — session log and projection registry, ask/approval waterfalls, session
  controller, workspace registry, system-prompt seam. Remote-owned, read-mostly, conformist.
- **The DSH Web client shell** — the page shell, navigation, settings container, UI primitives,
  locale, keyboard, toast/modal primitives. Surfaces *composes* these; it does not own them.
- **The storage platform** — the host's storage-domain mechanism (per-record documents,
  validation, backups). Durability & Integrity adapts to it.
- **An extraction model provider** — reachable only through the deployment-configured
  extraction seam, only with consent. A true external dependency.
- **The installation** — profile configuration, peers, and the host process lifecycle.

## Contexts across the two halves

| Context | Host half | Browser half |
|---|---|---|
| Attention Register | authoritative: item records, lifecycle, counts, retention | none — reads the read model only |
| Capture | authoritative: folds, backfill, extraction, raises | none |
| Answering & Delivery | authoritative: route guards, router, delivery records, session bridge | carries the user's reply intent and the client-settle outcome |
| Surfaces | exposes the route and the read model | authoritative: all rendering and interaction |
| Durability & Integrity | authoritative (the store is host-side) | none |
| Model Contract & Consent | authoritative: tool registration, nudge, egress | renders and edits the settings record |

The browser half may be newer than the host half because it hot-reloads independently; the
protocol is designed to be skew-tolerant and to say so honestly.

## Deferred cross-context decisions

These are decisions this map deliberately does not make. Each spec owns its own deferred
list; the recurring cross-context ones are:

- **Cross-session identity** — when are two items in different sessions "the same decision"?
  Today they are two items; whether to group them is deferred.
- **A live delta channel from host to browser** — the read model is pull-based (revision,
  focus, poll). A pushed channel would change the read-model contract for every surface.
- **Decay** — the policy that populates the `stale` state and archives untouched items. The
  state and the rules that respect it are defined; the trigger policy is deferred.
- **Team-task capture** — the item kind and the closure rules exist, but the liveness gate
  that would justify raising team-task items is not designed, so the family is deliberately
  outside capture's dispatch. Recorded in Capture's context and its out-of-scope list.
- **A second owner for the register** — multi-host or cross-device access is outside this map
  (the single-writer rule is an assumption, not a wish).

## Related reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — the shape, principles and evidence model this map
  serves.
- `docs/adrs/` — the cross-context decisions that shaped the boundaries (no session-log
  writes, composing published seams, detection state kept separate from the register).
- The design packet at the repository root — implementation mechanics, measured evidence and
  release history. The packet is the *record of how*; this map is the *statement of what*.
