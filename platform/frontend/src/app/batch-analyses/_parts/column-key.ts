/**
 * Column keys are the stable identifier cells reference, but asking a user to
 * invent one is friction with no upside — derive it from the column name and
 * disambiguate collisions positionally.
 *
 * The backend rejects anything that isn't lowercase alphanumeric-with-
 * underscores starting on an alphanumeric, so this derivation is the contract
 * between what the user types and what the API accepts.
 */
export function toColumnKey(
  name: string,
  index: number,
  taken: Set<string>,
): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || `column_${index + 1}`;
  const withLetter = /^[a-z0-9]/.test(base) ? base : `c_${base}`;
  let key = withLetter;
  let suffix = 2;
  while (taken.has(key)) {
    key = `${withLetter}_${suffix}`;
    suffix += 1;
  }
  taken.add(key);
  return key;
}
