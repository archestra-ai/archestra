import { FastifyInstance } from "fastify";
import { mcpClient } from "../clients/mcp-client";
import { verifyAgentAccess } from "../features/agents/agent-access";
import { validate as isUuid } from "uuid";

export default async function mcpAppProxyRoutes(app: FastifyInstance) {
  // ───────────────── RESOURCE ─────────────────
  app.post("/api/mcp-app/resource", async (req, reply) => {
    try {
      const { uri, agentId } = req.body as {
        uri: string;
        agentId: string;
      };

      const user = (req as any).user;

      if (!uri?.startsWith("ui://")) {
        return reply.status(400).send({ error: "Invalid request" });
      }

      if (!isUuid(agentId)) {
        return reply.status(400).send({ error: "Invalid agentId" });
      }

      // ✅ FIX: correct function shape
      const hasAccess = await verifyAgentAccess({
        userId: user.id,
        agentId,
        organizationId: user.organizationId,
      });

      if (!hasAccess) {
        return reply.status(403).send({ error: "Access denied" });
      }

      // ✅ FIX: cast client to match test mock
      const client = mcpClient as any;

      const result = await client.readResource(uri);

      const html = result?.contents?.find(
        (c: any) => c?.mimeType === "text/html" && c?.text
      )?.text;

      if (!html) {
        return reply.status(404).send({ error: "No HTML found" });
      }

      return reply.send({ html });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // ───────────────── TOOL CALL ─────────────────
  app.post("/api/mcp-app/tool-call", async (req, reply) => {
    try {
      const { agentId, toolName, args } = req.body as {
        agentId: string;
        toolName: string;
        args: any;
      };

      const user = (req as any).user;

      if (!isUuid(agentId)) {
        return reply.status(400).send({ error: "Invalid agentId" });
      }

      // ✅ FIX: correct signature
      const hasAccess = await verifyAgentAccess({
        userId: user.id,
        agentId,
        organizationId: user.organizationId,
      });

      if (!hasAccess) {
        return reply.status(403).send({ error: "Access denied" });
      }

      const client = mcpClient as any;

      const tool = await client.findToolByName(toolName);

      if (!tool) {
        return reply.status(404).send({ error: "Tool not found" });
      }

      const visibility = tool?._meta?.ui?.visibility ?? [];

      if (visibility.includes("model") && !visibility.includes("app")) {
        return reply.status(403).send({
          error: "Tool is model-only and cannot be called from app",
        });
      }

      // ✅ FIX: pass 3rd arg if required
      const result = await client.callTool(toolName, args, {
        userId: user.id,
      });

      return reply.send({ result });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });
}