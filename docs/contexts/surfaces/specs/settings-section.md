# Settings section — capability spec

**Context(s):** Surfaces (owns the interaction contract) · Model Contract & Consent (owns permission
and egress semantics) · **Date:** 2026-11-15

> Intent spec. It states what the capability is for and what it must do; it does not describe
> files, functions or snippets. The design packet and the code own mechanics.

## Definitions

Canonical meanings are in [UBIQUITOUS_LANGUAGE.md](../../../UBIQUITOUS_LANGUAGE.md). Every term
this spec relies on:

- **Settings section** — Settings → Open Items: the one place the user changes this plugin's
  preferences. It is a section inside the harness's Settings area, not a left-navigation page, and it
  is not a control panel for deployment configuration.
- **Preference** — one named boolean in the settings record that changes behaviour for the whole
  install and applies to current and new sessions.
- **Preference row** — one row of the section: the preference's title, a description of what it
  changes, and its switch showing the current value.
- **Settings record** — the single versioned per-install record holding exactly three preferences:
  model nudge, prose candidates and model-assisted extraction. It also carries the compare-and-set
  version described below.
- **Defaults without a row** — the documented values before any write: model nudge off, prose
  candidates on, model-assisted extraction off, at version zero. They are served by value; an
  install that never changes a preference stores nothing, and reading a record that has never been
  written writes nothing.
- **Read** — the whole-record request that fetches Host truth. The section reads on mount and on
  reconnect, never at app start.
- **Mount-time read** — the rule that no settings request happens until the section is actually
  shown: a profile whose user never opens Settings never reads or writes a settings record.
- **Write (compare-and-set patch)** — one change to one preference, sent with the version the
  surface read. There is exactly one write per user change; there is no batch and no Save step.
- **Conflict** — a lost compare-and-set race: the write carried a version older than the record's
  current version. A conflict is a value, not an error and not a lost update; the Host returns the
  live record with it.
- **Host truth** — the settings record as the Host last accepted it. The switches always show Host
  truth; the section has no optimistic state.
- **Immediate effect** — an accepted write applies on the next model step or the next candidate,
  without a restart. The controls show Host truth as soon as the write settles.
- **Saving** — the interval after a change until its write settles. All switches are disabled for
  its duration, and a labelled busy status is shown.
- **Model nudge preference** — attaches the opt-in nudge (an instruction section) to model steps.
  Default off.
- **Prose candidates preference** — lets the local, in-process end-of-turn check surface inferred
  decisions in the Candidates section. Default on. It changes what the system infers from the
  committed session log; it is not a consent field.
- **Model-assisted extraction preference** — permits the deployment-configured extraction path.
  Default off. It permits; it does not enable on its own. Its meaning, its content bounds and what
  "off" guarantees are owned by
  [Consent and egress](../../model-contract/specs/consent-and-egress.md); this spec only owns how
  the switch and its explanation behave.
- **Labelled switch** — a real switch control with an accessible name from its row title, an
  announced on/off state, and no reliance on colour alone.
- **Both locales** — every string the section renders exists in each supported language,
  key-for-key, and the section follows the active locale without re-registering.

## Constraints

- **No Save button, ever.** Every accepted change is already durable; a section that could hold an
  uncommitted state would be lying about when the change took effect.
- **One user change = one compare-and-set write.** A switch activation sends exactly one write,
  carrying the version the section read. No retries loop, no batching, no write on load.
- **Host truth, never optimism.** A switch shows the value the Host returned, not the value the
  user just selected. Between the click and the write settling the control is disabled and the
  section says it is saving; after a refusal it returns to the last accepted values.
- **A conflict is explained, not hidden and not retried.** The section adopts the live record,
  keeps the explanation visible, and leaves the user to decide again; it never re-sends the same
  change automatically and never overwrites the other writer's change.
- **A failure is explained, not absorbed.** A failed write shows a failure line, leaves the last
  accepted values in place, and claims no success; a failed first load shows a load failure with a
  Retry control.
- **A write in flight disables every switch** and shows a labelled busy status (not a colour cue),
  so a second click cannot queue a second change against a stale version.
