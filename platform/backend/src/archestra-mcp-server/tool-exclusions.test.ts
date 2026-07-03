// biome-ignore-all lint/suspicious/noExplicitAny: tests inspect MCP tool payloads dynamically
import {
  getArchestraToolFullName,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_SEARCH_TOOLS_FULL_NAME,
  TOOL_WHOAMI_FULL_NAME,
} from "@archestra/shared";
import { vi } from "vitest";
import mcpClient from "@/clients/mcp-client";
import { AgentModel, KnowledgeBaseConnectorModel, ToolModel } from "@/models";
import { agentToolExclusionsService } from "@/services/agent-tool-exclusions";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";
import {
  getUnassignedDiscoverableTools,
  isDynamicallyAvailableArchestraTool,
  resolveDynamicTool,
} from "./dynamic-tools";

vi.mock("@/clients/mcp-client", () => ({
  default: {
    executeToolCallForOwner: vi.fn(),
  },
}));

const QUERY_KNOWLEDGE_SOURCES_FULL_NAME = getArchestraToolFullName(
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
);

function resultText(result: { content: unknown }): string {
  return (result.content as Array<{ text?: string }>)
    .map((item) => item.text ?? "")
    .join("\n");
}

describe("Auto-tool-mode exclusions", () => {
  let agent: Agent;
  let organizationId: string;
  let userId: string;
  let context: ArchestraContext;

  beforeEach(async ({ makeAgent, makeMember, makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    const org = await makeOrganization();
    organizationId = org.id;
    const user = await makeUser();
    userId = user.id;
    await makeMember(user.id, org.id, { role: "admin" });
    agent = await makeAgent({
      name: "Exclusions Agent",
      organizationId,
      accessAllTools: true,
    });
    context = {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId,
      userId,
    };
  });

  describe("dynamic discovery and dispatch (points 1-3)", () => {
    test("a single excluded tool leaves the discoverable set; its catalog siblings stay", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog({ organizationId });
      const excludedTool = await makeTool({
        name: "github__delete_repository",
        catalogId: catalog.id,
      });
      await makeTool({ name: "github__create_issue", catalogId: catalog.id });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });

      await agentToolExclusionsService.replaceExclusions({
        agentId: agent.id,
        organizationId,
        excludedToolIds: [excludedTool.id],
      });

      const names = (
        await getUnassignedDiscoverableTools({
          assignedToolNames: new Set(),
          agentId: agent.id,
          userId,
          organizationId,
        })
      ).map((tool) => tool.name);
      expect(names).not.toContain("github__delete_repository");
      expect(names).toContain("github__create_issue");
    });

    test("resolveDynamicTool returns null for an excluded tool", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog({ organizationId });
      const tool = await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
      });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });

      // Control: resolvable before exclusion
      expect(
        (
          await resolveDynamicTool({
            toolName: "github__search_repositories",
            agentId: agent.id,
            userId,
            organizationId,
          })
        )?.id,
      ).toBe(tool.id);

      await agentToolExclusionsService.replaceExclusions({
        agentId: agent.id,
        organizationId,
        excludedToolIds: [tool.id],
      });
      expect(
        await resolveDynamicTool({
          toolName: "github__search_repositories",
          agentId: agent.id,
          userId,
          organizationId,
        }),
      ).toBeNull();
    });

    test("an excluded built-in loses the dynamic relaxation (query_knowledge_sources)", async ({
      makeAgent,
      seedAndAssignArchestraTools,
    }) => {
      // Seed built-in rows (assigned to a throwaway agent, not ours) and give
      // the user an accessible knowledge connector so the relaxation applies.
      const seededAgent = await makeAgent({ organizationId });
      await seedAndAssignArchestraTools(seededAgent.id);
      await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Test Connector",
        connectorType: "jira",
        visibility: "org-wide",
        teamIds: [],
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "PROJ",
        },
      });
      const kbTool = await ToolModel.findByName(
        QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
      );
      if (!kbTool) throw new Error("query_knowledge_sources row missing");

      expect(
        await isDynamicallyAvailableArchestraTool({
          toolName: QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
          agentId: agent.id,
          userId,
          organizationId,
        }),
      ).toBe(true);

      await agentToolExclusionsService.replaceExclusions({
        agentId: agent.id,
        organizationId,
        excludedToolIds: [kbTool.id],
      });

      expect(
        await isDynamicallyAvailableArchestraTool({
          toolName: QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
          agentId: agent.id,
          userId,
          organizationId,
        }),
      ).toBe(false);
    });
  });

  describe("assigned Archestra built-in gate (point 4)", () => {
    test("an ASSIGNED built-in is refused when excluded and Auto mode is on, and works again when Auto mode is off", async ({
      seedAndAssignArchestraTools,
    }) => {
      await seedAndAssignArchestraTools(agent.id);
      const whoami = await ToolModel.findByName(TOOL_WHOAMI_FULL_NAME);
      if (!whoami) throw new Error("whoami row missing");

      // Control: assigned and not excluded → executes
      const before = await executeArchestraTool(
        TOOL_WHOAMI_FULL_NAME,
        {},
        context,
      );
      expect(before.isError ?? false).toBe(false);

      await agentToolExclusionsService.replaceExclusions({
        agentId: agent.id,
        organizationId,
        excludedToolIds: [whoami.id],
      });

      const refused = await executeArchestraTool(
        TOOL_WHOAMI_FULL_NAME,
        {},
        context,
      );
      expect(refused.isError).toBe(true);
      expect(resultText(refused)).toContain("is not assigned to this agent");

      // Exclusions are inert in Custom mode: same rows, accessAllTools off
      await AgentModel.update(agent.id, { accessAllTools: false });
      const custom = await executeArchestraTool(
        TOOL_WHOAMI_FULL_NAME,
        {},
        context,
      );
      expect(custom.isError ?? false).toBe(false);
    });
  });

  describe("search_tools (point 5)", () => {
    test("an assigned-but-excluded tool disappears from search results in Auto mode only", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog({ organizationId });
      const excludedTool = await makeTool({
        name: "github__search_repositories",
        description: "Search repositories",
        catalogId: catalog.id,
      });
      const keptTool = await makeTool({
        name: "github__create_issue",
        description: "Create an issue",
        catalogId: catalog.id,
      });
      await makeAgentTool(agent.id, excludedTool.id);
      await makeAgentTool(agent.id, keptTool.id);
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });

      await agentToolExclusionsService.replaceExclusions({
        agentId: agent.id,
        organizationId,
        excludedToolIds: [excludedTool.id],
      });

      const result = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "github", limit: 20 },
        context,
      );
      expect(result.isError).toBe(false);
      const names = (result.structuredContent as any).tools.map(
        (tool: { toolName: string }) => tool.toolName,
      );
      expect(names).not.toContain("github__search_repositories");
      expect(names).toContain("github__create_issue");

      // Inert in Custom mode: the assigned tool is searchable again
      await AgentModel.update(agent.id, { accessAllTools: false });
      const customResult = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "github", limit: 20 },
        context,
      );
      const customNames = (customResult.structuredContent as any).tools.map(
        (tool: { toolName: string }) => tool.toolName,
      );
      expect(customNames).toContain("github__search_repositories");
    });
  });

  describe("run_tool (point 6)", () => {
    test("refuses an excluded assigned tool by exact name without dispatching", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog({ organizationId });
      const tool = await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
      });
      await makeAgentTool(agent.id, tool.id);
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });

      await agentToolExclusionsService.replaceExclusions({
        agentId: agent.id,
        organizationId,
        excludedToolIds: [tool.id],
      });

      const result = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "github__search_repositories", tool_args: {} },
        context,
      );
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain(
        'No tool named "github__search_repositories" is available to this agent',
      );
      expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
    });

    test("a tool both assigned and excluded is blocked in All mode but runs in Custom mode", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      // Exclusions and assignments are independent: the exclusion only bites
      // while accessAllTools is on; in Custom mode the assignment wins.
      const catalog = await makeInternalMcpCatalog({ organizationId });
      const tool = await makeTool({
        name: "github__search_repositories",
        catalogId: catalog.id,
      });
      await makeAgentTool(agent.id, tool.id);
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });

      await agentToolExclusionsService.replaceExclusions({
        agentId: agent.id,
        organizationId,
        excludedToolIds: [tool.id],
      });

      const blocked = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "github__search_repositories", tool_args: {} },
        context,
      );
      expect(blocked.isError).toBe(true);
      expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();

      // Same rows, Auto mode off → the exclusion is inert and the assigned
      // tool dispatches.
      await AgentModel.update(agent.id, { accessAllTools: false });
      vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as any);

      const custom = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "github__search_repositories", tool_args: {} },
        context,
      );
      expect(custom.isError).toBe(false);
      expect(mcpClient.executeToolCallForOwner).toHaveBeenCalledTimes(1);
    });

    test("short-name recovery neither resolves to nor discloses an excluded tool", async ({
      makeAgentTool,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const catalogA = await makeInternalMcpCatalog({ organizationId });
      const keptTool = await makeTool({
        name: "alpha__deploy",
        catalogId: catalogA.id,
      });
      const catalogB = await makeInternalMcpCatalog({ organizationId });
      const excludedTool = await makeTool({
        name: "beta__deploy",
        catalogId: catalogB.id,
      });
      await makeAgentTool(agent.id, keptTool.id);
      await makeAgentTool(agent.id, excludedTool.id);
      await makeMcpServer({ catalogId: catalogA.id, scope: "org" });
      await makeMcpServer({ catalogId: catalogB.id, scope: "org" });

      // Control: both visible → ambiguous, disclosing both candidates
      const ambiguous = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "deploy", tool_args: {} },
        context,
      );
      expect(ambiguous.isError).toBe(true);
      expect(resultText(ambiguous)).toContain("alpha__deploy");
      expect(resultText(ambiguous)).toContain("beta__deploy");

      await agentToolExclusionsService.replaceExclusions({
        agentId: agent.id,
        organizationId,
        excludedToolIds: [excludedTool.id],
      });

      vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as any);

      const recovered = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        { tool_name: "deploy", tool_args: {} },
        context,
      );
      // No ambiguity anymore, and the excluded name never surfaces
      expect(resultText(recovered)).not.toContain("beta__deploy");
      expect(mcpClient.executeToolCallForOwner).toHaveBeenCalledTimes(1);
      const dispatchedCall = vi.mocked(mcpClient.executeToolCallForOwner).mock
        .calls[0][0];
      expect(dispatchedCall.name).toBe("alpha__deploy");
    });
  });
});
