import { describe, expect, it } from "vitest";
import {
  extractCitations,
  hasKnowledgeBaseToolCall,
} from "./knowledge-graph-citations";

describe("hasKnowledgeBaseToolCall", () => {
  it("returns true when a part has toolName ending with query_knowledge_base", () => {
    const parts = [
      { type: "dynamic-tool", toolName: "archestra__query_knowledge_base" },
    ];
    expect(hasKnowledgeBaseToolCall(parts)).toBe(true);
  });

  it("returns true for legacy tool parts with type ending in query_knowledge_base", () => {
    const parts = [{ type: "tool-archestra__query_knowledge_base" }];
    expect(hasKnowledgeBaseToolCall(parts)).toBe(true);
  });

  it("returns false when no knowledge base tool call exists", () => {
    const parts = [
      { type: "text" },
      { type: "dynamic-tool", toolName: "some_other_tool" },
    ];
    expect(hasKnowledgeBaseToolCall(parts)).toBe(false);
  });

  it("returns false for empty parts", () => {
    expect(hasKnowledgeBaseToolCall([])).toBe(false);
  });

  it("finds KB tool call among many parts (cross-message scenario)", () => {
    const parts = [
      { type: "text" },
      { type: "dynamic-tool", toolName: "web_search" },
      { type: "dynamic-tool", toolName: "archestra__query_knowledge_base" },
      { type: "text" },
    ];
    expect(hasKnowledgeBaseToolCall(parts)).toBe(true);
  });
});

describe("extractCitations", () => {
  const makeKbPart = (output: unknown) => ({
    type: "dynamic-tool",
    toolName: "archestra__query_knowledge_base",
    state: "output-available" as const,
    output,
  });

  it("extracts citations from KB tool output", () => {
    const output = {
      results: [
        {
          citation: {
            title: "Doc Title",
            sourceUrl: "https://example.com/doc",
            connectorType: "confluence",
            documentId: "doc-1",
          },
        },
        {
          citation: {
            title: "Another Doc",
            sourceUrl: null,
            connectorType: null,
            documentId: "doc-2",
          },
        },
      ],
    };
    const citations = extractCitations([makeKbPart(output)]);
    expect(citations).toHaveLength(2);
    expect(citations[0]).toEqual({
      title: "Doc Title",
      sourceUrl: "https://example.com/doc",
      connectorType: "confluence",
      documentId: "doc-1",
    });
    expect(citations[1]).toEqual({
      title: "Another Doc",
      sourceUrl: null,
      connectorType: null,
      documentId: "doc-2",
    });
  });

  it("deduplicates citations by documentId", () => {
    const output = {
      results: [
        {
          citation: {
            title: "Same Doc",
            sourceUrl: "https://example.com",
            connectorType: null,
            documentId: "doc-dup",
          },
        },
        {
          citation: {
            title: "Same Doc Copy",
            sourceUrl: "https://example.com/copy",
            connectorType: null,
            documentId: "doc-dup",
          },
        },
      ],
    };
    const citations = extractCitations([makeKbPart(output)]);
    expect(citations).toHaveLength(1);
    expect(citations[0].documentId).toBe("doc-dup");
  });

  it("returns empty array when no KB parts exist", () => {
    const parts = [
      {
        type: "text",
        toolName: undefined,
        state: undefined,
        output: undefined,
      },
    ];
    expect(extractCitations(parts)).toEqual([]);
  });

  it("ignores KB parts that are not in output-available state", () => {
    const part = {
      type: "dynamic-tool",
      toolName: "archestra__query_knowledge_base",
      state: "input-available",
      output: undefined,
    };
    expect(extractCitations([part])).toEqual([]);
  });

  it("ignores parts with toolName that does not match KB suffix", () => {
    const part = {
      type: "dynamic-tool",
      toolName: "some_other_tool",
      state: "output-available",
      output: { results: [{ citation: { documentId: "d1", title: "T" } }] },
    };
    expect(extractCitations([part])).toEqual([]);
  });

  it("handles string output (JSON stringified)", () => {
    const output = JSON.stringify({
      results: [
        {
          citation: {
            title: "String Doc",
            sourceUrl: null,
            connectorType: null,
            documentId: "doc-str",
          },
        },
      ],
    });
    const citations = extractCitations([makeKbPart(output)]);
    expect(citations).toHaveLength(1);
    expect(citations[0].title).toBe("String Doc");
  });

  it("handles malformed output gracefully", () => {
    expect(extractCitations([makeKbPart("not-json")])).toEqual([]);
    expect(extractCitations([makeKbPart(null)])).toEqual([]);
    expect(extractCitations([makeKbPart({})])).toEqual([]);
    expect(extractCitations([makeKbPart({ results: "not-array" })])).toEqual(
      [],
    );
  });

  it("skips results without documentId", () => {
    const output = {
      results: [
        { citation: { title: "No ID" } },
        {
          citation: {
            title: "Has ID",
            documentId: "doc-valid",
            sourceUrl: null,
            connectorType: null,
          },
        },
      ],
    };
    const citations = extractCitations([makeKbPart(output)]);
    expect(citations).toHaveLength(1);
    expect(citations[0].documentId).toBe("doc-valid");
  });

  it("defaults title to 'Untitled' when missing", () => {
    const output = {
      results: [{ citation: { documentId: "doc-no-title", sourceUrl: null } }],
    };
    const citations = extractCitations([makeKbPart(output)]);
    expect(citations).toHaveLength(1);
    expect(citations[0].title).toBe("Untitled");
  });

  it("extracts citations from legacy tool type parts", () => {
    const part = {
      type: "tool-archestra__query_knowledge_base",
      state: "output-available" as const,
      output: {
        results: [
          {
            citation: {
              title: "Legacy Doc",
              sourceUrl: null,
              connectorType: null,
              documentId: "doc-legacy",
            },
          },
        ],
      },
    };
    const citations = extractCitations([part]);
    expect(citations).toHaveLength(1);
    expect(citations[0].documentId).toBe("doc-legacy");
  });

  it("extracts citations from MCP Gateway wrapped tool_result format", () => {
    const innerJson = JSON.stringify({
      results: [
        {
          content: "some content",
          citation: {
            title: "Wrapped Doc",
            sourceUrl: "https://example.com/wrapped",
            connectorType: "jira",
            documentId: "doc-wrapped",
          },
        },
      ],
    });
    const toolResult = `name: archestra__query_knowledge_base\ncontent: "${innerJson.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const output = { tool_result: toolResult };
    const citations = extractCitations([makeKbPart(output)]);
    expect(citations).toHaveLength(1);
    expect(citations[0]).toEqual({
      title: "Wrapped Doc",
      sourceUrl: "https://example.com/wrapped",
      connectorType: "jira",
      documentId: "doc-wrapped",
    });
  });

  it("extracts citations across multiple KB tool parts", () => {
    const part1 = makeKbPart({
      results: [
        {
          citation: {
            title: "Doc A",
            sourceUrl: null,
            connectorType: null,
            documentId: "doc-a",
          },
        },
      ],
    });
    const part2 = makeKbPart({
      results: [
        {
          citation: {
            title: "Doc B",
            sourceUrl: null,
            connectorType: null,
            documentId: "doc-b",
          },
        },
      ],
    });
    const citations = extractCitations([part1, part2]);
    expect(citations).toHaveLength(2);
    expect(citations.map((c) => c.documentId)).toEqual(["doc-a", "doc-b"]);
  });
});
