/**
 * Asserts that every non-null value in `values` matches `validationRegex`.
 * No-op when the regex is null/empty (validation disabled) or values is empty.
 * Throws a plain Error so the caller can decide HTTP status / framing.
 *
 * `targetName` is woven into the error message so the user sees which
 * environment rejected their value (e.g. "staging", "Default"). The regex
 * itself is intentionally NOT included — surfacing it to end users leaks
 * security/policy intent and tends to be noisy.
 */
export function validateValuesAgainstRegex(
  values: Record<string, unknown> | null | undefined,
  validationRegex: string | null | undefined,
  targetName: string,
): void {
  if (!validationRegex) return;
  if (!values) return;

  const re = new RegExp(validationRegex);

  for (const [key, value] of Object.entries(values)) {
    if (value == null) continue;
    const str = String(value);
    if (str === "") continue;
    if (!re.test(str)) {
      throw new Error(
        `Value for "${key}" does not match the validation pattern required by "${targetName}"`,
      );
    }
  }
}
