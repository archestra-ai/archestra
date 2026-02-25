import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getChatMcpClient } from "@/clients/chat-mcp-client";
import logger from "@/logging";
import { requireAuth } from "@/middleware/auth";
import { requirePermissions } from "@/middleware/permissions";

const mcpResourcesRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /api/mcp/resources/read
   * Read a resource from an MCP server via the MCP Gateway
   * Used by MCP App UI to fetch HTML/assets
   */
  fastify.post(
    "/resources/read",
    {
      preHandler: [requireAuth, requirePermissions({ agent: ["read"] })],
      schema: {
        body: z.object({
          agentId: z.string(),
          conversationId: z.string().optional(),
          resourceUri: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const { agentId, conversationId, resourceUri } = request.body as {
        agentId: string;
        conversationId?: string;
        resourceUri: string;
      };

      const userId = request.user?.id;
      const organizationId = request.user?.organizationId;

      if (!userId || !organizationId) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      try {
        // Get MCP client for this agent/user
        const client = await getChatMcpClient(
          agentId,
          userId,
          organizationId,
          request.user?.isAgentAdmin ?? false,
          conversationId,
        );

        if (!client) {
          logger.error(
            { agentId, userId, resourceUri },
            "Failed to get MCP client for resource read",
          );
          return reply.code(500).send({
            error: "Failed to connect to MCP Gateway",
          });
        }

        // Call resources/read on the MCP server
        logger.info(
          { agentId, userId, resourceUri },
          "Reading MCP resource via gateway",
        );

        const result = await client.readResource({ uri: resourceUri });

        logger.info(
          { agentId, userId, resourceUri, contentCount: result.contents.length },
          "Successfully read MCP resource",
        );

        return reply.send(result);
      } catch (error) {
        logger.error(
          { agentId, userId, resourceUri, error },
          "Failed to read MCP resource",
        );
        return reply.code(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to read MCP resource",
        });
      }
    },
  );
};

export default mcpResourcesRoutes;
