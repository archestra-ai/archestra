/**
 * Compile an environment's `validationRegex` source into a `RegExp`. Returns
 * `null` when the source is empty/null or fails to compile (callers treat both
 * as "no validation").
 */
export function compileValidationRegex(
  source: string | null | undefined,
): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

/**
 * Map a catalog field's declared type (env var: "plain_text" | "secret" |
 * "boolean" | "number"; userConfig: "boolean" | "number" | text) to the
 * validation value type. Anything that isn't explicitly numeric or boolean is
 * treated as free-text "string" — the only type the rule applies to.
 */
export function toFieldValueType(
  type: string | undefined,
): "string" | "number" | "boolean" {
  if (type === "number") return "number";
  if (type === "boolean") return "boolean";
  return "string";
}

/**
 * Validate a single config field value against the environment's compiled
 * allowlist regex. Returns an error message when the value violates the rule,
 * or `null` when it passes. Only string-valued fields are checked — number and
 * boolean fields bypass, since the rule targets free-text values (URLs,
 * hostnames, env names). Empty values bypass; required-ness is enforced
 * elsewhere.
 *
 * `environmentName` is woven into the message so it matches the admin's
 * vocabulary (e.g. "staging") rather than a generic "environment".
 */
export function validateFieldAgainstRegex(params: {
  value: string;
  regex: RegExp | null;
  valueType: "string" | "number" | "boolean";
  environmentName: string;
}): string | null {
  const { value, regex, valueType, environmentName } = params;
  if (!regex) return null;
  if (valueType !== "string") return null;
  if (!value) return null;
  return regex.test(value)
    ? null
    : `Value does not match the ${environmentName} validation rule`;
}
