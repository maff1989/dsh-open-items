# Open Items — domain and architecture documentation

**Date:** 2026-11-15

This folder holds two kinds of documentation, deliberately kept apart:

1. **The intent corpus** — what the product is for, the language it uses, the boundaries of
   its domain, and the contracts each part must keep. It is written to stay true as the code
   changes: behaviour and contracts, not file inventories.
2. **Operator documentation** — [install.md](install.md), [release.md](release.md),
   [perf.md](perf.md), [a11y.md](a11y.md), [session-log-policy.md](session-log-policy.md) and
   [client-foundation.md](client-foundation.md): how to build, install, verify and operate the
   plugin.

The repository root holds the **design packet**: `DESIGN.md`, `UI.md`, `PLAN*.md`,
`OPEN-ITEMS.md`, `GAP-ANALYSIS.md`, `ACCEPTANCE-rc2.md`, `REVIEW-rc1.md` and `research/`;
the release evidence and change history live in this package as `VERIFY.md` and
`CHANGELOG.md`. That packet is the *record of how* — implementation mechanics, measured evidence,
release gates, dated decisions. This corpus is the *statement of what* — the design a reader
should understand before touching either. Where the two differ, the packet is history and this
corpus is intent; reconcile by amending this corpus deliberately, never by silently copying a
packet claim forward.

## Map

| Document | What it is |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The system's shape and intent: the four questions it answers, the evidence model, the design principles, the quality attributes, the dependency direction. Start here. |
| [CONTEXT_MAP.md](CONTEXT_MAP.md) | The six bounded contexts, the shared kernel, the relationships and the cross-context contracts. |
| [UBIQUITOUS_LANGUAGE.md](UBIQUITOUS_LANGUAGE.md) | The authoritative glossary: canonical terms, context-local terms, retired words, and the code name of each concept. Read it before writing anything. |
| [contexts/attention-register/CONTEXT.md](contexts/attention-register/CONTEXT.md) | The core context: what an item is and what it becomes. |
| [contexts/capture/CONTEXT.md](contexts/capture/CONTEXT.md) | How the system learns what waits. |
| [contexts/answering/CONTEXT.md](contexts/answering/CONTEXT.md) | How a decision reaches the work, and what may be claimed. |
| [contexts/surfaces/CONTEXT.md](contexts/surfaces/CONTEXT.md) | Where the user meets the register. |
| [contexts/durability/CONTEXT.md](contexts/durability/CONTEXT.md) | How the register survives and the harness stays intact. |
| [contexts/model-contract/CONTEXT.md](contexts/model-contract/CONTEXT.md) | What the agent is told and allowed, and what may leave the machine. |
| `contexts/*/specs/` | Capability specs — the intent of one capability, with definitions, constraints, user stories, acceptance criteria, deferred decisions and out-of-scope. |
| `adrs/` and `contexts/*/adrs/` | Architectural decision records for decisions that are hard to reverse, surprising without context, and the result of a real trade-off. |
| [templates/](templates/) | The skeletons this corpus uses: context, spec, ADR. |
| [tools/check-docs.mjs](tools/check-docs.mjs) | Corpus integrity check: required sections and headers, relative links, forbidden vocabulary, acceptance-criteria presence. Run it before committing a documentation change. |

## Reading paths

- **New to the project:** ARCHITECTURE → CONTEXT_MAP → UBIQUITOUS_LANGUAGE → the context you
  are about to work in → its specs.
- **Implementing a capability:** its spec (acceptance criteria first), then the owning
  context's invariants, then the packet's DESIGN/UI section for mechanics and the schemas in
  `src/shared/`.
- **Reviewing a change:** the spec the change implements; if it changes a contract in
  CONTEXT_MAP, the map must change with it.
- **Looking for a decision's rationale:** the ADR index in the owning context; if it is not
  there, the packet's decision log.

## Conventions

### Intent-first, and no status markers

This corpus describes the intended design. It does **not** track release status: there is no
release-status label (built / not built / hidden / planned) on a capability. Status lives where
it belongs — `CHANGELOG.md`, `VERIFY.md`, the plan and the decision log in the packet.

Where the implementation has not caught up with the intent, the design is still stated, and
the gap is named as a design deferral in the spec's **Deferred Decisions** or as an explicit
**Out of Scope** entry. "Deferred" here means *a decision we chose not to make yet, and the seam
that keeps it open* — never *a feature that is not in the build*.

### Language

[UBIQUITOUS_LANGUAGE.md](UBIQUITOUS_LANGUAGE.md) is authoritative. A document that needs a word
it does not define adds the word to the glossary first. Do not invent synonyms for canonical
terms, and do not use a retired word outside the retired-terms table. UI copy in the product
uses the same words the docs do.

### Specs are amended, not rewritten

A spec's acceptance criteria are its contract. If behaviour must change, amend the spec
explicitly (with the date and the reason) before or with the change; a spec that quietly stops
matching behaviour is worse than no spec. Story-level criteria belong to the story: add a
story rather than weakening an existing one.

### ADR test

Write an ADR only when all three hold:

1. the decision is hard to reverse (changing it later costs a lot), and
2. a future reader would be surprised by it without context, and
3. there were genuine alternatives and a real trade-off was made.

Number ADRs sequentially in the directory that owns them (`001-slug.md`, `002-slug.md`, …).
Keep them short: context, decision, why; alternatives and consequences only when they add
value.

### Writing rules

- Every document carries a **Date** and, where relevant, its **Context(s)**.
- Behaviour over implementation: no file paths and no code snippets in specs. CONTEXT.md may
  name the contract or seam a context is reached through; the packet and the code own the
  mechanics.
- Prefer stating a rule and its reason over enumerating a list of cases that will go stale.
- Relative links only; check that they resolve.
- When a document disagrees with the code, decide which is right: if the code is intended,
  amend the document; if the document is intended, the code is a defect and the document
  records the intent until it is fixed.
