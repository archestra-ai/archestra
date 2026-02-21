import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { McpServerModel } from "@/models";

const QuerySchema = z.object({
  uri: z.string(),
  mcpServerId: z.string(),
});

/**
 * Proxy endpoint for fetching MCP App UI resources (ui:// scheme).
 * The frontend calls this to load the HTML content for MCP App iframes,
 * and the backend routes the request to the appropriate MCP server.
 */
const mcpAppResourceRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/chat/agents/:agentId/mcp-app-resource",
    {
      schema: {
        tags: ["chat"],
        params: z.object({
          agentId: z.string(),
        }),
        querystring: QuerySchema,
      },
    },
    async (request, reply) => {
      const { agentId } = request.params as { agentId: string };
      const queryResult = QuerySchema.safeParse(request.query);

      if (!queryResult.success) {
        return reply.status(400).send({
          error: "Invalid query: uri (ui:// scheme) and mcpServerId required",
        });
      }

      const { uri, mcpServerId } = queryResult.data;

      if (!uri.startsWith("ui://")) {
        return reply.status(400).send({
          error: "Only ui:// resource URIs are supported",
        });
      }

      try {
        const mcpServer = await McpServerModel.findById(mcpServerId);
        if (!mcpServer) {
          return reply
            .status(404)
            .send({ error: `MCP server ${mcpServerId} not found` });
        }

        // Use the MCP client to call resources/read on the target server
        const mcpClient = fastify.mcpClientManager?.getClient(mcpServerId);
        if (!mcpClient) {
          return reply.status(502).send({
            error: `No active MCP client for server ${mcpServerId}`,
          });
        }

        const result = await mcpClient.readResource({ uri });

        if (
          !result ||
          !result.contents ||
          result.contents.length === 0
        ) {
          return reply.status(404).send({ error: "Resource not found" });
        }

        const content = result.contents[0];
        const mimeType =
          (content as { mimeType?: string }).mimeType ?? "text/html";
        const text = (content as { text?: string }).text ?? "";

        return reply
          .header("Content-Type", mimeType)
          .header("X-Frame-Options", "SAMEORIGIN")
          .send(text);
      } catch (error) {
        logger.error(
          { err: error, agentId, mcpServerId, uri },
          "Failed to fetch MCP App resource",
        );
        const message =
          error instanceof Error
            ? error.message
            : "Failed to fetch MCP App resource";
        return reply.status(502).send({ error: message });
      }
    },
  );
};

export default mcpAppResourceRoutes;
