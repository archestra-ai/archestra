import { describe, expect, it, vi } from "vitest";
import { agentRuntimeTiersSeed } from "@/mocks/data/organization";
import {
  runtimeTierFormMemory,
  runtimeTierFormValues,
  runtimeTierSettingsAfter,
  suggestRuntimeTierName,
  validateRuntimeTierForm,
} from "./runtime-tier-form";

it("suggests a readable name while avoiding case-insensitive tier-name collisions", () => {
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  try {
    expect(suggestRuntimeTierName(["brisk cedar", "Brisk Cedar 2"])).toBe(
      "Brisk Cedar 3",
    );
  } finally {
    random.mockRestore();
  }
});

describe("validateRuntimeTierForm", () => {
  const otherNames = ["S", "M", "L"];

  it("rejects an unrepresentable derived limit while allowing a representable explicit limit", () => {
    const values = {
      ...runtimeTierFormValues(null, false),
      name: "Memory",
      cpuRequest: "1",
      memoryRequestGiB: String(2 ** 42),
    };
    expect(
      validateRuntimeTierForm(values, { otherNames }).errors.memoryLimitGiB,
    ).toBe(
      "Enter an explicit memory limit; the default exceeds the supported numeric range",
    );
    expect(
      validateRuntimeTierForm(
        { ...values, memoryLimitGiB: String(2 ** 42) },
        { otherNames },
      ).tier,
    ).toMatchObject({ memoryRequestMiB: 2 ** 52, memoryLimitMiB: 2 ** 52 });
  });

  it("enforces numeric boundaries and compares limits with effective requests", () => {
    const base = {
      ...runtimeTierFormValues(null, false),
      name: "Memory",
      cpuRequest: "1",
    };
    for (const cpuRequest of ["0.1", "1.001", "8", "256"]) {
      expect(
        validateRuntimeTierForm({ ...base, cpuRequest }, { otherNames }).tier,
      ).not.toBeNull();
    }
    for (const field of ["cpuRequest", "cpuLimit"] as const) {
      for (const invalid of [
        "0",
        "-1",
        "invalid",
        "Infinity",
        "NaN",
        "0.0001",
        "0.099",
        "256.001",
      ]) {
        expect(
          validateRuntimeTierForm({ ...base, [field]: invalid }, { otherNames })
            .errors[field],
        ).toBeDefined();
      }
    }
    for (const field of ["memoryRequestGiB", "memoryLimitGiB"] as const) {
      for (const invalid of [
        "0",
        "-1",
        "invalid",
        "Infinity",
        "NaN",
        "0.0001",
      ]) {
        expect(
          validateRuntimeTierForm({ ...base, [field]: invalid }, { otherNames })
            .errors[field],
        ).toBeDefined();
      }
    }
    expect(
      validateRuntimeTierForm({ ...base, cpuLimit: "256" }, { otherNames })
        .tier,
    ).not.toBeNull();
    expect(
      validateRuntimeTierForm(
        {
          ...base,
          cpuRequest: "256",
          cpuLimit: "256",
          memoryRequestGiB: "4096",
          memoryLimitGiB: "4096",
          workspaceGiB: "2048",
        },
        { otherNames },
      ).tier,
    ).toMatchObject({
      cpuRequest: 256,
      cpuLimit: 256,
      memoryRequestMiB: 4194304,
      memoryLimitMiB: 4194304,
      workspaceGiB: 2048,
    });
    expect(
      validateRuntimeTierForm({ ...base, memoryLimitGiB: "1" }, { otherNames })
        .errors.memoryLimitGiB,
    ).toBe("The memory limit is below the memory request");
    expect(
      validateRuntimeTierForm(
        { ...base, cpuLimit: "1", memoryLimitGiB: "2" },
        { otherNames },
      ).tier,
    ).not.toBeNull();
  });

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
        memoryRequestMiB: null,
        memoryLimitMiB: null,
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
        "Enter a positive whole number, or leave it blank for the default",
    });
  });

  it("keeps explicit memory when CPU changes and clears overrides back to defaults", () => {
    const values = runtimeTierFormValues(
      {
        ...agentRuntimeTiersSeed.tiers[0],
        memoryRequestMiBOverride: 8192,
        memoryLimitMiBOverride: 8192,
      },
      false,
    );
    const changed = { ...values, cpuRequest: "0.5" };
    expect(values).toMatchObject({
      memoryRequestGiB: "8",
      memoryLimitGiB: "8",
    });
    expect(
      validateRuntimeTierForm(changed, { otherNames: [] }).tier,
    ).toMatchObject({
      cpuRequest: 0.5,
      memoryRequestMiB: 8192,
      memoryLimitMiB: 8192,
    });
    expect(runtimeTierFormMemory(changed)).toEqual({
      memoryRequestMiB: 8192,
      memoryLimitMiB: 8192,
    });
    expect(
      validateRuntimeTierForm(
        { ...changed, memoryLimitGiB: "4" },
        { otherNames: [] },
      ).errors.memoryLimitGiB,
    ).toBe("The memory limit is below the memory request");
    expect(
      validateRuntimeTierForm(
        { ...changed, memoryRequestGiB: "-1" },
        { otherNames: [] },
      ).tier,
    ).toBeNull();
    expect(
      validateRuntimeTierForm(
        { ...changed, memoryRequestGiB: "", memoryLimitGiB: "" },
        { otherNames: [] },
      ).tier,
    ).toMatchObject({
      memoryRequestMiB: null,
      memoryLimitMiB: null,
    });
  });

  it("converts fractional GiB to whole MiB and preserves existing MiB precision when edited", () => {
    const values = {
      ...runtimeTierFormValues(null, false),
      name: "Memory",
      cpuRequest: "0.5",
      memoryRequestGiB: "1.5",
      memoryLimitGiB: "2.25",
    };
    expect(
      validateRuntimeTierForm(values, { otherNames: [] }).tier,
    ).toMatchObject({
      memoryRequestMiB: 1536,
      memoryLimitMiB: 2304,
    });
    expect(
      validateRuntimeTierForm(
        {
          ...values,
          memoryRequestGiB: "0.1",
        },
        { otherNames: [] },
      ).tier?.memoryRequestMiB,
    ).toBe(102);
    const edited = runtimeTierFormValues(
      {
        ...agentRuntimeTiersSeed.tiers[0],
        memoryRequestMiBOverride: 1025,
        memoryLimitMiBOverride: 2049,
      },
      false,
    );
    expect(
      validateRuntimeTierForm(edited, { otherNames: [] }).tier,
    ).toMatchObject({
      memoryRequestMiB: 1025,
      memoryLimitMiB: 2049,
    });
    for (const memoryRequestGiB of ["0", "-1", "0.0001", "invalid"]) {
      expect(
        validateRuntimeTierForm(
          {
            ...values,
            memoryRequestGiB,
          },
          { otherNames: [] },
        ).tier,
      ).toBeNull();
    }
  });

  it("names each problem under its field", () => {
    const base = runtimeTierFormValues(null, false);
    expect(
      validateRuntimeTierForm(
        { ...base, name: " ", cpuRequest: "257" },
        { otherNames },
      ).errors,
    ).toEqual({
      name: "Enter a name",
      cpuRequest: "Enter a number from 0.1 to 256",
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
        { ...base, name: "XL", cpuRequest: "2.0001", cpuLimit: "257" },
        { otherNames },
      ).errors,
    ).toEqual({
      cpuRequest: "At most three decimals",
      cpuLimit:
        "Enter a number from 0.1 to 256, or leave it blank for no limit",
    });
  });
});

describe("runtimeTierSettingsAfter", () => {
  it("preserves another tier's explicit memory during an unrelated edit", () => {
    const current = {
      ...agentRuntimeTiersSeed,
      tiers: agentRuntimeTiersSeed.tiers.map((tier) =>
        tier.name === "S"
          ? {
              ...tier,
              memoryRequestMiBOverride: 8192,
              memoryLimitMiBOverride: 8192,
            }
          : tier,
      ),
    };
    expect(
      runtimeTierSettingsAfter(current, { kind: "delete", name: "L" }).tiers[0],
    ).toMatchObject({
      memoryRequestMiB: 8192,
      memoryLimitMiB: 8192,
    });
  });
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
