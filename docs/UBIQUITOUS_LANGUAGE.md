# Ubiquitous language — Open Items

**Date:** 2026-11-15
**Scope:** the whole `dsh-open-items` domain (Host half, browser half, documentation).

This file is the authoritative glossary. Documentation, code comments, identifiers, UI
copy, spec acceptance criteria and commit messages use these words with these meanings.
When a document and this file disagree, this file wins — then fix the document. When the
code and this file disagree, decide which is right: if the code's behaviour is intended,
amend this file; if the meaning here is intended, the code is a defect.

Three statuses exist for a term, and only these three:

- **Canonical** — the word to use. It has one meaning in this domain.
- **Context-local** — a mechanism name that legitimately means something only inside one
  bounded context (for example *fold* in Capture). Other contexts refer to the concept,
  not the mechanism.
- **Retired** — a word this domain used to use or that readers will expect. It must not
  appear except in the retired-terms table, which says what to use instead.

Capitalisation: "Open Items" is the product; "an open item" is an entity; UI copy uses
sentence case ("Needs you" is the one exception, as a section name).

---

## 1. Actors and places

**User**
The human the register serves. One human per install. The word "you" in UI copy means the
user. Avoid *operator* (that is the connection's peer identity), *owner* (that is the
install), and *customer*.

**Work**
The agent activity that raised an item: the session, turn and steps that are blocked on,
or waiting for, a human decision. "The work is waiting" means the agent cannot act until
the user answers. Work is not the model and not the session; it is what the session is
doing. Prefer "the work" over "the agent" when the subject is *something being blocked*,
and "the agent" when the subject is *a model that can call tools*.

**Agent**
A model-driven actor that can call tools and raise items (via the `open_items` tool).
Subagents and teammates are agents too; their raises roll up (see *Roll up*).

**Host half**
The Node-side half of the plugin: capture, store, read model, reply engine, model-facing
tool. It is the only writer of durable records and the only half allowed to act on
sessions. A "host" without "half" means the DSH process.

**Browser half**
The Web-client half: the page, in-session card, panel, register tab, settings section and
export. It reads through one route and writes only by sending intents.

**Plugin / install / profile / deployment**
The *plugin* is `dsh-open-items` as a package. An *install* is one copy of the plugin in
one profile, with its own durable records and one install identity. A *profile* is a DSH
configuration (for example `web`). A *deployment* is a profile plus the plugin
configuration it supplies (providers, models, caps). Several sessions share one install.

**Session**
A durable DSH conversation. An item is always traced to the session that raised it. See
*Root session*, *Subagent session*, *Cold session*, *Archived session*.

**Root session**
A session the user sees in the session list and drives directly. Capture only produces
cross-session items from root sessions; a subagent's raise is rolled up to its root.

**Subagent session**
A session created by another session to delegate work (`delegationDepth > 0` or
`origin: 'subagent'`). Its unresolved state is delegated work, not a user decision. The
test is the harness's classification, not the presence of a parent id (an ordinary fork
can have one).

**Turn**
The unit of durable progress in a session: it starts at `turn/start` and ends at
`turn/end`. "The turn that raised it" is the item's origin turn. The current turn matters
to answering: a running turn can be steered, an ended turn cannot.

**Message**
A human-originated or notice-originated entry in a session's transcript. "A later user
message" is the usual closure evidence for a candidate.

**Workspace**
A DSH grouping of sessions over a canonical directory. An item stores a workspace
*snapshot* — id (identity), title (display), path (display only) — taken when it was
raised. Grouping is by workspace **id membership in the workspace's session ids**, never
by path and never by the session's current cwd.

**Cold session / Running turn / Archived session**
A *cold session* has no resident agent: waking it costs residency plus a model turn. A
*running turn* is a turn currently in progress. An *archived session* is hidden by the
workspace registry; a message delivered to it is destroyed silently, so delivery must
refuse it.

---

## 2. The item

**Item**
One durable record of something the user must supply before the work can be considered
done. The item is the unit of identity, state, history and evidence in the register. An
item is never a note: the test is *"if the user never answers this, is the work wrong or
incomplete?"* If no, it is not an item.

**Open item**
An item in a live state — one the user has not answered, dismissed, or lost to decay. The
product is named Open Items because this is what it is for. When a spec says "open item"
it means this; when it means the durable entity in any state it says *item*.

**Item kind**
The product-facing classification of what the user must supply. Exactly eight kinds:

