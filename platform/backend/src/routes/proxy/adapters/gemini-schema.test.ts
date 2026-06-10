import { describe, expect, it } from "vitest";
import { sanitizeGeminiToolSchema } from "./gemini-schema";

describe("sanitizeGeminiToolSchema", () => {
  it("removes a boolean enum nested in anyOf (the reported failure shape)", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
        flag: {
          anyOf: [
            {
              type: "object",
              properties: {
                discriminator: { type: "boolean", enum: [true] },
              },
            },
            { type: "string" },
          ],
        },
      },
    };

    expect(sanitizeGeminiToolSchema(schema)).toEqual({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
        flag: {
          anyOf: [
            {
              type: "object",
              properties: {
                discriminator: {
                  type: "boolean",
                  description: "Value must be `true`.",
                },
              },
            },
            { type: "string" },
          ],
        },
      },
    });
  });

  it("drops a numeric enum but keeps the numeric type", () => {
    expect(
      sanitizeGeminiToolSchema({ type: "number", enum: [1, 2, 3] }),
    ).toEqual({
      type: "number",
      description: "Value must be one of: `1`, `2`, `3`.",
    });
  });

  it("infers the type from the first value when none is declared", () => {
    expect(sanitizeGeminiToolSchema({ enum: [true] })).toEqual({
      type: "boolean",
      description: "Value must be `true`.",
    });
    expect(sanitizeGeminiToolSchema({ enum: [7] })).toEqual({
      type: "integer",
      description: "Value must be `7`.",
    });
    expect(sanitizeGeminiToolSchema({ enum: [1.5] })).toEqual({
      type: "number",
      description: "Value must be `1.5`.",
    });
  });

  it("appends the constraint to an existing description", () => {
    expect(
      sanitizeGeminiToolSchema({
        type: "boolean",
        enum: [true],
        description: "Acknowledgement.",
      }),
    ).toEqual({
      type: "boolean",
      description: "Acknowledgement. Value must be `true`.",
    });
  });

  it("drops mixed enums entirely", () => {
    expect(
      sanitizeGeminiToolSchema({ type: "string", enum: ["a", 1] }),
    ).toEqual({
      type: "string",
      description: "Value must be one of: `a`, `1`.",
    });
  });

  it("infers a safe type for null-only and heterogeneous untyped enums", () => {
    // typeof null === "object" must not leak as type "object"
    expect(sanitizeGeminiToolSchema({ enum: [null] })).toEqual({
      type: "string",
      description: "Value must be `null`.",
    });
    // mixed value types fall back to string rather than the first value's type
    expect(sanitizeGeminiToolSchema({ enum: [1, "a"] })).toEqual({
      type: "string",
      description: "Value must be one of: `1`, `a`.",
    });
    // all-float numeric set stays number, not integer
    expect(sanitizeGeminiToolSchema({ enum: [1, 1.5] })).toEqual({
      type: "number",
      description: "Value must be one of: `1`, `1.5`.",
    });
  });

  it("recurses into dependencies and unevaluatedItems subschemas", () => {
    expect(
      sanitizeGeminiToolSchema({
        type: "object",
        dependencies: {
          a: { type: "boolean", enum: [true] },
          b: ["c"],
        },
        unevaluatedItems: { type: "boolean", enum: [false] },
      }),
    ).toEqual({
      type: "object",
      dependencies: {
        a: { type: "boolean", description: "Value must be `true`." },
        b: ["c"],
      },
      unevaluatedItems: {
        type: "boolean",
        description: "Value must be `false`.",
      },
    });
  });

  it("drops an empty enum without adding a description", () => {
    expect(sanitizeGeminiToolSchema({ type: "string", enum: [] })).toEqual({
      type: "string",
    });
  });

  it("leaves valid string enums untouched", () => {
    const schema = { type: "string", enum: ["red", "green", "blue"] };
    expect(sanitizeGeminiToolSchema(schema)).toEqual(schema);
  });

  it("recurses into items and $defs", () => {
    expect(
      sanitizeGeminiToolSchema({
        type: "array",
        items: { type: "boolean", enum: [true] },
        $defs: { Flag: { type: "boolean", enum: [false] } },
      }),
    ).toEqual({
      type: "array",
      items: { type: "boolean", description: "Value must be `true`." },
      $defs: {
        Flag: { type: "boolean", description: "Value must be `false`." },
      },
    });
  });

  it("passes through non-schema inputs", () => {
    expect(sanitizeGeminiToolSchema("text")).toBe("text");
    expect(sanitizeGeminiToolSchema(42)).toBe(42);
    expect(sanitizeGeminiToolSchema(null)).toBe(null);
    expect(sanitizeGeminiToolSchema([1, 2])).toEqual([1, 2]);
  });

  it("does not mutate the input", () => {
    const schema = {
      type: "object",
      properties: { flag: { type: "boolean", enum: [true] } },
    };
    const snapshot = structuredClone(schema);
    sanitizeGeminiToolSchema(schema);
    expect(schema).toEqual(snapshot);
  });
});
