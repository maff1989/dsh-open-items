# ADR 001 — Root sessions only, with roll-up

**Date:** 2026-11-15 · **Context(s):** Capture (with Session Topology in the shared kernel)

## Context

The harness creates sessions for delegated work: subagents and teammates run in their own sessions,
several layers deep. In the measured corpus a clear majority of sessions are this kind. Their
unresolved state is not a user decision — it is work that a parent agent delegated and is still
carrying. Yet a subagent can genuinely discover that the user must decide something (which approach
to take, which of two files to change), and that discovery is worthless if it dies in a session
nobody opens.

The harness classifies the difference: a subagent session carries an origin of `subagent` or a
non-zero delegation depth
([CONTEXT_MAP.md](../../../CONTEXT_MAP.md) §Shared kernel). A related but insufficient signal is the parent session id — an ordinary
fork can carry one, so keying on its presence would misclassify legitimate user conversations.

The register is an attention list. Every non-root item in it is attention that does not exist: the
user never asked to review delegated work, and cannot productively answer on the child's behalf.
The measured consequence of getting this wrong is not a small noise increase; it is a different
product — hundreds of "open items" that are all delegated state.

## Decision

We will detect items only from root sessions. The live drive and the backfill both drop non-root
sessions using the harness's classification (origin, delegation depth), never the presence of a
parent session id. The agent's declared **raise** is the one path a subagent contributes through:
the raise resolves the ownership chain to its root session, stores the item against the root with a
`raisedBy` attribution to the asking subagent, keys dedupe on the root session, and only the root
conversation may resolve or dismiss it.

## Why

- **The inbox must mean "the user's attention".** Delegated work is not waiting on the user; it is
  waiting on its parent. A subagent item in the inbox asks the user to intervene in a conversation
  they are not in, with no card and no context.
- **The one real case survives.** A subagent's discovery is a declaration, and a declaration has a
  precise owner: the item belongs to the conversation the user is in. Roll-up keeps that path
  without letting detection leak delegated state.
- **Dedupe follows ownership.** Keying the rolled-up item on the root means a later raise by the
  lead merges instead of duplicating, which is the only way the user sees one item for one decision.
- **Attribution and resolution stay honest.** The provenance names the asker; the root owns the
  resolution. A child cannot fabricate the user's answer, because the child has no user in context.

## Alternatives considered

- **Include every session.** Rejected: delegated state is not user attention, and the volume makes
  the register useless. This is the failure the root filter exists to prevent.
- **Exclude subagents entirely.** Rejected: a subagent can find a real decision, and silently
  dropping it recreates the product's founding failure — an insight dying with the conversation.
- **Classify by parent session id.** Rejected: an ordinary fork can carry a parent id, so this would
  demote legitimate root conversations and misfile their items.
- **Raise from the child but file it on the child, with a link to the root.** Rejected: the user
  does not read the child's transcript; the item would be visible only through the inbox, with no
  card in the conversation that can answer it, and dedupe would not merge with the lead's raise.
- **Let the subagent resolve the item once it believes the user answered.** Rejected outright: it
  is the model impersonating the user in a session where no user spoke.

## Consequences

- A subagent's detected and inferred output is invisible to the user. That is the intended
  boundary, and the rule is enforced on both driving paths so a child cannot slip items in through
  the live drive.
- Rolled-up items have no in-session card in the root until the lead re-raises the same decision;
  they surface in the panel and the inbox with their evidence instead. This is acceptable:
  the card is a convenience of the declaring call, not the item's home.
- The classification is the harness's, so Capture inherits the shared kernel's dependency: a host
  that cannot classify sessions treats them as root. The kernel contract requires the facts.
- The roll-up rule is exercised by the declared ingress
  ([authored capture](../specs/authored-capture.md)); the drop rule is exercised by the live drive
  and the backfill ([structural capture](../specs/structural-capture.md)).
- The subagent's session is provenance, not ownership: deleting or archiving the child must not
  affect the item, and the register must never group by the child.
- Any future "delegated attention" surface (a team-board view, say) must be built on the child
  sessions' own records, not by reclassifying these items — the item boundary here is a product
  decision, not a display filter.
