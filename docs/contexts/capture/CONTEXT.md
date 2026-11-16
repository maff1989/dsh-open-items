# Capture — context

**Kind:** core · **Date:** 2026-11-15

## Purpose

The work leaves evidence of what it is waiting for: a rejected approval, a question that never got
an answer, an interrupted turn, a stopped goal, a job that never reported, a plan left unfinished,
a decision asked for in the final sentence of a report. Capture answers one question from that
evidence: **how does the system learn what is waiting, without guessing its way into attention?**

Its answer is a pipeline ordered by evidence strength — harness facts, then the meaning of those
facts, then the agent's declaration, and only last a bounded inference that may never become
attention without the user's confirmation. Capture decides no identity, no state and no lifecycle;
it turns committed session evidence into item drafts and closures, and the register turns those
into records.

## Position in the map

Capture feeds [Attention Register](../attention-register/CONTEXT.md) and depends on the harness and
on permission; [CONTEXT_MAP.md](../../CONTEXT_MAP.md) owns the full boundary rules. Its positions:

- **DSH harness → Capture — conformist, read-only.** Capture adapts to the harness event
  vocabulary, never the reverse; the fold is the anti-corruption layer. It commits only to the
  committed event stream, the live ask/approval waterfalls and session/workspace metadata. Capture
  reads; it never writes the session log and never acts on a session.
- **Model Contract & Consent → Capture — upstream constraint, with a partnership.** Consent
  publishes what the model may declare and what may leave the machine; Capture executes that
  permission and never makes a permission decision. Model Contract owns the tool's declared
  surface, wording and consent; Capture owns what a raise means and what happens to it.
- **Capture → Attention Register — supplier on a published draft contract.** Detection must not
  mint identity or decide lifecycle; the register must not know what a fold is. The item draft is
  the only thing that crosses.
- **Durability & Integrity → Capture — persistence contract.** Detection cursors, suppressor
  reads and every write Capture's drafts cause travel through it; Capture holds no record format.
- **Capture → Answering & Delivery — evidence, not state.** Capture reads the log for the
  transitions that prove a reply landed or was acted on; the meaning and recording of that
  evidence belong to Answering & Delivery and Durability.

## What this context owns

Capture is the final authority for:

- **Detection.** The artifact families, what counts as evidence in a committed event, the
  per-family detector, and the per-family **closing detector**.
- **The driving model.** The per-session **fold**, its **ledger**, the registered **projection**,
  the **live drive**, the **backfill** and **rescan**, **hydration**, **replay**, the **fork cut**
  and the **cursor**.
- **The inference gate.** What may be inferred (the **candidate gate** and its **prose gate**),
  how a **batch** of asks is bounded, and **supersession** as the inference lifecycle closure.
- **The ingress.** What a declared **raise** means, its dedupe-on-raise and re-raise rules, and
  the **roll up** of a subagent's raise to its root session.
- **Capture evidence and provenance.** Which evidence accompanies an item draft, what the
  verbatim **quote** is, and which origin a draft is attributed to.
- **The extraction hand-off.** When inference may be handed to a model for a second opinion, what
  it may see, and what the verdict may change.

## What this context does not own

- **The item** — identity, lifecycle states, tier, severity and blocking semantics, resolution and
  reopen, suppressors, tombstones: [Attention Register](../attention-register/CONTEXT.md).
- **The `open_items` tool's declared contract and wording, consent, the nudge, egress and the
  settings record** — [Model Contract & Consent](../model-contract/CONTEXT.md); Capture consumes
  and executes them.
- **Delivery, acknowledgement and what may be claimed about them** —
  [Answering & Delivery](../answering/CONTEXT.md).
- **Record formats, schema versions, CAS, migration and the store** —
  [Durability & Integrity](../durability/CONTEXT.md).
- **What the user sees and how it is worded** — [Surfaces](../surfaces/CONTEXT.md); Capture
  supplies the zero-item explanation's facts, it does not render them.

## Invariants

1. **Evidence before meaning, declaration before inference.** The pipeline order is fixed: harness
   facts, then what they mean for the user, then the agent's declaration, then gated inference.
   Nothing inferred may enter attention except as a candidate the user confirms. *Prevents:* a
   heuristic outranking a fact, and a guessed item becoming something the user must act on.
