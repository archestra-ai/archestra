import type { McpToolUiCsp } from "@shared/mcp-app-types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import mcpClient from "@/clients/mcp-client";
import { AgentModel, ToolModel } from "@/models";
import { UuidIdSchema } from "@/types";

/**
 * Build a strict Content-Security-Policy from MCP App _meta.ui.csp.
 * Follows the SEP-1865 spec defaults — never includes unsafe-eval.
 */
function buildCspHeader(csp?: McpToolUiCsp): string {
  const connectSrc = csp?.connectDomains?.join(" ") ?? "";
  const resourceSrc = csp?.resourceDomains?.join(" ") ?? "";
  const frameSrc = csp?.frameDomains?.join(" ") ?? "";

  return [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: ${resourceSrc}`.trim(),
    `media-src 'self' data: ${resourceSrc}`.trim(),
    `font-src 'self' ${resourceSrc}`.trim(),
    `connect-src 'self' ${connectSrc}`.trim(),
    `frame-src 'self' ${frameSrc}`.trim(),
  ].join("; ");
}

/**
 * MCP App proxy routes.
 *
 * These endpoints serve as the bridge between the MCP App iframe in the
 * Chat UI and the upstream MCP servers.
 *
 * - GET  /api/mcp-app/resource — fetches a ui:// resource and serves the HTML with strict CSP
 * - POST /api/mcp-app/tool-call — proxies tool calls initiated from within the iframe
 */
const mcpAppProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // ---------------------------------------------------------------
  // GET /api/mcp-app/resource — serve MCP App HTML with strict CSP
  // ---------------------------------------------------------------
  fastify.get(
    "/api/mcp-app/resource",
    {
      schema: {
        tags: ["mcp-app"],
        querystring: z.object({
          uri: z.string().startsWith("ui://"),
          agentId: UuidIdSchema,
        }),
      },
    },
    async (request, reply) => {
      const { uri, agentId } = request.query;
      const userId = request.user?.id;

      if (!userId) {
        reply.status(401);
        return { error: "Unauthorized" };
      }

      // RBAC: verify user has access to this agent
      const agent = await AgentModel.findById(agentId);
      if (!agent) {
        reply.status(404);
        return { error: "Agent not found" };
      }

      // Find the tool that owns this resource URI
      const agentTools = await ToolModel.getMcpToolsByAgent(agentId);
      const matchingTool = agentTools.find((t) => {
        const meta = t.meta as Record<string, unknown> | null;
        const ui = meta?.ui as Record<string, unknown> | undefined;
        return ui?.resourceUri === uri;
      });

      if (!matchingTool) {
        reply.status(404);
        return { error: "Resource not found for this agent" };
      }

      // Read the resource from the upstream MCP server
      try {
        const result = await mcpClient.readResource(uri, agentId);

        const content = result?.contents?.[0];
        if (!content || !content.text) {
          reply.status(404);
          return { error: "Resource returned empty content" };
        }

        // Build CSP from the tool's _meta.ui.csp
        const toolMeta = matchingTool.meta as Record<string, unknown> | null;
        const uiMeta = toolMeta?.ui as Record<string, unknown> | undefined;
        const csp = uiMeta?.csp as McpToolUiCsp | undefined;

        reply.header("Content-Type", content.mimeType || "text/html");
        reply.header("Content-Security-Policy", buildCspHeader(csp));
        reply.header("X-Content-Type-Options", "nosniff");

        return content.text;
      } catch (error) {
        fastify.log.error(
          { err: error, uri, agentId },
          "Failed to read MCP App resource",
        );
        reply.status(502);
        return { error: "Failed to fetch resource from MCP server" };
      }
    },
  );

  // ---------------------------------------------------------------
  // POST /api/mcp-app/tool-call — proxy iframe-initiated tool calls
  // ---------------------------------------------------------------
  fastify.post(
    "/api/mcp-app/tool-call",
    {
      schema: {
        tags: ["mcp-app"],
        body: z.object({
          agentId: UuidIdSchema,
          toolName: z.string(),
          args: z.record(z.string(), z.unknown()).default({}),
        }),
      },
    },
    async (request, reply) => {
      const { agentId, toolName, args } = request.body;
      const userId = request.user?.id;

      if (!userId) {
        reply.status(401);
        return { error: "Unauthorized" };
      }

      // RBAC: verify user has access to this agent
      const agent = await AgentModel.findById(agentId);
      if (!agent) {
        reply.status(404);
        return { error: "Agent not found" };
      }

      // Validate the tool is assigned to this agent
      const agentTools = await ToolModel.getMcpToolsByAgent(agentId);
      const tool = agentTools.find((t) => t.name === toolName);
      if (!tool) {
        reply.status(403);
        return { error: "Tool not assigned to this agent" };
      }

      try {
        const toolCallId = `mcp-app-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        const result = await mcpClient.executeToolCall(
          { id: toolCallId, name: toolName, arguments: args },
          agentId,
        );

        return {
          content: result.content,
          isError: result.isError,
        };
      } catch (error) {
        fastify.log.error(
          { err: error, agentId, toolName },
          "Failed to execute MCP App tool call",
        );
        reply.status(502);
        return { error: "Failed to execute tool call" };
      }
    },
  );
};

export default mcpAppProxyRoutes;
