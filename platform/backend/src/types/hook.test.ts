import { describe, expect, test } from "vitest";
import { HookRequirementsSchema, InsertHookFileSchema } from "./hook";

describe("hook types", () => {
  test("requirements defaults to empty array", () => {
    const p = InsertHookFileSchema.parse({
      organizationId: "org",
      agentId: "00000000-0000-0000-0000-000000000000",
      event: "pre_tool_use",
      fileName: "guard.py",
      content: "x",
    });
    expect(p.requirements).toEqual([]);
  });
  test("rejects more than 20 requirements", () => {
    expect(
      HookRequirementsSchema.safeParse(
        Array.from({ length: 21 }, (_, i) => `p${i}`),
      ).success,
    ).toBe(false);
  });
  test("rejects multi-line requirements", () => {
    expect(HookRequirementsSchema.safeParse(["a\nb"]).success).toBe(false);
  });
  test("rejects empty content", () => {
    expect(
      InsertHookFileSchema.safeParse({
        organizationId: "org",
        agentId: "00000000-0000-0000-0000-000000000000",
        event: "pre_tool_use",
        fileName: "guard.py",
        content: "",
      }).success,
    ).toBe(false);
  });
});
