import { describe, expect, test } from "vitest";
import {
  internalResources,
  resourceCategories,
  resourceDescriptions,
  resourceLabels,
  resources,
} from "./permission.types";

describe("permission.types", () => {
  test("every resource has a label", () => {
    for (const resource of resources) {
      expect(resourceLabels[resource]).toBeDefined();
      expect(resourceLabels[resource].length).toBeGreaterThan(0);
    }
  });

  test("every resource has a description", () => {
    for (const resource of resources) {
      expect(resourceDescriptions[resource]).toBeDefined();
      expect(resourceDescriptions[resource].length).toBeGreaterThan(0);
    }
  });

  test("every non-internal resource appears in at least one category", () => {
    const allCategorizedResources = Object.values(resourceCategories).flat();
    for (const resource of resources) {
      if (internalResources.includes(resource)) continue;
      expect(allCategorizedResources).toContain(resource);
    }
  });

  test("no category contains internal resources except for minimalisticView", () => {
    const allCategorizedResources = Object.values(resourceCategories).flat();
    for (const internal of internalResources) {
      if (internal === "minimalisticView") continue;
      expect(allCategorizedResources).not.toContain(internal);
    }
  });
});
