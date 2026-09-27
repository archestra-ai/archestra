import { describe, expect, test } from "vitest";
import {
  GenerateContentRequestSchema,
  GenerateContentResponseSchema,
} from "./api";

describe("GenerateContentRequestSchema", () => {
  test("preserves provider-hosted tools through request parsing", () => {
    const tools = [
      { googleMaps: {} },
      { enterpriseWebSearch: {} },
      { fileSearch: { fileSearchStoreNames: ["files/test"] } },
    ];
    const parsed = GenerateContentRequestSchema.parse({ contents: [], tools });
    expect(parsed.tools).toEqual(tools);
  });
});

describe("GenerateContentResponseSchema", () => {
  test("accepts a SAFETY candidate that omits content and index", () => {
    const result = GenerateContentResponseSchema.safeParse({
      candidates: [{ finishReason: "SAFETY" }],
    });
    expect(result.success).toBe(true);
  });

  test("accepts a promptFeedback-only blocked response with no candidates", () => {
    const result = GenerateContentResponseSchema.safeParse({
      promptFeedback: { blockReason: "SAFETY" },
    });
    expect(result.success).toBe(true);
  });

  test("accepts an unknown finishReason string", () => {
    const result = GenerateContentResponseSchema.safeParse({
      candidates: [
        {
          index: 0,
          finishReason: "BRAND_NEW_REASON",
          content: { role: "model", parts: [{ text: "hi" }] },
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});
