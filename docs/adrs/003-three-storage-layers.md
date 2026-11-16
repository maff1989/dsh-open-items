# ADR 003 — Separate detection state from the register; merge one view

**Date:** 2026-11-15 · **Context(s):** Attention Register, Capture, Answering & Delivery

## Context

The system's state is not one kind of state. Three kinds have different owners, lifetimes and
cost profiles:

- **Detection state** — which artifacts a session's committed events show open, and what closes
  them. It is mechanically reconstructable: replaying the log recomputes it, a restarted process
  rebuilds it, and a fold-version change replays every session once. It is per-session and cheap
  to recompute, but it says nothing about what the *user* decided.
- **Register state** — every item ever raised, and every human outcome on it (answers,
  dismissals, snoozes, reopens, deletes, suppressors), plus the settings and the last scan
  report. None of this can be recomputed from a session log: it exists because a human or an
  agent wrote it, and it must survive restarts, upgrades and log loss.
- **Live state** — an ask that is in flight right now. It exists only while the process that
  observed the request does, and it is precisely the state that is invisible in the log until it
  resolves.

A single cache for everything would lose the user's answers on restart. A single durable store
for everything would write on every folded event and blur "what the log shows" with "what the
user decided".

## Decision

Separate the **detection ledger** from the **register**, and merge one **read view** over them:

- the per-session fold ledger is detection state — checkpointed by the projection, rebuildable
  from logs, and never the place a decision lives;
- every raised item, whether a detector derived it or an agent declared it, becomes an ordinary
  **durable register record** in the install-wide store, carrying its origin (authored or
  derived) and any user outcome as authored state on that record;
- in-flight asks are observed only, never persisted;
- all three are merged into one read snapshot with one identity, one Needs-you predicate and one
  revision.

## Why

- Each failure mode stays contained: losing the ledger means a rebuild from logs; losing the
  live observation means "connect a client to answer"; losing the register is the one
  unrecoverable case, and it is the only path with durable writes, version checks and
  migrations.
- Detection can replay freely without ever touching a human answer, because a replay converges
  on existing records instead of recreating them.
- The read model has one job — merge and count — so every surface can be consistent by
  construction.

## Alternatives considered

- **Keep derived items only in the projection cache** — rejected: a user can dismiss or reopen a
  derived item, and that outcome is not in the log; cache lifetime would destroy it.
- **Store the fold ledger in the register store too** — rejected: it would write on every event
  for state that is recomputable, and it makes replay a source of record churn.
- **Merge into a cached snapshot** — rejected: a cached snapshot needs an invalidation story for
  every writer; merging per read is cheap at register scale and needs no cache coherence.
- **Persist live asks** — rejected: they are process-local truths with no persistence semantics;
  persisting them would outlive the request they describe.

## Consequences

- Replay must converge: the same log produces the same artifact ids, and a re-sighting updates
  the existing record (occurrence, audit version) rather than creating a second item. It must
  never reopen a user-resolved item.
- Derived and authored items share one record shape, one retention policy and one migration
  path; the origin is persisted because the answering path depends on it (a mirrored approval
  has a real request to settle; an authored approval does not).
- The register needs a merge precedence rule and a monotonic revision so a stale client is
  detectable and cheap to correct.
- Races are resolved by the durable layer's compare-and-set, never by last-writer-wins.
