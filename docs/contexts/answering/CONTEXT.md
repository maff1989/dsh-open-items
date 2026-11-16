# Answering & Delivery — context

**Kind:** core · **Date:** 2026-11-15

## Purpose

How does the user's decision reach the work, and what may we claim happened? An item is only
half the product: the other half is that the user can act on it wherever it is seen, that the
action lands in the work through the honest channel for *that item in that moment*, and that the
register can say afterwards whether the answer was applied to a live request, sent into a
session, recorded without being sent, acted on by the work, or lost — each with evidence, never
with a comfortable guess. This context exists because an attention register that cannot close
its loops is a list, and because the easiest lie in the product is the receipt.

## Position in the map

It is the only context allowed to act on a session, and it sits between the register and the
harness. [CONTEXT_MAP.md](../../CONTEXT_MAP.md) owns the boundaries; in brief:

- **Upstream — Attention Register**: items, their versions, the lifecycle transitions a reply
  may cause and the reply descriptor stored on the item. The pattern is *published transitions
  and record shapes*: delivery commands the lifecycle; it never edits an item's state itself.
- **Upstream — Capture, read-only**: the observe-only carrier of live-ask observations, and the
  fold that turns committed session evidence into delivery and acknowledgement evidence. Nothing
  here holds, claims or answers a harness waterfall on Capture's behalf.
- **Upstream — the shared kernel (session topology)** and the harness behind it: root session
  identity, turn state, archived sessions, message provenance, and the session services a reply
  may use. The pattern is *conformist*: the harness is adapted to, never adapted.
- **Upstream — Durability & Integrity**: the persistence contract. Every write this context asks
  for is a version-checked transition; a version mismatch is a named conflict refusal with a
  recovery, and the caller re-reads.
- **Downstream — Surfaces**: the published *reply contract* — payload vocabulary, descriptor,
  answer-matrix outcome, delivery state, failure codes, capability flags. The surface shows the
  control; this context owns the claim.
- **Downstream — Attention Register**: delivery attempts and the evidence that moves an item to
  `awaiting`, to `resolved`, and its acknowledgement from `pending` to `observed` or `none`.

## What this context owns

- **Answerability** — which items can be settled, delivered, recorded or must be refused from a
  surface, and the honest exceptions. A candidate is never answerable: a reply for one is a named
  refusal until the item is confirmed.
- **The reply contract** — the closed payload vocabulary, the reply descriptor's meaning, the
  requested track, the delivery id, the confirmation flag and the reply outcome.
- **The answer matrix** — the one rule table, by item origin and session state, that decides
  settle / host-settle / steer / deliver / record / refuse. Every surface uses it; no surface
  chooses the track.
- **The three delivery tracks** — client-settle, host-settle, session-message — and their
  preconditions, downgrades and refusals.
- **Wake and interruption rules** — never wake unconfirmed; never steer a turn that is not
  running; never spend a turn without the user seeing the cost.
- **The reply guards and their canonical order** — (1) request identity and a delivery id, (2)
  payload validation, (3) item exists, (4) the approval origin/track combination, (5) duplicate
  delivery id (an accepted or in-flight attempt is returned; a failed one needs a new id), (6) the
  item is answerable (candidates are not), (7) the expected version and state check, (8) the
  session is not archived, (9) delivery planning.
- **Delivery attempts and evidence** — delivery id, track, state, evidence, failure codes, and
  the two-phase boundary between queued and delivered.
- **Acknowledgement evidence and window** — what counts as the work having acted, and the policy
  bound after which the honest report is "no acknowledgement observed". The acknowledgement
  record itself is a field of the item, stored and transitioned by the register.
- **Notice attribution** — a delivered reply enters the transcript as the plugin's own notice,
  with the item and delivery ids, and never as the user's own message.
- **Approval parity** — the origin split between mirrored and authored approvals, the same-live-
  card rule, Allow once, never retroactive, fail closed, and the retry instruction that replaces
  a late grant.

## What this context does not own

- **The item and its lifecycle** — identity, kind, tier, severity, blocking, state, resolution,
  reopen, retention, the Needs-you predicate and the register's in-flight presentation belong to
  [Attention Register](../attention-register/CONTEXT.md).
- **How items are learned** — detectors, closing detectors, the candidate gate, prose inference,
  the live-ask observation mechanism and capture evidence belong to
  [Capture](../capture/CONTEXT.md).
- **How a reply looks** — layout, controls, copy, focus, announcement, keyboard and locale
  belong to [Surfaces](../surfaces/CONTEXT.md). The descriptor's *meaning* is ours; its
  rendering is theirs.
