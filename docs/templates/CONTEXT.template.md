# <Context name> — context

**Kind:** core | supporting | generic · **Date:** YYYY-MM-DD

## Purpose

One paragraph: the question this context exists to answer, in the user's terms.

## Position in the map

Which contexts it depends on, which depend on it, and the pattern of each relationship. Link
to [CONTEXT_MAP.md](../../CONTEXT_MAP.md) rather than restating the map.

## What this context owns

The decisions this context is the final authority for. Another context may use these concepts;
it may not redefine them.

## What this context does not own

The concepts it consumes and who owns them. This section exists so ownership is never
ambiguous.

## Invariants

The rules that must hold no matter how the implementation changes. Each invariant says what
must never happen and why it matters. This is the most valuable section of the document.

## Inbound contracts

What this context needs from elsewhere: the shape, the guarantee, and what it does when that
guarantee is missing (refuse? degrade? retry?).

## Outbound contracts

What this context publishes: the shape, the guarantee, and its stability expectations.

## Key concepts

The context's terms, with the precise sense they have here. Link the canonical glossary entry;
add a local note only where the context uses the term with extra conditions.

## Design decisions in force

ADRs that shaped this context, and decisions recorded in the specs that a reader must know.
Link, do not duplicate.

## Deferred and open

What this context deliberately does not decide yet, and the seam that keeps each decision
open. Link the specs' Deferred Decisions where they live.

## Reading

The specs in this context, the related packet sections, and the glossary terms a reader should
know first.