2. **Capture writes nothing.** It never writes the session log (a hard constraint on the whole
   domain: see [ADR 002 — No session-log writes](../../adrs/002-no-session-log-writes.md)) and it
   never writes an item record; it reads committed evidence and reports drafts and closures. The
   register and Durability are the only writers. *Prevents:* a capture change being able to change
   what an item *is*, and a corrupt session log.
3. **The fold is total and pure.** Unknown, malformed or uninteresting events never throw, never
   abort a pass, and never lose the ledger; an uninteresting event returns the previous state
   unchanged. *Prevents:* a plugin payload from being able to take down a session's capture.
4. **Same log, same items.** A replay of the same committed log produces the same artifacts and
   ids, creates no duplicate items, never reopens an item the user resolved, and never claims new
   attention. A re-sighting of a still-live artifact-keyed item records an occurrence and bumps the
   record's version as audit — that is the only version movement a replay may cause. A delta re-fold
   over unchanged events reports no transitions at all. *Prevents:* a restart or version upgrade from
   spamming the register, and a false promise of no writes.
5. **The fork cut is never folded.** Events a session inherited from its parent are skipped, so an
   item is not raised once per fork. *Prevents:* a corpus of forks multiplying one decision into
   many items.
6. **Detection is root-only.** No detector produces an item from a subagent session; the agent's
   declared raise is the one path a child contributes through, and it rolls up to the root. See
   [ADR 001 — Root sessions only, with roll-up](adrs/001-root-sessions-only-with-roll-up.md).
   *Prevents:* delegated work filling the user's attention list.
7. **No family is dispatched without a closer.** Every dispatched artifact family names the rule that
   resolves its item, and every item is raised with at least one way out. See
   [ADR 002 — Every artifact family names a closing detector](adrs/002-every-artifact-family-names-a-closing-detector.md).
   *Prevents:* a register that only grows.
8. **Every item names its evidence.** A draft carries the artifact identity, the detector code, its
   detection source, the location ids that join it to the transcript, and — whenever the artifact
   carries text — the verbatim quote. *Prevents:* an item the user cannot audit or judge.
9. **Candidates are never attention.** A candidate is never counted as Needs you, never answerable
   as an item, and leaves the open set only by confirmation or suppression. *Prevents:* the
   inference tier from becoming a noisy second inbox.
10. **Preference changes cannot strand an item.** The prose-candidate preference gates *prose*
    raises only; the unfinished-plan aggregate is not governed by it, and every closure always
    passes. *Prevents:* turning inference off locking an open candidate open forever.
11. **Closure is evidence, never a timer.** A family closes on its named detector, a user action,
    or — for the families declared conditional or user-only — waits for the user. A clock is not
    evidence. *Prevents:* showing a decision as resolved because time passed.
12. **Scan skip proof is cursor coverage only.** A session is skipped without a read only when the
    cursor provably covers its log; a prompt-time or creation-time value is never evidence that
    nothing happened. *Prevents:* silently never scanning a session that committed activity after
    its last prompt.
13. **Bounded and contained.** Every fold state slice, draft batch, scan window and model-facing
    result is bounded; a backfill yields to the event loop; a per-session failure is counted and
    retried, never fatal. *Prevents:* capture costing the harness its responsiveness.
14. **Empty is explained.** Capture reports what it has scanned and which capabilities attached,
    so a zero-item inbox can be told apart from a broken one. *Prevents:* silence that looks like
    success.

## Inbound contracts

