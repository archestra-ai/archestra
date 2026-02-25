import {
  ARCHESTRA_MCP_CATALOG_ID,
  DEFAULT_ARCHESTRA_TOOL_NAMES,
} from "@shared";
import { describe, expect, it } from "vitest";
import {
  getDefaultArchestraToolIds,
  sortAndFilterTools,
} from "./agent-tools-editor.utils";

const OTHER_CATALOG_ID = "other-catalog-id";

function makeCatalog(id: string, name: string) {
  return { id, name };
}

function makeTool(id: string, name: string) {
  return { id, name };
}

describe("getDefaultArchestraToolIds", () => {
  const defaultTools = DEFAULT_ARCHESTRA_TOOL_NAMES.map((name, i) =>
    makeTool(`tool-${i}`, name),
  );

  it("returns correct tool IDs when Archestra catalog and default tools are present", () => {
    const catalogs = [
      makeCatalog(OTHER_CATALOG_ID, "Other"),
      makeCatalog(ARCHESTRA_MCP_CATALOG_ID, "Archestra"),
    ];
    const toolsByCatalog = [[makeTool("x", "some_tool")], defaultTools];

    const result = getDefaultArchestraToolIds(catalogs, toolsByCatalog);

    expect(result).not.toBeNull();
    expect(result?.toolIds).toEqual(new Set(defaultTools.map((t) => t.id)));
  });

  it("returns correct catalogIndex", () => {
    const catalogs = [
      makeCatalog(OTHER_CATALOG_ID, "Other"),
      makeCatalog(ARCHESTRA_MCP_CATALOG_ID, "Archestra"),
    ];
    const toolsByCatalog = [undefined, defaultTools];

    const result = getDefaultArchestraToolIds(catalogs, toolsByCatalog);

    expect(result).not.toBeNull();
    expect(result?.catalogIndex).toBe(1);
  });

  it("returns null when Archestra catalog is not in the list", () => {
    const catalogs = [makeCatalog(OTHER_CATALOG_ID, "Other")];
    const toolsByCatalog = [[makeTool("x", "some_tool")]];

    expect(getDefaultArchestraToolIds(catalogs, toolsByCatalog)).toBeNull();
  });

  it("returns null when tools array for Archestra catalog is undefined", () => {
    const catalogs = [makeCatalog(ARCHESTRA_MCP_CATALOG_ID, "Archestra")];
    const toolsByCatalog = [undefined];

    expect(getDefaultArchestraToolIds(catalogs, toolsByCatalog)).toBeNull();
  });

  it("returns null when tools array is empty", () => {
    const catalogs = [makeCatalog(ARCHESTRA_MCP_CATALOG_ID, "Archestra")];
    const toolsByCatalog: { id: string; name: string }[][] = [[]];

    expect(getDefaultArchestraToolIds(catalogs, toolsByCatalog)).toBeNull();
  });

  it("returns null when no tools match DEFAULT_ARCHESTRA_TOOL_NAMES", () => {
    const catalogs = [makeCatalog(ARCHESTRA_MCP_CATALOG_ID, "Archestra")];
    const toolsByCatalog = [
      [makeTool("a", "unrelated_tool"), makeTool("b", "another_tool")],
    ];

    expect(getDefaultArchestraToolIds(catalogs, toolsByCatalog)).toBeNull();
  });

  it("ignores non-default tools and only returns matching ones", () => {
    const catalogs = [makeCatalog(ARCHESTRA_MCP_CATALOG_ID, "Archestra")];
    const extraTool = makeTool("extra", "unrelated_tool");
    const toolsByCatalog = [[...defaultTools, extraTool]];

    const result = getDefaultArchestraToolIds(catalogs, toolsByCatalog);

    expect(result).not.toBeNull();
    expect(result?.toolIds.has("extra")).toBe(false);
    expect(result?.toolIds.size).toBe(defaultTools.length);
  });
});

describe("sortAndFilterTools", () => {
  function tool(id: string, name: string, description: string | null = null) {
    return { id, name, description };
  }

  it("sorts selected tools before unselected tools", () => {
    const tools = [
      tool("1", "server__alpha"),
      tool("2", "server__beta"),
      tool("3", "server__gamma"),
    ];
    const selected = new Set(["3"]);

    const result = sortAndFilterTools(tools, selected, "");

    expect(result.map((t) => t.id)).toEqual(["3", "1", "2"]);
  });

  it("preserves relative order within selected and unselected groups", () => {
    const tools = [
      tool("1", "server__a"),
      tool("2", "server__b"),
      tool("3", "server__c"),
      tool("4", "server__d"),
    ];
    const selected = new Set(["4", "2"]);

    const result = sortAndFilterTools(tools, selected, "");

    expect(result.map((t) => t.id)).toEqual(["2", "4", "1", "3"]);
  });

  it("filters tools by formatted name (strips server prefix)", () => {
    const tools = [tool("1", "server__alpha"), tool("2", "server__beta")];

    const result = sortAndFilterTools(tools, new Set(), "alpha");

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("1");
  });

  it("filters tools by description", () => {
    const tools = [
      tool("1", "server__alpha", "Handles payments"),
      tool("2", "server__beta", "Sends emails"),
    ];

    const result = sortAndFilterTools(tools, new Set(), "payment");

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("1");
  });

  it("is case insensitive when filtering", () => {
    const tools = [tool("1", "server__MyTool", "UPPERCASE DESC")];

    expect(sortAndFilterTools(tools, new Set(), "mytool")).toHaveLength(1);
    expect(sortAndFilterTools(tools, new Set(), "uppercase")).toHaveLength(1);
  });

  it("returns all tools sorted when search query is empty", () => {
    const tools = [tool("1", "a"), tool("2", "b"), tool("3", "c")];
    const selected = new Set(["2"]);

    const result = sortAndFilterTools(tools, selected, "");

    expect(result).toHaveLength(3);
    expect(result[0]?.id).toBe("2");
  });

  it("returns empty array when no tools match search", () => {
    const tools = [tool("1", "server__alpha")];

    expect(sortAndFilterTools(tools, new Set(), "nonexistent")).toHaveLength(0);
  });

  it("applies both filtering and sorting together", () => {
    const tools = [
      tool("1", "server__alpha_one"),
      tool("2", "server__alpha_two"),
      tool("3", "server__beta"),
    ];
    const selected = new Set(["2"]);

    const result = sortAndFilterTools(tools, selected, "alpha");

    expect(result.map((t) => t.id)).toEqual(["2", "1"]);
  });
});
