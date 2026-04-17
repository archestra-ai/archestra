import { BUILT_IN_AGENT_IDS } from "@shared";
import { describe, expect, test } from "@/test";
import { BuiltInAgentConfigSchema, PassthroughHeadersSchema } from "./agent";

describe("BuiltInAgentConfigSchema", () => {
  test("requires maxRounds to be an integer for dual LLM main agent config", () => {
    const valid = BuiltInAgentConfigSchema.safeParse({
      name: BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN,
      maxRounds: 5,
    });
    const invalid = BuiltInAgentConfigSchema.safeParse({
      name: BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN,
      maxRounds: 5.5,
    });

    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });
});

describe("PassthroughHeadersSchema", () => {
  test("accepts valid header names and lowercases them", () => {
    const result = PassthroughHeadersSchema.safeParse([
      "X-Correlation-Id",
      "x-tenant-id",
    ]);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(["x-correlation-id", "x-tenant-id"]);
  });

  test("accepts null", () => {
    const result = PassthroughHeadersSchema.safeParse(null);
    expect(result.success).toBe(true);
    expect(result.data).toBeNull();
  });

  test("rejects hop-by-hop headers", () => {
    for (const blocked of [
      "connection",
      "keep-alive",
      "transfer-encoding",
      "upgrade",
      "host",
      "content-length",
    ]) {
      const result = PassthroughHeadersSchema.safeParse([blocked]);
      expect(result.success).toBe(false);
    }
  });

  test("rejects headers with invalid characters", () => {
    const result = PassthroughHeadersSchema.safeParse(["X-Header With Space"]);
    expect(result.success).toBe(false);
  });

  test("enforces max 20 headers", () => {
    const headers = Array.from({ length: 21 }, (_, i) => `x-header-${i}`);
    const result = PassthroughHeadersSchema.safeParse(headers);
    expect(result.success).toBe(false);

    const valid = PassthroughHeadersSchema.safeParse(headers.slice(0, 20));
    expect(valid.success).toBe(true);
  });

  test("rejects empty header names", () => {
    const result = PassthroughHeadersSchema.safeParse([""]);
    expect(result.success).toBe(false);
  });
});