| Kind | Meaning |
|---|---|
| `decision` | Choose between options, or settle a direction where alternatives exist. |
| `approval` | Grant permission for a specific action. Always one-shot (see *Allow once*). |
| `question` | Supply information, a yes/no, or a go-ahead. |
| `plan-review` | Approve or reject a plan before work continues. |
| `blocker` | Work cannot proceed until this is resolved. |
| `risk` | Accept or mitigate a stated risk, or acknowledge it. |
| `follow-up` | Agreed work that is not yet scheduled. |
| `task` | A team-board task the user must act on. (See *Team-task capture* in Capture's context.) |

The kind is what the user sees. Detector vocabulary is finer (an *artifact family* names
what was observed); kinds are independent of tier, severity and blocking.

**Tier**
The evidence class of an item's existence, and the gate on whether it may claim attention:

- **Structural** — the item exists because a harness fact says so or because a human/agent
  declared it. Structural items are answerable as items immediately.
- **Candidate** — the item was *inferred* by a heuristic. A candidate is never "Needs you"
  and is not answerable as an item until the user confirms it (see *Promote*). Candidates
  are shown in their own section with their evidence.

Tier is not state, not severity and not a confidence percentage.

**Severity**
The user-facing urgency class of an item, 1–3:

- **1 — Needs you now.** Something is blocked: a failed approval, a pending ask, an
  interrupted turn.
- **2 — A decision.** The work can continue, but the user's call is expected.
- **3 — FYI.** Worth knowing, never counted as "Needs you".

Severity comes from the artifact's nature (or the declaring agent). It is not raised by a
model guess, and it is not the same axis as *blocking*.

**Blocking**
Whether the work is waiting on this item to continue: `true` means "I cannot proceed
without this", `false` means "deciding later is fine". Blocking is declared or derived, and
it is the input to the answering *answer matrix*. Blocking is not severity: a severity-3
follow-up can be blocking if the work stopped, and a severity-2 decision can be
non-blocking if the work moved on.

**Authored item**
An item whose existence was declared rather than observed: raised by the agent through the
`open_items` tool, or by a human action. Authored items have a title key (see *Dedupe key*)
and are the only items whose origin the user can blame on a declaration. For approvals,
authored means "no harness request exists to settle" — the decision is delivered as a
message.

**Derived item**
An item whose existence was observed from a committed harness event (an approval pair, a
pending tool call, a goal change, an interrupted turn, a job). Derived items carry the
artifact they mirror and are structural unless a detector explicitly makes them candidates.
A *mirrored item* is a derived item that mirrors a live ask or approval — the same decision
the chat card shows. Prose is **not** derived: the text is read from the log, but the item
is a heuristic reading of it, so a prose item is inferred and candidate tier.

**Inferred item**
An item produced by a heuristic from the turn's text or its plan state. Inferred items are
always candidates unless promoted. "Inferred" describes how the item came to exist;
"candidate" describes what the user may do with it. A prose candidate's evidence is derived
from the log record, but the item itself is inferred — the two words are not interchangeable.

**Item id**
The durable identity of an item: a UUIDv7, so ids sort by creation time. It is stable
across moves, edits and reopens. It is not the dedupe key and not the artifact id.

**Artifact id**
The identity of the observed fact inside its session, for example `approval:call_…`,
`question:call_…`, `goal:…`, `job:…`, `prose:t<turn>:<hash>`. Replaying the same log
produces the same artifact ids. Users never see them.

**Dedupe key**
The stable key that decides when two sightings are one item. Two forms exist, both scoped to
the session:

- **authored form** — kind + session + normalised title; minted when an agent declares an item;
- **artifact-keyed form** — kind + session + artifact id; used for every item whose existence
  rests on a log artifact, whether it is *detected* or *inferred*. The code's builder is named
  after the artifact (`derivedDedupeKey`); the item it keys need not be a derived item.

Same decision in two different sessions is two items (different context the user is being
asked about). A re-raise of a still-open item merges into the existing item and says so.
See also *Occurrence*.

**Occurrence**
One additional sighting of a *detected or inferred* (artifact-keyed) item that already exists
(same dedupe key).
Occurrences refresh `lastSeenAt` and are recorded (bounded), but they are not new items and
must not notify as if they were. An authored re-raise of a still-open item is not an
occurrence: it merges silently, returns the existing item and reports the dedupe, and writes
nothing.

**Suppressor**
A durable "the user said this is not an item" record. It is written only by *Suppress*
(the candidate action), and it matches on the dedupe key prefix so the same inferred ask
cannot re-raise. A plain dismiss does not write one.

**Tombstone**
The record left by *Delete forever*: the item resolved, the title and body replaced by a
deletion marker, retention archived. A tombstone is excluded from the inbox, the register,
counts and exports; it is not a resolution; it cannot be archived or pruned into
nothingness; capture cannot re-raise it.

---

## 3. Lifecycle

**State**
One of six lifecycle states. State answers "what is this item doing right now?", never
"what happened to it" (that is a *Resolution*).

| State | Meaning |
|---|---|
| `open` | Live, waiting on the user. The default. |
| `snoozed` | Deferred by the user until a stated instant. Wakes back to `open`. |
| `awaiting` | The user replied; the work has not yet acknowledged it. Waiting on the work, not on the user. |
| `stale` | The item's raising context has gone quiet (the session moved on or went cold). Still tracked; still counts as Needs you when severity and tier allow. |
| `archived` | A live item moved out of the active register by a cap or by decay. Hidden from Needs you; still tracked and listed under Archive. |
| `resolved` | Terminal outcome. The item is a register entry from then on. |

**Resolution**
The recorded outcome that ends an item's active life. A **settle** (client- or host-settle)
records the payload when the answer is accepted, and the item moves to `awaiting` carrying it.
A **session-message** reply records no resolution at send: the item is `awaiting`, and the
answer it carried becomes the resolution when the work acknowledges it or when the
acknowledgement window elapses with no evidence. In both cases the item's *state* becomes
`resolved` only then. Exactly four kinds:

| Resolution kind | Meaning |
|---|---|
| `answered` | The user supplied the decision/answer (or the detector's own mechanism resolved it). |
| `dismissed` | The user said this is not an item. |
| `superseded` | A later turn/message made the item moot without an answer. |
| `detected-closed` | A detector, migration or reconciler closed the item without a human answer. |

A resolution records its **actor**: `user` (a human action in a surface), `model` (the
agent recording the human's decision, answer or dismissal from the conversation), or
`detector` (a closure rule).

**Closure**
The act of a *closing detector* resolving an item. "Closed automatically" is UI copy for a
`detected-closed` resolution; in documentation use *closure* or *detector-closed*.

**Reopen**
A user action that returns a settled (`resolved`) item, or a cap-archived (`archived` state)
item, to `open`. A resolved item moves its prior resolution into the item's *resolution log*
and increments `reopenCount`; a cap-archived item keeps its content and has no resolution to
move (the archived state is not an outcome). A permission that was exercised is not reopenable
as a plain item (the honest action is a correction).

**Resolution log**
The bounded history of earlier resolutions, so a reopened item keeps what came before.

**Acknowledgement**
The question "did the work act on the user's answer?" — not "did the user answer?". The
acknowledgement state is `pending` (no evidence yet), `observed` (evidence exists) or
`none` (the window elapsed with no evidence). Evidence kinds are specific: a tool result,
a continued turn, a retried call, a resumed goal, a completed task, a next turn. An item
becomes `awaiting` on reply; the register reports it as *in flight* until acknowledgement.

**Acknowledgement window**
The policy bound (24 hours by default) after which a `pending` acknowledgement becomes
`none`. "No acknowledgement observed" is the honest report; it is not a failure claim.

**Archived (two meanings — always qualify)**
- **Archived item state** — a live item moved out of the active register (cap or decay);
  it keeps its content and can be seen under Archive.
- **Archived retention class** — a resolved register entry older than the active window
  whose transcript-derived text is dropped while the decision is kept.

Never say "archived" alone when the difference matters.

**Prune**
Removing the oldest *archived retention class* entries when the resolved-record cap is
exceeded. Pruning is a cap behaviour on archived entries only. It is not decay and it is
not a user action.

**Retention class**
Whether a resolved register entry is *active* (its text is kept) or *archived* (its
transcript-derived text is dropped and the decision is kept). Retention class applies to
resolved entries only; it is not the archived item state. The register owns the policy that
sets it; Durability & Integrity owns applying it durably.

---

## 4. Capture vocabulary

**Capture**
The bounded context that answers "how do we know something is waiting?". Capture turns
committed session evidence into item drafts. It never writes records and never decides
identity; the register does.

**Detect**
To recognize an artifact in committed events and open a draft for it.

**Derive**
To compute an item from a committed harness event (as opposed to inferring it from text).

**Fold**
*(Context-local, Capture)* The pure per-session function that walks committed events and
produces the session's capture state: open artifacts, pending closures, prose asks. A fold
is all-or-nothing per event, replayable and side-effect free.

**Ledger**
*(Context-local, Capture)* The per-session state a fold produces and a projection
checkpoints. A ledger holds open artifacts, their closers and the turn bookkeeping.

**Projection**
*(Context-local, Capture)* The registered mechanism that drives folds over every session
and checkpoints a ledger at turn boundaries. The production line, not a report.

**Artifact**
The harness fact a detector observed: an approval pair, a pending tool call, a goal phase,
a turn interruption, a job, a turn's final text, a plan snapshot. Artifacts are the
evidence an item's existence rests on.

**Artifact family**
A group of artifacts with one fold handler and one closing detector: approval, question and
plan review, interrupted turn, goal, background job, prose, plan (`todo`), team task.

**Detector**
The rule that recognizes one artifact family. A detector produces a draft with a kind,
severity, title and evidence.

**Closing detector**
The rule that resolves an artifact's item. Non-negotiable: every family must name a closer,
so the register cannot rot. A family that cannot name one does not ship.

**Raise**
To create an item (or a candidate) in the register. "Raise" is the verb for existence; the
agent's declaration, a detector's draft and a backfill's replay all raise.

**Roll up**
To attribute an item raised by a subagent or teammate to its root session, labelled as
raised by that subagent. The item belongs to the root conversation; the subagent's session
is provenance, not ownership.

**Candidate gate**
The bounded policy that turns inference into candidates instead of items: what may be
inferred, how many per turn and per session, how it is corrected, and when it closes. The
**prose gate** is the specific gate over a turn's final assistant text.

**Ask**
One item-shaped request inside the agent's final message ("should I use A or B?"). A batch
of asks from one turn is the unit the prose gate bounds and closes together.

**Extraction**
*(Context-local, Capture)* The optional, model-assisted second opinion on a *new live*
prose candidate: it may drop the candidate or refine its kind and title, never create one.
Extraction is permissioned by *Consent*; without consent and configuration nothing leaves
the machine.

**Backfill**
The bounded, resumable scan of sessions that existed before the plugin: it folds their
logs once so the register is not empty on day one.

**Rescan**
The periodic, bounded repeat of the backfill over eligible sessions, so items closed
outside the live path are still closed.

**Hydration**
The one-time read of a session's committed log when its first live event arrives, so a
restart does not lose the closers for items raised before the restart.

**Replay**
Re-folding a session's log from its start (a fold or projection version change). A replay
must be idempotent: no item churn, no duplicate raises.

**Fork cut**
The event boundary an inherited session must never fold below: events the session
inherited from its parent are skipped, so an item is not raised once per fork.

**Cursor**
The per-session record of how far a fold/scan has processed (`lastScannedSeq`, fold
version). Cursor coverage is the only sound skip proof for scans.

**Capture evidence**
What proves an item's existence: the artifact (ids, seq, turn, call id), the verbatim
quote where the artifact carries text (an inferred ask, or a harness reason/objective/plan),
and the origins of evidence (projection, log-fold, regex gate, model extraction, tool
declaration, human action). Not to be confused with *Delivery
evidence*.

**Quote**
The verbatim, markdown-clean excerpt that proves an item: for an inferred item, the ask
itself (shown to the user when confirming a candidate); for a derived artifact, the harness
text that justifies it (an approval reason, a goal objective, a plan, an unknown-outcome
message). It is evidence, not a summary. The two uses have different bounds — narrower for an
inferred ask, wider for harness text — and each spec states its own bound.

**Batch**
One turn's set of inferred asks, treated as a unit for bounds and closure. A batch never
supersedes its own members.

**Supersession**
Closure of a candidate because a later turn or user message made it moot. Supersession is
not dismissal and writes no suppressor.

**Promote**
The user's confirmation of a candidate: it becomes a structural item, answerable like any
other, with an optional **correction** of its inferred kind, title, body, quote or options.
A correction rekeys the item's dedupe key (and its suppressor) so the corrected identity is
the one the register keeps.

**Suppress**
The user's "not an item" on a candidate: it resolves as dismissed and writes an exact-key
**suppressor**, so the same dedupe key cannot raise again. A plain dismiss is not a suppress.

**Todo aggregate**
The single severity-3 `follow-up` candidate per session that lists an abandoned plan's
unfinished items; closed by a later completed plan, never by a user message. It is always
produced (it is not gated by the prose-candidate preference) and never counts as Needs you.

**Declaration**
A raise made by the agent through the `open_items` tool (an authored item), as opposed to an
item observed from the log. A declaration states what the agent needs; it is not a claim
about the session's state.

---

## 5. Answering and delivery

**Reply**
The user's action and content sent from a surface for one item: the typed payload (option,
text, approval outcome, task action, dismiss) plus the surface's intent. A reply is an
attempt; it is not yet a resolution.

**Reply descriptor**
What a surface must render to make an item answerable in place: the controls
(option/text/approve/deny/task-action), the verbatim options, whether free text is allowed,
whether the send will wake a session, and the copy note.

**Answerable**
Whether an item can be settled or delivered from the surface without navigating. Almost all
items are answerable; the honest exceptions are named in the surface.

**Answer**
The substantive decision text or option the user supplied. "The answer" is the content;
"the reply" is the act and its payload; "the resolution" is the recorded outcome.

**Settle**
To answer a *live* ask or approval through its own channel, so the request resolves and the
blocked turn continues. Settling applies only where a real request exists (mirrored items,
continued questions). Settle-once: a request can be settled exactly once.

**Deliver**
To put the reply into the session as a message the agent will see at its next step. Delivery
is the only path for authored items, inferred items (after promotion) and any item with no
live request. "Sent to session" is the delivery claim.

**Record**
To save an answer for the work without waking it. "Recorded" is honest about the work not
having seen the answer yet.

**Delivery attempt**
One logged attempt to carry a reply: its track, payload, state, evidence and failure. It is
append-only and bounded. The **delivery id** identifies the attempt across the route, the
message source and the log, which is what makes sends idempotent.

**Delivery track**
How a reply travels. Three tracks exist:

| Track | What it does |
|---|---|
| `client-settle` | The browser settles the live ask/approval through its own card; the host records the evidenced outcome. |
| `host-settle` | The host settles a continued question through the ask channel; no browser needed. |
| `session-message` | The host sends the reply into the session as a notice-sourced message. The universal path; costs a turn. |

**Delivery state**
The evidenced state of one attempt: `sending`, `settled`, `queued`, `delivered`,
`acknowledged`, `failed`. A surface may claim only what the state proves — *"Answer
applied"* for settled, *"Sent to session"* for queued/delivered, never a merge of the two.
The claim may be narrower than the state: an outcome the durable record cannot distinguish
(a recorded answer) is never read back as applied, and a replayed rendering states only what
the record proves.

**Delivery evidence**
The log coordinates that prove a delivery landed: sequence, message id, call id, inbox id.
Distinct from *Capture evidence* and from *Acknowledgement evidence*.

**Claim**
What a surface may say happened, and the evidence it requires. Four claims are distinct
and may never stand in for each other: *applied* (the ask or approval was settled and the
work continues), *sent to session* (the message was queued or delivered), *recorded* (the
answer is saved but the work has not seen it), and *not applied* (a named failure with a
recovery). A surface may show only the claim its evidence proves; an immediate reply outcome
may be narrower than the durable claim, and a replayed rendering may state only what the
durable record proves.

**Two-phase delivery**
The property of a session message that it is first committed durably to the session's
inbox and only later claimed by a step; between the two it can be parked, superseded or
lost. It is why *sent* and *applied* are different claims.

**Failure code**
The named reason a delivery failed: `was-not-applied`, `cannot-apply`,
`session-archived`, `agent-unavailable`, `operator-cancelled`, `unknown-outcome`, `parked`.
Never a bare boolean, and never silently retried.

**Live ask**
A harness question or approval that is currently pending in a session: a real request with
an owner, a call id and (where a browser holds it) a card. Live asks are observed, not held.
When the point is the request's identity or whether it can still be settled, the corpus also
says **live request**; it is the same concept, not a second one.

**Ask liveness**
Whether the request an item mirrors is still answerable: *live* (a request exists and can be
settled), *not live* (it resolved or expired), or *unknown* (the process cannot tell).
Liveness decides whether a reply may settle, must be delivered, or must be refused.

**Mirrored item / Authored approval**
For an `approval`, the origin decides the answer path. A mirrored approval has a real
request and is settled only through the live card, once, never retroactively. An authored
approval has no request: its outcome is delivered as a message and recorded as such.

**Allow once**
The only approval outcome the domain may produce: one request, one action, no persistence.

**Approve & retry**
The honest recovery when the request a mirrored approval refers to is no longer live: an
instruction to the work to re-issue the action, which produces a new request. It is never an
approval of the expired request and never a retroactive grant.

**Fail closed**
When an approval or ask cannot be answered through its own channel, the outcome is refusal
with a named reason and an alternative — never a grant, never a silent success.

**Wake**
To resume a cold session by delivering a message into it. Waking costs residency and a
model turn, so it requires an explicit *confirmed wake* from the user and must be visible in
the control's copy.

**Confirmed wake**
The user's explicit agreement that a reply may resume a cold session and spend a turn. It is
required before any send that would wake a session, and the control's copy must say so
before the click.

**Steer**
To interrupt a running turn so the reply lands at the agent's next step. Steer is only for
a running turn and only when the item is blocking; otherwise *record*.

**Answer matrix**
The rule table that decides settle/steer/record/deliver/refuse from the item's origin and
the session's state. Every surface uses the same matrix; the surface never chooses the
track.

**Notice**
A transcript entry written by the plugin rather than by the user. A delivered reply renders
as a notice labelled with the plugin's source kind, never as the user's own message. This is
attribution honesty, not a cosmetic choice.

**Idempotency**
One reply action produces at most one delivery attempt. A repeated delivery id returns the
recorded attempt only for a lost response of an accepted or in-flight attempt; retrying a
failed attempt mints a new delivery id and appends a new attempt. A second click while sending
is a no-op.

**Compare-and-set (CAS)**
The concurrency rule for every durable write: a write carries the version it read, and a
mismatch is a *conflict*, never a lost update. The settings write returns a conflict as a
value carrying the live record; an item transition returns a named refusal with a recovery
and the caller re-reads. Either way one writer wins and the loser is told the truth.

---

## 6. Surface vocabulary

**Surface**
One place the user meets the register. Three surfaces ship plus the settings section: the
page, the in-session card, the per-session panel, and Settings → Open Items.

**Inbox**
The page's primary sections — Needs you, Candidates, Snoozed — where open items are listed
and answered. "The inbox" is not the durable record; that is the *register*.

**Page**
The Open Items page in the left navigation. A cross-session view with one shared
list/detail region and a tab strip.

**Read model / Snapshot**
The merged, filtered view a surface renders: items page, session rows, workspace rows,
global counts, revision and paging cursor. One read model serves every surface, so no
surface can contradict the badge that sent the user there.

**Revision**
The read model's monotonic per-process counter. A client compares revisions to detect a
stale snapshot cheaply; it re-reads, it never patches a snapshot locally.

**Nav row / Dot**
The left-navigation entry for the page. The **dot** means "items new since your last
visit"; it is not a count. The page title carries the count.

**Needs you / Candidates / Snoozed / Resolved**
The four page sections:
- *Needs you* — structural items the one Needs-you predicate counts.
- *Candidates* — inferred items awaiting confirmation.
- *Snoozed* — items deferred until a stated instant.
- *Resolved* — the register view: every resolution, in-flight entries first.

**Grouping / Lens / Facet**
*Grouping* is how the list is grouped: by Session (default) or by Workspace (the workspace
*lens*). A *facet* is a filter over a grouping dimension (for example the workspace facet).
Counts are global; grouping and filters change the list, never the counts.

**Source (filter)**
Two different filters share the word. In the inbox, *source* distinguishes authored items from
derived items. In the register, *source* has two values — the resolution actor: *by you*
(`user`) or *automatic* (`detector`); *in flight* is a band/outcome, not a source value. Always
say which sense is meant.

**Triage order**
The defined ordering inside a group: severity (1 before 2 before 3), then age; sessions and
workspaces carry their own defined orders. Ordering is deterministic, never incidental.

**Row**
One item in a list: kind, title, quiet metadata and the answer control. A row is not the
item; it is a projection of it.

**Session row / Workspace row**
The grouping rows: a session row carries the session's counts and running/archived state
where known; a workspace row carries its item and session counts and whether the workspace
is removed. They are read-model rows, not items.

**Detail pane**
The secondary pane showing one item's body, evidence, delivery state and actions. Wide
screens show list + detail; narrow screens push the detail.

**In-flight band**
The top region of the Resolved section listing replies that have left the user but have no
terminal acknowledgement yet.

**Card**
The in-session surface attached to the `open_items` tool row: the item as it was raised,
answerable in place. It hydrates by item id and version; it is a snapshot, not the truth.

**Panel**
The per-session right-panel tab: what this conversation still owes the user, split into
needs you / waiting / resolved here.

**Source indicator**
The glyph-plus-word marker on a register row that says how an entry ended without relying
on colour: `✓ by you` (answered), `✓ muted` (dismissed), `↗` in flight, `○ automatically`
(detector-closed, naming the detector). Meaning is never colour-only.

**Handoff**
A navigation from one surface to another that carries its scope, for example the panel's
*View all* opening the register filtered to that session. A handoff changes what the user
is looking at, not what the register holds.

**Answer-as-delivery**
The rule that answering from the in-session card is a delivery, not a settle: the card owns
no live request, so its answer travels the ordinary session-message path.

**Card hydration**
Reading an item record by id and preferring a newer version when the card replays, so the
card renders current state rather than the snapshot captured at raise time. Not the same as
Capture's *hydration* (reading a session's ledger from its log); always qualify the sense.

**Settings section**
Settings → Open Items: the user's preferences for capture and model-facing behaviour. No
Save button; each change is a compare-and-set write applied immediately.

**Freshness**
How a surface learns the register changed. The client re-reads on its own writes, window
focus/visibility, connection reset and a visible-window poll; it never patches locally from
a partial response. A snapshot carries a *revision* so a stale client is detectable.

**Paging cursor**
The opaque continuation token for the next page of a list or register read. It is not
Capture's detection cursor; when the word appears in a surface context it means paging.

**Last-visit watermark**
The instant of the user's previous visit to the page. It drives the nav dot and the
*new since last visit* count, and it is not a list filter.

**Completeness flag**
The read model's honest note that older archived entries were pruned by the resolved-record
cap, so a count or page may not be total. Its wire and UI label is *"earlier records pruned"*;
a surface must show it when it is set. Avoid: *pruned flag*.

**Owner fence**
The transport rule that only the owning client peer may read or write the register through
the route. Authentication and the fence belong to the connection layer, not to the domain;
the domain relies on them rather than re-implementing them.

**Page state**
The page's own interaction state — section, grouping, filters, detail selection and scroll
— remembered while the app session lasts so opening a conversation and coming back does not
reset the user's place.

**Degrade truthfully**
The rule that an unavailable capability, a stale bundle, a restarting host or an offline
route is described as such, with a retry — never shown as an empty register or a fake
success.

**Export**
A deterministic, local rendering of the current register filter as CSV, JSONL or HTML.
Determinism is a requirement: the same records, filter and *export time* produce
byte-identical output. The export time is an explicit generation input (the only clock in
the file), so the rule is testable with an injected time rather than accidental.

---

## 7. Model-facing vocabulary

**`open_items` tool**
The single model-facing tool: actions `raise`, `list`, `resolve`, `dismiss`. `raise`
declares an item; `resolve` records that the user answered in conversation (`actor: model`);
`list` reads the register; `dismiss` says a declared item is not wanted. The tool's wording
is part of the contract (the failure mode is over-raising).

**Nudge**
The opt-in system-prompt section that tells the agent when to raise and resolve. A nudge is
guidance, not enforcement; it is off by default, and it is not a runtime-context line.

**Runtime-context line**
The designed (not current) single context line telling a fresh session about open items
from other sessions. It is distinct from the nudge: a runtime-context line carries *state*,
the nudge carries *instructions*.

**Model-facing surface**
Any seam through which the product talks to a model: the `open_items` tool declaration, the
opt-in nudge, and the designed runtime-context line. A model-facing surface carries one of
three things — an action contract (tool), instructions (nudge) or state (runtime-context
line). The nudge, the runtime-context line and model-assisted extraction are consent-gated and
default off; the declaration tool is always available (an offer to declare, not an
instruction), and the local confirm-first prose gate defaults on — the deliberate exception
recorded in the Model Contract's ADR 001 (default-off model surfaces).

**Consent**
The user's permission for a model-facing or egressing capability, expressed through the
settings record and, where required, deployment configuration. Consent is required for
extraction; nothing may leave the machine without both.

**Egress**
Any byte sent from the machine to a model provider because of this plugin. The domain
permits exactly one optional egress path (extraction) and requires that it be off by
default, bounded and content-minimal.

**Settings record**
The single versioned per-install preferences record: model nudge, prose candidates,
model-assisted extraction. Defaults are served without materialising a row; a write is a
compare-and-set patch.

**Opt-in / Default-off**
A capability is off unless the user (and, for extraction, the deployment) turns it on.
This is a product posture, not a configuration convenience: the register must never surprise
the user with behaviour they did not ask for.

---

## 8. Durability vocabulary

**Store**
The durable persistence mechanism holding the register: one record per document under the
install's storage domain, validated at the durable boundary. The store is a mechanism; the
*register* is the domain memory it holds.

**Record**
One durable document: an item record, a detection cursor, a suppressor, or a meta row
(install identity, settings, last backfill report). "Record" is the storage word; "item" is
the domain word.

**Durable boundary**
The place where an untrusted durable value becomes a record and where every record is
validated. An invalid record is quarantined and skipped rather than disabling the register;
validation failures never reach the user as silent absence.

**Schema version**
The version of a record's shape (store schema). A reader rejects a newer version and never
reads an older one under the current shape: an explicit migration transforms it and writes
it as the current shape, and a record with no such path is set aside rather than guessed at.
Distinct from the domain format version and the wire protocol version — three independent
versions, each with its own contract.

**Migration**
A bounded, idempotent, one-time transformation of stored records (or of inferred items and
suppressors) at activation. Migration is audited, counted and never fatal to activation.

**Retention**
The policy that keeps the register honest over time: the acknowledgement window, the active
register window before archiving, the resolved-record cap, and the live-item cap.
The register owns the policy; Durability & Integrity applies it durably. Retention never
deletes by decay; only an explicit delete forever, or pruning of archived resolutions past
the cap, removes a record.

**Resolved-record cap**
The safety cap on stored resolutions (default 5000, deployment-configurable within a bounded
range). It counts every resolved register entry, active and archived; only entries in the
archived retention class can be pruned against it, and a tombstone is not a resolution and does
not count. Avoid: *saved-resolution safety cap*, *resolved-record safety cap*.

**Live cap**
The cap on live items. Breaching it archives the items with the least claim on attention
first — `stale` before live ones, then least urgent severity (3 before 2 before 1), then
oldest update — and it never deletes.

**Backfill report**
The durable, counts-only record of the last bounded scan: when, what armed it, and
how many sessions were eligible/folded/skipped/failed, with draft and batch counts and
duration. It carries no session ids, titles or content.

**Session log**
The durable per-session event log maintained by the harness. The plugin **reads** it and
**never writes** to it. This is a hard constraint, not a preference: a write would make
sessions that used the plugin fail to restore.

**Single writer**
The rule that exactly one Host instance owns an install's records. There is no
cross-process locking; the plugin's durability story assumes one owning host.

---

## 9. Measures and predicates

**Live item**
An item in a live state — `open`, `stale` or `snoozed`. Live items count against the live
cap and are the population caps and decay act on. Items in `awaiting` and `resolved` are not
live items.

**Needs you**
A computed predicate, not a state and not a tab-only concept: an item is "needs you" when
its state is `open` or `stale`, its tier is `structural`, its severity is 1 or 2, and it is
not a tombstone. Candidates, snoozed items, awaiting items and FYI items are counted
separately. Every surface that says "Needs you" must use this one predicate; the nav dot,
page counts, tab counts, workspace counts and session counts all follow from it.

**Global counts**
Counts are over every stored record and do not change when the user filters or searches.
The page title count, the nav label and the session rows are all statements about the whole
install.

**new since last visit**
The count of items first seen at or after the user's last visit watermark (an inclusive
boundary; the watermark instant itself counts as new). It drives the nav dot and the register's
period window; it is not a filter on the inbox list.

