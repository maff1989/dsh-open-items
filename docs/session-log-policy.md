# Session-log policy: this plugin writes nothing to the Session log

**`dsh-open-items` (rc1, rc2 and the unreleased remediation) never calls
`session.append()` and never calls `appendPluginRecord()`.** The durable store — the `open_items`
storage-domain unit at `$DSH_HOME/storages/open_items/` (one JSON document per
record; `$DSH_HOME` is `~/.dsh` unless set) — is the single source of truth, and
each item's store-internal `history[]` is its audit trail. The legacy
`$DSH_HOME/open-items/store.json` is only the P0 document imported once during
migration; it is not a write target. An earlier draft of this scaffold declared `open-items/*` event
types through `SessionEventMap` declaration merging and appended them to the
calling Session. **That was wrong and has been removed**: declaration merging
satisfies TypeScript only, not the runtime persistence reader, and it would have
made sessions that used the tool fail to restore on resume — installed or not.

## Evidence

The event vocabulary is a static, generated allow-list, and out-of-tree plugin
events are outside it by construction
(`repo:packages/core/session/src/known-event-types.ts:8-20`):

> Every `SessionEventMap` member declared in this repository — the event
> vocabulary this build understands. The persistence read path refuses to
> interpret a log containing a type outside this set unless the event carries
> the envelope's `ignorable` marker ... Downstream (out-of-repo) plugin events
> are outside this list by construction. The persisted `SessionEvent.ignorable`
> marker is the compatibility mechanism; event-name registration was rejected
> because it does not classify omission safety and would make reads
> composition-dependent.

The restore path is not lenient about it
(`repo:packages/session/session-format-v3-to-v4/src/validation.ts:59-62`):

```ts
for (const [index, event] of artifact.events.entries()) {
  if (!knownEventTypes.has(event.type) && event['ignorable'] !== true) {
    throw new SessionFormatUnsupportedMigrationError(
      `format v4 contains unknown event type ${JSON.stringify(event.type)} at seq ${index}`,
    )
  }
```

The only sanctioned ignorable channel is `appendPluginRecord()`, and it is
reserved for in-repository experimental packages
(`repo:packages/core/session/src/index.ts:473`; `repo:packages/core/session/README.md:72`):

> Only production source under `packages/experimental/` may call this function;
> the `verify-plugin-record-callers` gate rejects any other production caller in
> this repository.
>
> Plugins outside this repository must not call it either, although no
> repository check can inspect them.

There is **no registration API** for event types: `KNOWN_SESSION_EVENT_TYPES` is
a generated `ReadonlySet` and the installed `0.2.2-rc.1`
`@deepseek-ai/dsh-session` exposes no `registerEventType`/`registerSessionEvent`.
The `ignorable` marker is the only compatibility mechanism, and it exists on the
`SessionEvent` envelope written by the restricted channel above.

## Consequences for this plugin

- **No `SessionEventMap` augmentation.** The package must not declare or write
  `open-items/*` session events; `src/shared/events.ts` was deleted, and
  `tests/policy.spec.ts` fails if a Session-log write path or event
  declaration is reintroduced.
- **The remediation adds no write path.** User preferences live in the store
  domain's existing `meta` table (`settings` key), not in a Session; the opt-in
  model nudge registers a `systemPrompt` section (prompt assembly only, no
  event); the prose candidate gate, the `todo_write` aggregate and the
  team-task retirement all read committed events and write store records. The
  policy test still fails on any reintroduced Session-log write path.
- **Round-2 extraction is not a log write either.** The opt-in model-assisted
  extraction makes one outbound model call for a new live prose candidate (only
  when the deployment configures a provider/model and the user enables the
  toggle), and writes no Session event and no request record containing the
  excerpt. No session content, title or id reaches the plugin log (failure logs
  carry the error name only). Disabled or unconfigured, it sends nothing at all.
  The durable backfill report is a count-only record in the store's `meta`
  table, never in a Session log.
- **Audit lives in the store.** `OpenItem.history` records
  `raised`/`answered`/`dismissed`/`reopened` with timestamps and a short detail,
  capped at `MAX_HISTORY_ENTRIES` (50) per item so each record stays bounded.
- **Future opt-in, deliberately unused.** If the harness ever exposes a
  sanctioned out-of-tree ignorable channel, an ignorable `plugin:open-items/*`
  record (written via `appendPluginRecord`-equivalent, not
  `session.append`) would be the only acceptable way to mirror store events into
  a session log. It is not used today: `appendPluginRecord` is reserved for
  `packages/experimental/` and explicitly off-limits to plugins outside this
  repository, and a reader that does not know the record must be able to skip it
  safely.
