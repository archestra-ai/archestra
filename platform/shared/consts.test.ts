import { describe, expect, test } from "vitest";
import {
  ALL_ARCHESTRA_TOKEN_PREFIXES,
  ARCHESTRA_TOKEN_PREFIX,
  getArchestraTokenPrefix,
  hasArchestraTokenPrefix,
  LEGACY_ARCHESTRA_TOKEN_PREFIXES,
} from "./consts";

describe("token prefix helpers", () => {
  test("uses a neutral prefix for newly generated tokens", () => {
    expect(ARCHESTRA_TOKEN_PREFIX).toBe("arch_");
  });

  test("keeps legacy prefixes in the accepted prefix list", () => {
    expect(ALL_ARCHESTRA_TOKEN_PREFIXES).toContain(
      LEGACY_ARCHESTRA_TOKEN_PREFIXES[0],
    );
  });

  test("matches the current token prefix", () => {
    expect(getArchestraTokenPrefix(`${ARCHESTRA_TOKEN_PREFIX}abc123`)).toBe(
      ARCHESTRA_TOKEN_PREFIX,
    );
    expect(hasArchestraTokenPrefix(`${ARCHESTRA_TOKEN_PREFIX}abc123`)).toBe(
      true,
    );
  });

  test("matches legacy token prefixes", () => {
    expect(
      getArchestraTokenPrefix(`${LEGACY_ARCHESTRA_TOKEN_PREFIXES[0]}abc123`),
    ).toBe(LEGACY_ARCHESTRA_TOKEN_PREFIXES[0]);
    expect(
      hasArchestraTokenPrefix(`${LEGACY_ARCHESTRA_TOKEN_PREFIXES[0]}abc123`),
    ).toBe(true);
  });

  test("returns null for non-platform prefixes", () => {
    expect(getArchestraTokenPrefix("sk-abc123")).toBeNull();
    expect(hasArchestraTokenPrefix("sk-abc123")).toBe(false);
  });
});