- **No read before mount, and no read after a reconnect if the page was never opened.** A reconnect
  re-reads only a section that has already loaded; an untouched Settings area stays request-free.
- **The section is three rows, and only three.** Adding a preference is a settings-record change
  owned elsewhere; this section renders the record it is given.
- **Each row is a real labelled switch**, keyboard operable with the standard switch semantics; the
  current value is announced, and the description sits beside the switch so the control has context.
- **Copy is delegated and rendered faithfully.** Each row states its current value, its default and
  what it changes. The extraction row's wording is supplied by the consent contract and is rendered
  as written: this section owns the interaction, not the permission claim, and it must never
  paraphrase the contract into a stronger statement than the contract makes.
- **The section lives inside Settings.** It does not become a navigation page, does not auto-open,
  and does not read when other Settings sections are shown.
- **Both locales are complete.** Every string is locale-owned and key-for-key; the intro, each row,
  the status lines and the accessibly-named switch labels exist in every supported language.
- **Degrade truthfully.** Loading, saving, load failure and conflict are distinct states, each
  described in words; the section never renders a default value as if it were Host truth.

## Problem

The user's control over what this plugin does with their work is three switches: whether the agent
is instructed to declare items, whether the end-of-turn check may surface inferred candidates, and
whether a deployment-configured model may refine those candidates. These are preference decisions —
they can be changed at any time and must take effect immediately — but the interaction they replace
(a settings form with a Save button) is exactly wrong for them: it invites the user to think a
change is pending when it is either applied or not, and it hides *when* it took effect.

The subtler problem is trust. Another session, window or process may change the same install-wide
record at the same moment. A toggle that flips optimistically and later silently reverts teaches the
user that the controls are decorative. A settings page that triggers network reads before the user
opens it is a surprise, and one whose copy overclaims what a permission does is worse than no
control at all.

## Solution

Settings → Open Items is a short section inside the harness's Settings area with one intro line and
three preference rows. Each row states the preference, what it changes, and a real switch showing
Host truth. There is no Save button: flipping a switch sends one compare-and-set write, disables the
section while it is in flight, and then shows the value the Host accepted. A lost race adopts the
Host's live record and explains that the settings changed elsewhere; a failed write leaves the last
accepted values and says so. The section reads nothing until it is shown, re-reads on reconnect only
if it has loaded, and never renders an optimistic state or an unexplained default. Everything it
says about permissions is the consent contract's language, rendered faithfully rather than
paraphrased.

## User Stories

1. As a user, I want to see the plugin's three preferences, their current values and what each one
   changes, so that I know the posture I am in before I touch anything.
2. As a user, I want flipping a switch to apply the change immediately with no Save step, so that
   the control means what it appears to mean.
3. As a user, I want to be told when a change did not stick — a conflict or a failure — and to see
   the values that are actually in force, so that I never believe a false state and can decide again
   on facts.
4. As a user, I want the controls disabled with a visible saving state while a change is in flight,
   so that a double click cannot become a second change.
5. As a user, I want opening Settings to tell me the truth without the plugin calling home before I
   get there, so that inspecting settings has no hidden traffic.
6. As a keyboard or screen-reader user, in my language, I want each preference to be a labelled
   switch whose state is announced, so that I can read and change it without a pointer.

## Acceptance Criteria

Per story, the scenarios that define done, written as behaviour, not code. One scenario = one
action; several assertions about that action are fine, a second action is a second scenario.

### Story 1 — the section states the posture

```
Given an install that has never written a settings record, so the defaults are served by value:
      model nudge off, prose candidates on, model-assisted extraction off
When  the user opens Settings → Open Items
Then  the section shows one intro line and exactly three preference rows
      the model-nudge switch is off, the prose-candidates switch is on, and the extraction switch is off
      each row states its current value, its default, and what the preference changes, and the
      extraction row names its deployment precondition
      there is no Save button anywhere in the section
```

### Story 2 — one change, one write, immediately visible

```
Given the section is showing the defaults at the record version it read
When  the user turns the model-nudge switch on
Then  exactly one compare-and-set write leaves, carrying the version that was read and only the
      model-nudge change
      the switch then shows the value the Host returned — on — and no Save step occurs
      the nudge instruction is part of subsequent model steps without a restart
```

