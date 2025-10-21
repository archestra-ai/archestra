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

export const createArchestraMcpServer = () => {
  const archestraMcpServer = new McpServer({
    name: "archestra-server",
    version: config.api.version,
  });

  archestraMcpServer.registerTool(
    "getAgentTools",
    {
      title: "Get agent tools",
      description: "Get all tools available for a specific agent",
      inputSchema: {
        agentId: z.string().describe("The ID of the agent to get tools for"),
      },
    },
    async ({ agentId }) => {
      try {
        // For now, return mock data. Later we can hook up real data using:
        // const tools = await ToolModel.getToolsByAgent(agentId);

        const mockTools = [
          {
            id: "tool-1",
            name: "read_file",
            description: "Read the contents of a file",
            parameters: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "The path to the file to read",
                },
              },
              required: ["path"],
            },
          },
          {
            id: "tool-2",
            name: "write_file",
            description: "Write content to a file",
            parameters: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "The path to the file to write",
                },
                content: {
                  type: "string",
                  description: "The content to write to the file",
                },
              },
              required: ["path", "content"],
            },
          },
          {
            id: "tool-3",
            name: "list_directory",
            description: "List the contents of a directory",
            parameters: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "The path to the directory to list",
                },
              },
              required: ["path"],
            },
          },
        ];

        return {
          content: [
            {
              type: "text",
              text: `Found ${mockTools.length} tools for agent ${agentId}:\n\n${mockTools
                .map((tool) => `• ${tool.name}: ${tool.description}`)
                .join("\n")}\n\nTools: ${JSON.stringify(mockTools, null, 2)}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching tools for agent ${agentId}: ${error instanceof Error ? error.message : "Unknown error"}`,
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
    stateful: false,
    mcpEndpoint: "/mcp",
    /**
     * biome-ignore lint/suspicious/noExplicitAny: the typing is likely slightly off here since we are
     * using the @socotra/modelcontextprotocol-sdk forked package.. remove this once we
     * switch back to the official package.
     */
    createServer: createArchestraMcpServer as any,
  });
};

export default archestraMcpServerPlugin;
