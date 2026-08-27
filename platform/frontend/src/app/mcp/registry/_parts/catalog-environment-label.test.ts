import { describe, expect, it } from "vitest";
import { resolveCatalogEnvironmentLabel } from "./catalog-environment-label";

const envs = [
  { id: "prod", name: "Production" },
  { id: "staging", name: "Staging" },
];

describe("resolveCatalogEnvironmentLabel", () => {
  it("hides the label when there are no real environments (only Default)", () => {
    expect(
      resolveCatalogEnvironmentLabel({
        environmentId: "prod",
        environments: [],
      }),
    ).toBeNull();
    expect(
      resolveCatalogEnvironmentLabel({
        environmentId: null,
        environments: [],
      }),
    ).toBeNull();
  });

  it("shows the assigned real environment's name", () => {
    expect(
      resolveCatalogEnvironmentLabel({
        environmentId: "staging",
        environments: envs,
      }),
    ).toBe("Staging");
  });

  it("returns null for a Default-assigned item when Default is unnamed", () => {
    expect(
      resolveCatalogEnvironmentLabel({
        environmentId: null,
        environments: envs,
      }),
    ).toBeNull();
  });

  it("hides the Default environment even when it has been customized", () => {
    expect(
      resolveCatalogEnvironmentLabel({
        environmentId: null,
        environments: envs,
      }),
    ).toBeNull();
  });

  it("returns null when the assigned environment is no longer in the list", () => {
    expect(
      resolveCatalogEnvironmentLabel({
        environmentId: "deleted",
        environments: envs,
      }),
    ).toBeNull();
  });
});
