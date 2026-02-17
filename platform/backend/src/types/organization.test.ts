import { describe, expect, it } from "vitest";
import { UpdateOrganizationSchema } from "./organization";

const basePayload = {
  onboardingComplete: false,
  convertToolResultsToToon: false,
  autoConfigureNewTools: false,
  allowChatFileUploads: true,
  globalToolPolicy: "permissive" as const,
};

describe("UpdateOrganizationSchema", () => {
  it("accepts valid image data URL logo", () => {
    const result = UpdateOrganizationSchema.partial().safeParse({
      ...basePayload,
      logo: "data:image/png;base64,iVBORw0KGgo=",
    });

    expect(result.success).toBe(true);
  });

  it("rejects non-image data URL logo", () => {
    const result = UpdateOrganizationSchema.partial().safeParse({
      ...basePayload,
      logo: "data:text/plain;base64,SGVsbG8=",
    });

    expect(result.success).toBe(false);
  });

  it("rejects malformed image data URL logo", () => {
    const result = UpdateOrganizationSchema.partial().safeParse({
      ...basePayload,
      logo: "data:image/png;base64,NotAnImageJustText",
    });

    expect(result.success).toBe(false);
  });
});
