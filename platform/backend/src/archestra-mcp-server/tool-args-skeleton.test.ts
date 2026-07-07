import { describe, expect, test } from "vitest";
import { toolParamsSkeleton } from "./tool-args-skeleton";

describe("toolParamsSkeleton", () => {
  test("renders every top-level property and extracts the required names", () => {
    const result = toolParamsSkeleton({
      type: "object",
      properties: {
        appId: { type: "string" },
        baseVersion: { type: "number" },
        edits: {
          type: "object",
          properties: { old_str: { type: "string" } },
          required: ["old_str"],
        },
      },
      required: ["appId", "edits"],
    });

    expect(result).not.toBeNull();
    expect(result?.required).toEqual(["appId", "edits"]);
    for (const key of ["appId", "baseVersion", "edits"]) {
      expect(result?.skeleton).toContain(`"${key}"`);
    }
  });

  test("returns null for a schema without readable properties", () => {
    expect(toolParamsSkeleton({ type: "object" })).toBeNull();
    expect(toolParamsSkeleton({ type: "object", properties: {} })).toBeNull();
    expect(toolParamsSkeleton("not a schema")).toBeNull();
  });
});
