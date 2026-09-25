import { describe, expect, test } from "vitest";
import {
  isSafeInlineMimeType,
  sanitizeAttachmentContentType,
} from "./attachment-content-type";

describe("sanitizeAttachmentContentType", () => {
  test("coerces text/html to octet-stream", () => {
    expect(sanitizeAttachmentContentType("text/html")).toBe(
      "application/octet-stream",
    );
    expect(sanitizeAttachmentContentType("TEXT/HTML")).toBe(
      "application/octet-stream",
    );
  });

  test("coerces image/svg+xml to octet-stream", () => {
    expect(sanitizeAttachmentContentType("image/svg+xml")).toBe(
      "application/octet-stream",
    );
  });

  test("coerces XHTML to octet-stream", () => {
    expect(sanitizeAttachmentContentType("application/xhtml+xml")).toBe(
      "application/octet-stream",
    );
  });

  test("coerces JavaScript variants to octet-stream", () => {
    expect(sanitizeAttachmentContentType("application/javascript")).toBe(
      "application/octet-stream",
    );
    expect(
      sanitizeAttachmentContentType("application/javascript; charset=utf-8"),
    ).toBe("application/octet-stream");
    expect(sanitizeAttachmentContentType("text/javascript")).toBe(
      "application/octet-stream",
    );
  });

  test("coerces text/xml to octet-stream", () => {
    expect(sanitizeAttachmentContentType("text/xml")).toBe(
      "application/octet-stream",
    );
  });

  test("preserves safe mime types", () => {
    expect(sanitizeAttachmentContentType("application/pdf")).toBe(
      "application/pdf",
    );
    expect(sanitizeAttachmentContentType("image/png")).toBe("image/png");
    expect(sanitizeAttachmentContentType("image/jpeg")).toBe("image/jpeg");
    expect(sanitizeAttachmentContentType("text/plain")).toBe("text/plain");
    expect(sanitizeAttachmentContentType("application/json")).toBe(
      "application/json",
    );
    expect(sanitizeAttachmentContentType("audio/mpeg")).toBe("audio/mpeg");
    expect(sanitizeAttachmentContentType("application/zip")).toBe(
      "application/zip",
    );
  });
});

describe("isSafeInlineMimeType", () => {
  test("allows PDFs and common raster image formats inline", () => {
    expect(isSafeInlineMimeType("application/pdf")).toBe(true);
    expect(isSafeInlineMimeType("image/png")).toBe(true);
    expect(isSafeInlineMimeType("image/jpeg")).toBe(true);
    expect(isSafeInlineMimeType("image/gif")).toBe(true);
    expect(isSafeInlineMimeType("image/webp")).toBe(true);
    expect(isSafeInlineMimeType("text/plain")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isSafeInlineMimeType("IMAGE/PNG")).toBe(true);
    expect(isSafeInlineMimeType("Application/Pdf")).toBe(true);
  });

  test("rejects script-carrier mime types", () => {
    expect(isSafeInlineMimeType("text/html")).toBe(false);
    expect(isSafeInlineMimeType("image/svg+xml")).toBe(false);
    expect(isSafeInlineMimeType("application/xhtml+xml")).toBe(false);
    expect(isSafeInlineMimeType("application/javascript")).toBe(false);
    expect(isSafeInlineMimeType("text/javascript")).toBe(false);
    expect(isSafeInlineMimeType("text/xml")).toBe(false);
  });

  test("rejects everything else (allow-list semantics)", () => {
    expect(isSafeInlineMimeType("application/zip")).toBe(false);
    expect(isSafeInlineMimeType("application/json")).toBe(false);
    expect(isSafeInlineMimeType("audio/mpeg")).toBe(false);
    expect(isSafeInlineMimeType("video/mp4")).toBe(false);
    expect(isSafeInlineMimeType("application/octet-stream")).toBe(false);
  });
});

describe("sanitize + isSafeInline composition", () => {
  test("after sanitize, all script-carriers fall back to a non-inline mime", () => {
    for (const mime of [
      "text/html",
      "image/svg+xml",
      "application/xhtml+xml",
      "application/javascript",
      "text/javascript",
      "text/xml",
    ]) {
      const safe = sanitizeAttachmentContentType(mime);
      expect(isSafeInlineMimeType(safe)).toBe(false);
    }
  });
});
