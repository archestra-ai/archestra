import { describe, expect, test } from "vitest";
import { SKILL_SANDBOX_ROOT, skillRootPath } from "./runtime-image";

// Mirrors `skill_root_path_rejects_empty_dot_and_traversal` in
// sandbox-core/src/validation.rs — the authoritative twin of this boundary.
describe("skillRootPath", () => {
  test("builds the per-skill root for ordinary names", () => {
    expect(skillRootPath("alpha")).toBe(`${SKILL_SANDBOX_ROOT}/alpha`);
  });

  test("rejects names that collapse onto or escape the shared root", () => {
    for (const bad of ["", ".", "..", "a/b", "../x", "a/../b"]) {
      expect(() => skillRootPath(bad)).toThrow();
    }
  });
});
