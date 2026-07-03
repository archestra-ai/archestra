import { describe, expect, it } from "vitest";
import { filterMcpTools } from "./mcp-tool-search";

const tools = [
  { name: "create_pull_request", description: "Create a new pull request" },
  { name: "get_file_contents", description: "Get the contents of a file" },
  { name: "fork_repository" },
];

describe("filterMcpTools", () => {
  it("returns all tools for an empty or whitespace-only query", () => {
    expect(filterMcpTools(tools, "")).toEqual(tools);
    expect(filterMcpTools(tools, "   ")).toEqual(tools);
  });

  it("matches tool names case-insensitively", () => {
    expect(filterMcpTools(tools, "FORK")).toEqual([
      { name: "fork_repository" },
    ]);
  });

  it("matches descriptions too", () => {
    expect(filterMcpTools(tools, "contents of a file")).toEqual([
      { name: "get_file_contents", description: "Get the contents of a file" },
    ]);
  });

  it("trims the query before matching", () => {
    expect(filterMcpTools(tools, "  pull_request ")).toEqual([
      { name: "create_pull_request", description: "Create a new pull request" },
    ]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterMcpTools(tools, "nonexistent")).toEqual([]);
  });
});
