# ADR 002 — The plugin never writes the session log

**Date:** 2026-11-15 · **Context(s):** Durability & Integrity, Capture, Answering & Delivery

## Context

It is tempting to record plugin activity — item raised, answered, delivered — as events in the
session they concern. That would give a per-session audit trail for free, and a reader of the
session could see exactly what the plugin did.

The harness's persisted event vocabulary is a **static, generated allow-list** of every session
event type declared in the harness repository; out-of-repo plugin events are outside it by
construction. The restore validator throws on any unknown event type that is not marked
ignorable, so a session whose log contains one fails to load — while the plugin is installed and
after it is uninstalled. The only ignorable channel is reserved by policy for experimental
packages inside the repository; out-of-tree plugins must not call it either. Declaring the type
through TypeScript declaration merging satisfies the compiler but not the runtime reader, which
is exactly the trap the first prototype fell into.

## Decision

The plugin **reads** the session log and **never writes** it. There is no plugin-owned session
event type, no ignorable plugin record and no declaration merging. The durable register is the
plugin's record; a conversation is written to only as a labelled transcript notice (an ordinary
message whose source identifies the plugin), which is the sanctioned way to put something into a
chat.

## Why

Corrupting a user's sessions is the worst failure this product could cause — worse than not
shipping, worse than a missing feature. The register's own audit trail belongs in the register,
where it can be queried, migrated and retained under the register's rules, not grafted onto a
format the plugin does not own.

## Alternatives considered

- **Declare `SessionEventMap` types and append** — rejected: compiles, but the runtime restore
  path rejects the log; the compatibility mechanism is not "TypeScript knows this type".
- **`appendPluginRecord`** — rejected: reserved by policy for in-repo experimental packages, and
  using it would still make reads composition-dependent.
- **Go in-tree so the type joins the generated allow-list** — a different product (ADR 001).
- **Store per-session JSON beside the session** — rejected: not the session's durable semantics;
  the register store already provides durability with validation and migration.

## Consequences

- The plugin's audit trail lives in its store (`history`, delivery attempts, resolutions), not
  in the transcript; provenance in the chat exists only for delivered replies, which render as
  notices under a plugin-owned source kind.
- Any future requirement for a durable per-session annotation needs a new product decision and a
  different compatibility story, not a quiet append.
- Boundary tests and build-time guards must keep this true: no append call, no declaration
  merging, and no session event construction anywhere in the built bundles.
