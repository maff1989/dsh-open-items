# Structural capture — families, closers and the driving model

**Context(s):** Capture, with Attention Register consuming the draft contract · **Date:** 2026-11-15

> Intent spec. It states what the capability is for and what it must do; it does not describe files,
> functions or snippets. The design packet and the code own mechanics.

## Definitions

These are the terms this spec relies on; their canonical senses are in
[UBIQUITOUS_LANGUAGE.md](../../../UBIQUITOUS_LANGUAGE.md) §4, refined here where this capability
uses them with extra conditions.

- **Committed event** — one immutable record in a session log: session id, strictly increasing
  `seq`, event type, event time, opaque payload. Only committed events are evidence.
- **Artifact** — the harness fact a detector observed: an approval pair, a pending tool call, a
  goal phase, a turn interruption, a job, a plan snapshot.
- **Artifact family** — a group of artifacts with one fold handler and one closing detector.
- **Detector** — the rule that recognises one family and produces a draft: a product kind, a
  severity, a title, a body and its evidence.
- **Closing detector** — the rule that resolves an artifact's item, named by its family. A family
  that cannot name one is not dispatched.
- **Structural capture** — the part of capture that *derives* items from committed artifacts; its
  items are structural in tier because a harness fact says they exist. **Derive** = compute an item
  from a committed harness event; **detect** = recognise an artifact and open a draft for it.
- **Artifact id** — the fact's identity inside its session (`approval:call_…`, `question:call_…`,
  `goal:…`, `interrupted:call_…`, `job:…`). Replaying the same log produces the same ids; users
  never see them.
- **Draft / closure draft** — what capture publishes: a draft opens or refreshes an item; a closure
  draft records that an artifact resolved, with its closure code. Neither is an item record.
- **Ledger** — the plain-JSON per-session state: open artifacts, pending evidence and turn
  bookkeeping. **Fold** = the pure, synchronous, all-or-nothing-per-event function from (ledger,
  event) to (ledger, drafts).
- **Projection** — the registered mechanism that drives the fold over every session and
  checkpoints the ledger at turn boundaries. **Live drive** = folding committed events as they
  land, so a detector reacts within the turn that produced the evidence.
- **Live-only artifact** — an artifact truthful only while observed live (a pending ask whose
  request exists only in the running process). A cold read may close it, never raise it.
- **Fork cut** — the inherited-prefix boundary; events inherited from the parent are never folded.
  **Replay** = folding a session's log again from its start; it must be idempotent.
- **Cursor** — the per-session record of how far a fold has processed. Cursor coverage is the only
  sound skip proof.
- **Detection source** — the named origin stamped on a draft: projection, log fold, regex gate,
  model extraction, the declared tool, a human action.
- **Capture evidence** — artifact id, session, seq, turn, call/approval/goal/job id, detector code,
  detection source, and the verbatim quote where the evidence is text.
- **Workspace snapshot** — the workspace id, title and path frozen on an item at raise time. The id
  is identity; title and path are display only.
- **Root session / subagent session** — a root session is driven directly by the user; a subagent
  session is delegated work (`origin: 'subagent'` or delegation depth > 0).
- **Kind, severity, blocking** — the product classification, the urgency class (1–3) and whether
  the work waits on the item. Capture proposes them; the register owns their meaning.

## Constraints

1. **Order.** Facts → meaning → declaration → gated inference. A blocking structural item for a
   turn suppresses inference over that turn; inference never stands in for a fact.
2. **Total, pure, plain-JSON fold.** A malformed, unknown or uninteresting payload never throws and
   never changes the ledger; an uninteresting event returns the previous state by reference;
   processing is all-or-nothing per event; the state survives a projection checkpoint and a cursor
   round-trip, and a partially written state reads as "nothing known yet".
3. **Determinism.** The same log produces the same artifacts and drafts. Artifact ids derive from
   committed facts only (never the clock or the message head); a baseline reports artifacts in
   stable artifact-id order; a batch is ordered by event `seq` then family dispatch order; text
   bounds are word- or line-bound.
4. **Read-only.** Capture never writes the session log and never writes an item record. It reports
   drafts and closures through the published draft contract.
5. **Root-only detection.** No structural draft comes from a subagent session; delegated work is
   not a user decision. The declared raise is the one rolled-up path
   ([authored capture](authored-capture.md)).
6. **Fork cut.** Every event below the session's inherited prefix is skipped. The live path gets the
   exact prefix length from the session; a cold read derives it from the log's last
   seeded-inheritance marker.
7. **Live-only rule.** A cold read (backfill, cold projection, replay) never raises a live-only
   artifact; its closures always pass, so a decided ask closes an already-open pending row.
