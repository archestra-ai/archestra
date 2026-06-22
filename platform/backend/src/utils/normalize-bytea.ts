/**
 * pg returns `bytea` columns as Buffer; PGlite (used in tests) returns
 * Uint8Array. Callers rely on Buffer semantics (`.toString("base64")`,
 * `.equals()`), so models normalize at the read boundary with this helper.
 */
export function normalizeByteaField<
  Key extends string,
  Row extends Record<Key, Buffer | null>,
>(row: Row, key: Key): Row {
  if (row[key] == null || Buffer.isBuffer(row[key])) return row;
  // the runtime value is a Uint8Array here, which the static type can't see
  return { ...row, [key]: Buffer.from(row[key] as unknown as Uint8Array) };
}
