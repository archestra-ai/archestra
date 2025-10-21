/**
 * NOTE: we are only using the @socotra/modelcontextprotocol-sdk forked package until
 * This PR is merged https://github.com/modelcontextprotocol/typescript-sdk/pull/869#issuecomment-3300474160
 *
 * (that PR adds zod v4 support to @modelcontextprotocol/sdk)
 */
import { McpServer } from "@socotra/modelcontextprotocol-sdk/server/mcp.js";
import type { FastifyPluginAsync } from "fastify";
import { streamableHttp } from "fastify-mcp";
import { z } from "zod";
import config from "@/config";
import { ToolModel } from "@/models";

/**
 * TEMPORARY: Global agent context for MCP server
 *
 * This is a temporary solution using global state to track the active agent.
 * This approach has limitations:
 * - Race conditions with multiple concurrent connections
 * - All MCP clients share the same agent context
 * - No isolation between different client sessions
 *
 * TODO: Refactor to session-based approach using:
 * - https://github.com/modelcontextprotocol/typescript-sdk?tab=readme-ov-file#with-session-management
 * - https://github.com/haroldadmin/fastify-mcp?tab=readme-ov-file#session-management
 *
 * This will allow proper per-session agent context and tool isolation.
 */
const _currentAgentId: string | null = null;
const _globalArchestraServer: McpServer | null = null;

/**
 * Session-isolated MCP server factory
 * Each connection gets its own server instance with agent-specific tools
 */
export const createArchestraMcpServer = () => {
  const archestraMcpServer = new McpServer({
    name: "archestra-server",
    version: config.api.version,
  });

  // Core platform tools (always available)
  archestraMcpServer.registerTool(
    "getAgentTools",
    {
      title: "Get agent tools",
      description: "Get all tools available for a specific agent",
      inputSchema: {
        agentId: z.string().describe("The ID of the agent to get tools for"),
      },
    },
    async ({ agentId: requestedAgentId }) => {
      try {
        const tools = await ToolModel.getToolsByAgent(requestedAgentId);

        return {
          content: [
            {
              type: "text",
              text: `Found ${tools.length} tools for agent ${requestedAgentId}:\n\n${tools
                .map(
                  (tool) =>
                    `• ${tool.name}: ${tool.description || "No description"}`,
                )
                .join("\n")}\n\nTools: ${JSON.stringify(
                tools.map((tool) => ({
                  id: tool.id,
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                })),
                null,
                2,
              )}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching tools for agent ${requestedAgentId}: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
        };
      }
    },
  );

  archestraMcpServer.registerTool(
    "listAvailableAgents",
    {
      title: "List available agents",
      description: "List all agents in the platform",
      inputSchema: {},
    },
    async () => {
      try {
        // This would need to be implemented in AgentModel
        return {
          content: [
            {
              type: "text",
              text: "Agent listing not yet implemented. Use getAgentTools with a specific agent ID to get agent-specific tools.",
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing agents: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
        };
      }
    },
  );

  return archestraMcpServer.server;
};

const archestraMcpServerPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(streamableHttp, {
    stateful: false, // Use stateless mode with global state for now
    mcpEndpoint: config.archestraMcpServer.endpoint,
    /**
     * biome-ignore lint/suspicious/noExplicitAny: the typing is likely slightly off here since we are
     * using the @socotra/modelcontextprotocol-sdk forked package.. remove this once we
     * switch back to the official package.
     */
    createServer: createArchestraMcpServer as any,
  });
};

export default archestraMcpServerPlugin;
