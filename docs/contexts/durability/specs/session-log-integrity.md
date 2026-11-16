# Session-log integrity

**Context(s):** Durability & Integrity · **Date:** 2026-11-15

> Intent spec. It states what the capability is for and what it must do; it does not describe
> files, functions or snippets. The design packet and the code own mechanics.

## Definitions

The canonical senses are in [UBIQUITOUS_LANGUAGE.md](../../../UBIQUITOUS_LANGUAGE.md); this spec
adds precise local senses where the constraint needs them.

- **Session log** — the durable per-session event log maintained by the harness. The plugin reads
  it and never writes it.
- **Session event** — one entry in the log: a type drawn from the harness's vocabulary plus a
  payload. A session is restored from its events.
- **Event type** — the string identity of a session event. It is the compatibility boundary between
  a log's writer and every reader that later opens the session.
- **Static allow-list** — the harness's fixed, generated set of event types that its restore path
  understands. It is built from the harness's own source tree; an out-of-tree plugin's types are
  outside it by construction. There is no API by which an installed plugin can add a type to it.
- **Unknown event type** — a logged type outside the allow-list that is not marked ignorable.
- **Restore validation** — the read of a persisted session log when the session is opened or
  resumed. It refuses to interpret a log containing an unknown, non-ignorable event type rather
  than skipping it.
- **Ignorable marker** — the per-event envelope flag that tells a reader it may skip that event
  safely. It is the format's only compatibility mechanism for unknown events.
- **Ignorable plugin record** — an event carrying that marker, written through the harness's
  restricted channel. The marker is what makes an unknown event safe to skip; nothing else does.
- **Restricted ignorable channel** — the harness's write API for such records. It is reserved by
  policy for experimental packages inside the harness repository; plugins outside the repository
  are explicitly not permitted to call it.
- **Declaration merging** — a TypeScript-only technique that adds plugin event names to the
  harness's compile-time event map. It satisfies the compiler and declares nothing to the runtime
  restore validator.
- **In-tree fork** — building the plugin as part of the harness source so its event types join the
  generated allow-list. That is a different product, and it is refused (see
  [ADR 001](../../../adrs/001-compose-published-seams.md)).
- **Out-of-tree plugin** — a package installed into a profile, composing only published seams; not a
  patch and not a fork.
- **Read-only conformance** — the posture that the harness's format is authoritative and the plugin
  adapts to it; the plugin never asks the format to adapt to the plugin.
- **Plugin audit history** — the append-only, bounded record inside the store that says what
  happened to an item (raised, answered, dismissed, reopened, delivery attempts, resolutions). It is
  the plugin's own answer to "what happened", and it is not the session log.
- **Transcript notice** — a conversation entry written by the plugin as an ordinary message whose
  source identifies the plugin. The sanctioned way to put something into a conversation.
- **Notice source kind** — the plugin-owned value in a message's source that labels the entry as a
  notice and carries the item id and the delivery id. It is a source value, not an event type.
- **Tool-result card payload** — the data the plugin supplies on its own tool result so the
  in-session card can render the raised item. The harness writes the tool-result event itself.
- **Per-session durable annotation** — a plugin-owned record written into a session's log so a
  reader of that session sees it. Not permitted by this design.
- **Boundary guard** — a test or build check that fails when a forbidden construct (a session write,
  an event declaration, a restricted-channel call) reappears anywhere in the production tree or the
  built bundles.

## Constraints

- **The session log is read-only to the whole domain, absolutely.** The plugin never appends a
  session event, never declares a plugin event type, never constructs a plugin event literal, and
  never calls the restricted ignorable channel. There is no feature large enough to justify an
  exception.
- **No type declaration, no merging, no fork assumption.** The design may not assume the harness will
  ever add the plugin's types to its allow-list, may not add them through TypeScript declaration
  merging, and may not depend on being built inside the harness repository. Any capability that
  needs a new event type is refused or deferred.
- **Reads are pure.** Reading or folding the log never mutates it and never opens a write handle; two
  reads of the same committed events produce the same result; a read has no timestamp-dependent
  identity.
- **The only conversation write is a labelled notice.** A reply that must reach the conversation is
  an ordinary message on the session-message delivery track, sourced under the plugin's own notice
  source kind, carrying the item id and delivery id in the source and the user's words in the text.
  The user's own source kind is never reused, and the plugin never grants a permission retroactively
  by writing a message.
