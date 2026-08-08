import { randomBytes } from "node:crypto";

/**
 * Sortable, opaque, immutable domain identifiers (ULID layout: 48-bit
 * millisecond timestamp + 80 bits of randomness, Crockford base32).
 *
 * Why opaque rather than content-derived: a canonical join key must survive
 * every change to how we describe its subject. A fingerprint-derived ID is
 * recomputed whenever the fingerprint schema changes, a normalization bug is
 * fixed, or a new material dimension is added — silently renumbering history
 * and orphaning every provider mapping, metric snapshot, and cohort already
 * pointing at it. Content hashes answer "is this the same content?", which is a
 * different question from "which creative is this?".
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

function encodeTime(milliseconds: number): string {
  let remaining = milliseconds;
  let out = "";
  for (let index = TIME_CHARS - 1; index >= 0; index -= 1) {
    out = CROCKFORD[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

const COUNTER_CHARS = 3;

function encodeCounter(value: number, width: number): string {
  let remaining = value;
  let out = "";
  for (let index = 0; index < width; index += 1) {
    out = CROCKFORD[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < RANDOM_CHARS; index += 1) {
    out += CROCKFORD[bytes[index]! % 32];
  }
  return out;
}

export interface IdFactoryOptions {
  now?: () => Date;
  /** Injectable for deterministic tests; defaults to crypto randomness. */
  randomBytes?: (size: number) => Uint8Array;
}

export function createIdFactory(options: IdFactoryOptions = {}) {
  const now = options.now ?? (() => new Date());
  const random = options.randomBytes ?? ((size: number) => Uint8Array.from(randomBytes(size)));
  let lastMilliseconds = -1;
  let monotonicCounter = 0;

  return function mint(prefix: string): string {
    const milliseconds = now().getTime();
    // Two IDs minted in the same millisecond must still sort in creation order.
    if (milliseconds === lastMilliseconds) {
      monotonicCounter += 1;
    } else {
      lastMilliseconds = milliseconds;
      monotonicCounter = 0;
    }
    const body = `${encodeTime(milliseconds)}${encodeRandom(random(RANDOM_CHARS))}`;
    if (monotonicCounter === 0) return `${prefix}_${body}`;
    // Keep the length fixed at 26 by overwriting the tail with a Crockford
    // counter, so same-millisecond mints stay unique and still sort in order.
    const counter = encodeCounter(monotonicCounter, COUNTER_CHARS);
    return `${prefix}_${body.slice(0, TIME_CHARS + RANDOM_CHARS - COUNTER_CHARS)}${counter}`;
  };
}

export const ULID_PATTERN = /^[a-z_]+_[0-9A-HJKMNP-TV-Z]{26}$/;
