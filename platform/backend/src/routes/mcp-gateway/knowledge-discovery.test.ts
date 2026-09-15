import {
  ARCHESTRA_MCP_CATALOG_ID,
  OAUTH_TOKEN_ID_PREFIX,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { jsonSchema } from "ai";
import { buildAgentSystemPrompt } from "@/agents/agent-system-prompt";
import {
  archestraMcpBranding,
  executeArchestraTool,
} from "@/archestra-mcp-server";
import {
  AgentConnectorAssignmentModel,
  AgentExcludedConnectorModel,
  AgentExcludedToolModel,
  KnowledgeBaseConnectorModel,
  ToolModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import { createAgentServer } from "./utils";

describe("knowledge discovery guidance", () => {
  for (const scenario of [
    "auto",
    "custom compact",
    "custom full",
    "custom empty",
    "no connector",
    "excluded source",
    "excluded tool",
    "no query permission",
    "inaccessible source",
  ] as const) {
    test(
      scenario,
      async ({
        makeAgent,
        makeAgentTool,
        makeCustomRole,
        makeMember,
        makeOrganization,
        makeTeam,
        makeUser,
      }) => {
        const org = await makeOrganization();
        const user = await makeUser();
        const restricted =
          scenario === "no query permission" ||
          scenario === "inaccessible source";
        const role = restricted
          ? await makeCustomRole(org.id, {
              permission: {
                agent: ["read"],
                ...(scenario === "inaccessible source"
                  ? { knowledgeSource: ["query" as const] }
                  : {}),
              },
            })
          : null;
        await makeMember(user.id, org.id, { role: role?.role ?? "admin" });
        const custom = scenario.startsWith("custom");
        const full = scenario === "custom full";
        const available =
          scenario === "auto" || (custom && scenario !== "custom empty");
        const agent = await makeAgent({
          name: "Knowledge Discovery Agent",
          organizationId: org.id,
          agentType: "agent",
          accessAllTools: !custom,
          toolExposureMode: full ? "full" : "search_and_run_only",
          systemPrompt: "You are a helpful assistant.",
        });
        await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
        const knowledgeTool = archestraMcpBranding.getToolName(
          TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
        );
        const searchTool = archestraMcpBranding.getToolName(
          TOOL_SEARCH_TOOLS_SHORT_NAME,
        );
        const tool = await ToolModel.findByName(knowledgeTool);
        if (!tool) throw new Error("Missing knowledge tool");
        if (scenario !== "no connector" && scenario !== "custom empty") {
          const owner = await makeUser();
          const team = await makeTeam(org.id, owner.id);
          const connector = await KnowledgeBaseConnectorModel.create({
            organizationId: org.id,
            name: "Engineering Jira",
            description: "Release decisions and production access procedures",
            connectorType: "jira",
            visibility:
              scenario === "inaccessible source" ? "team-scoped" : "org-wide",
            teamIds: scenario === "inaccessible source" ? [team.id] : [],
            config: {
              type: "jira",
              jiraBaseUrl: "https://example.atlassian.net",
              isCloud: true,
              projectKey: "DEMO",
            },
          });
          if (custom) {
            await AgentConnectorAssignmentModel.assign(agent.id, connector.id);
          }
          if (scenario === "excluded source") {
            await AgentExcludedConnectorModel.replaceForAgent(agent.id, [
              connector.id,
            ]);
          }
        }
        if (custom) await makeAgentTool(agent.id, tool.id);
        if (scenario === "excluded tool") {
          await AgentExcludedToolModel.replaceForAgent(agent.id, [tool.id]);
        }
        const { server } = await createAgentServer({
          agentId: agent.id,
          tokenAuth: {
            tokenId: `${OAUTH_TOKEN_ID_PREFIX}${crypto.randomUUID()}`,
            teamId: null,
            isOrganizationToken: false,
            organizationId: org.id,
            isUserToken: true,
            userId: user.id,
          },
        });
        const handler = (
          server.server as unknown as {
            _requestHandlers: Map<
              string,
              (request: unknown) => Promise<ListToolsResult>
            >;
          }
        )._requestHandlers.get("tools/list");
        if (!handler) throw new Error("Missing tools/list handler");
        const listed = await handler({ method: "tools/list", params: {} });
        expect(listed.tools.some((item) => item.name === knowledgeTool)).toBe(
          full,
        );
        const description = listed.tools.find(
          (item) => item.name === searchTool,
        )?.description;
        if (!full) {
          expect(
            description?.includes("Internal knowledge search is available."),
          ).toBe(available);
          expect(description?.includes(knowledgeTool)).toBe(available);
        }
        const systemPrompt = await buildAgentSystemPrompt({
          agent,
          agentId: agent.id,
          organizationId: org.id,
          userId: user.id,
          mcpTools: Object.fromEntries(
            listed.tools.map((item) => [
              item.name,
              {
                description: item.description,
                inputSchema: jsonSchema(item.inputSchema),
              },
            ]),
          ),
        });
        expect(
          systemPrompt?.includes("Internal knowledge search is available."),
        ).toBe(available);
        expect(systemPrompt?.includes(knowledgeTool)).toBe(available);
        if (available) {
          expect(systemPrompt).toContain(
            "prefer knowledge search over public web search",
          );
          expect(systemPrompt).toContain("Engineering Jira");
          expect(systemPrompt).toContain(
            "Release decisions and production access procedures",
          );
          expect(systemPrompt).toContain("live status, exact record lookups");
          expect(systemPrompt).toContain(
            full ? `Use \`${knowledgeTool}\`` : `Discover \`${knowledgeTool}\``,
          );
          const search = await executeArchestraTool(
            searchTool,
            { query: "query knowledge sources search", limit: 20 },
            {
              agent: { id: agent.id, name: agent.name },
              agentId: agent.id,
              organizationId: org.id,
              userId: user.id,
            },
          );
          expect(search.isError).toBe(false);
          const knowledgeResult = (
            search.structuredContent as {
              tools: { toolName: string; description: string }[];
            }
          ).tools.find((item) => item.toolName === knowledgeTool);
          expect(knowledgeResult?.description).toContain("Engineering Jira");
          expect(knowledgeResult?.description).toContain(
            "Release decisions and production access procedures",
          );
          expect(knowledgeResult?.description).toContain(
            "live status, exact record lookups",
          );
          if (!full) {
            expect(description).toContain("Engineering Jira");
            expect(description).toContain(
              "Release decisions and production access procedures",
            );
          }
          expect(
            (
              search.structuredContent as { tools: { toolName: string }[] }
            ).tools.map((item) => item.toolName),
          ).toContain(knowledgeTool);
        }
      },
    );
  }
});
