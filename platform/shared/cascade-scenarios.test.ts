/**
 * Predicate baseline sweep — runs every scenario in `CASCADE_SCENARIOS`
 * through the shared `isMetadataOnlyEdit` predicate.
 *
 * This test answers: "given the scenario's edit applied to the
 * scenario's shape, does the shared predicate classify the diff as the
 * scenario claims it should?"
 *
 * This is only a baseline. The shared predicate can NOT make the full
 * cascade decision on its own — it has no concept of schema evolution
 * (optional vs required env vars), no knowledge of which DB columns
 * are runtime-relevant, and no view of which install rows exist. The
 * authoritative decision lives in:
 *   • backend/src/services/mcp-reinstall.ts → `requiresNewUserInputForReinstall`
 *   • backend/src/routes/internal-mcp-catalog.ts → `cascadeReinstallForCatalog`
 *
 * Backend/frontend/e2e test suites should each import `CASCADE_SCENARIOS`
 * and assert their layer's slice of the contract.
 */

import { describe, expect, test } from "vitest";
import {
  CASCADE_SCENARIOS,
  type CascadeScenario,
  type SharedPredicateExpectation,
} from "./cascade-scenarios";
import { isMetadataOnlyEdit } from "./catalog-runtime-fields";
import { CATALOG_SHAPES } from "./catalog-shape-fixtures";

describe("cascade scenarios — shared predicate sweep", () => {
  // Tripwire: catalog shape ids must resolve to real fixtures. The
  // `CatalogShapeId` type already enforces this at compile time, but a
  // runtime check guards against bad refactors (e.g. someone removes a
  // fixture without updating the scenarios).
  test("every scenario points at a real shape fixture", () => {
    const orphans = CASCADE_SCENARIOS.filter(
      (s) => !(s.shape in CATALOG_SHAPES),
    ).map((s) => s.id);
    expect(orphans).toEqual([]);
  });

  // Tripwire: ids must be unique. Duplicate ids would make the
  // parameterized test names collide and rotate which assertion
  // actually runs.
  test("scenario ids are unique", () => {
    const ids = CASCADE_SCENARIOS.map((s) => s.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });

  test.each(
    CASCADE_SCENARIOS,
  )("$id ($expected): $userAction", (scenario: CascadeScenario) => {
    const baseline = CATALOG_SHAPES[scenario.shape];
    const edited = scenario.edit(baseline);
    const isMetadataOnly = isMetadataOnlyEdit(
      baseline as Record<string, unknown>,
      edited as Record<string, unknown>,
    );

    const expected: Record<SharedPredicateExpectation, boolean> = {
      // The predicate's contract: `true` when every diff is in
      // METADATA_ONLY_CATALOG_FIELDS AND at least one such diff exists.
      "metadata-only-diff": true,
      // Some non-metadata field differs → false.
      "non-metadata-diff": false,
      // Nothing differs → false (by contract, not by accident).
      "no-diff": false,
    };

    expect(isMetadataOnly).toBe(expected[scenario.sharedPredicate]);
  });
});