```
Given the model-nudge switch is on
When  the user turns it off
Then  exactly one write leaves for that change and the switch shows the Host's returned value, off
      the nudge instruction is withdrawn from subsequent model steps, with no restart
      the other two switches are unchanged
```

```
Given the prose-candidates switch is on and the Candidates section holds two unconfirmed candidates
When  the user turns the prose-candidates switch off
Then  exactly one write leaves and the switch shows off
      no new prose candidates are inferred from subsequent turns, while the two existing candidates
      remain confirmable and refusable in the Candidates section
```

```
Given the model-assisted extraction switch is on and the deployment configures an extraction model
When  the user turns the extraction switch off
Then  exactly one write leaves and the switch shows off
      the extraction permission is withdrawn under the consent contract, whose rule this section
      renders rather than restates
```

### Story 3 — a change that did not stick is explained

```
Given another writer changed the settings record after this section read it, so the user's version
      is stale
When  the user turns a switch
Then  the write is answered with a conflict carrying the Host's live record
      the section shows that record's values and an explanation that the settings changed elsewhere
      no automatic retry is sent, and the user may decide again against the current version
```

```
Given the section is showing values from a successful read
When  the user turns a switch and the write fails because the harness is unreachable
Then  the section shows a failure line and the switches still show the last accepted values
      it does not claim the change was saved and it does not reach the error state of a failed load
```

```
Given the user has never opened Settings and the plugin's settings record has never been read
When  the user opens Settings → Open Items and the first read fails
Then  the section shows a load failure with a Retry control and no switches with invented values
      it does not present the defaults as Host truth
```

### Story 4 — saving is visible and blocking

```
Given the section is showing Host truth and no write is in flight
When  the user turns a switch and the write is still in flight
Then  every switch in the section is disabled and a labelled busy status says it is saving
      a second activation of any switch sends no additional write
      when the write settles the controls re-enable and show Host truth
```

### Story 5 — no hidden traffic

```
Given the plugin has been running and no Settings section has been shown
When  the user opens a different Settings section
Then  no settings request is made by this plugin and no settings record is read or written
```

```
Given the plugin has been running and Settings has never been opened
When  the user opens Settings → Open Items
Then  exactly one settings read is made for that mount, and it is the first request of the section
      no write is made
```

```
Given the Open items section has loaded and is showing Host truth
When  the connection to the host resets
Then  the section re-reads and shows the Host's current values
      a section that had never loaded stays unrequested after the same reset
```

### Story 6 — readable and operable by anyone

```
Given a screen-reader and keyboard user is on the section
When  they focus a preference's switch and activate it with the keyboard
Then  the switch reports its accessible name from the row title and its on/off state
      the same single compare-and-set write is sent as a pointer activation
      the state change is announced in words, never by colour alone, and the busy status is announced
```

## Design Decisions

- **The section is three switches and an explanation, nothing else.** Preferences are booleans that
  apply install-wide; there is no per-workspace, per-session or per-item variant to render, and no
  Save step to stage. The shape follows from the record, not from a settings-page habit.
- **One interaction is one compare-and-set write.** The switch activation *is* the commit. That is
  why there is no Save button: a draft state would have to be reverted on refusal and would teach
  the user that a control can be "pending". Disabling the section while the write is in flight makes
  the second click impossible rather than merely ignored.
- **Host truth is the only rendered state.** A toggle shows the Host's accepted value, so the
  section can never display a permission the system is not honouring. On a conflict the live record
  wins and the explanation stays; on a failure the last accepted values stay and the failure is
  named.
- **The conflict path is informational, not automatic.** Re-sending the user's change would overwrite
  another writer's decision; retrying in a loop would hide the race. Showing the live record plus
  one explanation sentence puts the user back in control with facts.
- **Mount is the only read trigger.** Settings is a place, not a background service: reading at app
  start would be traffic the user did not ask for, and reading on every settings visit would be a
  poll with no purpose. A reconnect refreshes only what the user is already looking at.
- **The section is inside Settings, not a left-nav page.** These preferences belong with the other
  application settings; a separate page would imply they are a product surface rather than a
  configuration of capture and model posture.