**In flight**
The register's view of a reply with no terminal acknowledgement: the item is `awaiting`,
the delivery is `settled`/`queued`/`delivered`, and the register shows it in the in-flight
band. Not the same as "open" and not the same as "answered".

**Waiting on the work**
The user-facing phrase for `awaiting`: the user has done their part; the work has not yet
shown it acted.

**FYI**
Severity 3. Never counted as Needs you; hidden from the default sections unless it is a
candidate awaiting confirmation.

**Zero-item state**
An empty Needs you section that is *explained*: what has been scanned, whether capture
mounted, whether the first backfill has reported. An unexplained empty list is a defect,
because it is indistinguishable from a broken capture.

**Honest failure**
Every refusal, failure and unknown outcome is reported with a named reason and a recovery.
The domain has no silent drops: a reply that could not be applied says so.

---

## 10. Retired and forbidden words

| Avoid | Status | Use instead | Why |
|---|---|---|---|
| fingerprint | Retired | **dedupe key** | The stored identity is the dedupe key; "fingerprint" appears in older design prose only. |
| pending item | Retired | **open item** / **live ask** | "Pending" conflates an item waiting on the user with a request pending in a session. |
| notification, alert, reminder | Retired | **nudge** (model), **nav dot** (surface), **notice** (transcript entry) | Three different mechanisms were all called notifications. |
| auto-closed, auto-close | Retired | **detector-closed** / **closure** | Says who closed it and how. |
| task (alone) | Forbidden | **team task** (a harness artifact) or the item kind `task` | Two referents; always qualify. |
| answered (as a state) | Forbidden | state `resolved` + resolution `answered` | State and resolution are different axes. |
| settle (for authored items) | Forbidden | **deliver** / **record** | Settling requires a live request to resolve. |
| register (verb) | Forbidden | **record**, **raise**, **deliver** | "Register" is a noun in this domain. |
| draft (user-facing) | Retired | **item** / **candidate** | A draft is capture-internal work in progress. |
| uncertainty (kind) | Retired | kind `question`, `risk`, or `blocker` | Legacy migration vocabulary; not a product kind. |
| stale request / stale button | Forbidden | **expired ask** / **out-of-date control** | `stale` is an item state; a request that is no longer live is *expired*. |
| inbox (as the whole system) | Forbidden | **Open Items** / **the register** | The inbox is a surface; the register is the durable memory. |
| store (for the register) | Forbidden | **register** (domain), **store** (mechanism only) | Keeps the domain memory and its persistence mechanism distinct. |
| Needs You, Needs-you | Forbidden | **Needs you** | Section copy is sentence case. |

