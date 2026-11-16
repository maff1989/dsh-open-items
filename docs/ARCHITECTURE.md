# Architecture — Open Items

**Date:** 2026-11-15
**Companions:** [CONTEXT_MAP.md](CONTEXT_MAP.md), [UBIQUITOUS_LANGUAGE.md](UBIQUITOUS_LANGUAGE.md)

This document is the architecture at the level of intent: the shape the system must have to do
what it is for, the principles that shape it, and the obligations that keep it honest. It does
not inventory modules — the contexts and their specs own behaviour, and the design packet at
the repository root owns the mechanics.

## 1. What the system is for

Open Items exists because a long agent session ends with decisions still open, and the chat
that raised them scrolls away. The system answers four questions, in this order of importance:

1. **What is waiting on me?** — across sessions, workspaces and restarts, in one place, small
   enough to clear.
2. **How do we know?** — every item rests on evidence: a harness fact, the agent's declaration,
   a quoted piece of its final message, a plan left unfinished. The user can see the evidence
   and may reject the item.
3. **How do I answer from here?** — without opening the conversation, on any surface, for any
   kind of item.
4. **What happened after I answered?** — whether the answer was applied, sent, seen, acted on,
   or lost, recorded so the user is never told a comfortable lie.

The one-sentence purpose: **turn durable session evidence into a register of human attention
that outlives the chat, and carry the human's decision back into the work with evidence.**

Everything in this architecture is justified by one of those four questions, or by a hazard
that would make an answer to them false.

## 2. The shape

```
        ┌─────────────────────────── the DSH process ───────────────────────────┐
        │                                                                       │
   ┌────┴─────────────┐    ┌──────────────────────────────────┐   ┌─────────────┴────┐
   │ Browser half     │    │ Host half                        │   │ DSH services     │
   │                  │    │                                  │   │                  │
   │ page · card      │◄───┤ one route · read model           │──►│ sessions, asks,  │
   │ panel · register │    │ capture · register · delivery    │   │ workspaces, log  │
   │ settings · export│    │ store · tool · consent           │◄──│ projection, LLM  │
   └──────────────────┘    └──────────────────────────────────┘   └──────────────────┘
                reads one snapshot, sends one intent                  read + act, never write
                                                                      to the session log
```

Four structural facts follow from the purpose:

- **Two halves, one route.** The host owns truth and action; the browser owns presentation and
  intent. They talk through one versioned request/reply channel, never through shared memory.
- **The register lives on the host and outlives every session.** Sessions are the evidence
  source, not the record. The durable store is the record; a session may be archived, deleted
  or never opened again and the register still answers "what did I decide, and when?".
- **The plugin's contact with the harness is narrow and one-directional in each direction.**
  In: committed session events, live asks, session/workspace metadata. Out: settle a live ask,
  wake-and-send a message, declare a tool, contribute a prompt section, render a slot. The
  plugin never writes the session log — a hard constraint, not a preference.
- **The model is not on the register's critical path.** The `open_items` tool is the only
  synchronous model-facing seam; capture reads committed evidence, and an optional consented
  second opinion is the only model-assisted path. The inbox works with no model in the loop.

## 3. The evidence model

The system's central architectural idea is that **attention is justified by evidence, and
evidence has layers with different owners and lifetimes**, merged into one view at read time.

| Layer | What it holds | Owner | Lifetime | Cost |
|---|---|---|---|---|
| **Detection** | the per-session fold ledger: which artifacts are open, what closes them, the prose/plan bookkeeping | capture (per session, checkpointed) | rebuildable from logs | a pure fold per event |
| **Authored** | declarations and human outcomes: raises, answers, dismissals, snoozes, reopens, deletes, suppressors, settings | register and model contract | durable, install-wide | one validated write per action |
| **Live** | asks that are in flight *right now* | capture's observation of the harness waterfalls | the life of the process only | negligible |
| **View** | the merged snapshot every surface reads | register | computed per read | one scan of an in-memory table |
| **Delivery** | attempts to carry a reply: track, state, evidence, failure | answering | durable, appended per action | one send per action |

