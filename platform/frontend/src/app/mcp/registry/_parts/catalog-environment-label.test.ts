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
        defaultEnvironmentName: "Default",
      }),
    ).toBeNull();
    expect(
      resolveCatalogEnvironmentLabel({
        environmentId: null,
        environments: [],
        defaultEnvironmentName: "Renamed",
      }),
    ).toBeNull();
  });

  it("shows the assigned real environment's name", () => {
    expect(
      resolveCatalogEnvironmentLabel({
        environmentId: "staging",
        environments: envs,
        defaultEnvironmentName: "Default",
      }),
    ).toBe("Staging");
  });

  it("returns null for a Default-assigned item when Default is unnamed", () => {
    expect(
      resolveCatalogEnvironmentLabel({
        environmentId: null,
        environments: envs,
        defaultEnvironmentName: "Default",
      }),
    ).toBeNull();
  });

  it("shows the Default name only when it has been customized", () => {
    expect(
      resolveCatalogEnvironmentLabel({
        environmentId: null,
        environments: envs,
        defaultEnvironmentName: "Sandbox",
      }),
    ).toBe("Sandbox");
  });

  it("returns null when the assigned environment is no longer in the list", () => {
    expect(
      resolveCatalogEnvironmentLabel({
        environmentId: "deleted",
        environments: envs,
        defaultEnvironmentName: "Default",
      }),
    ).toBeNull();
  });
});
