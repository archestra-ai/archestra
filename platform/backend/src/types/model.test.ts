import { describe, expect, it } from "vitest";
import { PatchModelBodySchema } from "./model";

describe("PatchModelBodySchema", () => {
  it("allows embedding models without output modalities", () => {
    const result = PatchModelBodySchema.safeParse({
      embeddingDimensions: 3072,
      inputModalities: ["text", "image"],
      outputModalities: [],
    });

    expect(result.success).toBe(true);
  });

  it("requires output modalities for non-embedding models", () => {
    const result = PatchModelBodySchema.safeParse({
      embeddingDimensions: null,
      inputModalities: ["text"],
      outputModalities: [],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["outputModalities"]);
      expect(result.error.issues[0]?.message).toBe(
        "At least one output modality is required",
      );
    }
  });
});
