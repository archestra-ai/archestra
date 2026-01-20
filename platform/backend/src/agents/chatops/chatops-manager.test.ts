import { describe, expect, test } from "@/test";
import { findTolerantMatchLength } from "./chatops-manager";

describe("findTolerantMatchLength", () => {
  describe("exact matches", () => {
    test("matches exact name with same case", () => {
      expect(findTolerantMatchLength("Agent Peter hello", "Agent Peter")).toBe(
        11,
      );
    });

    test("matches exact name case-insensitively", () => {
      expect(findTolerantMatchLength("agent peter hello", "Agent Peter")).toBe(
        11,
      );
    });

    test("matches at end of string", () => {
      expect(findTolerantMatchLength("Agent Peter", "Agent Peter")).toBe(11);
    });

    test("matches with newline after", () => {
      expect(
        findTolerantMatchLength("Agent Peter\nsome message", "Agent Peter"),
      ).toBe(11);
    });
  });

  describe("space-tolerant matches", () => {
    test("matches name without spaces in text", () => {
      expect(findTolerantMatchLength("AgentPeter hello", "Agent Peter")).toBe(
        10,
      );
    });

    test("matches name without spaces case-insensitively", () => {
      expect(findTolerantMatchLength("agentpeter hello", "Agent Peter")).toBe(
        10,
      );
    });

    test("matches with extra spaces in text", () => {
      expect(findTolerantMatchLength("Agent  Peter hello", "Agent Peter")).toBe(
        12,
      );
    });

    test("matches single word agent name", () => {
      expect(findTolerantMatchLength("Sales hello", "Sales")).toBe(5);
    });
  });

  describe("non-matches", () => {
    test("returns null when name not at start", () => {
      expect(findTolerantMatchLength("Hello Agent Peter", "Agent Peter")).toBe(
        null,
      );
    });

    test("returns null for partial match without word boundary", () => {
      expect(findTolerantMatchLength("AgentPeterX hello", "Agent Peter")).toBe(
        null,
      );
    });

    test("returns null for completely different text", () => {
      expect(findTolerantMatchLength("Hello World", "Agent Peter")).toBe(null);
    });

    test("returns null for partial name match", () => {
      expect(findTolerantMatchLength("Agent hello", "Agent Peter")).toBe(null);
    });

    test("returns null when text is shorter than name", () => {
      expect(findTolerantMatchLength("Age", "Agent Peter")).toBe(null);
    });
  });

  describe("edge cases", () => {
    test("handles empty text", () => {
      expect(findTolerantMatchLength("", "Agent")).toBe(null);
    });

    test("handles single character agent name", () => {
      expect(findTolerantMatchLength("A hello", "A")).toBe(1);
    });

    test("handles agent name with multiple spaces", () => {
      expect(findTolerantMatchLength("John  Doe hello", "John Doe")).toBe(9);
    });

    test("handles mixed case input", () => {
      expect(findTolerantMatchLength("AGENTPETER hello", "Agent Peter")).toBe(
        10,
      );
    });

    test("handles text that is exactly the agent name", () => {
      expect(findTolerantMatchLength("Sales", "Sales")).toBe(5);
    });
  });
});