| From | What Capture needs | Guarantee | When it is missing |
|---|---|---|---|
| DSH harness — committed session events | Session id, monotonic `seq`, event type, time, opaque payload; turn/start and turn/end boundaries | Append-only, ordered, immutable committed evidence | No live drive and no backfill evidence source; capture reports the capability absent rather than guessing |
| DSH harness — live ask/approval waterfalls | Ask identity (session, call id, kind) while a request is in flight | Observation only; Capture must never claim, hold or answer the request | Live asks are not observed; asks that settled are still detected from the log |
| DSH harness — session topology | Root vs subagent classification (`origin`, `delegation depth`), inherited prefix length, session creation time, archive state | The harness's classification is authoritative; a parent session id alone is not a classification | A session is treated as root — the kernel contract requires the harness to say otherwise (see [CONTEXT_MAP.md](../../CONTEXT_MAP.md) §Shared kernel) |
| DSH harness — workspace registry | Workspace id, title, path and `sessionIds` membership | A session belongs to the first workspace whose `sessionIds` contains it | Items carry no workspace snapshot and group as ungrouped; nothing else degrades |
| DSH harness — persisted session log catalog and roster | The historical corpus to fold; optional live activity, running state and titles | Reading is complete for the window; the roster's prompt time is a lower bound, never a skip proof | No backfill (live drive only); a cursor store still runs in memory |
| Durability & Integrity — persistence contract | Durable detection cursors; suppressor reads; the register's write path for drafts and evidenced transitions | Validated, version-checked writes; cursors survive restart | Backfill is unavailable; capture still folds live |
| Model Contract & Consent — settings and consent | The prose-candidate preference; the extraction toggle; consent and deployment configuration for egress | Defaults are served without a materialised write; a change applies without a remount | Defaults apply: prose candidates on, extraction off, nothing leaves the machine |
| Model Contract & Consent — extraction seam | One bounded one-shot second opinion on a live prose raise | The verdict may only drop or refine an item the gate already produced | Gate-only capture; the candidate is kept unchanged |

## Outbound contracts

**Item draft (published to Attention Register).** One draft per open artifact, or one closure for an
artifact that resolved. An open draft carries: the artifact id, the product-facing kind, the tier,
the severity, a bounded title and body; a quote wherever the artifact carries text (the ask for an
inferred item; a harness reason, objective, plan or result message for a detected one); the owning
session and its workspace snapshot; the location ids (seq, turn, call id, approval id, goal id and
revision, job id); the detector code; the detection source; whether the artifact blocks the work;
and an optional reply descriptor. A closure draft carries the same artifact identity plus the closure code
and the time. The guarantee: a draft exists only because evidence exists, the same evidence always
produces the same artifact id, and the register alone mints identity, applies dedupe and decides
state. Stability: additive only within a fold version; a change to what a draft means is a fold
version bump, not a silent reinterpretation.

**Evidenced transitions.** Captured facts that prove what happened to a reply — that its notice
message is committed, that the session acted afterwards. They are evidence, not state; the meaning
and recording belong to Answering & Delivery and Durability.

**Capture status.** The published status the read model carries: whether the plugin mounted and
whether the projection, live drive and backfill attached; the cursor count, the session-catalog
size, the last backfill report's counts and the last error. Live-ask observation is wired but
internal — it is not a published status field. The counts carry no session ids, titles or content.
Surfaces uses this to explain an empty inbox.

## Key concepts

The canonical senses are in [UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md) §4; this context
uses them as follows.

- **Facts, meaning, declaration, inference** — the four evidence strengths, in that order: a
  committed harness artifact; the kind, severity and blocking read from it; the agent's raise; the
  gated reading of a turn's final text or an unfinished plan.
- **Fold / ledger / projection** — the pure synchronous per-session function over committed
  events; the plain-JSON state it produces; the registered mechanism that drives it over every
  session and checkpoints the ledger at turn boundaries.
- **Live drive** — the folding of each committed event as it lands, so a detector reacts within
  the turn that produced the evidence and a closure is not lost to a restart. Projection and live
  drive share one fold; they differ in what they checkpoint and what provenance they stamp.
- **Artifact / artifact family / detector / closing detector / artifact id** — what was observed;
  the group with one fold handler and one closer; the rule that recognises it; the rule that ends
  its item; the fact's identity inside its session, stable across replay and never shown to users.
- **Detection source** — the named origin of a draft (projection, log fold, regex gate, model
  extraction, the declared tool, a human action). Provenance, not confidence.
- **Live-only artifact** — one that is truthful only while observed live, such as a pending ask
  whose request exists only in the running process. A cold read may close it, never raise it.
- **Candidate gate / prose gate / ask / batch / supersession** — the bounded policy that turns
  inference into candidates; the specific gate over a turn's final assistant text; one
  item-shaped request inside it; one turn's asks as the unit bounded and closed together; closure
  because a later turn or message made the ask moot.
