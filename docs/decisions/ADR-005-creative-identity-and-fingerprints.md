# ADR-005: Creative identity is opaque; fingerprints are versioned and separate

- Status: accepted
- Date: 2026-08-08
- Supersedes: the identity model introduced in commit `0d6587d`

## Context

The first Winner Loop implementation derived `creative_id` from a SHA-256
fingerprint of the creative's material dimensions (`cr_<fingerprint[0:16]>`).
That made identity a pure function of content, which reads elegantly and is
wrong for a permanent join key.

`creative_id` is the column that ties a hypothesis to a render job, an organic
post, a Spark Ad, an attribution record, and a RevenueCat cohort. Brief section
23 requires it to survive the whole funnel. A content-derived ID does not
survive:

- changing the fingerprint schema renumbers every historical creative;
- fixing a normalization bug renumbers every affected creative;
- adding a material dimension renumbers everything;
- two creatives that are genuinely distinct but describe identically collide.

Any of those silently orphans every provider mapping, metric snapshot, and
cohort already pointing at the old value. The damage is invisible at write time
and only surfaces as missing history much later.

The brief also conflated two different questions in one set of "material
dimensions": what the creative _is_ (the rendered pixels and audio) and how it
was _shipped_ (caption beside the media, destination, UTMs, scheduling).

## Decision

Split identity, equivalence, and delivery into three separate concepts.

**`creative_id`** — opaque, immutable, sortable (ULID layout: 48-bit millisecond
timestamp plus 80 bits of randomness, Crockford base32). Minted exactly once at
variant creation, never recomputed, never reused. This is the canonical join key.

**`content_fingerprint` + `content_fingerprint_version`** — a deterministic hash
used for deduplication and equivalence detection only. Algorithms are versioned
and additive; a stored record keeps the version it was written under, so
introducing `v2` cannot change what `v1` concluded. Fingerprints may be
recomputed freely because nothing joins on them.

**`delivery_variant_id`** — a distinct record for non-media delivery
differences: caption beside the media, ad copy not embedded, destination URL,
UTMs, privacy, platform publishing settings. Same media, same `creative_id`,
different delivery.

Identity rules, restated precisely:

- the same rendered asset on TikTok and Meta keeps one `creative_id`;
- changing only UTMs or a provider post ID never creates a new `creative_id`;
- changing opening frame, edit, duration, audio, speaker, visual sequence,
  on-screen proof, or an embedded CTA is material and mints a new
  `creative_id` carrying parent lineage;
- a caption or CTA rendered _into_ the pixels or audio is material
  (`embeddedCta`); one sitting beside the media is delivery (`caption`,
  `adCopy`);
- a changed landing destination is a delivery variant, unless the hypothesis is
  explicitly testing the destination — expressed by
  `destinationIsTestedHypothesis`, which promotes the normalized destination
  into the content fingerprint.

Fingerprint `v1` is retained in the algorithm registry so records written under
it stay verifiable.

## Consequences

Identity now survives every future change to how creatives are described. The
cost is that equivalence detection is a scan over stored fingerprints rather
than a map lookup on the ID, which is acceptable at Winner Loop's scale and
becomes a database index when the ledger is persisted.

Because no real creatives existed when this changed, no data migration was
required; the deterministic IDs only ever appeared in tests. Had production data
existed, the migration would have been: mint opaque IDs, write the old
deterministic value into a `legacy_deterministic_id` column, and repoint
provider mappings through it.

`registerVariant` is idempotent by fingerprint within a hypothesis and family,
so re-registering identical media returns the existing creative instead of
minting a duplicate.
