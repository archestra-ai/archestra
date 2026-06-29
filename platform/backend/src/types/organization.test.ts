import { describe, expect, it } from "vitest";
import {
  Base64ImageSchema,
  OnboardingWizardSchema,
  UpdateAppearanceSettingsSchema,
} from "./organization";

// 1x1 transparent PNG
const PNG_1PX_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PNG_1PX_DATA_URI = `data:image/png;base64,${PNG_1PX_BASE64}`;

// 1x1 GIF (GIF89a header + minimal body)
const GIF_1PX_BASE64 =
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const GIF_1PX_DATA_URI = `data:image/gif;base64,${GIF_1PX_BASE64}`;

describe("Base64ImageSchema", () => {
  it("accepts a valid PNG data URI", () => {
    const result = Base64ImageSchema.safeParse(PNG_1PX_DATA_URI);
    expect(result.success).toBe(true);
  });

  it("accepts a valid GIF data URI", () => {
    const result = Base64ImageSchema.safeParse(GIF_1PX_DATA_URI);
    expect(result.success).toBe(true);
  });

  it("accepts null", () => {
    const result = Base64ImageSchema.safeParse(null);
    expect(result.success).toBe(true);
  });

  it("rejects non-PNG/GIF prefixes", () => {
    const result = Base64ImageSchema.safeParse(
      "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
    );
    expect(result.success).toBe(false);
  });

  it("rejects strings without a data URI prefix", () => {
    const result = Base64ImageSchema.safeParse(PNG_1PX_BASE64);
    expect(result.success).toBe(false);
  });

  it("rejects PNG data URI with corrupt magic bytes", () => {
    // Valid base64 that decodes to bytes that are NOT a PNG header
    const fakePngUri = `data:image/png;base64,${Buffer.from(
      "not really a png",
    ).toString("base64")}`;
    const result = Base64ImageSchema.safeParse(fakePngUri);
    expect(result.success).toBe(false);
  });

  it("rejects GIF data URI with corrupt magic bytes", () => {
    const fakeGifUri = `data:image/gif;base64,${Buffer.from(
      "not really a gif",
    ).toString("base64")}`;
    const result = Base64ImageSchema.safeParse(fakeGifUri);
    expect(result.success).toBe(false);
  });

  it("rejects images over 2MB", () => {
    // 2.5MB of zero bytes, base64-encoded, still prefixed as PNG
    const bigPayload = Buffer.alloc(2.5 * 1024 * 1024).toString("base64");
    const bigUri = `data:image/png;base64,${bigPayload}`;
    const result = Base64ImageSchema.safeParse(bigUri);
    expect(result.success).toBe(false);
  });
});

describe("OnboardingWizardSchema", () => {
  it("accepts a wizard with one page, content only", () => {
    const result = OnboardingWizardSchema.safeParse({
      label: "Setup",
      pages: [{ content: "Step 1" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a wizard with PNG image on a page", () => {
    const result = OnboardingWizardSchema.safeParse({
      label: "Setup",
      pages: [{ image: PNG_1PX_DATA_URI, content: "Step 1" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a wizard with GIF image on a page", () => {
    const result = OnboardingWizardSchema.safeParse({
      label: "Setup",
      pages: [{ image: GIF_1PX_DATA_URI, content: "Animated step" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty label", () => {
    const result = OnboardingWizardSchema.safeParse({
      label: "",
      pages: [{ content: "x" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects label over 25 chars", () => {
    const result = OnboardingWizardSchema.safeParse({
      label: "a".repeat(26),
      pages: [{ content: "x" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero pages", () => {
    const result = OnboardingWizardSchema.safeParse({
      label: "Setup",
      pages: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than 10 pages", () => {
    const result = OnboardingWizardSchema.safeParse({
      label: "Setup",
      pages: Array.from({ length: 11 }, () => ({ content: "x" })),
    });
    expect(result.success).toBe(false);
  });
});

describe("UpdateAppearanceSettingsSchema onboardingWizard", () => {
  it("accepts a valid single wizard", () => {
    const result = UpdateAppearanceSettingsSchema.safeParse({
      onboardingWizard: {
        label: "Setup",
        pages: [{ content: "page" }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a wizard with invalid shape", () => {
    const result = UpdateAppearanceSettingsSchema.safeParse({
      onboardingWizard: { label: "Setup", pages: [] },
    });
    expect(result.success).toBe(false);
  });

  it("accepts null", () => {
    const result = UpdateAppearanceSettingsSchema.safeParse({
      onboardingWizard: null,
    });
    expect(result.success).toBe(true);
  });
});
