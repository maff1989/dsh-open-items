# ADR 001 — no custom pending-interaction kind

**Date:** 2026-11-15 · **Context(s):** Surfaces, Model Contract & Consent

## Context

The harness client already classifies the on-screen session as "waiting for an approval", "plan
awaiting review" or "waiting for an answer" from its pending-interaction state. That classification
is process-local, dies on reload, and knows nothing about closed sessions. Its sidebar rendering
is a closed switch: the indicator accepts only those three vocabulary values and silently drops any
other kind. A custom kind would therefore never light the platform indicator.

Two further facts constrain the decision. First, publishing any pending interaction has a side
effect beyond display: while one exists, Escape-to-stop is suppressed for the session, so a plugin
that published a kind for a purely informational signal would take away a user's ability to stop the
work. Second, Open Items needs to advertise something the session does not have: items waiting on the
user in *other* sessions, which are exactly the ones the on-screen indicator cannot know about.

The context map adds that plugin code must not reach into platform indicators — no document title,
no sidebar status dot, no pending-interaction publish.

## Decision

We will not publish a custom pending-interaction kind, and we will not reuse an existing kind to
make the platform indicator light up. Open Items advertises attention only through surfaces it owns:
the navigation row's new-item dot, the page-title count, the in-session card at the `open_items` tool
row, and the per-session panel.

## Why

A custom kind would be a signal with no honest consumer: the only renderer that could show it is a
closed switch, so the plugin would pay a real behavioural cost — suppressing Escape-to-stop — for a
signal the user cannot see. Reusing `question` would be worse: it would claim the session is waiting
for an answer at the level of the platform indicator when the item may belong to another session,
may be a decision rather than a question, and may not be blocking at all. The honest place to say
"there are open items" is a surface that can also say how many, from which sessions, and what each
one needs — which is the count and the inbox, not the session status vocabulary.

The trade-off is accepted deliberately: the plugin gives up the one platform-wide indicator it
cannot truthfully drive, rather than break Escape-to-stop or lie about the session's state.

## Alternatives considered

- **Publish a custom pending-interaction kind.** Rejected: no consumer renders it, and its existence
  changes behaviour elsewhere (Escape-to-stop suppression) for no visible gain.
- **Reuse the `question` kind when items are waiting.** Rejected: it misstates the session's state —
  the waiting item may be an approval, a decision, a risk or a follow-up, and may live in another
  session entirely — and it makes the plugin's attention signal indistinguishable from a real ask.
- **Steal a platform surface (document title, sidebar status dot).** Rejected: those surfaces are
  harness-owned and their meaning is part of the session contract; overriding them would make the
  session lie about itself and would be fragile across harness versions.
- **A numeric badge on the navigation row.** Rejected as a shape, not as information: the sidebar has
  no numeric nav-badge seat, and an overlay pip reads as a separate application. The count is stated
  in the page title and in the navigation row's accessible label instead.
- **Chosen:** a navigation dot for newness, a page-title count for the global Needs-you number, and
  the page, card and panel for everything else.

## Consequences

- The user learns "how many" on the page and in the nav label, not from a badge on the icon; the dot
  answers only "is there anything new?" and clears when the page is opened.
- The Needs-you predicate becomes the single meaning of the number on every surface; a plugin-local
  reinterpretation of "waiting" is not available as a shortcut.
- Session-scoped doorways (a session-row pip, a session-header chip) cannot be implemented by
  extending the pending-interaction vocabulary. If the harness later publishes a trailing seat with a
  truthful per-session signal, the doorway becomes a separate decision recorded in this context's
  deferred list.
- If a future harness version opens the indicator to plugin kinds, this decision is revisited with
  the Escape-to-stop side effect measured again; that would be a new ADR, not a quiet extension.
- Telling the agent about open items stays on the model-facing surfaces — the opt-in nudge and the
  runtime-context line — never a session status publish.
