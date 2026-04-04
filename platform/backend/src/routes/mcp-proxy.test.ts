import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import * as auth from "@/auth";
import db, { schema } from "@/database";
import { afterEach, describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import { mcpProxyRoutes } from "./mcp-proxy";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a Fastify instance with the mcp-proxy plugin registered.
 * `userId` and `organizationId` are injected into every request.
 */
async function buildApp(
  userId: string,
  organizationId: string,
): Promise<FastifyInstance> {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorateRequest("user");
  app.decorateRequest("organizationId");
  app.addHook("preHandler", (request, _reply, done) => {
    // biome-ignore lint/suspicious/noExplicitAny: test hook sets auth context
    (request as any).user = {
      id: userId,
      email: "test@test.com",
      name: "Test",
    };
    // biome-ignore lint/suspicious/noExplicitAny: test hook sets auth context
    (request as any).organizationId = organizationId;
    done();
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: { message: error.message, type: error.type },
      });
    }
    const err = error as Error & { statusCode?: number };
    const status = err.statusCode ?? 500;
    return reply.status(status).send({ error: { message: err.message } });
  });

  await app.register(mcpProxyRoutes);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("mcpProxyRoutes POST /api/mcp/:agentId", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) await app.close();
  });

  test("rejects a non-UUID agentId with 400", async ({ makeUser }) => {
    const user = await makeUser();
    app = await buildApp(user.id, crypto.randomUUID());

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp/not-a-valid-uuid",
      headers: { "content-type": "application/json" },
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    expect(response.statusCode).toBe(400);
  });

  test("returns 403 when the user does not have access to the agent", async ({
    makeUser,
    makeOrganization,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    vi.spyOn(auth, "hasAnyAgentTypeAdminPermission").mockResolvedValue(false);

    app = await buildApp(user.id, org.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/${crypto.randomUUID()}`,
      headers: { "content-type": "application/json" },
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.error?.message).toBe("Forbidden");
  });

  test("rejects tools/call for a tool whose visibility excludes 'app'", async ({
    makeUser,
    makeAgent,
    makeTool,
    makeAgentTool,
    makeInternalMcpCatalog,
  }) => {
    const user = await makeUser();
    const agent = await makeAgent({ authorId: user.id });
    vi.spyOn(auth, "hasAnyAgentTypeAdminPermission").mockResolvedValue(true);

    const catalog = await makeInternalMcpCatalog({
      name: "test-server",
      serverUrl: "https://example.com/mcp/",
    });
    const tool = await makeTool({
      name: "server__model_only",
      description: "Model-only tool",
      parameters: {},
      catalogId: catalog.id,
    });
    // Set meta with visibility: ["model"] (not app-callable)
    await setToolMeta(tool.id, {
      _meta: { ui: { visibility: ["model"] } },
    });
    await makeAgentTool(agent.id, tool.id);

    app = await buildApp(user.id, agent.organizationId);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/${agent.id}`,
      headers: { "content-type": "application/json" },
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "server__model_only", arguments: {} },
        id: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.error?.code).toBe(-32601);
    expect(body.error?.message).toContain("not accessible from MCP Apps");
  });

  test("allows tools/call for a tool with visibility including 'app'", async ({
    makeUser,
    makeAgent,
    makeTool,
    makeAgentTool,
    makeInternalMcpCatalog,
  }) => {
    const user = await makeUser();
    const agent = await makeAgent({ authorId: user.id });
    vi.spyOn(auth, "hasAnyAgentTypeAdminPermission").mockResolvedValue(true);

    const catalog = await makeInternalMcpCatalog({
      name: "test-server",
      serverUrl: "https://example.com/mcp/",
    });
    const tool = await makeTool({
      name: "server__both",
      description: "App+model tool",
      parameters: {},
      catalogId: catalog.id,
    });
    await setToolMeta(tool.id, {
      _meta: { ui: { visibility: ["model", "app"] } },
    });
    await makeAgentTool(agent.id, tool.id);

    app = await buildApp(user.id, agent.organizationId);

    // The route will proceed to createAgentServer which fails in this test env.
    // We only care that it did NOT return a -32601 rejection.
    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/${agent.id}`,
      headers: { "content-type": "application/json" },
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "server__both", arguments: {} },
        id: 1,
      },
    });

    if (response.statusCode === 200) {
      const body = response.json();
      expect(body.error?.code).not.toBe(-32601);
    } else {
      // Any non-200 status is fine here — tool visibility was not the blocker
      expect(response.statusCode).not.toBe(400);
    }
  });

  test("rejects tools/call with missing name param", async ({
    makeUser,
    makeAgent,
  }) => {
    const user = await makeUser();
    const agent = await makeAgent({ authorId: user.id });
    vi.spyOn(auth, "hasAnyAgentTypeAdminPermission").mockResolvedValue(true);

    app = await buildApp(user.id, agent.organizationId);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/${agent.id}`,
      headers: { "content-type": "application/json" },
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: {} },
        id: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toContain("requires a string 'name' parameter");
  });
});

// =============================================================================
// Internal helpers
// =============================================================================

async function setToolMeta(
  toolId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await db
    .update(schema.toolsTable)
    .set({ meta })
    .where(eq(schema.toolsTable.id, toolId));
}
