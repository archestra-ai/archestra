import MemoryTombstoneModel from "@/models/memory-tombstone";
import { describe, expect, test } from "@/test";
import {
  hasExternalContextMarker,
  screenCandidateBeforePersist,
} from "./screen-candidate-before-persist";

describe("screenCandidateBeforePersist", () => {
  test("detects normalized external context markers", () => {
    expect(
      hasExternalContextMarker(
        "Received UNSAFE   CONTEXT   BOUNDARY metadata from TOOL RESULT payload.",
      ),
    ).toBe(true);
  });

  test("flags medium instruction-like content without blocking persistence", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();

    const result = await screenCandidateBeforePersist({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: user.id,
      content: "Always remember to answer in concise bullets.",
      source: "manual_create",
    });

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.policyFlags).toContain("instruction_like");
      expect(result.policyFlags).toContain("instruction_like_medium");
    }
  });

  test("blocks tombstoned content before persistence", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const content = "Never persist this manipulative instruction again.";

    await MemoryTombstoneModel.record({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: user.id,
      content,
      reason: "rejected",
    });

    const result = await screenCandidateBeforePersist({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: user.id,
      content,
      source: "manual_create",
    });

    expect(result).toMatchObject({
      allowed: false,
      code: "tombstone_hit",
    });
  });
});
