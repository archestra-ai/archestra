import { describe, expect, it } from "vitest";
import { agentRuntimeTiersSeed } from "@/mocks/data/organization";
import {
  runtimeTierFormMemory,
  runtimeTierFormValues,
  runtimeTierSettingsAfter,
  validateRuntimeTierForm,
} from "./runtime-tier-form";

describe("validateRuntimeTierForm", () => {
  const otherNames = ["S", "M", "L"];

  it("returns the tier once the name and CPU amounts are valid", () => {
    const values = {
      ...runtimeTierFormValues(null, false),
      name: "XL",
      cpuRequest: "8",
    };
    expect(validateRuntimeTierForm(values, { otherNames })).toEqual({
      errors: {},
      tier: {
        name: "XL",
        cpuRequest: 8,
        cpuLimit: null,
        pooled: true,
        workspaceGiB: null,
      },
    });
    expect(runtimeTierFormMemory(values)).toEqual({
      memoryRequestMiB: 16384,
      memoryLimitMiB: 32768,
    });
    // A workspace size is whole GiB; blank keeps the deployment's default.
    expect(
      validateRuntimeTierForm({ ...values, workspaceGiB: "60" }, { otherNames })
        .tier?.workspaceGiB,
    ).toBe(60);
    expect(
      validateRuntimeTierForm(
        { ...values, workspaceGiB: " 1.5" },
        { otherNames },
      ).errors,
    ).toEqual({
      workspaceGiB:
        "Enter a whole number from 1 to 1024, or leave it blank for the default",
    });
  });

  it("names each problem under its field", () => {
    const base = runtimeTierFormValues(null, false);
    expect(
      validateRuntimeTierForm(
        { ...base, name: " ", cpuRequest: "9" },
        { otherNames },
      ).errors,
    ).toEqual({
      name: "Enter a name",
      cpuRequest: "Enter a number from 0.1 to 8",
    });
    expect(
      validateRuntimeTierForm(
        { ...base, name: "m", cpuRequest: "4", cpuLimit: "2" },
        { otherNames },
      ).errors,
    ).toEqual({
      name: "Another tier is named m",
      cpuLimit: "The CPU limit is below the CPU request",
    });
    expect(
      validateRuntimeTierForm(
        { ...base, name: "XL", cpuRequest: "2.0001", cpuLimit: "17" },
        { otherNames },
      ).errors,
    ).toEqual({
      cpuRequest: "At most three decimals",
      cpuLimit: "Enter a number up to 16, or leave it blank for no limit",
    });
  });
});

describe("runtimeTierSettingsAfter", () => {
  const S = {
    name: "S",
    cpuRequest: 2,
    cpuLimit: null,
    pooled: true,
    workspaceGiB: null,
  };
  const M = {
    name: "M",
    cpuRequest: 4,
    cpuLimit: null,
    pooled: true,
    workspaceGiB: null,
  };
  const L = {
    name: "L",
    cpuRequest: 8,
    cpuLimit: null,
    pooled: false,
    workspaceGiB: null,
  };

  it("appends a created tier, replaces an edited one with its previous name, and drops a deleted one", () => {
    const XL = {
      name: "XL",
      cpuRequest: 8,
      cpuLimit: null,
      pooled: true,
      workspaceGiB: 60,
    };
    expect(
      runtimeTierSettingsAfter(agentRuntimeTiersSeed, {
        kind: "create",
        tier: XL,
        isDefault: true,
      }),
    ).toEqual({ tiers: [S, M, L, XL], defaultTier: "XL" });
    expect(
      runtimeTierSettingsAfter(agentRuntimeTiersSeed, {
        kind: "update",
        original: "M",
        tier: { ...M, name: "Medium" },
        isDefault: false,
      }),
    ).toEqual({
      tiers: [S, { ...M, name: "Medium", previousName: "M" }, L],
      defaultTier: "Medium",
    });
    expect(
      runtimeTierSettingsAfter(agentRuntimeTiersSeed, {
        kind: "delete",
        name: "L",
      }),
    ).toEqual({ tiers: [S, M], defaultTier: "M" });
  });
});
