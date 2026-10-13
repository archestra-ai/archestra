import { describe, expect, test } from "vitest";
import {
  approvalPromptCall,
  formatArgumentLines,
  parseReviewedArguments,
  reviewedToolLabel,
} from "./review-display";

describe("approvalPromptCall", () => {
  test("shows the reviewed call instead of the remedy call", () => {
    expect(
      approvalPromptCall({
        toolName: "archestra__execute_remedy_plan",
        toolArgs: { offer_id: "offer-1" },
        review: {
          text: "Approve this call?",
          tool: "mcp/context7/query-docs",
          arguments: '{"libraryId":"/node"}',
        },
      }),
    ).toEqual({
      toolName: "context7__query-docs",
      toolArgs: { libraryId: "/node" },
    });
  });

  test("falls back to the review text without a structured tool", () => {
    expect(
      approvalPromptCall({
        toolName: "archestra__execute_remedy_plan",
        toolArgs: { offer_id: "offer-1" },
        review: { text: "Approve this call?" },
      }),
    ).toEqual({
      toolName: "archestra__execute_remedy_plan",
      toolArgs: { offer_id: "offer-1" },
      reviewText: "Approve this call?",
    });
  });

  test("keeps a plain tool approval as is", () => {
    expect(
      approvalPromptCall({ toolName: "github__create_issue", toolArgs: {} }),
    ).toEqual({ toolName: "github__create_issue", toolArgs: {} });
  });
});

describe("reviewedToolLabel", () => {
  test("shows a gateway tool the way the agent called it", () => {
    expect(reviewedToolLabel("mcp/context7/query-docs")).toBe(
      "context7__query-docs",
    );
  });

  test("keeps any other name as is", () => {
    expect(reviewedToolLabel("Bash")).toBe("Bash");
    expect(reviewedToolLabel("context7__query-docs")).toBe(
      "context7__query-docs",
    );
    expect(reviewedToolLabel("mcp/a/b/c")).toBe("mcp/a/b/c");
  });
});

describe("parseReviewedArguments", () => {
  test("returns an object", () => {
    expect(parseReviewedArguments('{"libraryId":"/node"}')).toEqual({
      libraryId: "/node",
    });
  });

  test("returns undefined for missing, invalid or non-object JSON", () => {
    expect(parseReviewedArguments(undefined)).toBeUndefined();
    expect(parseReviewedArguments("{")).toBeUndefined();
    expect(parseReviewedArguments("[1]")).toBeUndefined();
    expect(parseReviewedArguments('"text"')).toBeUndefined();
  });
});

describe("formatArgumentLines", () => {
  test("aligns names and wraps long values under the value column", () => {
    expect(
      formatArgumentLines(
        {
          libraryId: "/websites/nodejs",
          query: "fs module file I/O readFile writeFile",
        },
        32,
      ),
    ).toBe(
      [
        "libraryId  /websites/nodejs",
        "query      fs module file I/O",
        "           readFile writeFile",
      ].join("\n"),
    );
  });

  test("serializes non-string values", () => {
    expect(formatArgumentLines({ limit: 5, tags: ["a"] })).toBe(
      'limit  5\ntags   ["a"]',
    );
  });

  test("returns an empty string without arguments", () => {
    expect(formatArgumentLines({})).toBe("");
  });
});
