import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectImageType } from "./detect-image-type";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "__fixtures__", name));

describe("detectImageType", () => {
  it("detects JPEG from magic bytes", () => {
    expect(detectImageType(fixture("sample.jpg"))).toBe("image/jpeg");
  });

  it("detects PNG from magic bytes", () => {
    expect(detectImageType(fixture("sample.png"))).toBe("image/png");
  });

  it("detects GIF from magic bytes", () => {
    expect(detectImageType(fixture("sample.gif"))).toBe("image/gif");
  });

  it("detects WebP from magic bytes", () => {
    expect(detectImageType(fixture("sample.webp"))).toBe("image/webp");
  });

  it("falls back to image/png for unknown format", () => {
    expect(detectImageType(Buffer.from("unknown data here"))).toBe("image/png");
  });

  it("falls back to image/png for empty buffer", () => {
    expect(detectImageType(Buffer.alloc(0))).toBe("image/png");
  });

  it("falls back to image/png for buffer shorter than 4 bytes", () => {
    expect(detectImageType(Buffer.from([0x00, 0x01]))).toBe("image/png");
  });
});
