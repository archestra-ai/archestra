import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import * as auth from "@/auth";
import { AgentModel, ToolModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import { mcpProxyRoutes } from "./mcp-proxy";

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEST_USER_ID = crypto.randomUUID();
const TEST_ORG_ID = crypto.randomUUID();

/** Build a Fastify instance with the mcp-proxy plugin registered. */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Fastify 5: declare decorators without initial value (reference types
  // are prohibited), then set per-request in a hook.
  app.decorateRequest("user");
  app.decorateRequest("organizationId");
  app.addHook("preHandler", (request, _reply, done) => {
    // biome-ignore lint/suspicious/noExplicitAny: test hook sets auth context
    (request as any).user = {
      id: TEST_USER_ID,
      email: "test@test.com",
      name: "Test",
    };
    // biome-ignore lint/suspicious/noExplicitAny: test hook sets auth context
    (request as any).organizationId = TEST_ORG_ID;
    done();
  });

  // Minimal error handler: forwards ApiError status codes and passes through
  // Fastify/Zod validation errors (which already carry a 400 statusCode).
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

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("rejects a non-UUID agentId with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/mcp/not-a-valid-uuid",
      headers: { "content-type": "application/json" },
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    expect(response.statusCode).toBe(400);
  });

  test("returns 403 when the user does not have access to the agent", async () => {
    vi.spyOn(auth, "hasAnyAgentTypeAdminPermission").mockResolvedValue(false);
    vi.spyOn(AgentModel, "findById").mockResolvedValue(null);

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

  test("rejects tools/call for a tool whose visibility excludes 'app'", async () => {
    const agentId = crypto.randomUUID();

    vi.spyOn(auth, "hasAnyAgentTypeAdminPermission").mockResolvedValue(false);
    // Return a valid agent so the agent-access check passes
    vi.spyOn(AgentModel, "findById").mockResolvedValue({
      id: agentId,
      name: "Test Agent",
      organizationId: TEST_ORG_ID,
    } as unknown as Awaited<ReturnType<typeof AgentModel.findById>>);
    // Tool has visibility: ["model"] — app-callable is false
    vi.spyOn(ToolModel, "findByName").mockResolvedValue({
      id: "tool-1",
      name: "server__model-only",
      meta: { _meta: { ui: { visibility: ["model"] } } },
    } as unknown as Awaited<ReturnType<typeof ToolModel.findByName>>);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/${agentId}`,
      headers: { "content-type": "application/json" },
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "server__model-only", arguments: {} },
        id: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.error?.code).toBe(-32601);
    expect(body.error?.message).toContain("not accessible from MCP Apps");
  });

  test("allows tools/call for a tool with visibility including 'app'", async () => {
    const agentId = crypto.randomUUID();

    vi.spyOn(auth, "hasAnyAgentTypeAdminPermission").mockResolvedValue(false);
    vi.spyOn(AgentModel, "findById").mockResolvedValue({
      id: agentId,
      name: "Test Agent",
      organizationId: TEST_ORG_ID,
    } as unknown as Awaited<ReturnType<typeof AgentModel.findById>>);
    vi.spyOn(ToolModel, "findByName").mockResolvedValue({
      id: "tool-2",
      name: "server__both",
      meta: { _meta: { ui: { visibility: ["model", "app"] } } },
    } as unknown as Awaited<ReturnType<typeof ToolModel.findByName>>);

    // The route will proceed to createAgentServer which fails in this test env.
    // We only care that it did NOT return a -32601 rejection.
    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/${agentId}`,
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

  test("returns 403 when agent exists but belongs to another organization", async () => {
    vi.spyOn(auth, "hasAnyAgentTypeAdminPermission").mockResolvedValue(true);
    vi.spyOn(AgentModel, "findById").mockResolvedValue({
      id: crypto.randomUUID(),
      name: "Other Org Agent",
      organizationId: crypto.randomUUID(),
    } as unknown as Awaited<ReturnType<typeof AgentModel.findById>>);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/${crypto.randomUUID()}`,
      headers: { "content-type": "application/json" },
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    expect(response.statusCode).toBe(403);
  });
});
