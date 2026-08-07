import {
  APP_ARCHESTRA_TOOL_SHORT_NAMES,
  ARCHESTRA_MCP_CATALOG_ID,
  DEFAULT_ARCHESTRA_TOOL_NAMES,
  DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES,
  getCreationDefaultArchestraToolShortNames,
  PLAYWRIGHT_MCP_CATALOG_ID,
  PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAMES,
  SANDBOX_RUNTIME_ARCHESTRA_TOOL_SHORT_NAMES,
  SKILL_ARCHESTRA_TOOL_SHORT_NAMES,
} from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  buildBulkToolUpdate,
  computeMcpEnvConflicts,
  computeSharedPersonalPins,
  filterDefaultArchestraToolIds,
  getCatalogAssignmentGate,
  getDefaultArchestraToolIds,
  isCatalogInAppEnvironment,
  isCatalogInEnvironment,
  setsEqual,
  shouldResetCredentialPin,
  sortAndFilterTools,
  sortCatalogItems,
  summarizeBulkFailure,
} from "./agent-tools-editor.utils";
import { DYNAMIC_CREDENTIAL_VALUE } from "./token-select";

const OTHER_CATALOG_ID = "other-catalog-id";

describe("getCatalogAssignmentGate", () => {
  // Install state does not gate assignment: a catalog item with discovered
  // tools but no install the caller can resolve stays assignable (as a dynamic
  // assignment) and is surfaced as unavailable.
  it("keeps a catalog with discovered tools but no resolvable install assignable", () => {
    const gate = getCatalogAssignmentGate({
      hasDiscoveredTools: true,
      hasResolvableInstall: false,
      isEnvIncompatible: false,
    });

    expect(gate.disabled).toBe(false);
    expect(gate.disabledReason).toBeUndefined();
    expect(gate.unavailable).toBe(true);
  });

  it("keeps a fully-installed catalog assignable and available", () => {
    const gate = getCatalogAssignmentGate({
      hasDiscoveredTools: true,
      hasResolvableInstall: true,
      isEnvIncompatible: false,
    });

    expect(gate.disabled).toBe(false);
    expect(gate.unavailable).toBe(false);
  });

  it("refuses a catalog with no discovered tool — nothing to assign", () => {
    const gate = getCatalogAssignmentGate({
      hasDiscoveredTools: false,
      hasResolvableInstall: true,
      isEnvIncompatible: false,
    });

    expect(gate.disabled).toBe(true);
    expect(gate.disabledReason).toBe("Not installed");
    expect(gate.unavailable).toBe(false);
  });

  it("refuses an environment-incompatible catalog with a named-environment reason", () => {
    const gate = getCatalogAssignmentGate({
      hasDiscoveredTools: true,
      hasResolvableInstall: false,
      isEnvIncompatible: true,
      environmentName: "Staging",
    });

    expect(gate.disabled).toBe(true);
    expect(gate.disabledReason).toBe('Not in the "Staging" environment');
  });

  it("refuses an environment-incompatible catalog in the Default environment", () => {
    const gate = getCatalogAssignmentGate({
      hasDiscoveredTools: true,
      hasResolvableInstall: true,
      isEnvIncompatible: true,
    });

    expect(gate.disabled).toBe(true);
    expect(gate.disabledReason).toBe("Not in the Default environment");
  });

  it("refuses a disabled app with a 'Disabled' reason", () => {
    const gate = getCatalogAssignmentGate({
      hasDiscoveredTools: true,
      hasResolvableInstall: true,
      isEnvIncompatible: false,
      isDisabledApp: true,
    });

    expect(gate.disabled).toBe(true);
    expect(gate.disabledReason).toBe("Disabled");
    expect(gate.unavailable).toBe(false);
  });

  it("gates on disabled status before environment incompatibility", () => {
    const gate = getCatalogAssignmentGate({
      hasDiscoveredTools: true,
      hasResolvableInstall: true,
      isEnvIncompatible: true,
      environmentName: "Staging",
      isDisabledApp: true,
    });

    expect(gate.disabledReason).toBe("Disabled");
  });
});

