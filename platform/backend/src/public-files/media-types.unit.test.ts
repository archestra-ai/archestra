import { describe, expect, test } from "vitest";
import { sniffPublicFileMime } from "./media-types";

const bytes = (...parts: (string | number[])[]) =>
  Buffer.concat(
    parts.map((part) =>
      typeof part === "string"
        ? Buffer.from(part, "latin1")
        : Buffer.from(part),
    ),
  );

describe("sniffPublicFileMime", () => {
  test("accepts the shareable images, videos, and PDF by their bytes", () => {
    expect(
      sniffPublicFileMime(
        bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe("image/png");
    expect(sniffPublicFileMime(bytes("%PDF-1.7\n"))).toBe("application/pdf");
    expect(
      sniffPublicFileMime(bytes([0, 0, 0, 0x20], "ftypisom", [0, 0, 2, 0])),
    ).toBe("video/mp4");
    expect(
      sniffPublicFileMime(
        bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84], "webm"),
      ),
    ).toBe("video/webm");
  });

  test("refuses same-container formats that are not MP4/WebM video", () => {
    // QuickTime and HEIC share the ISO container; Matroska shares EBML.
    expect(sniffPublicFileMime(bytes([0, 0, 0, 0x14], "ftypqt  "))).toBeNull();
    expect(sniffPublicFileMime(bytes([0, 0, 0, 0x18], "ftypheic"))).toBeNull();
    expect(
      sniffPublicFileMime(
        bytes([0x1a, 0x45, 0xdf, 0xa3, 0xa3, 0x42, 0x82, 0x88], "matroska"),
      ),
    ).toBeNull();
  });

  test("refuses script-capable and unknown content however it is named", () => {
    expect(
      sniffPublicFileMime(bytes("<svg onload=alert(1)></svg>")),
    ).toBeNull();
    expect(sniffPublicFileMime(bytes("<!doctype html><script>"))).toBeNull();
    expect(sniffPublicFileMime(Buffer.alloc(0))).toBeNull();
  });
});
