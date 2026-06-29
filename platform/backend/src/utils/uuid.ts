// Canonical 8-4-4-4-12 hex UUID shape, shared so call sites don't each
// re-declare the same regex.
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `value` is a canonical UUID string. Guard with this before passing a
 * value to a uuid column — Postgres throws "invalid input syntax for type uuid"
 * on a non-uuid string, so an unchecked comparison can fail the whole query.
 */
export function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}