Every raised item — detected from the log or declared by the agent — becomes an ordinary
**durable register record**; the ledger is where detection is computed, not where the register
lives. Three consequences follow, and they shape the rest of the architecture:

- **Detection state must be replay-safe.** Replay, restart and backfill may recompute the
  ledger any number of times. The same log must produce the same artifacts and converge on the
  same register records: no duplicates, no reopening of what the user resolved, no phantom new
  items. What replay cannot reconstruct — answers, dismissals, snoozes, suppressors — is
  authored state on the record, never recomputed from a log.
- **Authored state must be durable before it is acknowledged.** A write returns only after the
  record is durable and version-checked. The user's click is the one thing the system may not
  lose.
- **The merged view must be one view.** Counts, rows and the register read the same snapshot and
  the same predicate, so a surface cannot contradict the badge that sent the user there.

### The evidence ladder

Capture is ordered by a single invariant: **facts first, meaning second, declaration third,
heuristics only as a gate.**

1. **Facts** — a failed approval, a pending question, an interrupted turn, a blocked goal, an
   unsettled job. Deterministic, replayable, zero model cost.
2. **Meaning** — what the fact means for the user: kind, severity, whether it blocks the work.
3. **Declaration** — the agent explicitly raises an item through the tool, and records when the
   user answered in conversation. The highest-precision source; its failure mode is
   over-raising, so its wording is part of the contract.
4. **Inference, gated** — the final prose of a turn and an abandoned plan may be *inferred*, but
   inference may only produce a **candidate**: confirm-first, never counted as attention,
   never answerable as an item until the user says it is one.

Two obligations keep the ladder from rotting:

- **Every artifact names a closing detector.** An item that nothing can close is noise forever,
  so a detector family that cannot state what closes it does not produce items.
- **Every claim names its evidence.** "Applied", "sent", "acknowledged" and "no acknowledgement
  observed" are distinct claims with distinct evidence; the architecture refuses to let one
  stand in for another.

## 4. Design principles

These are the rules the system is built to obey. Each names the failure it prevents.

1. **The user's attention is the scarce resource.** The default view is the small set that
   needs a decision now; everything else is counted separately and reachable one step away.
   *Prevents:* a product that becomes another inbox to triage.
2. **Evidence over optimism.** A reply is not "answered" because it was queued; an approval is
   not "granted" because a message said so; an item is not "closed" because a timer passed.
   *Prevents:* the comfortable lies that make the register untrustworthy.
3. **Facts before meaning before guesses.** The pipeline order is not negotiable, and inference
   sits behind a confirmation gate. *Prevents:* a noisy heuristic outranking a harness fact.
4. **The human decides what is real.** Inferred items are confirmable, correctable and
   suppressible; a suppression is remembered; an answer is recorded with who said it.
   *Prevents:* the system deciding on the user's behalf what deserves attention.
5. **Every loop closes.** Every raised item has at least one way to leave the open list, and
   every closure reason is recorded. *Prevents:* a register that only grows.
6. **Nothing is deleted by neglect.** Decay may archive; it may not destroy. Only an explicit,
   confirmed delete removes a record, and it removes it everywhere and for good.
   *Prevents:* losing the answer to a real decision because it aged out.
7. **Never wake, never send, never grant without consent.** Waking a cold session costs a turn
   and must be confirmed; approvals are one-shot and fail closed; bytes leave the machine only
   when the user and the deployment both permit it. *Prevents:* a plugin with side effects the
   user did not ask for.
8. **Never corrupt the harness.** No session-log writes, additive seams only, no fork, honest
   version skew. *Prevents:* making user sessions fail to restore — the one failure that would
   be worse than not shipping.
9. **Durable over session-scoped; cross-session by default.** An item belongs to the register,
   not to the chat that raised it. *Prevents:* the founding failure, where insight died with
   the conversation.
10. **The register is the memory; surfaces are views.** No surface is a source of truth; each
    renders a snapshot and sends intents. *Prevents:* two tabs disagreeing about what is open.
