import { randomBytes } from "node:crypto";

/**
 * Whether `value` is a canonical UUID string. Guard with this before passing a
 * value to a uuid column — Postgres throws "invalid input syntax for type uuid"
 * on a non-uuid string, so an unchecked comparison can fail the whole query.
 */
export function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

/**
 * Generate a monotonic UUIDv7 (RFC 9562).
 *
 * Rows whose primary keys come from here sort by insertion order even when
 * their `created_at` values collide on the same millisecond: the first 48
 * bits are the unix-ms timestamp and the 12 `rand_a` bits act as an
 * intra-millisecond counter, so back-to-back ids from one process are
 * strictly increasing. This gives tables a chronological `(created_at, id)`
 * tiebreaker WITHOUT a schema migration — the `uuid` column type accepts any
 * UUID version, and pre-existing random (v4) ids simply keep their
 * arbitrary-but-stable order.
 */
export function uuidv7(): string {
  let timestamp = Date.now();
  if (timestamp <= lastTimestamp) {
    // Same-ms call (or clock regression): keep the previous timestamp and
    // bump the counter so this id still sorts after the last one.
    timestamp = lastTimestamp;
    counter += 1;
    if (counter > 0xfff) {
      // 12-bit counter exhausted within one millisecond: borrow the next ms.
      timestamp += 1;
      counter = 0;
    }
  } else {
    counter = 0;
  }
  lastTimestamp = timestamp;

  const bytes = randomBytes(16);
  bytes.writeUIntBE(timestamp, 0, 6);
  bytes[6] = 0x70 | (counter >> 8); // version 7 + counter high nibble
  bytes[7] = counter & 0xff; // counter low byte
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 9562 variant

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Canonical 8-4-4-4-12 hex UUID shape, shared so call sites don't each
// re-declare the same regex.
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// uuidv7 monotonicity state: last timestamp handed out and the rand_a
// counter used to order same-millisecond ids.
let lastTimestamp = -1;
let counter = 0;