8. **One declared closer per family.** Each dispatched family declares *detector* (a later event
   always closes it), *conditional* (a later event closes it only if the agent retries or resumes;
   otherwise the user resolves it) or *user-only*. The declaration is part of the acceptance
   contract.
9. **Every draft carries evidence.** Artifact id, detector code, detection source, session, the
   location ids the artifact provides, and the quote when the artifact carries text. Title 120
   characters on one line; body 2000; a detected artifact's quote 2000, word-/line-bound (an
   inferred candidate's ask quote is bounded separately at 300 —
   [candidate tier](candidate-tier.md)). A pending ask quotes its first question; a plan quotes the
   plan text; a plan snapshot lists at most five unfinished labels.
10. **Workspace by membership.** The snapshot comes from the first workspace whose session ids
    contain the session. `cwd` is never grouping identity; an unresolved session is ungrouped, and a
    resolver failure never aborts capture.
11. **Containment.** A per-session fold failure is counted and retried; it never aborts a pass or
    reaches a session dispatch. Live asks are observed, never held: capture records that a question
    or approval request is in flight (session, call id, kind) so the reply path can re-read
    liveness, and never claims, holds, answers or delays the request.

## Problem

The harness records many open loops — an approval that settled rejected, an ask whose result never
landed, a repaired turn with an unknown outcome, a goal left blocked, a job that never reported —
and each is a real place where the work stopped waiting for the user. Without a detector the user
must remember which chat stalled and why; the evidence exists but never reaches the list of
decisions.

The naive remedies each fail specifically. A pass over sessions after they end has nothing to
hook: sessions end by process exit, not by an event, and the durable boundary is the turn. A
detector that raises on every signal produces items nothing can close, so the list only grows. A
capture that folds forked sessions re-raises the parent's decision once per fork; one that folds
subagent sessions turns delegated work into hundreds of items. One that re-derives from the log on
every restart churns the register, rewriting items the register had already closed. And an item that
cannot say where it came from is not auditable, so a real block cannot be told from an old row.

## Solution

Structural capture derives an item for every artifact family the harness commits, and gives each
family a closing detector before it is dispatched.

| Artifact (family) | Raised when | Becomes | Severity | Closes when |
|---|---|---|---|---|
| Blocked approval | an approval settles `rejected`, `cancelled` or `unavailable` | kind `approval` | 1 | a retry of the same call id, or of the same tool when the call id changed, is granted; otherwise the user resolves or dismisses it (*conditional*) |
| Pending approval | an approval is asked and not yet decided | kind `approval` | 1 | its decision lands (*detector*); live-only |
| Pending question | a question tool call has no result | kind `question` | 1 | a result for that call id lands — answer, timeout payload or repair result (*detector*) |
| Plan review | a plan-mode call has no result | kind `plan-review` | 1 | a result for that call id lands (*detector*) |
| Interrupted turn | resume repair appends an unknown-outcome result for a recorded call | kind `blocker` | 1 | a same-name tool retry (`tool/call:retried`) or a later turn start (`turn/start:superseded`) (*detector*) |
| Blocked goal | the goal snapshot is in the blocked phase | kind `blocker` | 2 | a later goal mutation leaves the blocked phase or clears the goal (*detector*) |
| Unsettled job | a registered job has not settled when its turn ends, or when the log ends mid-turn | kind `follow-up` | 3 | the job settles (*detector*) |

The evidence model that makes this honest:

- **The turn is the checkpoint and the log end is a boundary.** The fold runs per committed event;
  the turn end is where the projection checkpoints and where last-turn artifacts (unsettled jobs)
  become raiseable. A log that stops inside a turn never appended that boundary, so a cold read
  raises whatever the last event time leaves open.
- **The fork cut prevents duplication; root-only keeps attention honest.** An inherited item is
  the parent's item; a subagent's unresolved state is delegated work, and it contributes only via a
  rolled-up declaration.
- **The cursor makes incremental re-folds safe.** A delta fold reports transitions only from events
  beyond the cursor, so a restart over an unchanged corpus is a no-op.
- **Provenance makes every row auditable** (session, turn, call, detector, verbatim excerpt), and
  the **workspace snapshot** groups correctly from the first read — membership, never `cwd`.

What must remain true: every structural loop the harness records is reachable; every raised item
has a stated way out; nothing inferred stands in for a fact; replaying the same corpus produces the
same items and ids, with no duplicate items and no new attention.

## User Stories

1. As the user, I want a rejected or unavailable approval to become an item, so I can decide the
   blocked action instead of discovering the stall later.
2. As the user, I want an ask whose answer never landed — a question or plan review — to become an
   item while unresolved, so I know the work is still waiting.
3. As the user, I want a turn whose tool outcome was never recorded to become an item, so I verify
   external state before trusting the work.
