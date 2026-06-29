import {
  ARCHESTRA_MCP_CATALOG_ID,
  DEFAULT_ARCHESTRA_TOOL_NAMES,
} from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  computeMcpEnvConflicts,
  getDefaultArchestraToolIds,
  isCatalogInEnvironment,
  sortAndFilterTools,
  sortCatalogItems,
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

  it("matches branded default tool names under white-labeling", () => {
    const catalogs = [makeCatalog(ARCHESTRA_MCP_CATALOG_ID, "Sparky")];
    const brandedDefaultTools = DEFAULT_ARCHESTRA_TOOL_NAMES.map((name, i) => {
      const toolName = name.replace("archestra__", "sparky__");
      return makeTool(`branded-tool-${i}`, toolName);
    });

    const result = getDefaultArchestraToolIds(catalogs, [brandedDefaultTools]);

    expect(result).not.toBeNull();
    expect(result?.toolIds).toEqual(
      new Set(brandedDefaultTools.map((tool) => tool.id)),
    );
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

  it("ranks name matches ahead of description-only matches within selected tools", () => {
    const tools = [
      tool("1", "server__get_mcp_servers", "Use create_agent here"),
      tool("2", "server__create_agent", "Creates an agent"),
      tool("3", "server__deploy_mcp_server", "Create a deployment"),
    ];
    const selected = new Set(["1", "2"]);

    const result = sortAndFilterTools(tools, selected, "create");

    expect(result.map((t) => t.id)).toEqual(["2", "1", "3"]);
  });
});

describe("sortCatalogItems", () => {
  it("keeps the built-in MCP catalog first even when other catalogs are assigned", () => {
    const catalogs = [
      { id: "github", name: "GitHub" },
      { id: ARCHESTRA_MCP_CATALOG_ID, name: "Sparky" },
      { id: "local", name: "internal-dev-test-server" },
    ];

    const result = sortCatalogItems(
      catalogs,
      (catalog) => (catalog.id === "github" ? 3 : 0),
      (catalog) => (catalog.id === "github" ? 41 : 1),
    );

    expect(result.map((catalog) => catalog.id)).toEqual([
      ARCHESTRA_MCP_CATALOG_ID,
      "github",
      "local",
    ]);
  });

  it("falls back to assigned count and tool count ordering after the built-in catalog", () => {
    const catalogs = [
      { id: ARCHESTRA_MCP_CATALOG_ID, name: "Archestra" },
      { id: "github", name: "GitHub" },
      { id: "empty", name: "Empty" },
      { id: "slack", name: "Slack" },
    ];

    const result = sortCatalogItems(
      catalogs,
      (catalog) => {
        if (catalog.id === "github") return 2;
        if (catalog.id === "slack") return 1;
        return 0;
      },
      (catalog) => {
        if (catalog.id === "github") return 41;
        if (catalog.id === "slack") return 10;
        return 0;
      },
    );

    expect(result.map((catalog) => catalog.id)).toEqual([
      ARCHESTRA_MCP_CATALOG_ID,
      "github",
      "slack",
      "empty",
    ]);
  });
});

describe("isCatalogInEnvironment", () => {
  const env = (environmentId: string | null, serverType = "local") => ({
    id: "c1",
    name: "Cat",
    serverType,
    environmentId,
  });

  it("matches when catalog and agent share an environment id", () => {
    expect(isCatalogInEnvironment(env("env-a"), "env-a")).toBe(true);
    expect(isCatalogInEnvironment(env("env-a"), "env-b")).toBe(false);
  });

  it("treats null (Default runtime) as its own bucket on both sides", () => {
    expect(isCatalogInEnvironment(env(null), null)).toBe(true);
    expect(isCatalogInEnvironment(env(null), "env-a")).toBe(false);
    expect(isCatalogInEnvironment(env("env-a"), null)).toBe(false);
  });

  it("treats missing environmentId as the Default runtime bucket", () => {
    expect(isCatalogInEnvironment({ id: "c1", name: "Cat" }, null)).toBe(true);
    expect(isCatalogInEnvironment({ id: "c1", name: "Cat" }, "env-a")).toBe(
      false,
    );
  });

  it("exempts builtin catalogs from every environment", () => {
    expect(isCatalogInEnvironment(env("env-a", "builtin"), "env-b")).toBe(true);
    expect(isCatalogInEnvironment(env(null, "builtin"), "env-a")).toBe(true);
  });
});

describe("computeMcpEnvConflicts", () => {
  const catalogs = [
    {
      id: "default-mcp",
      name: "Default MCP",
      serverType: "local",
      environmentId: null,
    },
    {
      id: "prod-mcp",
      name: "Prod MCP",
      serverType: "local",
      environmentId: "prod",
    },
    {
      id: "builtin",
      name: "Archestra",
      serverType: "builtin",
      environmentId: null,
    },
  ];

  it("flags selected catalogs not in the agent's environment", () => {
    const conflicts = computeMcpEnvConflicts(
      catalogs,
      ["default-mcp", "prod-mcp", "builtin"],
      "prod",
    );
    expect(conflicts).toEqual([
      { catalogId: "default-mcp", name: "Default MCP" },
    ]);
  });

  it("never flags builtin catalogs", () => {
    const conflicts = computeMcpEnvConflicts(catalogs, ["builtin"], "prod");
    expect(conflicts).toEqual([]);
  });

  it("returns no conflicts when everything matches the Default runtime", () => {
    const conflicts = computeMcpEnvConflicts(
      catalogs,
      ["default-mcp", "builtin"],
      null,
    );
    expect(conflicts).toEqual([]);
  });

  it("skips unknown catalog ids", () => {
    const conflicts = computeMcpEnvConflicts(catalogs, ["ghost"], "prod");
    expect(conflicts).toEqual([]);
  });
});