describe("shouldResetCredentialPin", () => {
  const base = {
    credentialsLoaded: true,
    selectionIsDynamic: false,
    pinnedServerId: "srv-1",
    resolvableServerIds: ["srv-2", "srv-3"],
  };

  it("resets a stale pin absent from a non-empty resolvable set", () => {
    expect(shouldResetCredentialPin(base)).toBe(true);
  });

  // Regression: an assignment persists independently of install state. When no
  // connection resolves for the caller, preserve the pin instead of coercing it
  // to dynamic — coercing would silently rewrite the pin on the next save.
  it("preserves the pin when no connection resolves for the caller", () => {
    expect(shouldResetCredentialPin({ ...base, resolvableServerIds: [] })).toBe(
      false,
    );
  });

  it("keeps a pin that still resolves", () => {
    expect(shouldResetCredentialPin({ ...base, pinnedServerId: "srv-2" })).toBe(
      false,
    );
  });

  it("does nothing for a dynamic selection", () => {
    expect(
      shouldResetCredentialPin({
        ...base,
        selectionIsDynamic: true,
        pinnedServerId: null,
      }),
    ).toBe(false);
  });

  it("waits until credentials have loaded", () => {
    expect(
      shouldResetCredentialPin({ ...base, credentialsLoaded: false }),
    ).toBe(false);
  });
});

function makeCatalog(id: string, name: string) {
  return { id, name };
}

function makeTool(id: string, name: string) {
  return { id, name };
}

