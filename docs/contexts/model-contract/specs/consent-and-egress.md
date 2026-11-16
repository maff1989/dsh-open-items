# Consent and egress

**Context(s):** Model Contract & Consent (owns) · Capture (executes extraction) · Surfaces (renders
and edits the settings section) · Durability & Integrity (persists the settings record) ·
**Date:** 2026-11-15

> Intent spec. It states what the capability is for and what it must do; it does not describe
> files, functions or snippets. The design packet and the code own mechanics.

## Definitions

- **Consent** — the user's permission for a model-facing or egressing capability, expressed
  through the settings record and, for egress, additionally through deployment configuration.
  Consent is a durable, reversible record; it is never inferred from an install, a default, a visit
  to a page or a deployment's willingness to configure a provider
  ([glossary §7](../../../UBIQUITOUS_LANGUAGE.md#7-model-facing-vocabulary)).
- **Egress** — any byte sent from the machine to a model provider because of this plugin. The
  domain permits exactly one optional egress path: model-assisted extraction.
- **Settings record** — the single versioned per-install preferences record. It holds exactly three
  preferences: model nudge, prose candidates and model-assisted extraction. Defaults are served
  without materialising a record; a write is a compare-and-set patch.
- **Preference** — one named boolean in the settings record that changes behaviour for the whole
  install, applying to current and new sessions.
- **Model nudge preference** — the preference that attaches the opt-in nudge (an instruction
  section) to model steps. Default off.
- **Prose candidates preference** — the preference that lets the local candidate gate emit new
  prose candidates. Default on. It is not a consent field: it changes what the system infers from
  the committed session log, sends nothing and tells the agent nothing.
- **Model-assisted extraction preference** — the preference that permits extraction. Default off.
  It permits; it does not enable on its own.
- **Default** — the documented value of a preference before any write. The defaults are: model
  nudge off, prose candidates on, model-assisted extraction off, record version zero.
- **Version** — the compare-and-set token of the settings record; zero means "the record has never
  been written and the defaults are being served".
- **Compare-and-set (CAS)** — the write rule for the settings record: the write carries the version
  it read, and a mismatch is a **conflict** returned as a value with the live record, never a lost
  update.
- **Immediate effect** — a preference change applies on the next model step or the next candidate
  without a restart, because every consumer reads the record per use.
- **Deployment** — a profile plus the plugin configuration it supplies: the model provider route
  and model id, the retention caps, and the extraction deadline, budget and input-byte knobs. The
  deployment is the operator's; the preferences are the user's.
- **Provider route / model id** — the deployment's named provider endpoint and the exact model the
  extraction calls would use. Empty means "this deployment permits no extraction". These two are
  the only parts of the call the deployment chooses; the sampling (temperature 0) and the small
  output cap are fixed by the plugin for the one-shot call.
- **Extraction** — the optional, model-assisted second opinion on a *new live* prose candidate: one
  bounded one-shot call that may drop the candidate or refine its kind and title. It never creates
  an item and never closes one. Permitted here; executed by Capture
  ([glossary §4](../../../UBIQUITOUS_LANGUAGE.md#4-capture-vocabulary)).
- **Item / open item** — one durable record of something the user must supply; an *open item* is
  one in a live state. The item's meaning is the register's
  ([glossary §2](../../../UBIQUITOUS_LANGUAGE.md#2-the-item)).
- **Register** — the durable domain memory holding the install's items; "emitted to the register"
  means the candidate becomes a stored record the user can see.
- **Candidate** — an inferred item awaiting the user's confirmation; it never counts as attention
  and is not answerable as an item until confirmed.
- **Prose candidate** — a candidate the end-of-turn prose gate inferred from the turn's final
  assistant text. Extraction is only ever about this candidate family.
- **Tier** — the evidence class of an item's existence: **structural** (declared or observed) or
  **candidate** (inferred). Extraction can only ever sharpen a candidate's text.
- **Closure** — the act of a closing detector resolving an item because its artifact resolved.
  A closure is a lifecycle fact, not a judgement, so extraction never runs for one.
- **Capture evidence** — what proves an item's existence: the artifact, the verbatim quote where
  the artifact carries text (an inferred ask, or a harness reason, objective or plan) and the
  detection origin. Extraction can refine a title but may not invent or discard this evidence.
- **Needs you / attention** — the register's computed predicate for the user's live attention: a
  structural item in a live state (`open` or `stale`) with severity 1 or 2, and not a tombstone. A
  candidate is never counted by it, so a candidate being emitted is not an attention claim
  ([glossary §9](../../../UBIQUITOUS_LANGUAGE.md#9-measures-and-predicates)).
- **Model runtime** — the harness service that can prepare and run one model call. It is optional;
  absent or unmounted means extraction is impossible.
- **Session id / session title** — the durable identity and the display title of a session. Neither
  is ever sent in an extraction request, and neither is ever written to the plugin log.
- **Live path** — a candidate raised from a session event as it happens. **Historical** means the
  bounded backfill/rescan over sessions whose logs already existed; its candidates are never
  extracted.
- **One-shot call** — a single, non-conversational model request: one system instruction, one user
  message, no tool schemas, sampling fixed by the plugin (temperature 0), a small output cap fixed
  by the plugin, and one end-to-end deadline. It is not a session, produces no transcript and is
  retried by nobody.
- **Prompt** — the text sent as that call's user message: the turn's final assistant text, byte-
  capped, explicitly framed as untrusted data.
- **Verdict** — the model's answer for one candidate: a strict JSON object with `keep` (boolean),
  `kind` (`question` or `decision`), `title` (bounded string) and `confidence` (0–1). It is a
  judgement about one candidate, not about a session.
- **Confidence** — the model's reported certainty in a verdict, from 0 to 1. Below the published
  threshold the verdict is ignored; at or above it the verdict is applied.
- **Fail closed** — the rule that any failure, absence or ambiguity produces "no verdict", which
  means the gate's candidate is kept unchanged. It never produces a call, a grant or an error
  surfaced into the work.
- **Budget** — the in-memory cap on extraction calls per UTC day, default 20. It is a pace limit,
  not a durable quota; zero disables calls without changing the preference.
- **UTC day** — the calendar day in Coordinated Universal Time; the budget counter belongs to one
  UTC day and starts again on the next.
- **Deadline** — the end-to-end time limit for one extraction call, after which the call is
  abandoned and the candidate is kept unchanged.
- **Input byte cap** — the hard UTF-8 byte limit on the assistant text placed in one prompt.
- **Plugin log** — the diagnostic log the plugin writes for its own failures. It is distinct from
  the **session log**, the harness's durable per-session event log, which the plugin only reads and
  never writes ([glossary §8](../../../UBIQUITOUS_LANGUAGE.md#8-durability-vocabulary)).
- **Request record** — a durable record of a request or response. This capability writes none that
  carry session content.
- **Disclosure** — the plain statement, in the place where a preference is set, of what that
  preference changes, what its default is, and — for extraction — what would be sent and under
  which two conditions. Disclosure is part of consent, not marketing copy.
- **Opt-in / default-off** — the product posture that a capability which changes what the agent
  does or sends bytes off-machine is off unless the user, and for extraction the deployment, turns
  it on ([glossary §7](../../../UBIQUITOUS_LANGUAGE.md#7-model-facing-vocabulary)). It governs the
  nudge, the runtime-context line and extraction. It does not govern the always-available
  declaration tool (an offer to declare, not an instruction) or the local, confirm-first prose
  gate whose on-by-default value is the deliberate exception in
  [ADR 001](../adrs/001-default-off-model-surfaces.md).

## Constraints

1. **The consent rule.** Extraction runs only when **both** conditions hold: the model-assisted
   extraction preference is on **and** the deployment configures a non-empty provider route and
   model id. If either condition is missing, no request is made, no byte is sent, and the candidate
   proceeds exactly as if extraction did not exist. Configuration without consent is dormant;
   consent without configuration has no effect.
2. **One egress path, and only one.** The domain permits no second path off the machine: capture
   folds, the register, the page's reads and writes, the settings record, the backfill and the
   delivery messages are all local. Sending a reply into a session is not egress by this plugin —
   it creates durable session content, which then inherits that session's own upload and telemetry
   posture, and the disclosure says so.
3. **Content bounds.** One call per candidate, and the call carries only that candidate's turn
   final assistant text, byte-capped and framed as untrusted data. It never carries the transcript,
   the user's messages, tool output, file contents, the item record, the session id or the session
   title. There is one identity-free user message and one system instruction; there are no tool
   schemas, no conversation history and no attachments. The sampling (temperature 0) and the small
   output cap are fixed by the plugin for the call, not deployment settings; the input byte cap and
   the deadline are deployment configuration with documented defaults and hard bounds, and neither
   is unbounded.
4. **Volume bounds.** Extraction runs once per *new live* candidate, never more than once for the
   same candidate, never for a closure, and never for a historical candidate. The UTC-day budget is
   consumed before the attempt, so a failing call still counts; a zero budget disables calls
   without changing the preference; the counter is a pace limit, not a durable quota, and a new UTC
   day starts a fresh allowance.
5. **Verdict bounds.** A verdict may drop a candidate (`keep: false`) or refine its kind and title
   (`keep: true`). It may refine the kind only to `question` or `decision`, and the title is
   sanitised and bounded (at most 120 characters). It cannot create a candidate, close an item,
   change severity, blocking, options, quote or capture evidence, or touch anything outside the
   candidate it was asked about.
6. **Application rule.** A well-formed, confident verdict is applied by changing only the fields it
   names; every other property of the gate's candidate is unchanged. A candidate is dropped only
   when the model explicitly says not to keep it — silence, failure or uncertainty keeps it.
7. **Fail closed.** Any of the following keeps the candidate unchanged and produces no user-visible
   error: no model runtime mounted, provider or model unconfigured, preference off, budget
   exhausted, deadline exceeded, provider error, malformed or non-JSON response, missing or
   non-boolean `keep`, missing or non-numeric confidence, confidence below the threshold, plugin
   disposal during a call. An extraction failure never throws into capture and never interrupts a
   session dispatch.
8. **Threshold and tolerance.** A single surrounding Markdown code fence around the JSON object is
   tolerated (models add it); anything else that is not the strict object is a malformed response.
   The confidence threshold is published and fixed at 0.6; a verdict exactly at the threshold is
   accepted, a verdict below it is ignored.
9. **Privacy of records.** Extraction writes no session event, no request record carrying the
   excerpt, and no log line containing session content, titles or ids — failures are reported by
   error name only. The only durable footprint of this capability is the candidate's own record (in
   the register) and the settings record's three booleans.
10. **Immediate effect and truth.** Consumers read the settings record per use, so a preference
    change applies on the next step or the next candidate without a restart, and a model runtime
    that mounts later is still picked up. A write is a compare-and-set patch; a lost race is a
    conflict value carrying the live record, and the surface must show that record rather than
    pretend the change stuck. Reading a record that has never been written writes nothing.
11. **Disclosure.** The settings section must state, for each preference: its current value, its
    default, and what it changes. For the model nudge it must say the agent is told to declare
    items and that a subagent's raise rolls up. For prose candidates it must say candidates are
    inferred and never count as attention until confirmed. For extraction it must say that it is
    used only when the deployment configures an extraction model, that it sends the last assistant
    message of a turn that produced a candidate to that model to confirm or refine the candidate,
    and that nothing leaves the machine while it is off or while no provider/model is configured.
    Copy may not overclaim: "off means nothing leaves" is true; "nothing is ever sent" is not.
12. **Determinism of the contract.** A model response is not deterministic; pinning the call's
    sampling (temperature 0) and capping its output make the request repeatable, not the answer.
    What must be deterministic is the consent decision and the verdict application: given the same
    preferences, deployment configuration, injected clock, budget counter and a fixed stub
    response, the same candidate input produces the same call (or no call) and the same emitted
    candidate. Candidate order is the capture order for the turn, and the budget day is decided in
    UTC.

## Problem

The end-of-turn prose gate is a heuristic, so some of what it infers is wrong. A second opinion
from a model would improve precision — but that second opinion is the only thing the whole product
would do off the machine, and it is exactly the kind of convenience that turns into a silent
privacy regression: a plugin that starts sending prompt text because someone configured a provider,
or because a default was convenient, or because a failure made it try harder.

Consent has a second failure mode: it is easy to ask once and never again. If a user cannot see
what is on, cannot reverse it, or has to restart to make a change, the consent is theatre. And a
lost race on a settings write must never quietly discard the user's choice — the record is the
truth, so a conflict has to be visible.

## Solution

Three preferences in one versioned record, with defaults that mean the product sends nothing until
the user decides otherwise: model nudge off, prose candidates on (local, confirm-first, no bytes),
model-assisted extraction off. Each is disclosed where it is set, and each applies immediately.

Extraction takes two keys: the user's preference **and** the deployment's configured provider and
model. Neither alone can send a byte — a willing deployment cannot spend the user's data, and a
willing user cannot egress from a deployment that never configured a provider. When both hold, each
new live prose candidate gets one bounded one-shot call carrying only that turn's final assistant
text, and the verdict can only drop the candidate or sharpen its kind and title. Any doubt keeps
the gate's candidate. Nothing is retried, nothing is recorded carrying the excerpt, and the plugin
log never sees session content. What must remain true afterwards: a user who leaves the defaults
alone can be certain that nothing left the machine, and can prove it from the settings record.

## User Stories

1. As the user, I want the default install to send nothing, so I can use the product without making
   a privacy decision first.
2. As the user, I want each preference to say what it changes and what its default is, so my
   consent is informed rather than implied.
3. As the user, I want the model nudge to take effect the moment I turn it on and stop the moment I
   turn it off, so I do not have to restart my work.
4. As the user, I want model-assisted extraction to be impossible until both I and the deployment
   permit it, so no plan or configuration can turn it on behind my back.
5. As the user, I want to know exactly what would be sent while extraction is on: the last assistant
   message of a turn that produced a candidate, and nothing else.
6. As the user, I want the register to keep working — with the candidate intact — when extraction is
   off, unconfigured, slow, failing or over its budget.
7. As the user, I want my prompt content kept out of the plugin's logs and out of every session
   record.
8. As the user, I want a lost settings race to show me the current values instead of silently
   discarding my change.

## Acceptance Criteria

These criteria are the definition of done. They change only by amending the spec.

### Story 1 — The defaults are served without writing

```
Given an install whose settings record has never been written
When  the settings record is read
Then  the record reports the model nudge off, prose candidates on and model-assisted extraction
      off, at version 0
And   reading it again reports the same values and still no stored record is materialised
```

### Story 2 — A preference applies immediately

```
Given the settings record at version 1 with the model nudge off, and a root session in its third
      turn
When  the user turns the model nudge on and the write returns at version 2
Then  the next model step of that session carries the nudge instruction, with no restart and no
      new session
And   the plugin writes no session event for the change or for the step
```

### Story 3 — Consent without configuration cannot egress

```
Given the model-assisted extraction preference is on at version 4, and the deployment configures
      no extraction provider route and no model id
When  a new live prose candidate "Should I run the verification ladder?" is raised in root session
      "session-7"
Then  no extraction request is made and no byte leaves the machine
And   the candidate is emitted exactly as the gate produced it
```

### Story 4 — Configuration without consent cannot egress

```
Given the deployment configures extraction provider "local-route" and model "classifier-1", and
      the model-assisted extraction preference is off
When  a new live prose candidate "Should I update the changelog?" is raised in root session
      "session-7"
Then  no extraction request is made and no byte leaves the machine
And   the candidate is emitted exactly as the gate produced it
```

### Story 5 — One bounded call per new live candidate

```
Given extraction is permitted (preference on, provider "local-route" and model "classifier-1"
      configured) and the model runtime is available, and the turn's final assistant text is "I
      reviewed the migration and the schema matches. Do you want me to run the full verification
      ladder now? It takes about ten minutes."
When  the prose gate raises the candidate "Do you want me to run the full verification ladder now?"
Then  exactly one call is made, with one user message containing that turn's final assistant text
      up to the input byte cap and one system instruction
And   the call carries no session id, no session title, no transcript, no tool output, no file
      content and no item record, and offers the model no tools
And   the returned verdict's refinement or drop is applied to that candidate and to no other
```

### Story 6 — A negative verdict drops the candidate

```
Given extraction is permitted and the model returns the strict object {"keep":false,
      "kind":"decision", "title":"ignored", "confidence":0.8}
When  the verdict for the candidate "Should I run the verification ladder?" is applied
Then  the candidate is not emitted to the register at all
And   no other candidate of the turn is affected
```

### Story 7 — A positive verdict refines only kind and title

```
Given extraction is permitted and the model returns {"keep":true, "kind":"decision",
      "title":"  Which rollout window  should we use? ", "confidence":0.9}
When  the verdict for the candidate "Which rollout window should we use?" is applied
Then  the emitted candidate has kind decision and the title "Which rollout window should we use?",
      with whitespace collapsed and the title bounded
And   the candidate's quote, evidence, session, turn and blocking stay exactly as the gate
      produced them, and the candidate is still a candidate
```

### Story 8 — A verdict at the confidence boundary is applied

```
Given extraction is permitted and the model returns {"keep":true, "kind":"decision",
      "title":"Which rollout window should we use?", "confidence":0.6}
When  the verdict is applied
Then  the candidate is kept and the refined kind and title are applied, because a verdict exactly at
      the threshold is accepted
```

### Story 9 — A low-confidence verdict never changes the candidate

```
Given extraction is permitted and the model returns {"keep":true, "kind":"decision",
      "title":"Renamed by the model", "confidence":0.59}
When  the verdict is applied
Then  the candidate is emitted exactly as the gate produced it — the model's kind and title are
      not applied and no other property of the candidate changes
```

### Story 10 — A failing call keeps the candidate and leaks nothing

```
Given extraction is permitted and the turn's final assistant text is
      "SECRET-ASSISTANT-TEXT-DO-NOT-LOG"
When  the extraction call for the candidate in root session "session-7" fails before returning a
      usable response (the provider errors, or the deadline passes with nothing returned)
Then  the candidate is emitted exactly as the gate produced it
And   no error is raised into capture and none is shown in the session
And   the plugin log contains no session content, title or id — only a failure name
And   no session-log entry is written and no request record carrying the excerpt is stored
```

### Story 11 — The day's budget bounds the volume

```
Given extraction is permitted and the daily budget is one call, and one extraction call was
      already made earlier in the current UTC day
When  a new live prose candidate "Should I stage the release?" is raised in root session
      "session-7"
Then  no extraction request is made, no byte leaves the machine, and the candidate is emitted
      exactly as the gate produced it
And   the preference is still reported as on
```

### Story 12 — Historical candidates are never extracted

```
Given extraction is permitted, and a session whose log predates the plugin contains the turn
      final text "Do you want me to migrate the legacy store?"
When  the bounded backfill folds that session and the prose gate raises the candidate
Then  no extraction call is made for it
And   the candidate is emitted exactly as the gate produced it, still confirmable by the user
```

## Design Decisions

- **Consent is a record, not a dialog.** A first-run prompt is easy to forget and leaves no durable
  answer; a versioned record with documented defaults can be inspected, reversed and raced safely.
  A lost race is a conflict value so the user's choice is never silently replaced.
- **Two keys for the one egress path.** The deployment's configuration is not consent, and the
  user's toggle is not capability. Requiring both is defence in depth against the two realistic
  failures: a deployment that turns on a provider for its own reasons, and a user preference that
  survives into an install that never configured one.
- **The exception is local and confirm-first.** The prose candidates preference defaults on, unlike
  the two model-facing permissions, because it changes only what the system *infers* from the
  committed log, sends nothing, tells the agent nothing, and its output is a candidate the user must
  confirm. The general posture — opt-in/default-off for what changes what the agent does or sends
  bytes off-machine — is kept intact (see
  [ADR 001](../adrs/001-default-off-model-surfaces.md)).
- **One closed question about one candidate.** The call asks the model to judge a single candidate
  from a single turn's final text. It is not a conversation, has no tools, and cannot accumulate
  context; that is what keeps the payload minimal and the cost bounded.
- **The verdict can only reduce noise, never add attention.** Extraction may drop or sharpen; it
  cannot create a candidate, cannot close an item and cannot change severity, blocking or evidence.
  A second opinion that could add items would be a second detector, with a second detector's
  failure modes and no user confirmation.
- **Live-only.** Historical candidates from the backfill are cheap and already bounded; extracting
  them would spend the user's budget and privacy on turns they can no longer relate to a call. The
  live path is where a candidate just appeared and the model's second opinion is most useful.
- **Fail closed, including the boring failures.** Missing runtime, missing configuration, timeout,
  malformed response, low confidence, exhausted budget: each keeps the gate's candidate. The
  attractive alternative — retry harder, or trust a partially parsed response — is how a privacy
  feature becomes a reliability feature that sends more.
- **The budget is a pace limit, not a quota.** An in-memory UTC-day counter bounds cost and surprise
  without turning consent into a metered resource; a restart resets the pace but cannot change what
  the preference permits.
- **Disclosure is part of the contract.** The settings section must say what each preference does
  and that off means nothing leaves. Copy that implies more safety than the mechanism provides
  ("nothing is ever sent") is a defect against this spec, even if a given configuration is in fact
  safe.

### Deferred Decisions

- **A local, on-machine extraction provider.** Whether a provider that runs on the same machine
  changes the consent requirement is deliberately undecided. The consent rule is written in terms
  of egress — bytes sent to a model provider — so if such a provider is ever offered, deciding that
  it is not egress is a policy decision made here, not a configuration detail. The seam is that the
  extractor is addressed by a deployment-provided provider route and model id, so the policy can be
  narrowed to a named route without changing the call's content bound.
- **A durable budget.** Whether the UTC-day allowance should survive a restart is deferred; the
  rule in force is an in-memory pace limit, so a restart resets the pace. The seam is one counter in
  the consent-enabled path; persisting it is a durability decision with its own record shape.
- **Additional egress purposes.** None are designed. Any future purpose (summarising, a second
  detector, an optional embedding of the register) would need its own preference, its own content
  bound and its own consent decision under the ADR's obligations; the seam is that the egress
  contract is published per purpose rather than as a general "may call a model" switch.
- **The exact disclosure copy and its localisation.** The contract states what the copy must say;
  the final wording, length budget and locale coverage belong to the settings section and its
  rendering, so they are deferred to Surfaces without weakening the obligations above.

## Testing Strategy

- The model provider is the only mock boundary; the settings record, the candidate gate's output
  and the capture seam are exercised for real, so a passing test proves that a call *was or was not*
  made, not merely that no error was raised.
- The absence behaviours are tested first and explicitly: default install, preference off, provider
  missing, model missing, runtime missing, and historical path each assert zero calls and an
  unchanged candidate. A test that only asserts "no crash" is not evidence.
- Payload bounds are asserted on the request itself: the prompt contains the turn's final assistant
  text and nothing else identifiable; the byte cap binds at the cap, not beyond it; the request
  offers no tools and contains exactly one user message and one system instruction.
- Failure classes are enumerated and each is one test: absent runtime, unconfigured provider,
  deadline, provider error, malformed JSON, shape violation, low confidence, exhausted budget,
  disposal mid-call. Every one asserts the same outcome: the gate's candidate, unchanged.
- Verdict application is tested as a pure transform with a fixed stub response, including the
  confidence boundary (exactly at the threshold accepted, one increment below ignored) and the fact
  that only kind and title can change.
- Determinism: the clock is injected and the UTC-day rollover is driven by it; the budget counter is
  reset explicitly in fixtures; a test that depends on wall-clock time is a test defect.
- Privacy is asserted, not assumed: the fixture's secret assistant text must be absent from the
  plugin log and from every written record, and the count of session events appended across the
  whole extraction path must be zero.
- Settings truthfulness: two writes racing on one expected version yield one written record and one
  conflict carrying the live record; the defaults read at version zero writes nothing.

## Out of Scope

- Rendering the settings section, its switches, status lines, accessibility and locale strings —
  Surfaces owns them; this spec owns what they must say and what they may not claim.
- The persistence contract for the settings record (storage shape, schema version, migration) —
  Durability & Integrity owns it; this spec owns the record's meaning.
- The candidate gate's detection rules, bounds and closure behaviour — Capture owns them; this spec
  only bounds what may be sent about their output.
- Reply delivery and notice writing: a delivered reply is session content and inherits that
  session's own upload and telemetry posture; it is not egress by this plugin.
- Any model-facing egress that is not a candidate second opinion — none is designed, and adding one
  is a new consent decision.
- Operating instructions for configuring a deployment's provider or model — that is operator
  documentation, not a domain contract.

## Open Questions

- **What exactly should the disclosure say, and who signs it off?** The contract states the
  obligations; the final sentences, length and localisation are Surfaces' rendering with the product
  owner's sign-off. The extraction sentence is the one that must not drift from the design
  packet's statement of what leaves the machine.
- **Should a configured-but-off deployment be shown as "available" in the settings section?** If the
  deployment configures a provider and the preference is off, should the row say extraction is
  available and off, or nothing at all? The honest answer needs the settings section's owner and the
  operator documentation to agree on what the user is being told.
- **Should an extraction failure ever be observable?** The design hides it: the candidate simply
  stands. Whether the settings section or the Candidates surface should mention that
  model-assisted extraction is unavailable (unconfigured, over budget, or failing) is a product
  question for Surfaces; this context's contract is only that the candidate is unchanged.