4. As the user, I want a blocked goal at decision urgency and an unreported job as FYI, so urgency
   matches what the artifact means.
5. As the user, I want an item to leave the open set as soon as evidence closes it, and to stay
   when only I can resolve it, so the list never rots and never lies.
6. As the user, I want restart, replay and upgrade to produce no duplicate or reopened items.
7. As the user with forked sessions, I want a decision to appear once, not once per fork.
8. As the user with agent teams, I want delegated work never to appear as my decision.
9. As the reader of an item, I want its session, turn, call and verbatim evidence, so I can audit
   why it exists.
10. As the user grouping by workspace, I want every structural item to carry its workspace.

## Acceptance Criteria

Each scenario starts from a fixture log; the fold is the only actor. "Draft" means the published
draft contract, not a record.

### Story 1 — Deriving the families

```
Given a root session log containing approval/asked {id: "ap-1", callId: "call-7", toolName: "bash"}
  then approval/decided {id: "ap-1", outcome: "rejected"}
When  the log is folded
Then  one draft is raised with artifact id "approval:call-7", kind approval, severity 1, blocking
  true, detector code "approval/decided:rejected", carrying seq and callId "call-7"
```

```
Given a root session log containing tool/call {turn: 2, callId: "call-9", name:
  "ask_user_question"} carrying one question, then tool/call {turn: 3, callId: "call-4", name:
  "exit_plan_mode"} carrying a plan, with no result for either call
When  the log is folded
Then  two drafts are raised: question:call-9 as kind question, severity 1, blocking true, quoting
  the first question, and question:call-4 as kind plan-review, severity 1, offering approve-plan
  and keep-planning controls
```

```
Given a root session log with goal/change {operation: "block", goal: {id: "goal-1", phase:
  "blocked", objective: "ship the release"}}, then job/registered {jobId: "job-3"}, then turn/end
When  the log is folded to its end
Then  two drafts are raised: goal:goal-1 as blocker severity 2, and job:job-3 as follow-up severity
  3, blocking false
```

```
Given a root session log containing tool/result {callId: "call-2"} with error code
  TOOL_OUTCOME_UNKNOWN
When  the log is folded
Then  one draft is raised with artifact id "interrupted:call-2", kind blocker, severity 1
```

### Story 2 — The evidence-first gate

```
Given a root session turn whose fold raised the blocking approval:call-7 draft and whose final
  assistant message ends "Should I retry the build?"
When  that turn's turn/end event is folded
Then  no candidate draft is produced from the turn's text
```

### Story 3 — Closure

```
Given the blocked approval item for "approval:call-7" is open
When  a later approval/decided {id: "ap-8", outcome: "allowed-once"} arrives for an ask whose callId
  is "call-7"
Then  one closure draft is produced for "approval:call-7" with code
  "approval/decided:allowed-once"
```

```
Given the blocked approval item for "approval:call-7" is open and was never retried
When  the log is folded to its end
Then  no closure draft is produced for it, and its family's declared policy is conditional — only
  the user can resolve it
```

```
Given a pending question item for "question:call-9" is open
When  the tool/result for callId "call-9" arrives carrying a timeout payload
Then  one closure draft is produced for "question:call-9" with code "tool/result"
```

```
Given an interrupted-turn item for "interrupted:call-2" is open
When  a later tool/call for the same tool name arrives
Then  one closure draft is produced with code "tool/call:retried"
```

### Story 4 — Replay, forks and scope

```
Given a root session log that raised three drafts
When  the identical log is folded again from a fresh fold state
Then  the same three artifact ids are produced, and the register's dedupe turns them into
  occurrences of the same items rather than new items
```

```
Given a seeded child session whose inherited prefix contains approval/asked and approval/decided
  and whose own events begin after the prefix
When  the child's log is folded
Then  no draft is raised for the inherited approval; only artifacts after the fork cut are
  considered
```

```
Given a subagent session (origin "subagent") whose log contains a rejected approval
When  the live drive folds the subagent's events
Then  no draft is produced and no ledger is retained for the session
```

### Story 5 — Live-only and cold reads

```
Given a historical log containing approval/asked {id: "ap-2", callId: "call-9"} followed by
  approval/decided {id: "ap-2", outcome: "rejected"}
When  the backfill reads the log cold
Then  exactly one draft is raised — the decided-blocked approval — and no pending-approval row is
  raised for "approval:call-9"
```

### Story 6 — Evidence and grouping