---

## 11. Ownership index

Each context owns the meaning of these terms; other contexts use them, never redefine them.

| Context | Terms it owns |
|---|---|
| Attention Register | item, open item, live item, item kind, tier, severity, blocking, authored, derived, inferred, item id, dedupe key (authored and artifact-keyed forms), occurrence, suppressor, tombstone, state, resolution, resolution actor, closure, reopen, resolution log, acknowledgement state, archived item state, retention class, prune, retention policy (windows and caps), Needs you, global counts, in flight, waiting on the work |
| Capture | capture, detect, derive, fold, ledger, projection, artifact, artifact family, detector, closing detector, raise, declaration, roll up, candidate gate, prose gate, ask, promote, suppress, correction, todo aggregate, extraction, backfill, rescan, hydration, replay, fork cut, cursor, capture evidence, quote, batch, supersession |
| Answering & Delivery | reply, reply descriptor, answerable, answer, settle, deliver, record, claim, two-phase delivery, delivery attempt, delivery id, delivery track, delivery state, delivery evidence, failure code, live ask, ask liveness, mirrored item, allow once, approve & retry, fail closed, wake, confirmed wake, steer, answer matrix, notice, idempotency, compare-and-set, acknowledgement evidence kinds |
| Surfaces | surface, inbox, page, nav row, dot, Needs you / Candidates / Snoozed / Resolved sections, grouping, lens, facet, source filter, triage order, row, session row, workspace row, detail pane, in-flight band, card, card hydration, panel, settings section, read model, snapshot, revision, paging cursor, last-visit watermark, completeness flag, page state, handoff, source indicator, answer-as-delivery, freshness, owner fence, degrade truthfully, export, export time |
| Durability & Integrity | store, record, durable boundary, schema version, migration, retention application (sweep, prune, live-cap application), backfill report, session log, single writer |
| Model Contract & Consent | `open_items` tool, model-facing surface, nudge, runtime-context line, consent, egress, settings record, opt-in/default-off |