11. **Explain emptiness.** An empty list must say what was scanned and whether capture attached.
    *Prevents:* silence that is indistinguishable from breakage.
12. **Small interfaces, deep behaviour.** The plugin composes public seams and hides the depth
    behind them; it does not fork the harness to get behaviour it cannot have honestly.
    *Prevents:* a plugin that breaks on every harness upgrade.

## 5. The seams

The architecture is defined as much by what it refuses to touch as by what it builds.

**Read seams (the register's senses):**

- the committed session-event stream and the projection registry — the capture pipeline;
- the live ask/approval waterfalls — observation only, never holding or answering;
- session listing and workspace membership metadata — the roster and the grouping identity.

**Write seams (the register's hands), all confined to one context:**

- settle a live ask through the harness's own card (browser) or the ask channel (host);
- wake and send into a session (or steer a running turn), with archive and availability checks;
- declare a tool and contribute a prompt section (the agent-facing contract);
- render slots in the page, the panel and the settings container (surfaces).

**Own seams (the plugin's own contracts):**

- the durable store, the record formats and their versions;
- one route between the halves, with capability flags and progressable failure codes;
- the model contract and the consent record.

Rules for every seam:

- **A missing optional seam degrades; it never fabricates.** No live channel means live asks are
  observed but not settleable, and the surface says so. No system-prompt service means the nudge
  stores but does not apply. No model provider means extraction never runs.
- **Dependencies point inward.** The plugin depends on published harness seams; the harness never
  depends on the plugin. Everything the plugin needs in a shape not offered is adapted at one
  edge, not leaked inward.
- **One place per capability.** Capture never writes records; only delivery acts on sessions;
  only durability writes the store; only surfaces render. Each rule is auditable by finding the
  single module that could break it.

## 6. The two halves and the skew between them

The host half is authoritative for truth and action; the browser half is authoritative for
presentation and interaction. They deploy at different speeds — the browser bundle hot-reloads
while the host needs a restart — so the architecture assumes **the browser may legitimately be
newer than the host**:

- three independent versions are reported by the identity probe — the wire protocol, the
  durable domain format and the record schema; the client checks the protocol and domain
  versions it must speak, while record-schema skew is a host-side persistence concern;
- capability flags tell the client what this host can do (settle, deliver, register, settings),
  and the client degrades visibly instead of guessing;
- a mismatch is reported as a truthful banner ("restart the app to finish") rather than a
  silently empty or stale list.

## 7. Quality attributes as obligations

- **Durability.** A user action is durable before it is acknowledged; every write is
  version-checked; migrations are idempotent and never fatal; one host owns the records.
- **Honesty.** Every claim maps to evidence; failures and refusals carry named reasons and a
  recovery; unknown outcomes are never reported as success; no path is a silent drop.
- **Privacy.** Nothing leaves the machine except the one consented, bounded extraction call; no
  session content, id or title reaches the plugin's logs; the register needs no network.
- **Harness integrity.** The plugin never writes the session log, never declares harness event
  types, never forks the client, and never takes over the composer; the one way it writes into a
  conversation is a labelled notice.
- **Boundedness.** Every queue, history and table is bounded; caps archive and never delete
  except for the explicit delete-forever; scans are resumable and work-sliced so they never
  block a session.
- **Accessibility and internationalisation.** Keyboard access, meaning that is never colour-only,
  both baseline locales registered key-for-key, controls that keep focus and state honest.
- **Performance.** Capture is a pure synchronous fold; no I/O on the model latency path; the page
  polls only while visible; the duplicate read after a write is cheap because the snapshot
  carries a revision.
- **Compatibility.** Three independent versions (record schema, domain format, wire protocol),
  each with its own rule; replay is idempotent; skew is tolerated and surfaced.

## 8. Failure philosophy

The system fails the way an evidence system should:

- **Refuse, do not guess.** A missing agent, an archived session, a moved item, a lost
  permission — each is a named refusal with the recovery offered, never a retry that pretends.
- **A lost race is never a lost update.** Two writers racing on one item (the user and the
  model, two tabs, a duplicated send) are resolved by compare-and-set: the settings write
  returns a conflict value carrying the live record, an item transition returns a named refusal
  with a recovery, and the loser re-reads. Neither outcome silently drops a write.
- **Unknown is not success.** A delivery whose outcome cannot be evidenced is reported as
  unknown with the recovery, because "probably sent" is a lie the register cannot afford.
- **Degrade with an explanation.** Offline, restarting, unconfigured, not captured — each state
  is named in the surface, with a retry where retrying can help.
- **Never take the work down with the plugin.** Capture failures are contained per session; a
  malformed event never throws; a corrupt record is quarantined and skipped; an extraction
  failure leaves the candidate unchanged.

## 9. Boundaries and dependency direction

The domain is split into six bounded contexts around changes that happen for different reasons;
[CONTEXT_MAP.md](CONTEXT_MAP.md) owns the boundaries, relationships and dependency rules. The
three that carry the product are the register (what attention is), capture (how it is learned)
and answering (how it is acted on); surfaces, durability and the model contract exist so those
three can be honest, durable and safe.

The dependency direction in one line: **surfaces → answering/register → durability, and
everything → the shared kernel; nothing points back at a surface, and nothing but answering
touches a session.**

## 10. What this architecture deliberately does not do

Each of these is a decision, not an omission:

- **No session-end hook.** There is no session-end event in the harness; the turn is the durable
  boundary, and capture is a projection, not an after-session pass.
- **No in-tree fork.** The plugin lives out-of-tree and composes public seams; the cost is that
  some capabilities wait for a seam rather than being forced.
- **No composer takeover and no action cards.** The harness's own question and approval cards own the
  conversation; duplicating them would create two answers to one request.
- **No custom pending-interaction kind.** The harness's attention indicator is a closed switch,
  and reusing another kind to light it would be a lie.
- **No batch or approve-all reply.** One item, one deliberate send: batching is how an action
  surface becomes a rubber stamp.
- **No OS notifications, multi-host sync or cross-device access.** The register is one host's
  memory; the single-writer assumption is what makes the evidence story coherent.
- **No model access to the register beyond the tool.** A runtime-context line is designed but
  deliberately not part of the current architecture; the register is the user's, not the model's.
- **No decay yet.** The `stale` state and the rules that respect it exist; the policy that would
  populate it is deliberately deferred (see the register's spec).

## 11. Deferred architectural decisions

| Decision | The seam that keeps it open |
|---|---|
| Decay: when an untouched item becomes `stale` and then `archived` | the state vocabulary and retention rules already exist; only the trigger policy is missing |
| A live host→browser delta channel | the read model is revision-based; a push can replace polling behind the same snapshot contract |
| The runtime-context line for fresh sessions | the model contract separates instructions (nudge) from state (context line); the line is a distinct seam |
| The liveness gate that would justify team-task items | the item kind and closure rules exist; capture's dispatch is the single switch |
| Bounded host hold for unattended asks | delivery already models observe-only asks and refuses/wait as values; a hold adds a bounded wait behind the same track |
| Cross-session grouping of "the same decision" | identity is per-session by design; grouping would be a read-model feature, not a change to the record |
| Workspace entry points (context menu, session pip, header chip) | the page lens and the read model already expose the data; the missing piece is a surface slot |
| Cross-process or cross-device ownership | excluded by the single-writer rule; changing it changes durability's assumptions, not surfaces' |

## 12. Reading on

- [CONTEXT_MAP.md](CONTEXT_MAP.md) — the boundaries, relationships and shared kernel this shape
  decomposes into.
- [UBIQUITOUS_LANGUAGE.md](UBIQUITOUS_LANGUAGE.md) — the words every section above relies on.
- [contexts/](contexts/) — one `CONTEXT.md` per context and the capability specs underneath.
- [adrs/](adrs/) — the cross-context decisions that made this shape hard to reverse.