describe("filterDefaultArchestraToolIds", () => {
  const defaultTools = DEFAULT_ARCHESTRA_TOOL_NAMES.map((name, i) =>
    makeTool(`tool-${i}`, name),
  );

  it("returns only the default-short-named tool IDs from a mixed list", () => {
    const tools = [...defaultTools, makeTool("extra", "archestra__some_tool")];

    const result = filterDefaultArchestraToolIds(tools);

    expect(result).toEqual(new Set(defaultTools.map((t) => t.id)));
    expect(result.has("extra")).toBe(false);
  });

  // The child pill's selectDefaults backstop keys off an EMPTY set (not null)
  // to decide whether to fall back to all tools, so this contract matters.
  it("returns an empty set when nothing matches", () => {
    const tools = [
      makeTool("a", "archestra__unrelated_tool"),
      makeTool("b", "archestra__another_tool"),
    ];

    expect(filterDefaultArchestraToolIds(tools)).toEqual(new Set());
  });

  it("returns an empty set for an empty tool list", () => {
    expect(filterDefaultArchestraToolIds([])).toEqual(new Set());
  });

  it("composes the set from the feature flags", () => {
    const groupShortNames = [
      ...DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES,
      ...SKILL_ARCHESTRA_TOOL_SHORT_NAMES,
      ...APP_ARCHESTRA_TOOL_SHORT_NAMES,
      ...SANDBOX_RUNTIME_ARCHESTRA_TOOL_SHORT_NAMES,
      ...PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAMES,
    ];
    const tools = groupShortNames.map((shortName) =>
      makeTool(`tool-${shortName}`, `archestra__${shortName}`),
    );
    const flags = { skillsEnabled: true, sandboxEnabled: true };

    const result = filterDefaultArchestraToolIds(tools, flags);

    expect(result).toEqual(
      new Set(
        getCreationDefaultArchestraToolShortNames(flags).map(
          (shortName) => `tool-${shortName}`,
        ),
      ),
    );
  });
});

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

  describe("feature-flag composition (shared composer)", () => {
    const catalogs = [makeCatalog(ARCHESTRA_MCP_CATALOG_ID, "Archestra")];
    // One catalog tool per short name across every composable group, so the
    // expected pre-selection can be derived from the composer output.
    const groupShortNames = [
      ...DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES,
      ...SKILL_ARCHESTRA_TOOL_SHORT_NAMES,
      ...APP_ARCHESTRA_TOOL_SHORT_NAMES,
      ...SANDBOX_RUNTIME_ARCHESTRA_TOOL_SHORT_NAMES,
      ...PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAMES,
    ];
    const allGroupTools = groupShortNames.map((shortName) =>
      makeTool(`tool-${shortName}`, `archestra__${shortName}`),
    );

    function idsForShortNames(shortNames: readonly string[]): Set<string> {
      return new Set(shortNames.map((shortName) => `tool-${shortName}`));
    }

    it("pre-selects the defaults and app tools when every flag is off", () => {
      const result = getDefaultArchestraToolIds(catalogs, [allGroupTools], {});

      expect(result?.toolIds).toEqual(
        idsForShortNames([
          ...DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES,
          ...APP_ARCHESTRA_TOOL_SHORT_NAMES,
        ]),
      );
    });

    it("adds the skill tools when skillsEnabled", () => {
      const result = getDefaultArchestraToolIds(catalogs, [allGroupTools], {
        skillsEnabled: true,
      });

      expect(result?.toolIds).toEqual(
        idsForShortNames([
          ...DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES,
          ...SKILL_ARCHESTRA_TOOL_SHORT_NAMES,
          ...APP_ARCHESTRA_TOOL_SHORT_NAMES,
        ]),
      );
    });

    it("adds the sandbox runtime and persistent-files tools when sandboxEnabled", () => {
      const result = getDefaultArchestraToolIds(catalogs, [allGroupTools], {
        sandboxEnabled: true,
      });

      expect(result?.toolIds).toEqual(
        idsForShortNames([
          ...DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES,
          ...APP_ARCHESTRA_TOOL_SHORT_NAMES,
          ...SANDBOX_RUNTIME_ARCHESTRA_TOOL_SHORT_NAMES,
          ...PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAMES,
        ]),
      );
    });

    it("pre-selects exactly the shared composer output with every flag on", () => {
      const flags = {
        skillsEnabled: true,
        sandboxEnabled: true,
      };

      const result = getDefaultArchestraToolIds(
        catalogs,
        [allGroupTools],
        flags,
      );

      expect(result?.toolIds).toEqual(
        idsForShortNames(getCreationDefaultArchestraToolShortNames(flags)),
      );
    });

    it("matches branded group tool names under white-labeling", () => {
      const brandedTools = groupShortNames.map((shortName) =>
        makeTool(`tool-${shortName}`, `sparky__${shortName}`),
      );

      const result = getDefaultArchestraToolIds(
        [makeCatalog(ARCHESTRA_MCP_CATALOG_ID, "Sparky")],
        [brandedTools],
        { skillsEnabled: true },
      );

      expect(result?.toolIds).toEqual(
        idsForShortNames([
          ...DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES,
          ...SKILL_ARCHESTRA_TOOL_SHORT_NAMES,
          ...APP_ARCHESTRA_TOOL_SHORT_NAMES,
        ]),
      );
    });
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

describe("isCatalogInAppEnvironment", () => {
  const env = (environmentId: string | null, serverType = "local") => ({
    id: "c1",
    name: "Cat",
    serverType,
    environmentId,
  });

  it("accepts the app's own environment and the Default baseline", () => {
    expect(isCatalogInAppEnvironment(env("env-a"), "env-a")).toBe(true);
    expect(isCatalogInAppEnvironment(env(null), "env-a")).toBe(true);
    expect(isCatalogInAppEnvironment(env(null), null)).toBe(true);
  });

  it("still rejects a different non-default environment", () => {
    expect(isCatalogInAppEnvironment(env("env-a"), "env-b")).toBe(false);
    expect(isCatalogInAppEnvironment(env("env-a"), null)).toBe(false);
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

describe("computeSharedPersonalPins", () => {
  const personal = {
    id: "srv-personal",
    scope: "personal",
    ownerId: "user-1",
    ownerEmail: "owner@example.com",
    catalogName: "GitHub",
    name: "github-personal",
  };
  const team = {
    id: "srv-team",
    scope: "team",
    ownerId: "user-2",
    ownerEmail: "team-owner@example.com",
    catalogName: "Jira",
    name: "jira-team",
  };

  it("flags a static pin to a resolvable personal connection", () => {
    const pins = computeSharedPersonalPins(
      [
        {
          catalogId: "cat-a",
          pinnedServerId: "srv-personal",
          resolvableServers: [personal],
        },
      ],
      "user-2",
    );
    expect(pins).toEqual([
      {
        catalogId: "cat-a",
        mcpName: "GitHub",
        ownerEmail: "owner@example.com",
        isCurrentUser: false,
      },
    ]);
  });

  it("marks the current user's own connection", () => {
    const pins = computeSharedPersonalPins(
      [
        {
          catalogId: "cat-a",
          pinnedServerId: "srv-personal",
          resolvableServers: [personal],
        },
      ],
      "user-1",
    );
    expect(pins[0]?.isCurrentUser).toBe(true);
  });

  it("ignores a pin whose server is no longer resolvable (already reset / out of group)", () => {
    const pins = computeSharedPersonalPins(
      [
        {
          catalogId: "cat-a",
          pinnedServerId: "srv-personal",
          resolvableServers: [team],
        },
      ],
      "user-1",
    );
    expect(pins).toEqual([]);
  });

  it("ignores team- and org-scoped pins (shared by design)", () => {
    const pins = computeSharedPersonalPins(
      [
        {
          catalogId: "cat-a",
          pinnedServerId: "srv-team",
          resolvableServers: [team],
        },
      ],
      "user-1",
    );
    expect(pins).toEqual([]);
  });

  it("ignores catalogs that resolve at call time (no pin)", () => {
    const pins = computeSharedPersonalPins(
      [
        {
          catalogId: "cat-a",
          pinnedServerId: null,
          resolvableServers: [personal],
        },
      ],
      "user-1",
    );
    expect(pins).toEqual([]);
  });

  it("falls back to the raw name and a placeholder owner", () => {
    const pins = computeSharedPersonalPins(
      [
        {
          catalogId: "cat-a",
          pinnedServerId: "srv-x",
          resolvableServers: [
            {
              id: "srv-x",
              scope: "personal",
              ownerId: null,
              ownerEmail: null,
              catalogName: null,
              name: "raw-name",
            },
          ],
        },
      ],
      "user-1",
    );
    expect(pins).toEqual([
      {
        catalogId: "cat-a",
        mcpName: "raw-name",
        ownerEmail: "Deleted user",
        isCurrentUser: false,
      },
    ]);
  });
});

describe("setsEqual", () => {
  it("treats sets with the same members as equal regardless of order", () => {
    expect(setsEqual(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
    expect(setsEqual(new Set(), new Set())).toBe(true);
  });

  it("detects differing members and differing sizes", () => {
    expect(setsEqual(new Set(["a", "b"]), new Set(["a", "c"]))).toBe(false);
    expect(setsEqual(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
  });
});

describe("buildBulkToolUpdate", () => {
  const AGENT = "agent-1";

  const pending = (
    catalogId: string,
    selected: string[],
    credentialSourceId: string | null,
    catalogItem: {
      serverType?: string | null;
      enterpriseManagedConfig?: unknown;
      id?: string;
    } = {},
  ) =>
    [
      catalogId,
      {
        selectedToolIds: new Set(selected),
        credentialSourceId,
        catalogItem: {
          id: catalogItem.id ?? catalogId,
          serverType: catalogItem.serverType ?? "remote",
          enterpriseManagedConfig: catalogItem.enterpriseManagedConfig,
        },
      },
    ] as const;

  const assigned = (
    toolId: string,
    mcpServerId: string | null,
    credentialResolutionMode:
      | "static"
      | "dynamic"
      | "enterprise_managed" = "static",
  ) => ({ tool: { id: toolId }, mcpServerId, credentialResolutionMode });

  it("folds edits across catalogs into one assignments/removals pair", () => {
    const result = buildBulkToolUpdate({
      targetAgentId: AGENT,
      pendingChanges: [
        pending("cat-a", ["t1", "t2"], "srv-a"),
        pending("cat-b", ["t4"], "srv-b"),
      ],
      assignedToolsByCatalog: new Map([
        ["cat-a", [assigned("t1", "srv-a"), assigned("t3", "srv-a")]],
        ["cat-b", [assigned("t5", "srv-b")]],
      ]),
      isNewAgent: false,
    });

    // One flat pair for the whole editor, not one request per catalog or tool.
    expect(result.assignments).toEqual([
      {
        agentId: AGENT,
        toolId: "t2",
        mcpServerId: "srv-a",
        resolveAtCallTime: false,
        credentialResolutionMode: "static",
      },
      {
        agentId: AGENT,
        toolId: "t4",
        mcpServerId: "srv-b",
        resolveAtCallTime: false,
        credentialResolutionMode: "static",
      },
    ]);
    expect(result.removals).toEqual([
      { agentId: AGENT, toolId: "t3" },
      { agentId: AGENT, toolId: "t5" },
    ]);
    expect(result.hasChanges).toBe(true);
  });

  it("diffs a new agent's built-in catalog against the creation defaults", () => {
    const result = buildBulkToolUpdate({
      targetAgentId: AGENT,
      pendingChanges: [
        pending(ARCHESTRA_MCP_CATALOG_ID, ["d1"], null, {
          serverType: "builtin",
        }),
      ],
      assignedToolsByCatalog: new Map(),
      isNewAgent: true,
      creationDefaultToolIds: ["d1", "d2"],
    });

    // d2 was unchecked, so it needs a real unassign; d1 was left checked and the
    // backend already assigned it, so re-assigning it would be redundant.
    expect(result.removals).toEqual([{ agentId: AGENT, toolId: "d2" }]);
    expect(result.assignments).toEqual([]);
    expect(result.hasChanges).toBe(true);
  });

  it("ignores the creation defaults when editing an existing agent", () => {
    const result = buildBulkToolUpdate({
      targetAgentId: AGENT,
      pendingChanges: [
        pending(ARCHESTRA_MCP_CATALOG_ID, ["d1"], null, {
          serverType: "builtin",
        }),
      ],
      assignedToolsByCatalog: new Map(),
      isNewAgent: false,
      creationDefaultToolIds: ["d1", "d2"],
    });

    expect(result.removals).toEqual([]);
    expect(result.assignments).toEqual([
      {
        agentId: AGENT,
        toolId: "d1",
        mcpServerId: null,
        resolveAtCallTime: false,
        credentialResolutionMode: "static",
      },
    ]);
  });

  it("re-assigns a kept tool whose credential changed", () => {
    const result = buildBulkToolUpdate({
      targetAgentId: AGENT,
      pendingChanges: [pending("cat-a", ["t1"], "srv-new")],
      assignedToolsByCatalog: new Map([["cat-a", [assigned("t1", "srv-old")]]]),
      isNewAgent: false,
    });

    expect(result.assignments).toEqual([
      {
        agentId: AGENT,
        toolId: "t1",
        mcpServerId: "srv-new",
        resolveAtCallTime: false,
        credentialResolutionMode: "static",
      },
    ]);
    expect(result.removals).toEqual([]);
    expect(result.hasChanges).toBe(true);
  });

  it("leaves a kept tool alone when its credential is unchanged", () => {
    const result = buildBulkToolUpdate({
      targetAgentId: AGENT,
      pendingChanges: [
        pending("cat-a", ["t1"], DYNAMIC_CREDENTIAL_VALUE),
        pending("cat-b", ["t2"], "srv-b"),
      ],
      assignedToolsByCatalog: new Map([
        ["cat-a", [assigned("t1", null, "dynamic")]],
        ["cat-b", [assigned("t2", "srv-b")]],
      ]),
      isNewAgent: false,
    });

    expect(result).toEqual({
      assignments: [],
      removals: [],
      hasChanges: false,
    });
  });

  it.each([
    ["an app", { serverType: "app" }, "cat-app"],
    ["the Playwright catalog", {}, PLAYWRIGHT_MCP_CATALOG_ID],
    ["an explicit dynamic selection", {}, "cat-dyn"],
  ])("binds %s dynamically and clears any pinned server", (_label, item, id) => {
    const result = buildBulkToolUpdate({
      targetAgentId: AGENT,
      pendingChanges: [
        // A stale pin is carried in for the first two: a late-bound mode must
        // clear it rather than carry it over.
        pending(
          id,
          ["t1"],
          id === "cat-dyn" ? DYNAMIC_CREDENTIAL_VALUE : "srv-stale",
          item,
        ),
      ],
      assignedToolsByCatalog: new Map(),
      isNewAgent: false,
    });

    expect(result.assignments).toEqual([
      {
        agentId: AGENT,
        toolId: "t1",
        mcpServerId: null,
        resolveAtCallTime: true,
        credentialResolutionMode: "dynamic",
      },
    ]);
  });

  it("uses the enterprise-managed mode only when the binding is dynamic", () => {
    const enterprise = { enterpriseManagedConfig: { some: "config" } };

    const dynamic = buildBulkToolUpdate({
      targetAgentId: AGENT,
      pendingChanges: [
        pending("cat-e", ["t1"], DYNAMIC_CREDENTIAL_VALUE, enterprise),
      ],
      assignedToolsByCatalog: new Map(),
      isNewAgent: false,
    });
    expect(dynamic.assignments).toEqual([
      {
        agentId: AGENT,
        toolId: "t1",
        mcpServerId: null,
        resolveAtCallTime: true,
        credentialResolutionMode: "enterprise_managed",
      },
    ]);

    // Same catalog, but the user pinned a server — the explicit pin wins.
    const pinned = buildBulkToolUpdate({
      targetAgentId: AGENT,
      pendingChanges: [pending("cat-e", ["t1"], "srv-a", enterprise)],
      assignedToolsByCatalog: new Map(),
      isNewAgent: false,
    });
    expect(pinned.assignments).toEqual([
      {
        agentId: AGENT,
        toolId: "t1",
        mcpServerId: "srv-a",
        resolveAtCallTime: false,
        credentialResolutionMode: "static",
      },
    ]);
  });

  it("reports no changes when nothing is pending", () => {
    expect(
      buildBulkToolUpdate({
        targetAgentId: AGENT,
        pendingChanges: [],
        assignedToolsByCatalog: new Map([["cat-a", [assigned("t1", "srv-a")]]]),
        isNewAgent: false,
      }),
    ).toEqual({ assignments: [], removals: [], hasChanges: false });
  });
});

describe("summarizeBulkFailure", () => {
  // The regression guard: a response carrying only `notAssigned`/`duplicates`
  // has an empty `failed`, and must not read as an error. On the create path
  // agent-dialog reacts to a throw by deleting the agent it just created.
  it("returns undefined when nothing failed", () => {
    expect(summarizeBulkFailure(undefined)).toBeUndefined();
    expect(summarizeBulkFailure([])).toBeUndefined();
  });

  it("returns a single failure's message verbatim", () => {
    expect(summarizeBulkFailure([{ error: "Tool not found" }])).toBe(
      "Tool not found",
    );
  });

  it("reports the first failure and counts the rest", () => {
    expect(
      summarizeBulkFailure([
        { error: "Tool not found" },
        { error: "Agent not found" },
        { error: "Server unreachable" },
      ]),
    ).toBe("Tool not found (and 2 more)");
  });
});
