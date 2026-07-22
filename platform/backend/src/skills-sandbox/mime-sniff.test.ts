import { describe, expect, it } from "vitest";
import { isInlineSafeImageMime, resolveArtifactMime } from "./mime-sniff";

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF89A_HEADER = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00,
]);
const WEBP_HEADER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

describe("resolveArtifactMime", () => {
  it.each([
    ["png", PNG_HEADER, "image/png"],
    ["jpeg", JPEG_HEADER, "image/jpeg"],
    ["gif89a", GIF89A_HEADER, "image/gif"],
    ["webp", WEBP_HEADER, "image/webp"],
  ])("sniffs %s from magic bytes when unclaimed", (_label, buffer, expected) => {
    expect(resolveArtifactMime({ buffer, claimed: undefined })).toBe(expected);
  });

  it("keeps the claimed mime when bytes don't match a known image signature", () => {
    // sniff returns null for the HTML bytes, so the claim survives. the
    // browser-side defense (Content-Type: image/png + nosniff) prevents the
    // HTML from rendering — see the route handler.
    expect(
      resolveArtifactMime({
        buffer: Buffer.from("<html><script>alert(1)</script></html>"),
        claimed: "image/png",
      }),
    ).toBe("image/png");
  });

  it("sniffed mime wins over claimed when bytes match a known signature", () => {
    // attacker tries to mislabel a PNG as SVG to bypass the inline-safe filter
    expect(
      resolveArtifactMime({
        buffer: PNG_HEADER,
        claimed: "image/svg+xml",
      }),
    ).toBe("image/png");
  });

  it("falls back to application/octet-stream when neither sniff nor claim", () => {
    expect(
      resolveArtifactMime({
        buffer: Buffer.from("arbitrary"),
        claimed: undefined,
      }),
    ).toBe("application/octet-stream");
  });

  it("keeps a non-image claim when bytes are unknown", () => {
    expect(
      resolveArtifactMime({
        buffer: Buffer.from("%PDF-1.4 ..."),
        claimed: "application/pdf",
      }),
    ).toBe("application/pdf");
  });
});

describe("isInlineSafeImageMime", () => {
  it("includes the four raster formats", () => {
    expect(isInlineSafeImageMime("image/png")).toBe(true);
    expect(isInlineSafeImageMime("image/jpeg")).toBe(true);
    expect(isInlineSafeImageMime("image/webp")).toBe(true);
    expect(isInlineSafeImageMime("image/gif")).toBe(true);
  });

  it("excludes SVG and anything else", () => {
    expect(isInlineSafeImageMime("image/svg+xml")).toBe(false);
    expect(isInlineSafeImageMime("application/pdf")).toBe(false);
    expect(isInlineSafeImageMime("text/html")).toBe(false);
    expect(isInlineSafeImageMime("application/octet-stream")).toBe(false);
  });
});
