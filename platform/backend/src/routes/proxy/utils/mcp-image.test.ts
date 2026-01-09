import { describe, expect, test } from "@/test";
import { hasImageContent, isMcpImageBlock } from "./mcp-image";

describe("mcp-image utils", () => {
  describe("isMcpImageBlock", () => {
    test("returns true for valid MCP image blocks", () => {
      expect(isMcpImageBlock({ type: "image", data: "abc" })).toBe(true);
      expect(
        isMcpImageBlock({
          type: "image",
          data: "abc",
          mimeType: "image/png",
        }),
      ).toBe(true);
    });

    test("returns false for non-image blocks", () => {
      expect(isMcpImageBlock(null)).toBe(false);
      expect(isMcpImageBlock("image")).toBe(false);
      expect(isMcpImageBlock({ type: "text", data: "abc" })).toBe(false);
      expect(isMcpImageBlock({ type: "image" })).toBe(false);
      expect(isMcpImageBlock({ type: "image", data: 123 })).toBe(false);
    });
  });

  describe("hasImageContent", () => {
    test("returns false for non-array content", () => {
      expect(hasImageContent({})).toBe(false);
      expect(hasImageContent("not-an-array")).toBe(false);
      expect(hasImageContent(null)).toBe(false);
    });

    test("returns true when array contains MCP image blocks", () => {
      expect(hasImageContent([{ type: "text", text: "hello" }])).toBe(false);
      expect(
        hasImageContent([
          { type: "image", data: "abc", mimeType: "image/png" },
        ]),
      ).toBe(true);
    });

    test("supports custom image predicates", () => {
      const isCustomImage = (item: unknown): boolean => {
        if (typeof item !== "object" || item === null) return false;
        const candidate = item as Record<string, unknown>;
        return candidate.kind === "image";
      };

      expect(
        hasImageContent([{ kind: "image", payload: "x" }], isCustomImage),
      ).toBe(true);
    });
  });
});