- **Card data rides the harness's event.** The in-session card's payload is supplied as part of the
  plugin's own tool result; the harness persists the tool-result event it already owns. The plugin
  adds data, not an event type.
- **Audit stays in the register.** Bounded audit history, delivery attempts and resolutions live in
  the store; they are queryable, exportable and deletable under the register's own rules.
- **The constraint is enforced mechanically.** A production source tree containing a forbidden
  construct fails a boundary test; the built bundles are checked at build time for the same
  constructs. A constraint that depends on memory is not a constraint.
- **Conformance is version-tolerant.** Adding an event type on the harness side, or a newer harness
  release, must not require a plugin change; the plugin only consumes documented events it already
  reads.
- **The escaped case is not silent.** If the plugin's use of a session log ever fails to restore, that
  is the worst failure in the product; no workaround may be added under time pressure — the offending
  path is removed and the constraint re-argued.

## Problem

It is tempting to record plugin activity — item raised, answered, delivered — as events in the
session the activity concerns. It would give a per-session audit trail for free, and anyone reading
the session would see exactly what the plugin did.

That path is closed by the format, not by taste. The persisted event vocabulary is a static,
generated allow-list of the types the harness's own source tree declares; an out-of-tree plugin's
types are outside it by construction, and no API exists by which an installed plugin could add a
type to it. The restore path is not lenient: it refuses to interpret a log containing an unknown
event type that is not marked ignorable. The ignorable marker is the format's only compatibility
mechanism, and its only sanctioned writer is a channel reserved by policy for experimental packages
inside the
harness repository — explicitly not for out-of-tree plugins. TypeScript declaration merging would
satisfy the compiler and change nothing at runtime, which is the trap a prototype can fall into and
a user discovers later, when their conversation will not open.

The failure mode is therefore not a missing feature; it is the product destroying a user's chat
history while installed, and — because the event stays in the log — after uninstall too. The
session log is the harness's durable format, not a place for the plugin to store its own state.

## Solution

The plugin reads the session log and never writes it. Its own history lives in the register's store:
the bounded audit history of each item, its delivery attempts and its resolutions — queryable,
exportable and deletable under the register's own retention rules. The only way the plugin puts
anything into a conversation is the sanctioned message path: a delivered reply is an ordinary
message sourced under a plugin-owned notice kind, not a new event type, so the harness persists and
restores it as it does any other message. Anything that the plugin shows inside a session rides the
harness's own tool-result event.

The design accepts the cost: there is no per-session durable annotation and no mirrored event stream
inside the session log. Views of plugin history are the register's, not the transcript's. The
constraint is enforced by boundary guards in the test suite and at build time, so a later change
cannot quietly reopen the hole; and the conditions under which a per-session annotation could ever
be designed are recorded in Deferred Decisions, so a future debate starts from facts.

## User Stories

1. As a user, I want my conversations to open after I install, use, upgrade and uninstall the
   plugin, so a tool I tried can never make my chat history unreadable.
2. As a user, I want the plugin's account of what happened to live in the register, so I can review,
   export and delete it under the register's rules rather than reconstructing it from chat.
3. As a user, I want a reply sent into a conversation to be labelled as coming from the plugin, so it
   never impersonates something I said.
4. As a plugin author, I want exactly one sanctioned way to put something into a conversation, so
   there is no ambiguous "sometimes an event, sometimes a message" path.
5. As a maintainer, I want a test that fails the moment someone reintroduces a session-log write, so
   the constraint survives time pressure and new contributors.
6. As a reviewer, I want the reason recorded (allow-list, restore validator, reserved channel), so the
   decision is not re-litigated from a tempting premise.
7. As a user, I want the plugin's in-session presence to be a card attached to its own tool call, so
   seeing an item in chat does not require the plugin to write an event.
8. As an operator, I want capture's reads of the session log to stay read-only and replayable, so
   scanning history can never modify it.
9. As a user, I want a future harness upgrade to be compatible with my installed plugin, so a
   vocabulary change on either side does not require a fork.
10. As the product owner, I want a written, honest path for any future per-session annotation, so
   that decision is made deliberately rather than by an accidental append.

