import { ALL_MODELS_SENTINEL } from "@shared";
import { describe, expect, test } from "vitest";
import { CreateLimitApiSchema, LimitEntityTypeSchema } from "./limit";

describe("LimitEntityTypeSchema", () => {
  test("accepts the two new scopes added for budgeting v1", () => {
    expect(LimitEntityTypeSchema.parse("user")).toBe("user");
    expect(LimitEntityTypeSchema.parse("virtual_api_key")).toBe(
      "virtual_api_key",
    );
  });

  test("still accepts the pre-existing scopes", () => {
    expect(LimitEntityTypeSchema.parse("organization")).toBe("organization");
    expect(LimitEntityTypeSchema.parse("team")).toBe("team");
    expect(LimitEntityTypeSchema.parse("agent")).toBe("agent");
  });

  test("rejects unknown scopes", () => {
    expect(() => LimitEntityTypeSchema.parse("api_key")).toThrow();
  });
});

describe("CreateLimitApiSchema — ALL_MODELS_SENTINEL validation", () => {
  const base = {
    entityType: "user" as const,
    entityId: "user-123",
    limitType: "token_cost" as const,
    limitValue: 1000,
  };

  test("accepts ['*'] as the sole element", () => {
    const parsed = CreateLimitApiSchema.parse({
      ...base,
      model: [ALL_MODELS_SENTINEL],
    });
    expect(parsed.model).toEqual(["*"]);
  });

  test("accepts a concrete-model list", () => {
    const parsed = CreateLimitApiSchema.parse({
      ...base,
      model: ["gpt-4o", "claude-3-5-sonnet"],
    });
    expect(parsed.model).toEqual(["gpt-4o", "claude-3-5-sonnet"]);
  });

  test("rejects mixing '*' with concrete model names", () => {
    expect(() =>
      CreateLimitApiSchema.parse({
        ...base,
        model: [ALL_MODELS_SENTINEL, "gpt-4o"],
      }),
    ).toThrow();
  });

  test("rejects duplicate sentinels ['*','*']", () => {
    expect(() =>
      CreateLimitApiSchema.parse({
        ...base,
        model: [ALL_MODELS_SENTINEL, ALL_MODELS_SENTINEL],
      }),
    ).toThrow();
  });

  test("rejects an empty model array for token_cost", () => {
    expect(() =>
      CreateLimitApiSchema.parse({
        ...base,
        model: [],
      }),
    ).toThrow();
  });

  test("rejects missing model for token_cost", () => {
    expect(() => CreateLimitApiSchema.parse(base)).toThrow();
  });
});
