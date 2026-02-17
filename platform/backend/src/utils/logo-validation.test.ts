import { describe, expect, it } from "vitest";
import { validateLogoDataUrl } from "./logo-validation";

// Minimal valid 1x1 transparent PNG encoded as base64
const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAA0lEQVQI12P4z8BQDwAEgAF/QualzQAAAABJRU5ErkJggg==";

const VALID_LOGO = `data:image/png;base64,${VALID_PNG_BASE64}`;

describe("validateLogoDataUrl", () => {
  it("should accept a valid PNG data URL", () => {
    const result = validateLogoDataUrl(VALID_LOGO);
    expect(result.valid).toBe(true);
  });

  it("should reject a JPEG data URL", () => {
    const result = validateLogoDataUrl(
      "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("PNG");
    }
  });

  it("should reject a data URL with wrong MIME type", () => {
    const result = validateLogoDataUrl(
      "data:text/plain;base64,SGVsbG8gV29ybGQ=",
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("PNG");
    }
  });

  it("should reject a string that is not a data URL", () => {
    const result = validateLogoDataUrl("NotAnImageJustText");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("data URL");
    }
  });

  it("should reject a data URL with empty base64 payload", () => {
    const result = validateLogoDataUrl("data:image/png;base64,");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("empty");
    }
  });

  it("should reject invalid base64 characters", () => {
    const result = validateLogoDataUrl(
      "data:image/png;base64,!!!invalid-base64!!!",
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("invalid base64");
    }
  });

  it("should reject base64 that decodes to data too short for a PNG signature", () => {
    // "AQID" decodes to 3 bytes — not enough for 8-byte PNG signature
    const result = validateLogoDataUrl("data:image/png;base64,AQID");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("too small");
    }
  });

  it("should reject base64 that decodes to non-PNG data (wrong magic bytes)", () => {
    // "SGVsbG8gV29ybGQh" decodes to "Hello World!" — valid base64 but not PNG
    const result = validateLogoDataUrl(
      "data:image/png;base64,SGVsbG8gV29ybGQh",
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("invalid file signature");
    }
  });

  it("should reject the exact payload from the issue reproduction", () => {
    // The issue shows: data:image/png;base64,NotAnImageJustText
    const result = validateLogoDataUrl(
      "data:image/png;base64,NotAnImageJustText",
    );
    expect(result.valid).toBe(false);
  });

  it("should reject a logo exceeding the 2 MB file-size limit", () => {
    // Create base64 for > 2 MB of data starting with PNG magic bytes
    const pngMagic = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const padding = Buffer.alloc(2 * 1024 * 1024 + 1); // just over 2 MB total
    const oversized = Buffer.concat([pngMagic, padding]);
    const oversizedBase64 = oversized.toString("base64");
    const result = validateLogoDataUrl(
      `data:image/png;base64,${oversizedBase64}`,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("2 MB");
    }
  });

  it("should accept a logo at exactly the 2 MB boundary", () => {
    const pngMagic = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const padding = Buffer.alloc(2 * 1024 * 1024 - pngMagic.length);
    const exactLimit = Buffer.concat([pngMagic, padding]);
    const base64 = exactLimit.toString("base64");
    const result = validateLogoDataUrl(`data:image/png;base64,${base64}`);
    expect(result.valid).toBe(true);
  });

  it("should reject SVG content disguised with PNG data URL prefix", () => {
    // SVG content "<svg>" encodes to "PHN2Zz4=" — fails PNG magic byte check
    const result = validateLogoDataUrl("data:image/png;base64,PHN2Zz4=");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("invalid file signature");
    }
  });
});