## Acceptance Criteria

These criteria are the definition of done. They change only by amending the spec.

### Story 1 — A session that used the plugin still restores

```
Given a session in which the plugin raised an item, recorded an answer, reopened it, dismissed it and
      delivered two replies
When  the harness restores that session from its persisted log
Then  the log contains no plugin-declared event type, the restore completes, and the delivered replies
      appear as notices labelled by the plugin's notice source kind
```

```
Given a session whose log contains a notice delivered by the plugin
When  the plugin is uninstalled and the session is restored by the same harness
Then  the restore still completes, because the notice is an ordinary message with a source value and
      no part of the plugin is needed to read it
```

### Story 2 — The plugin's history lives in the register

```
Given an item the user answers from a surface
When  the answer is accepted
Then  the item's store audit history records the transition with a timestamp, and the session log's
      sequence is exactly what it was before the answer
```

```
Given a resolved item the user deletes forever
When  the tombstone is written
Then  the register's own audit record is stripped with the record, and no session-log entry is created,
      changed or removed by the deletion
```

### Story 3 — The only conversation write is a labelled notice

```
Given an item that must be delivered into its session rather than settled
When  the user confirms the send
Then  the reply lands as an ordinary message whose source is the plugin's notice source kind and
      carries the item id and delivery id, and whose text is exactly the user's words
```

```
Given the plugin raises an item inside a session
When  its tool result is committed
Then  the in-session card renders from data the plugin supplied on the harness's own tool-result
      event, and no plugin-authored session event exists in the log
```

### Story 4 — Reads never become writes

```
Given a committed session log with a known number of events and a plugin that folds it for capture
When  the same log is folded twice
Then  both folds produce the same items and evidence, the log's event count and content are unchanged,
      and no write handle was opened on the log
```

### Story 5 — The constraint is enforced, not remembered

```
Given a production source change that adds a call appending a session event
When  the boundary test suite runs
Then  it fails and names the offending source
```

```
Given a production source change that adds a plugin event type through declaration merging, or
      constructs a session-event literal carrying a plugin type
When  the boundary test suite runs
Then  it fails and names the offending source
```

```
Given a production source change that calls the restricted ignorable channel
When  the plugin is built and the produced bundles are checked
Then  the build fails, and no produced bundle contains the call
```

### Story 6 — No fork, no format extension

```
Given a capability that appears to need a per-session durable annotation so session readers can see
      plugin history
When  the design is assessed
Then  it is refused: no event type is declared, no declaration merging is added and no format change
      is attempted, because the harness offers no sanctioned skip-safe channel for an out-of-tree
      plugin, and the refusal is recorded as a different product decision
```

### Story 7 — Conformance survives harness upgrades

```
Given the installed harness gains new event types in a later release
When  the plugin runs unchanged against it
Then  no plugin code changes are needed, because the plugin declares no event types and consumes only
      documented events it already reads; an unknown-to-the-plugin type is simply outside what it reads
```

## Design Decisions

- **Read-only conformance is a boundary, not a preference.** The harness's event vocabulary is not
  ours to extend. The plugin adapts to the format and never asks the format to adapt to it; this is
  the same posture that refuses an in-tree fork
  ([ADR 001](../../../adrs/001-compose-published-seams.md)).
- **No event type, no declaration merging, no restricted channel.** Each alternative is rejected for
  a stated reason: a declared type satisfies the compiler but not the restore validator; declaration
  merging changes the build-time types only; the restricted channel is reserved by policy for
  in-repository experimental packages and would still make reads composition-dependent. The full
  argument is [ADR 002](../../../adrs/002-no-session-log-writes.md).
- **The audit trail is a register record.** Bounded history, delivery attempts and resolutions are
  durable in the store, where they can be queried, exported, retained and deleted under the
  register's rules. That is also what makes the plugin's account of an item independent of the chat
  it came from.
- **A conversation is written to only as a labelled notice.** A delivered reply is an ordinary
  message on the session-message delivery track: the user's words in the text, the plugin's notice
  source kind in the source, the item and delivery ids in the source. Attribution honesty is part of
  the contract — the entry must never look like a message the user typed, and the user's own source
  kind is never reused.