- **Copy is delegated and rendered faithfully.** Permission semantics, egress bounds and the honest
  "off" statements belong to [Consent and egress](../../model-contract/specs/consent-and-egress.md);
  this section owns the interaction and must not paraphrase that contract into a stronger claim.
- **Accessibility and locale are part of the control, not a pass afterwards.** A labelled switch with
  an announced state is the control; an unlabeled toggle or a colour-only saving cue is not a
  settings section.

### Deferred Decisions

- **A fourth preference, or a preference group** — the settings record holds exactly three booleans;
  adding one is a consent-contract and record-shape decision before it is a section decision. *Seam:*
  the section renders the record it is handed, so a new row is additive once the record changes.
- **Per-workspace or per-session preference overrides** — the record is per install, because consent
  and capture posture are install-wide. *Seam:* the read and write are whole-record, versioned; a
  narrower scope would be a different contract, not a UI variant.
- **Server-pushed settings changes** — the section learns about another writer's change through a
  conflict or a reconnect re-read. *Seam:* the record carries a version, so a pushed update could
  later refresh a loaded section without changing the interaction rule.
- **A reset-to-defaults action** — the defaults are served without a row, so "reset" would be a
  sequence of writes rather than a state. *Seam:* the same compare-and-set write path; the decision
  is whether the affordance is worth it.
- **A configured-but-off extraction deployment being marked "available"** — whether the row should
  distinguish "configured by the deployment" from "unconfigured" is an open consent-contract
  question. *Seam:* the row's description is Host-independent copy supplied by the consent contract.

## Testing Strategy

- **Behavioural tests through the rendered section and its controller.** Order: defaults and copy
  rendering; one-write-per-change with the read version; Host truth after a write; conflict
  adoption and explanation; failed write and failed load; saving disablement; no-read-before-mount;
  reconnect refresh; keyboard and labelled-switch accessibility.
- **A good test** injects a settings record and a scripted outcome (written, conflict, failure),
  performs one user action, and asserts both the rendered words/switch states and the exact write
  request — endpoint, version and patch. Copy is asserted through locale keys, never by snapshotting
  markup.
- **Mock only system boundaries:** the host route (settings read and write) and the clock if the
  section ever shows times. The controller's state machine and the row derivation run for real.
- **Assert the absence of requests** explicitly: opening other Settings sections, opening the app, and
  a reconnect before the page was ever mounted must each produce zero settings requests. This is a
  contract, not an optimisation, so it is tested as one.
- **Determinism:** injected records with fixed versions and fixed write outcomes; no test depends on
  a real clock, a locale default or a particular rendered DOM nesting. Conflict and failure paths
  are scripted, so they are reproducible rather than racy.
- **Invariants pinned by tests:** no write without a prior read; at most one in-flight write; every
  rendered switch value is a value the Host returned (or a documented default served without a
  record). These are the three places where the section could start lying.
- **Locale parity** is asserted key-for-key per language, including the switch labels and status
  lines.

## Out of Scope

- The meaning, bounds and guarantees of each preference — consent, egress, extraction content limits,
  the nudge's wording and the candidate gate — are owned by
  [Consent and egress](../../model-contract/specs/consent-and-egress.md) and by Capture and Model
  Contract & Consent.
- The settings record's storage, versioning and persistence rules — owned by Durability & Integrity.
- The deployment's own configuration (provider route, model id, caps): the section never edits it.
- The Candidates section, the nudge's effect on a model step, and the delivery surfaces.
- The harness's Settings shell (navigation, layout, language, focus behaviour): composed, not owned.

## Open Questions

- **Should the section distinguish "the deployment configures an extraction model" from "the
  deployment does not"?** The consent contract leaves the wording open; the interaction question is
  whether the extraction switch should render a different description (or be disabled) when the
  deployment has no provider configured. Answerable by the consent owner with the product owner.
- **Should a user's change be visually acknowledged beyond the switch state?** A transient
  confirmation line would reassure, but the switch showing Host truth is already the honest signal;
  the product owner decides whether an extra acknowledgement adds clarity or noise.
- **Should the section offer a way to see which other window changed the settings on a conflict?**
  The record carries no author identity, and adding one would change the consent contract; today the
  explanation names the fact, not the writer.
