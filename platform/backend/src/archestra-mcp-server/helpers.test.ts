import { describe, expect, test } from "@/test";
import {
  deduplicateLabels,
  formatAssignmentSummary,
  isAbortLikeError,
} from "./helpers";

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
  test("appends tool assignment results to lines", () => {
    const lines: string[] = ["Header"];
    formatAssignmentSummary(
      lines,
      [],
      [
        { toolId: "tool-1", status: "success" },
        { toolId: "tool-2", status: "error", error: "validation failed" },
      ],
    );

    expect(lines).toContain("Tool Assignments:");
    expect(lines.some((l) => l.includes("tool-1: success"))).toBe(true);
    expect(
      lines.some((l) => l.includes("tool-2: error - validation failed")),
    ).toBe(true);
  });

  test("appends sub-agent results to lines", () => {
    const lines: string[] = [];
    formatAssignmentSummary(lines, [{ id: "agent-1", status: "success" }]);
    expect(lines).toContain("Sub-Agent Delegations:");
  });

  test("does nothing when both arrays are empty", () => {
    const lines: string[] = ["Initial"];
    formatAssignmentSummary(lines, []);
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