- **The in-session card is data on the harness's event.** The plugin supplies the card payload on its
  own tool result; the harness writes and restores that event. The plugin therefore has an in-session
  surface without owning an event type.
- **The constraint is enforced twice.** A boundary test scans the production source tree, and the
  build scans the produced bundles. Both are part of this spec's definition of done; either failing
  is a release-blocking defect, not a warning.
- **No fallback path exists.** If the plugin's use of a session log ever failed to restore, the fix
  is to remove the offending write, never to add an ignore flag, patch the restore path or fork the
  harness.

### Deferred Decisions

- **A per-session durable annotation** is refused until *all* of these hold, and the seam that keeps
  the decision open is the store itself, which already owns the durable history:
  1. a different product decision establishes that a conversation reader, not the register, needs the
     annotation (the register's history is the sanctioned record);
  2. the harness publishes and documents a skip-safe record channel for plugins outside its
     repository — not the in-repository-only channel, and not declaring an event type;
  3. every reader that does not know the record can skip it safely, so restore can never refuse
     because of it;
  4. a written compatibility test proves install, uninstall and upgrade behaviour for the record on
     both sides.
- **Mirroring the register's events into the session log.** The same conditions apply; no mirror is
  designed. The seam: the delivery path already records its own evidence in the register and, for a
  delivered reply, in the message source.
- **A visible in-session "open items" indicator owned by the plugin.** The designed in-session
  surfaces are the tool-row card and the per-session panel, both of which need no log write. A future
  indicator that a plugin must add to the log would have to satisfy the annotation conditions above.

## Testing Strategy

- **Order of coverage.** The guards first (they protect everything else), then no-write assertions on
  every write path, then the restore fixtures, then conformance across an uninstall and an upgrade.
- **Behavioural, through the public boundary.** A test drives a real store and tool call against a
  fake session runtime that records every append; the assertion is the observable behaviour — zero
  plugin appends — not the presence or absence of a particular source string.
- **The restore fixture is the load-bearing test.** Build a session log containing everything the
  plugin normally writes — a raised item's tool result, a delivered notice — then restore it with
  the harness's validator: it must succeed with the plugin loaded and with the plugin absent.
- **Only system boundaries are mocked.** The session runtime (a fake log that records and throws on
  an unexpected append) and the restore validator fixture. Store, tool and capture logic are
  production code under test.
- **Guard tests are exact.** The source-tree scan fails on any append call, any event-map
  declaration, any session-event literal and any restricted-channel call; the bundle scan fails if
  any of those appear in the built output. Both name the violating file and line.
- **Determinism.** Folds run over fixed committed-event fixtures with an injected clock; the same
  fixture must produce the same items on every run; a test that checks "no write" must not depend on
  timing.
- **Uninstall and upgrade are tested as states.** A fixture store and a fixture session survive an
  uninstall simulation (plugin absent) and a harness-release simulation (extra unknown event types)
  with no plugin-side changes.

## Out of Scope

- **The session log's format, restore validator and allow-list.** Harness-owned; this spec states the
  constraint and the conformance posture, not the format.
- **Any API for adding an event type, any custom event type, or an in-tree fork.** Refused by
  design, not scheduled.
- **The per-session durable annotation and any mirroring of the register's events into a session.** Held
  behind the conditions in Deferred Decisions.
- **The runtime-context line and the nudge.** Model-facing surfaces with their own owner; they add no
  session event either, but their contract is not this spec's.
- **Capture's read path.** What a fold detects and how it replays is Capture's; this spec constrains
  only that the read never becomes a write.
- **Rendering the notice in the chat shell.** Surfaces and the harness shell own the presentation; the
  plugin owns the source attribution and the data it supplies.

## Open Questions

- **If the harness ever publishes a skip-safe out-of-tree record channel, which annotations would be
  worth a product decision?** The conditions are written; the product value is not. Who can answer:
  the product owner, with the Lead.
- **Should activation probe the installed reader's acceptance of the notice source kind defensively,
  or trust the documented seam?** A probe would be read-only, but it grades a harness detail the
  plugin cannot control. Who can answer: the harness owner, with the Lead.
- **How should the operator-facing evidence for this policy be kept?** The policy document cites the
  harness mechanisms; whether those citations need periodic re-verification against a harness upgrade
  is an operator-documentation question. Who can answer: the operator-documentation owner.
