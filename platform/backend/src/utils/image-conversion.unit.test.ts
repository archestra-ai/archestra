import { shrinkImageToFit } from "@archestra/image-rs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { shrinkImageForModel } from "./image-conversion";

// The native shrinker is a compiled addon absent in the unit-test env; mock it
// at the boundary. Real conversion is covered by the image-core Rust tests.
vi.mock("@archestra/image-rs", () => ({
  shrinkImageToFit: vi.fn(),
}));

const targets = { maxBytes: 100, maxDimension: 2000 };

describe("shrinkImageForModel", () => {
  beforeEach(() => {
    vi.mocked(shrinkImageToFit).mockReset();
  });

  test("maps the native result to buffer + contentType", async () => {
    const bytes = Buffer.from("shrunk");
    vi.mocked(shrinkImageToFit).mockResolvedValue({
      bytes,
      contentType: "image/jpeg",
    });

    const result = await shrinkImageForModel(Buffer.from("orig"), targets);

    expect(result).toEqual({ buffer: bytes, contentType: "image/jpeg" });
  });

  test("returns null when the native shrinker cannot fit the image", async () => {
    vi.mocked(shrinkImageToFit).mockResolvedValue(null);

    const result = await shrinkImageForModel(Buffer.from("x"), targets);

    expect(result).toBeNull();
  });

  test("returns null (does not throw) when the native call fails", async () => {
    vi.mocked(shrinkImageToFit).mockRejectedValue(new Error("addon missing"));

    const result = await shrinkImageForModel(Buffer.from("x"), targets);

    expect(result).toBeNull();
  });
});
