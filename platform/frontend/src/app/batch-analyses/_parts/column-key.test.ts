import { describe, expect, it } from "vitest";
import { toColumnKey } from "./column-key";

/**
 * Column keys are what cells reference, and the backend rejects anything that
 * isn't lowercase alphanumeric-with-underscores starting on an alphanumeric.
 * The user only ever types a display name, so this derivation is the contract
 * between the two.
 */
describe("toColumnKey", () => {
  const KEY_PATTERN = /^[a-z0-9][a-z0-9_]*$/;

  it("slugifies a display name", () => {
    expect(toColumnKey("Data residency region", 0, new Set())).toBe(
      "data_residency_region",
    );
  });

  it("collapses punctuation and trims separators", () => {
    expect(toColumnKey("  Breach notification?! ", 0, new Set())).toBe(
      "breach_notification",
    );
  });

  it("disambiguates a name that collides with one already taken", () => {
    const taken = new Set<string>();
    expect(toColumnKey("Status", 0, taken)).toBe("status");
    expect(toColumnKey("Status", 1, taken)).toBe("status_2");
    expect(toColumnKey("Status", 2, taken)).toBe("status_3");
  });

  it("falls back to a positional key when nothing survives slugifying", () => {
    expect(toColumnKey("???", 4, new Set())).toBe("column_5");
  });

  it("prefixes a name that would otherwise start with a non-alphanumeric", () => {
    // "_leading" would violate the backend's leading-character rule.
    expect(toColumnKey("_leading", 0, new Set())).toMatch(KEY_PATTERN);
  });

  it("always produces a key the backend will accept", () => {
    const taken = new Set<string>();
    for (const name of [
      "Data residency region",
      "SSO supported?",
      "  ",
      "123 numeric start",
      "émoji ✨ name",
      "Data residency region",
    ]) {
      expect(toColumnKey(name, 0, taken)).toMatch(KEY_PATTERN);
    }
  });
});
