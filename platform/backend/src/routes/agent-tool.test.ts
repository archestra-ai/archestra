import { validateAssignment } from "@/services/agent-tool-assignment";
import { describe, expect, test } from "@/test";
import type { InternalMcpCatalog, Tool } from "@/types";

/**
 * Build a minimal Tool object for test maps.
 * Only the fields checked by validateAssignment are set; the rest use defaults.
 */
function fakeTool(overrides: { id: string; catalogId?: string | null }): Tool {
  return {
    id: overrides.id,
    catalogId: overrides.catalogId ?? null,
    name: "test-tool",
    description: null,
    parameters: undefined,
    agentId: null,
    delegateToAgentId: null,
    meta: null,
    policiesAutoConfiguredAt: null,
    policiesAutoConfiguringStartedAt: null,
    policiesAutoConfiguredReasoning: null,
    policiesAutoConfiguredModel: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies Tool;
}

/**
 * Build a minimal InternalMcpCatalog for test maps.
 */
function fakeCatalog(overrides: {
  id: string;
  serverType: "local" | "remote";
}): InternalMcpCatalog {
  return {
    id: overrides.id,
    serverType: overrides.serverType,
  } as InternalMcpCatalog;
}

function emptyPreFetchedData() {
  return {
    existingAgentIds: new Set<string>(),
    toolsMap: new Map<string, Tool>(),
    catalogItemsMap: new Map<string, InternalMcpCatalog>(),
    mcpServersBasicMap: new Map<
      string,
      { id: string; ownerId: string | null; catalogId: string | null }
    >(),
  };
}

describe("validateAssignment", () => {
  test("returns null for a valid assignment with no catalog", async () => {
    const agentId = "agent-1";
    const tool = fakeTool({ id: "tool-1" });

    const data = {
      ...emptyPreFetchedData(),
      existingAgentIds: new Set([agentId]),
      toolsMap: new Map([[tool.id, tool]]),
    };

    const result = await validateAssignment({
      agentId,
      toolId: tool.id,
      credentialSourceMcpServerId: null,
      executionSourceMcpServerId: null,
      preFetchedData: data,
    });
    expect(result).toBeNull();
  });

  test("returns 404 when agent does not exist", async () => {
    const tool = fakeTool({ id: "tool-1" });

    const data = {
      ...emptyPreFetchedData(),
      toolsMap: new Map([[tool.id, tool]]),
    };

    const result = await validateAssignment({
      agentId: "missing-agent",
      toolId: tool.id,
      credentialSourceMcpServerId: null,
      executionSourceMcpServerId: null,
      preFetchedData: data,
    });
    expect(result).not.toBeNull();
    expect(result?.code).toBe("not_found");
    expect(result?.error.type).toBe("not_found");
    expect(result?.error.message).toContain("missing-agent");
  });

  test("returns 404 when tool does not exist", async () => {
    const data = {
      ...emptyPreFetchedData(),
      existingAgentIds: new Set(["agent-1"]),
    };

    const result = await validateAssignment({
      agentId: "agent-1",
      toolId: "missing-tool",
      credentialSourceMcpServerId: null,
      executionSourceMcpServerId: null,
      preFetchedData: data,
    });
    expect(result).not.toBeNull();
    expect(result?.code).toBe("not_found");
    expect(result?.error.type).toBe("not_found");
    expect(result?.error.message).toContain("missing-tool");
  });

  test("returns 400 for local server tool without execution source or dynamic credential", async () => {
    const catalogId = "catalog-local";
    const tool = fakeTool({ id: "tool-1", catalogId });
    const catalog = fakeCatalog({ id: catalogId, serverType: "local" });

    const data = {
      ...emptyPreFetchedData(),
      existingAgentIds: new Set(["agent-1"]),
      toolsMap: new Map([[tool.id, tool]]),
      catalogItemsMap: new Map([[catalogId, catalog]]),
    };

    const result = await validateAssignment({
      agentId: "agent-1",
      toolId: tool.id,
      credentialSourceMcpServerId: null,
      executionSourceMcpServerId: null,
      preFetchedData: data,
    });
    expect(result).not.toBeNull();
    expect(result?.code).toBe("validation_error");
    expect(result?.error.message).toContain("Execution source");
  });

  test("allows local server tool with executionSourceMcpServerId", async ({
    makeAgent,
    makeTool,
    makeMcpServer,
    makeInternalMcpCatalog,
  }) => {
    const catalogItem = await makeInternalMcpCatalog({
      serverType: "local",
    });
    const agent = await makeAgent();
    const tool = await makeTool({ catalogId: catalogItem.id });
    const server = await makeMcpServer({ catalogId: catalogItem.id });

    const data = {
      existingAgentIds: new Set([agent.id]),
      toolsMap: new Map([[tool.id, tool]]),
      catalogItemsMap: new Map([[catalogItem.id, catalogItem]]),
      mcpServersBasicMap: new Map([
        [
          server.id,
          { id: server.id, ownerId: null, catalogId: catalogItem.id },
        ],
      ]),
    };

    const result = await validateAssignment({
      agentId: agent.id,
      toolId: tool.id,
      credentialSourceMcpServerId: null,
      executionSourceMcpServerId: server.id,
      preFetchedData: data,
    });
    expect(result).toBeNull();
  });

  test("allows local server tool with useDynamicTeamCredential", async () => {
    const catalogId = "catalog-local";
    const tool = fakeTool({ id: "tool-1", catalogId });
    const catalog = fakeCatalog({ id: catalogId, serverType: "local" });

    const data = {
      ...emptyPreFetchedData(),
      existingAgentIds: new Set(["agent-1"]),
      toolsMap: new Map([[tool.id, tool]]),
      catalogItemsMap: new Map([[catalogId, catalog]]),
    };

    const result = await validateAssignment({
      agentId: "agent-1",
      toolId: tool.id,
      credentialSourceMcpServerId: null,
      executionSourceMcpServerId: null,
      preFetchedData: data,
      useDynamicTeamCredential: true,
    });
    expect(result).toBeNull();
  });

  test("returns 400 for remote server tool without credential source or dynamic credential", async () => {
    const catalogId = "catalog-remote";
    const tool = fakeTool({ id: "tool-1", catalogId });
    const catalog = fakeCatalog({ id: catalogId, serverType: "remote" });

    const data = {
      ...emptyPreFetchedData(),
      existingAgentIds: new Set(["agent-1"]),
      toolsMap: new Map([[tool.id, tool]]),
      catalogItemsMap: new Map([[catalogId, catalog]]),
    };

    const result = await validateAssignment({
      agentId: "agent-1",
      toolId: tool.id,
      credentialSourceMcpServerId: null,
      executionSourceMcpServerId: null,
      preFetchedData: data,
    });
    expect(result).not.toBeNull();
    expect(result?.code).toBe("validation_error");
    expect(result?.error.message).toContain("Credential source");
  });

  test("allows remote server tool with useDynamicTeamCredential", async () => {
    const catalogId = "catalog-remote";
    const tool = fakeTool({ id: "tool-1", catalogId });
    const catalog = fakeCatalog({ id: catalogId, serverType: "remote" });

    const data = {
      ...emptyPreFetchedData(),
      existingAgentIds: new Set(["agent-1"]),
      toolsMap: new Map([[tool.id, tool]]),
      catalogItemsMap: new Map([[catalogId, catalog]]),
    };

    const result = await validateAssignment({
      agentId: "agent-1",
      toolId: tool.id,
      credentialSourceMcpServerId: null,
      executionSourceMcpServerId: null,
      preFetchedData: data,
      useDynamicTeamCredential: true,
    });
    expect(result).toBeNull();
  });

  test("passes validation for tool with no catalogId (sniffed tool)", async () => {
    const tool = fakeTool({ id: "tool-1", catalogId: null });

    const data = {
      ...emptyPreFetchedData(),
      existingAgentIds: new Set(["agent-1"]),
      toolsMap: new Map([[tool.id, tool]]),
    };

    const result = await validateAssignment({
      agentId: "agent-1",
      toolId: tool.id,
      credentialSourceMcpServerId: null,
      executionSourceMcpServerId: null,
      preFetchedData: data,
    });
    expect(result).toBeNull();
  });

  test("passes validation when catalogId exists but catalog not in map", async () => {
    // catalogId set but catalog not found in pre-fetched map — no server type check
    const tool = fakeTool({ id: "tool-1", catalogId: "missing-catalog" });

    const data = {
      ...emptyPreFetchedData(),
      existingAgentIds: new Set(["agent-1"]),
      toolsMap: new Map([[tool.id, tool]]),
    };

    const result = await validateAssignment({
      agentId: "agent-1",
      toolId: tool.id,
      credentialSourceMcpServerId: null,
      executionSourceMcpServerId: null,
      preFetchedData: data,
    });
    expect(result).toBeNull();
  });
});
