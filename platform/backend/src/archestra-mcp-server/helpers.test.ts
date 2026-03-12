import { describe, expect, test } from "@/test";
import {
  deduplicateLabels,
  formatAssignmentSummary,
  isAbortLikeError,
  slugify,
} from "./helpers";

describe("slugify", () => {
  test("converts name to lowercase URL-safe slug", () => {
    expect(slugify("Hello World")).toBe("hello_world");
  });

  test("replaces special characters with underscores", () => {
    expect(slugify("My Agent (v2)!")).toBe("my_agent_v2");
  });

  test("strips leading and trailing underscores", () => {
    expect(slugify("__test__")).toBe("test");
  });

  test("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  test("collapses multiple separators", () => {
    expect(slugify("a---b...c")).toBe("a_b_c");
  });
});

describe("isAbortLikeError", () => {
  test("returns true for AbortError", () => {
    const error = new DOMException("The operation was aborted", "AbortError");
    expect(isAbortLikeError(error)).toBe(true);
  });

  test("returns true for error message containing abort", () => {
    const error = new Error("Request was aborted by client");
    expect(isAbortLikeError(error)).toBe(true);
  });

  test("returns false for non-Error values", () => {
    expect(isAbortLikeError("not an error")).toBe(false);
    expect(isAbortLikeError(null)).toBe(false);
    expect(isAbortLikeError(42)).toBe(false);
  });

  test("returns false for unrelated errors", () => {
    expect(isAbortLikeError(new Error("Connection timeout"))).toBe(false);
  });
});

describe("formatAssignmentSummary", () => {
  test("appends MCP server results to lines", () => {
    const lines: string[] = ["Header"];
    formatAssignmentSummary(
      lines,
      [
        { id: "mcp-1", status: "success", toolCount: 3 },
        { id: "mcp-2", status: "no_tools" },
      ],
      [],
    );

    expect(lines).toContain("MCP Server Tool Assignments:");
    expect(lines.some((l) => l.includes("mcp-1: success (3 tools)"))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes("mcp-2: no_tools"))).toBe(true);
  });

  test("appends sub-agent results to lines", () => {
    const lines: string[] = [];
    formatAssignmentSummary(lines, [], [{ id: "agent-1", status: "success" }]);
    expect(lines).toContain("Sub-Agent Delegations:");
  });

  test("does nothing when both arrays are empty", () => {
    const lines: string[] = ["Initial"];
    formatAssignmentSummary(lines, [], []);
    expect(lines).toEqual(["Initial"]);
  });
});

describe("deduplicateLabels", () => {
  test("removes duplicate keys keeping last value", () => {
    const result = deduplicateLabels([
      { key: "env", value: "staging" },
      { key: "team", value: "platform" },
      { key: "env", value: "production" },
    ]);
    expect(result).toEqual([
      { key: "env", value: "production" },
      { key: "team", value: "platform" },
    ]);
  });

  test("returns empty array for empty input", () => {
    expect(deduplicateLabels([])).toEqual([]);
  });

  test("passes through unique labels unchanged", () => {
    const labels = [
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ];
    expect(deduplicateLabels(labels)).toEqual(labels);
  });
});