- **How a record is written** — store mechanics, CAS execution, record formats, versions,
  migration and the single-writer rule belong to
  [Durability & Integrity](../durability/CONTEXT.md). This context carries the CAS token and
  treats a version mismatch as a named conflict refusal, then re-reads the item.
- **Session topology** — root versus subagent, the turn boundary, workspace identity, message
  provenance and archive state are the shared kernel in
  [CONTEXT_MAP.md](../../CONTEXT_MAP.md#shared-kernel-session-topology), not local definitions.
- **What the agent is told and allowed** — the `open_items` tool, the nudge, consent and
  settings belong to [Model Contract & Consent](../model-contract/CONTEXT.md).
- **The harness itself** — the ask and approval waterfalls, the agent loop, delivery primitives
  and the session log are outside the domain, read or driven through the bridge; the session log
  is never written by anything here.

## Invariants

1. **One actor on sessions.** Only this context settles a live request, steers a turn, wakes a
   session or sends a message. *Because* the write surface is where the product can hurt the
   user, it exists in exactly one place: one place to audit, one place to refuse.
2. **Never wake unconfirmed — settling is no exception.** A cold session is resumed only for an
   explicit *confirmed wake*, after the surface has said that doing so resumes the session and
   spends a turn. No render, no list refresh and no automatic retry ever wakes a session, and a
   continued ask that can only be settled by resuming is recorded instead when that confirmation
   is absent. *Because* waking is permanent residency plus a model turn, and a plugin may not spend
   either silently.
3. **Never claim more than is evidenced.** *Answer applied*, *sent to session*, *recorded* and
   *not applied* are four different claims with four different proofs, and every claim must be
   derivable from the durable record alone. A queued message is not an answer; an unknown outcome
   is not a success; a settle is never shown as a send; a recorded answer is never labelled
   applied or sent. *Because* the register's value is that its receipts can be trusted.
4. **Settle once.** A live request has exactly one outcome. A second decision — from a stale row,
   a second tab, another window or the model — cannot be applied; the loser is told that it lost
   and shown the winner. *Because* a request that appears answerable after it settled is a
   safety-adjacent failure, not a cosmetic one.
5. **An approval is Allow once, for one request, and never retroactive.** The decision is bound
   to the exact request identity, is granted only through that request's own channel, and can
   never be applied after the request ended. *Because* a late grant would make the transcript a
   fiction and the request boundary meaningless.
6. **A decision is never merely recorded.** An approval decision that cannot be delivered is
   refused with a named reason and a recovery; it is not stored as if the work had seen it.
   *Because* recording a grant nobody received claims an authority the user never exercised.
7. **No silent drops.** Every refusal and failure is a named value with the recovery the user can
   take: the archived session that would swallow a message, the absent agent, the moved item, the
   unknown outcome. *Because* a reply that vanishes is indistinguishable from one the work
   ignored, and both destroy trust.
8. **One action, one attempt.** One reply action produces at most one delivery attempt and at
   most one message; a repeated delivery id returns the accepted or in-flight attempt instead of
   acting again, while retrying a failed attempt is a new attempt with a new id. *Because* a double
   click and a lost response must collapse into one decision, and a known failure must not be
   replayed as an unknown one.
9. **Attribution is not cosmetic.** A delivered reply is a notice under the plugin's own source
   kind carrying the item id and the delivery id; its body is one attribution line plus the
   user's words. It is never written as the user's own message and never carries item prose as
   instructions. *Because* the harness treats direct human input as authority in several places,
   and impersonation would grant authority the user did not.
10. **The surface requests; the host decides.** A surface may name the track it believes applies,
    and the host validates it. A requested track may be downgraded and the downgrade is reported;
    it is never silently upgraded. *Because* the matrix needs one owner, and the user must not
    learn about a stronger action than the one that happened.
11. **Durable before claimed.** An item transition and its attempt are written before a surface
    reports the outcome; an attempt that could not be recorded is reported as such. *Because* the
    user's click is the one thing the system may not lose while saying it succeeded.

## Inbound contracts

| Contract | Guarantee this context needs | When the guarantee is missing |
|---|---|---|
| **Item record and version** (Attention Register) | The current item, its version, its source pointers, its reply descriptor, its tier and blocking flag. | Refuse `not-found`; never substitute a cached or stale item, and never guess a payload from a title. |
| **Lifecycle transitions** (Attention Register) | A reply may move `open → awaiting/resolved` only through the published transitions, with a compare-and-set. | A named conflict refusal with a recovery is returned; nothing is written and the surface re-reads. |
| **Session state** (shared kernel, via the harness) | Root session, live agent, running turn / open turn, cold, archived, message provenance. | The probe never wakes; an unprovable state degrades to the branch that can be recorded or refused, never to a wake. |
| **Ask liveness** (Capture's observe-only carrier) | For a derived live ask: *live*, *not-live*, or *unknown* — positive evidence only. | `unknown` proceeds on the branch that is recordable; `not-live` refuses and records nothing as applied. |
| **Session bridge capabilities** (harness) | Settle a continued ask, steer, follow-up, durability flush — each optional and feature-detected. | The capability flag is false and the track degrades with a named reason; nothing fabricates a channel. |
| **Connection fence** (route) | Only the install owner's browser reaches the reply route. | Every other peer is refused `forbidden`; no reply is attempted. |
| **Delivery/acknowledgement evidence** (Capture's fold) | Committed log facts with coordinates: a message with our delivery id landed; the work acted after the answer. | Evidence is applied only as evidence; a missing fact changes nothing and the acknowledgement window remains the fallback. |

## Outbound contracts

| Contract | Consumer | Guarantee | Stability |
|---|---|---|---|
| **Reply contract** | Surfaces | Request shape (item id, expected version, delivery id, payload, requested track, confirmed wake); the reply descriptor's meaning; the outcome claim (`applied` / `sent` / `recorded`); the recorded attempt with its state and failure. | Versioned with the wire protocol. Adding a failure code is additive; changing what a claim means is a breaking change. |
| **Capability advertisement** | Surfaces, the handshake | Whether this Host can record a client settle, settle a continued ask, and deliver a message. | A control is offered only when its capability is advertised. |
| **Delivery evidence for the register** | Attention Register | Append-only attempts, one per delivery id; the answered resolution payload — recorded at acceptance for a settle, and recorded for a message only when acknowledgement or the window resolves it; evidenced transitions to `delivered` and `acknowledged` that move the item's state; the distinguishing fact for every claim. | The attempt schema is the register's to store; the evidence kinds and their meaning are ours. |
| **Session message contract** | The harness, and every transcript reader | One durable message per attempt, source kind `open-items` / form `notice`, carrying item id and delivery id, one attribution line and the user's verbatim words. | Idempotent by delivery id; never the user's source kind; never item prose as an instruction. |
| **Refusal vocabulary** | Surfaces | Stable reason codes for a reply that could not travel, and named delivery failure codes for one that could not land. | Codes are additive; a refusal always carries a recovery. |

## Key concepts

The canonical senses are in [UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md); this context
adds only the conditions it uses them under.

- [Reply](../../UBIQUITOUS_LANGUAGE.md) — the user's submission for one item: an attempt, never
  yet a resolution.
- [Answerable](../../UBIQUITOUS_LANGUAGE.md) — can be acted on from the surface without
  navigating. The honest exceptions are named in [inline-answering.md](specs/inline-answering.md).
- [Answer](../../UBIQUITOUS_LANGUAGE.md), [settle](../../UBIQUITOUS_LANGUAGE.md),
  [deliver](../../UBIQUITOUS_LANGUAGE.md), [record](../../UBIQUITOUS_LANGUAGE.md) — the four
  different things a reply can become, kept distinct throughout.
- [Reply descriptor](../../UBIQUITOUS_LANGUAGE.md) — what the control accepts; it describes the
  item, not the track the Host will pick.
- [Answer matrix](../../UBIQUITOUS_LANGUAGE.md) — origin × session state → outcome. One table,
  every surface.
- [Delivery attempt](../../UBIQUITOUS_LANGUAGE.md), [delivery id](../../UBIQUITOUS_LANGUAGE.md),
  [delivery track](../../UBIQUITOUS_LANGUAGE.md), [delivery state](../../UBIQUITOUS_LANGUAGE.md),
  [delivery evidence](../../UBIQUITOUS_LANGUAGE.md) — *how* the reply travelled; *which* attempt
  it was; *what is proven* about it.
- [Failure code](../../UBIQUITOUS_LANGUAGE.md) — the named reason an attempt failed, never a bare
  boolean.
- [Wake](../../UBIQUITOUS_LANGUAGE.md) / **confirmed wake** — a wake the user explicitly
  confirmed after seeing that it resumes the session and spends a turn; the flag rides the reply.
- [Steer](../../UBIQUITOUS_LANGUAGE.md) — the answer joins a running turn at its next step; no
  wake, no extra turn.
- [Live ask](../../UBIQUITOUS_LANGUAGE.md), [mirrored item](../../UBIQUITOUS_LANGUAGE.md),
  [authored approval](../../UBIQUITOUS_LANGUAGE.md) — the request/declaration split that decides
  which channel may carry an approval.
- [Allow once](../../UBIQUITOUS_LANGUAGE.md), [fail closed](../../UBIQUITOUS_LANGUAGE.md) — the
  only approval outcome, and the posture when its channel is unavailable.
- [Notice](../../UBIQUITOUS_LANGUAGE.md) — a transcript entry written by the plugin; the
  attributed form of a delivered reply.
- [Idempotency](../../UBIQUITOUS_LANGUAGE.md), [Compare-and-set](../../UBIQUITOUS_LANGUAGE.md) —
  one action, one attempt; and who decides when two writers race.
- **Claim** — the strongest true statement a surface may make about one reply: *Answer applied*,
  *Sent to session*, *Recorded*, or *Not applied* with its reason. A claim is derived from the
  durable attempt's evidence, never from the click; a later reader must be able to derive exactly
  one claim, and a surface that cannot must not guess.
- **Owner fence** — the rule that the reply route admits only the install owner's browser; any
  other peer is refused `forbidden`.

## Design decisions in force

- [ADR 001 — three delivery tracks](adrs/001-three-delivery-tracks.md): one host-side router,
  three named tracks, the surface requests and the host decides.
- [ADR 002 — approvals through the live card only](adrs/002-approvals-through-the-live-card-only.md):
  one request, one decision, Allow once, never retroactive, fail closed.
- The specs record the decisions a reader must know before changing behaviour:
  [inline-answering.md](specs/inline-answering.md) (the matrix and the card-as-delivery rule),
  [delivery-and-evidence.md](specs/delivery-and-evidence.md) (the claims and the evidence
  ladder), [approval-parity.md](specs/approval-parity.md) (the origin split and the retry
  instruction).

## Deferred and open

- **Bounded host hold for unattended asks** — a hold that would let an ask wait for a browser that
  is not connected is deliberately left undecided. The seam is the host-settle port and the
  observe-only live-ask carrier; any future hold must be bounded, must settle on cancellation, and
  must fail closed — never an allow. An unattended ask is therefore observed only, and its item
  says it is waiting for a client.
- **Answering a multi-question ask from the inbox** — the row names one choice, so a batch ask is
  refused and handed to the session. The seam is a batch reply intent in the payload vocabulary.
- **Coalescing several answers to one session into one turn** — each reply is its own attempt
  by default; the seam is the delivery ledger, which could carry one attempt for several items.
- **Re-sending a recorded answer later** — a recorded answer is kept on the item; whether a later
  click delivers it as a new attempt or requires the user to reopen the item is not decided. The
  seam is the durable answer payload.
- **Classifying and recovering a parked delivery** — `parked` is the reserved name for a queued
  delivery that nothing claims; recognising one needs a reconciliation pass over accepted attempts
  with no acknowledgement, which is deferred together with whether the Host may re-wake it. The
  seam is the append-only attempt list plus the two-phase state (see
  [delivery-and-evidence.md](specs/delivery-and-evidence.md#deferred-decisions)).
- **Delivery ledger retention** — how many attempts an item keeps is a register/durability
  decision; the seam is the append-only attempt list, which needs no schema change to bound.
- **Out of scope, not deferred:** a retroactive approval grant. It is a forbidden design, not a
  feature waiting for a seam — the request identity rule in
  [approval-parity.md](specs/approval-parity.md) exists to make it unrepresentable.

## Reading

- The specs in this context: [inline-answering.md](specs/inline-answering.md),
  [delivery-and-evidence.md](specs/delivery-and-evidence.md),
  [approval-parity.md](specs/approval-parity.md).
- The packet sections that own the mechanics: [DESIGN.md](../../../../DESIGN.md) §6 (closing the
  loop), §5.8 (the in-session card), §6.7 (the card answers by delivery), §7.4.2
  (acknowledgement); [UI.md](../../../../UI.md) §6 (answering) and §11 (the flows);
  [OPEN-ITEMS.md](../../../../OPEN-ITEMS.md) OI-03, OI-08, OI-09.
- The research the design rests on:
  [research/inline-settle.md](../../../../research/inline-settle.md) (can an ask be settled from
  outside?) and [research/session-delivery.md](../../../../research/session-delivery.md) (can a
  reply be delivered into a session?).
- Glossary terms to know first: reply, settle, deliver, record, delivery track, live ask, allow
  once, fail closed, wake, notice.
