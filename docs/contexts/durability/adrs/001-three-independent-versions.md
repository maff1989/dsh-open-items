# ADR 001 — Three independent versions

**Date:** 2026-11-15 · **Context(s):** Durability & Integrity (all writers; both halves)

## Context

Three different things evolve at three different rates, for three different audiences:

- **A record family's shape.** An item record, the settings row and the backfill report each evolve
  on their own schedule: a field gains a default, a list gains a bound, a required value appears or
  disappears.
- **The store's durable vocabulary.** The table set, layout, keying and invalid-record policy are
  what the storage platform opens; changing them is a different kind of change from changing one
  record's fields.
- **The wire envelope between the halves.** The browser half hot-reloads while the host half
  restarts, so the browser can legitimately be newer than the host; the envelope, endpoint set and
  payload contract are the compatibility surface between them.

A single version cannot describe this. It would force a data migration whenever a payload changes
and a protocol bump whenever a record gains a field, and would leave the common real case — a newer
client in front of readable older data — inexpressible or dishonest. Most changes need no bump at
all: an optional field with a default, a row shape inside an existing table, an additive payload
field. A version bump is a compatibility promise, not a release marker, so skipping one is cheap.

## Decision

We will keep **three independent versions** — a record schema version, a domain format version and a
wire protocol version — each with its own contract, its own bump rule and its own reader/writer
obligation, and report all three on the route's identity probe so either half can see exactly which
one it cannot honour. The record schema version is per record family, and the probe's value is the
item-record family's; the settings record and the backfill report carry their own schema versions
in-record. We bump exactly the version whose contract changed, never infer or derive one version from
another, and each half acts only on the versions it must honour: the browser on the wire protocol and
domain format, the host on record schema.

## Why

Each version protects a different failure, and each failure has a different remedy:

| Version | Protects | Failure if wrong | Remedy |
|---|---|---|---|
| Record schema version | Whether a stored record can be read at all | Misread or lost records | Refuse a newer record; transform an older one only by an explicit migration, otherwise set it aside |
| Domain format version | Whether the store can be opened at all | The install opens data it does not understand | Open only the format it was written with; refuse honestly |
| Wire protocol version | Whether two halves can talk | Misread payloads, broken controls | Report skew; degrade truthfully; keep the data untouched |

Keeping them separate makes the cheapest compatible change free and makes an incompatibility
diagnosable to one dimension instead of a vague "version mismatch". The trade-off is real: three
concepts to maintain and explain, a classification duty on every change, and a reader that must never
assume the numbers relate.

## Alternatives considered

- **One global version for data, store and wire.** Rejected: forces lockstep, cannot express a newer
  client with readable older data, and makes any mismatch opaque to diagnose.
- **Two versions — record plus protocol, inferring the domain format from the record shape.**
  Rejected: the domain format is invisible in records (it is the table set and layout the platform
  opens), so it must be stated explicitly or it will be guessed.
- **The package's release version as the format version.** Rejected: release cadence is not a data
  contract; a packaging patch would appear to break readers.

## Consequences

- The identity probe must keep carrying all three versions; removing one from it is itself a breaking
  protocol change. The record-schema field reports the item-record family's version; every other
  family versions itself in-record, and the browser does not act on the field — it is a host-side
  persistence concern, while the browser acts on the wire protocol and domain format. Each bump rule
  gets a test, not a convention: an optional field with a default must not bump; a new table must
  bump the domain format only; a renamed payload field must bump the protocol only. A change can
  legitimately require two bumps, each for its own reason — never as a pair by habit.
- Record families carry their own schema version, because they evolve at different rates: the record
  schema version is per family, not per install, and the probe's single field can therefore speak
  only for the item-record family.
- A record newer than the reader is set aside rather than coerced; a store written by a newer domain
  format is refused rather than reinterpreted as the old one; a peer that cannot honour the protocol
  degrades truthfully instead of misreading a payload. These are three behaviours and must not be
  collapsed into one "unsupported" error.
- Reviewers must classify each change by asking which consumer breaks; ambiguity is resolved in
  favour of the narrower version (bump fewer, not more), and documentation and tests must never
  assume the three values are equal or move together
  (see [persistence and migration](../specs/persistence-and-migration.md)).
