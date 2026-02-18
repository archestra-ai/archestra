import { describe, expect, it } from "vitest";
import { UpdateOrganizationSchema } from "./organization";

// Minimal 1x1 red PNG as valid base64
const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const VALID_LOGO = `data:image/png;base64,${VALID_PNG_BASE64}`;

describe("UpdateOrganizationSchema - logo validation", () => {
  const basePayload = {
    onboardingComplete: false,
    convertToolResultsToToon: false,
    compressionScope: "organization" as const,
    autoConfigureNewTools: false,
    globalToolPolicy: "permissive" as const,
    allowChatFileUploads: false,
  };

  it("accepts a valid PNG data URI", () => {
    const result = UpdateOrganizationSchema.partial().safeParse({
      ...basePayload,
      logo: VALID_LOGO,
    });
    expect(result.success).toBe(true);
  });

  it("accepts null logo", () => {
    const result = UpdateOrganizationSchema.partial().safeParse({
      ...basePayload,
      logo: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects plain text as logo", () => {
    const result = UpdateOrganizationSchema.partial().safeParse({
      ...basePayload,
      logo: "data:image/png;base64,NotAnImageJustText",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-image MIME types", () => {
    const result = UpdateOrganizationSchema.partial().safeParse({
      ...basePayload,
      logo: `data:text/html;base64,${VALID_PNG_BASE64}`,
    });
    expect(result.success).toBe(false);
  });

  it("rejects strings without data URI prefix", () => {
    const result = UpdateOrganizationSchema.partial().safeParse({
      ...basePayload,
      logo: VALID_PNG_BASE64,
    });
    expect(result.success).toBe(false);
  });

  it("rejects data URIs with disallowed image types", () => {
    const result = UpdateOrganizationSchema.partial().safeParse({
      ...basePayload,
      logo: `data:image/bmp;base64,${VALID_PNG_BASE64}`,
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid JPEG data URI", () => {
    const result = UpdateOrganizationSchema.partial().safeParse({
      ...basePayload,
      logo: `data:image/jpeg;base64,${VALID_PNG_BASE64}`,
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid WebP data URI", () => {
    const result = UpdateOrganizationSchema.partial().safeParse({
      ...basePayload,
      logo: `data:image/webp;base64,${VALID_PNG_BASE64}`,
    });
    expect(result.success).toBe(true);
  });
});