```
Given a root session that belongs to workspace "ws-2" by membership although its own cwd is inside
  workspace "ws-1", containing a rejected approval whose ask carried reason "pushing to a
  protected branch"
When  the blocked-approval draft is produced
Then  the draft carries the workspace snapshot {workspaceId: "ws-2"}, the verbatim quote "pushing
  to a protected branch", the detector code, the detection source, and the session's seq and
  callId as capture evidence; the cwd is not grouping identity
```

## Design Decisions

- **Capture is a projection, not an after-session pass.** There is no session-end event; the turn is
  the durable boundary. Structural families are derived by a fold driven per committed event and
  checkpointed at turn ends. A sweep remains only for history it never saw
  ([historical capture](historical-capture.md)).
- **The family set is closed and explicit.** A new family needs a detector, a closer, a kind
  mapping, a severity, an artifact-id convention and a fold-version bump.
- **Closure policy is declared per family** — detector, conditional or user-only — and the
  acceptance contract verifies the declaration for every emittable family and the presence of the
  detector closer where the artifact resolves.
- **A blocked approval that no retry supersedes is the user's to resolve.** Its evidence path is a
  granted retry; a real decision that waits for the user is a standing item, not a detection gap.
- **A pending approval is live-only; a missing ask result is durable.** A pending approval's request
  may be gone, so a cold read must not resurrect it; a question or plan review with no result is a
  durable loop — the answer genuinely never reached the work.
- **The fork cut and the root classification are structural**, taken from what the session carries,
  never from content heuristics. A parent session id alone does not demote a session, because an
  ordinary fork can carry one.
- **Workspace identity is membership.** The snapshot freezes id, title and path at raise time;
  grouping never consults the path or the session's current directory.

### Deferred Decisions

- **The team-task liveness gate** — the family's kind and closure rules exist, but the rule that
  proves a team task *orphaned* rather than *waiting on a running owner* is not designed; the family is
  outside dispatch (see Out of Scope). Seam: the dispatch table. Re-enabling it is a dispatch
  decision plus a fold-version bump, not a draft-contract change.
- **Additional structured families** — a future harness artifact (for example a structured risk
  declaration) would be a new family; the seam requires it to name a closer, a kind, a severity and
  an artifact-id convention before dispatch. No speculative family is dispatched.

## Testing Strategy

- Behavioural tests through the fold and the draft contract, one family at a time, then the
  aggregate pass. Fixtures are committed-event sequences with inline payloads; assertions are on
  artifact ids, kinds, severities, blocking, detector codes, evidence and closure codes — never on
  internal state beyond the JSON round-trip.
- Determinism first: every test injects event times (never wall time) and asserts a second run
  produces byte-equal artifact ids and draft order. Replay tests fold the same log twice and assert
  no re-raise.
- Fork and scope fixtures carry a seeded-inheritance marker and a subagent header; live and cold
  paths are tested separately because the classification and the cut are supplied differently.
- Only the harness boundary is mocked: the event source, the session catalog, the workspace
  registry, the settings reader. The fold itself is never mocked — it is the behavioural surface.
- Suite-level invariants: a fold run writes no session log (the test double rejects writes); every
  emitted family has a declared closer; no draft lacks evidence; a malformed payload produces no
  draft and no throw; a table test over the declared family set keeps a new family from arriving
  without its closer.

## Out of Scope

- **Team-task capture.** The item kind and its closure rules exist, but the liveness gate that would
  justify raising team-task items is not designed: the rule separating an abandoned team task from
  one a running owner still carries is unsolved. The family is deliberately outside dispatch — no
  live or cold fold raises an item of the team-task family — while its fold and closure rules
  stay in the corpus for the gate's redesign. This is a design boundary, not a defect; it is recorded here and in
  [CONTEXT_MAP.md](../../../CONTEXT_MAP.md) §Deferred cross-context decisions.
- **Prose and plan inference** — [candidate tier](candidate-tier.md).
- **Historical scanning and recovery** — [historical capture](historical-capture.md).
- **Identity, lifecycle, state and counts** — the register's
  ([CONTEXT_MAP.md](../../../CONTEXT_MAP.md) §Cross-context contracts); capture publishes drafts only.
- **The semantics of delivery and acknowledgement evidence** — Answering & Delivery's; capture
  folds and reports the transitions only.
- **Rendering capture status or evidence** — Surfaces'.

## Open Questions

- **Does the harness expose any further committed artifact that names a waiting user decision?** It
  would have to name its closer first. Answerable by the Capture owner with the harness maintainers.
- **Should a blocked goal's severity follow the blocked code** (hard failure vs a soft pause)
  instead of the fixed decision-level class? Answerable by the product owner, constrained by the
  register's severity semantics.
- **When a pending approval is observed live and its turn ends without a decision**, is that a
  cancellation the harness can prove, or must the row wait for the user? Answerable by the harness
  owners; the closer stays user-only until proved otherwise.