- **Extraction** — the optional, consented second opinion on a new live prose candidate; it may
  drop or refine, never create.
- **Backfill / rescan / hydration / replay / fork cut / cursor** — the historical and recovery
  model: a bounded first sweep, a periodic bounded repeat, a one-time ledger restore on a
  session's first live event, a re-fold after a semantic change, the inherited boundary never
  folded, and the per-session processing record.
- **Capture evidence / quote / raise / roll up** — what proves an item's existence; the verbatim
  markdown-clean excerpt that proves an item — the ask for an inferred candidate, a harness text
  (reason, objective, plan or result message) for a detected artifact; creation by declaration;
  attributing a subagent's raise to its root session, labelled with the asker.
- **Draft** — Capture's internal output, not a user-facing object; the register turns it into an
  item.

## Design decisions in force

- [ADR 001 — Root sessions only, with roll-up](adrs/001-root-sessions-only-with-roll-up.md): the
  live drive and the backfill drop non-root sessions; the declared raise is the one rolled-up
  ingress.
- [ADR 002 — Every artifact family names a closing detector](adrs/002-every-artifact-family-names-a-closing-detector.md):
  a family that cannot name its closer is not dispatched.
- [ADR 004 — Confirm before attention](../../adrs/004-confirm-before-attention.md): the tier split
  and the confirmation gate that makes inference safe.
- [ADR 002 — No session-log writes](../../adrs/002-no-session-log-writes.md): Capture reads the
  session log and never writes it.
- Spec decisions a reader must know: the evidence-first pipeline order and the per-family closure
  map ([structural capture](specs/structural-capture.md)); the additive prose gate, the batch-aware
  bounds, the correction lifecycle and the one-time/periodic migration and reconciliation closures
  ([candidate tier](specs/candidate-tier.md)); the declared ingress and roll-up semantics
  ([authored capture](specs/authored-capture.md)); the cursor-coverage skip proof, version coupling
  and report ([historical capture](specs/historical-capture.md)).

## Deferred and open

- **The team-task liveness gate.** The item kind and the family's closure rules exist, but the rule
  that would prove a team task is *orphaned* rather than merely *waiting on a running owner* is not
  designed, so the family is deliberately outside dispatch. The seam: the dispatch table plus the
  family's fold and closure rules, kept so the gate can be designed without changing the draft
  contract. Recorded as **Out of Scope** in [structural capture](specs/structural-capture.md).
- **Candidate expiry by time.** A candidate leaves the open set by confirmation, suppression,
  supersession, the per-session bound, or a one-time migration/reconciliation closure that retires
  or de-duplicates candidates at activation or after a scan (see
  [candidate tier §Migration and reconciliation closures](specs/candidate-tier.md#migration-and-reconciliation-closures)).
  A time-based expiry is not part of the design. Seam: the supersession lifecycle and the
  batch-aware bound.
- **A wider inference read.** Inference reads one turn's final assistant text and the last plan
  snapshot; reading an earlier turn's text is not decided. Seam: the fold's per-turn text state.
- **Extraction beyond a second opinion.** A model may drop or refine a candidate, never create or
  close one, and never runs over historical sessions; any wider model-assisted detection is a
  consent decision for [Model Contract & Consent](../model-contract/CONTEXT.md). Seam: the
  single-verdict extraction contract.
- **Cross-session grouping of the same ask.** Capture raises per artifact and session; grouping two
  sessions' versions of one decision is a register read-model decision. Seam: per-session artifact
  identity.

## Reading

Start with [UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md) §4 (capture) and §2 (the item this
context feeds). Then [structural capture](specs/structural-capture.md) — the families, their
closers, the driving model, the fork cut, replay and provenance; [candidate tier](specs/candidate-tier.md)
— inference, bounds, promote/suppress/correction, extraction's hand-off; [authored capture](specs/authored-capture.md)
— the declared ingress, dedupe, roll-up and result bounds; and [historical capture](specs/historical-capture.md)
— backfill, rescan, hydration, the cursor skip proof, version coupling and the durable report.

The design packet at the repository root owns the mechanics and the measured evidence:
[DESIGN.md](../../../../DESIGN.md) §3.2 (capture is a projection), §4 (the capture steps), §2.4
(root sessions only). Read it after these documents, not instead of them.
