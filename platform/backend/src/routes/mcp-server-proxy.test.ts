import { ADMIN_ROLE_NAME } from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { type Mock, vi } from "vitest";
import { afterEach, describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import { createServerScopedServer } from "./mcp-server-gateway.utils";
import mcpServerProxyRoutes from "./mcp-server-proxy";

// Stub the MCP transport boundary so a request that passes the access +
// visibility gates surfaces as a 500 instead of hijacking the socket. A gate
// *rejection* returns a 200 JSON-RPC error and never reaches this, which is
// exactly what lets these tests assert "the request got through the gate".
vi.mock("./mcp-server-gateway.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-server-gateway.utils")>()),
  createServerScopedServer: vi.fn(),
}));

const mockCreateServerScopedServer = createServerScopedServer as Mock;

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
    (request as any).user = { id: userId, email: "t@t.com", name: "T" };
    // biome-ignore lint/suspicious/noExplicitAny: test hook sets auth context
    (request as any).organizationId = organizationId;
    done();
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .status(error.statusCode)
        .send({ error: { message: error.message, type: error.type } });
    }
    const err = error as Error & { statusCode?: number };
    return reply
      .status(err.statusCode ?? 500)
      .send({ error: { message: err.message } });
  });
  await app.register(mcpServerProxyRoutes);
  return app;
}

const JSON_HEADERS = { "content-type": "application/json" };
const rpc = (method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  ...(params !== undefined ? { params } : {}),
});

describe("mcpServerProxyRoutes POST /api/mcp/server/:mcpServerId", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close();
  });

  test("403 when the caller cannot view the installed server", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const caller = await makeUser();
    await makeMember(caller.id, org.id, { role: "member" });
    const catalog = await makeInternalMcpCatalog({
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "personal",
    });
    // Personal server owned by someone else, with no mcp_server_users link for
    // the caller — invisible to them, so the access gate must reject.
    const server = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: owner.id,
    });
    app = await buildApp(caller.id, org.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp/server/${server.id}`,
      headers: JSON_HEADERS,
      payload: rpc("tools/list", {}),
    });
    expect(res.statusCode).toBe(403);
  });

  test("tools/call without a name is rejected with -32602", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeMcpServer,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    const server = await makeMcpServer({ scope: "org" });
    app = await buildApp(user.id, org.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp/server/${server.id}`,
      headers: JSON_HEADERS,
      payload: rpc("tools/call", { arguments: {} }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().error.code).toBe(-32602);
  });

  test("tools/call for an unknown tool is rejected with -32601", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    const server = await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    await makeTool({
      catalogId: catalog.id,
      name: "known",
      meta: { _meta: {} },
    });
    app = await buildApp(user.id, org.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp/server/${server.id}`,
      headers: JSON_HEADERS,
      payload: rpc("tools/call", { name: "ghost", arguments: {} }),
    });
    expect(res.json().error.code).toBe(-32601);
  });

  test("tools/call for a model-only tool (visibility excludes app) is rejected", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    const server = await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    // Stored raw (unprefixed) by makeTool; the gate matches via unslugifyName.
    await makeTool({
      catalogId: catalog.id,
      name: "modelonly",
      meta: { _meta: { ui: { visibility: ["model"] } } },
    });
    app = await buildApp(user.id, org.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp/server/${server.id}`,
      headers: JSON_HEADERS,
      payload: rpc("tools/call", { name: "modelonly", arguments: {} }),
    });
    expect(res.json().error.code).toBe(-32601);
  });
});

describe("mcpServerProxyRoutes gate pass-through", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    mockCreateServerScopedServer.mockReset();
    if (app) await app.close();
  });

  test("an app-visible tools/call passes the gate and reaches the transport", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    const server = await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    await makeTool({
      catalogId: catalog.id,
      name: "appcallable",
      meta: { _meta: { ui: { visibility: ["app"] } } },
    });
    mockCreateServerScopedServer.mockImplementation(() => {
      throw new Error("transport unavailable in test");
    });
    app = await buildApp(user.id, org.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp/server/${server.id}`,
      headers: JSON_HEADERS,
      payload: rpc("tools/call", { name: "appcallable", arguments: {} }),
    });

    // Passed the visibility gate (a rejection would be a 200 JSON-RPC error),
    // so execution proceeded into the transport setup.
    expect(res.statusCode).toBe(500);
    expect(mockCreateServerScopedServer).toHaveBeenCalledWith({
      mcpServerId: server.id,
      catalogId: catalog.id,
    });
  });

  test("a non-tools/call method bypasses the tool-visibility gate", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    const server = await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    mockCreateServerScopedServer.mockImplementation(() => {
      throw new Error("transport unavailable in test");
    });
    app = await buildApp(user.id, org.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp/server/${server.id}`,
      headers: JSON_HEADERS,
      payload: rpc("tools/list", {}),
    });

    expect(res.statusCode).toBe(500);
    expect(mockCreateServerScopedServer).toHaveBeenCalledWith({
      mcpServerId: server.id,
      catalogId: catalog.id,
    });
  });

  test("tools/call for a block_always-policied tool is rejected by the invocation policy, not just visibility", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
    makeToolPolicy,
  }) => {
    const org = await makeOrganization({ globalToolPolicy: "restrictive" });
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    const server = await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: "blocked",
      meta: { _meta: { ui: { visibility: ["app"] } } },
    });
    // Unconditional block on every call to this tool.
    await makeToolPolicy(tool.id, { action: "block_always", conditions: [] });
    // A policy block must reject at the gate (200 JSON-RPC error); reaching the
    // transport here would throw and surface as 500.
    mockCreateServerScopedServer.mockImplementation(() => {
      throw new Error("transport must not be reached for a blocked tool");
    });
    app = await buildApp(user.id, org.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp/server/${server.id}`,
      headers: JSON_HEADERS,
      payload: rpc("tools/call", { name: "blocked", arguments: {} }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().error?.message).toMatch(/tool-invocation policy/i);
    expect(mockCreateServerScopedServer).not.toHaveBeenCalled();
  });

  test("a no-policy tool still passes the gate in a restrictive org (context-trusted app runtime does not over-block)", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const org = await makeOrganization({ globalToolPolicy: "restrictive" });
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    const server = await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    await makeTool({
      catalogId: catalog.id,
      name: "unpoliced",
      meta: { _meta: { ui: { visibility: ["app"] } } },
    });
    mockCreateServerScopedServer.mockImplementation(() => {
      throw new Error("transport unavailable in test");
    });
    app = await buildApp(user.id, org.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp/server/${server.id}`,
      headers: JSON_HEADERS,
      payload: rpc("tools/call", { name: "unpoliced", arguments: {} }),
    });

    // Reached the transport → passed the gate (a rejection would be a 200
    // JSON-RPC error). A tool with no block/approval policy stays callable.
    expect(res.statusCode).toBe(500);
    expect(mockCreateServerScopedServer).toHaveBeenCalled();
  });
});
