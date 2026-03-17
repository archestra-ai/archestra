import { describe, expect, test } from "vitest";
import { buildMetadataSuffixes } from "./metadata-suffix";

describe("buildMetadataSuffixes", () => {
  test("empty metadata returns null semantic and empty keyword", () => {
    const result = buildMetadataSuffixes({ metadata: {} });
    expect(result.semantic).toBeNull();
    expect(result.keyword).toBe("");
  });

  test("string values produce semantic and keyword suffixes", () => {
    const result = buildMetadataSuffixes({
      metadata: { status: "In Progress", priority: "High" },
    });

    expect(result.semantic).toContain("Metadata:");
    expect(result.semantic).toContain("status - In Progress");
    expect(result.semantic).toContain("priority - High");

    expect(result.keyword).toContain("In Progress");
    expect(result.keyword).toContain("High");
  });

  test("number and boolean values are stringified", () => {
    const result = buildMetadataSuffixes({
      metadata: { count: 42, active: true },
    });

    expect(result.semantic).toContain("count - 42");
    expect(result.semantic).toContain("active - true");
    expect(result.keyword).toContain("42");
    expect(result.keyword).toContain("true");
  });

  test("array values are joined with comma", () => {
    const result = buildMetadataSuffixes({
      metadata: { labels: ["bug", "frontend", "urgent"] },
    });

    expect(result.semantic).toContain("labels - bug, frontend, urgent");
    expect(result.keyword).toContain("bug, frontend, urgent");
  });

  test("null, undefined, and object values are skipped", () => {
    const result = buildMetadataSuffixes({
      metadata: {
        valid: "yes",
        nullVal: null,
        undefinedVal: undefined,
        objectVal: { nested: true },
      },
    });

    expect(result.semantic).toContain("valid - yes");
    expect(result.semantic).not.toContain("nullVal");
    expect(result.semantic).not.toContain("undefinedVal");
    expect(result.semantic).not.toContain("objectVal");
  });

  test("empty string values are skipped", () => {
    const result = buildMetadataSuffixes({
      metadata: { empty: "", whitespace: "   ", valid: "ok" },
    });

    expect(result.semantic).toContain("valid - ok");
    expect(result.semantic).not.toContain("empty");
    expect(result.semantic).not.toContain("whitespace");
  });

  test("empty string arrays are skipped", () => {
    const result = buildMetadataSuffixes({
      metadata: { labels: ["", "  "], valid: "ok" },
    });

    expect(result.semantic).not.toContain("labels");
  });

  test("25% budget rule drops semantic when too large", () => {
    // Create metadata that will exceed 25% of 512 tokens
    const largeMetadata: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      largeMetadata[`field_${i}`] =
        `This is a fairly long value for field number ${i} with extra words`;
    }

    const result = buildMetadataSuffixes({
      metadata: largeMetadata,
      maxTokens: 512,
    });

    expect(result.semantic).toBeNull();
    // Keyword is always kept
    expect(result.keyword).not.toBe("");
  });

  test("min content rule drops semantic when content budget too small", () => {
    // With high titleTokens, remaining budget after semantic will be too small
    const result = buildMetadataSuffixes({
      metadata: {
        status: "In Progress",
        priority: "High",
        type: "Bug",
        assignee: "John",
        team: "Engineering",
      },
      maxTokens: 512,
      titleTokens: 400, // Leaves very little room for content
    });

    // With 400 title tokens, even a small semantic suffix leaves < 256 for content
    // Semantic should be dropped
    expect(result.semantic).toBeNull();
    expect(result.keyword).not.toBe("");
  });

  test("semantic suffix format matches expected structure", () => {
    const result = buildMetadataSuffixes({
      metadata: { status: "Open" },
    });

    expect(result.semantic).toBe("\nMetadata:\n\tstatus - Open");
  });

  test("keyword suffix format is newline-prefixed values", () => {
    const result = buildMetadataSuffixes({
      metadata: { status: "Open", priority: "High" },
    });

    expect(result.keyword).toBe("\nOpen High");
  });

  test("metadata within budget keeps semantic suffix", () => {
    const result = buildMetadataSuffixes({
      metadata: { status: "Open", priority: "High" },
      maxTokens: 512,
      titleTokens: 10,
    });

    expect(result.semantic).not.toBeNull();
    expect(result.keyword).not.toBe("");
  });
});