---

## Appendix — Code anchors

The glossary is the meaning; these are the names the code uses for it, so a reader can
move between documentation and implementation. Names only — see the design packet for
paths and mechanisms.

| Term | Code name |
|---|---|
| item | `OpenItemRecord` |
| item kind | `OpenItemKind` |
| tier | `OpenItemTier` (`structural` / `candidate`) |
| severity | `Severity` (1–3) |
| state | `OpenItemState` |
| resolution | `Resolution`, `ResolutionKind` |
| acknowledgement | `Acknowledgement`, `AcknowledgementEvidence` |
| delivery attempt | `DeliveryRecord`, `DeliveryState`, `DeliveryTrack`, `DeliveryFailureCode` |
| reply payload | `ReplyPayload` |
| reply descriptor | `ReplyDescriptor` |
| dedupe key | `dedupeKey` (`authoredDedupeKey` / `derivedDedupeKey`) |
| suppressor | `SuppressorRecord` |
| capture draft | `DerivedItemDraft` |
| detection sources | `DetectionSource` |
| retention | `Retention`, `RetentionPolicy` |
| settings record | `SettingsRecord`, `DEFAULT_SETTINGS` |
| backfill report | `BackfillReportRecord` |
| Needs you predicate | `isNeedsYouRecord` |
| live states | `LIVE_STATES` |
| needs-you states/severities | `NEEDS_YOU_STATES`, `NEEDS_YOU_SEVERITIES` |
| read model | `InboxSnapshot`, `InboxQuery`, `CountSummary` |
| the route | `POST /api/open-items` (`RequestEnvelope`, `RouteReply`) |
