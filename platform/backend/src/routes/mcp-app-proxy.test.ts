import {
  getArchestraToolFullName,
  TOOL_APP_DATA_SET_SHORT_NAME,
  TOOL_CREATE_APP_SHORT_NAME,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import config from "@/config";
import db, { schema } from "@/database";
import { AppDataModel } from "@/models";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import mcpAppProxyRoutes from "./mcp-app-proxy";

const originalAppsEnabled = config.apps.enabled;
beforeAll(() => {
  (config.apps as { enabled: boolean }).enabled = true;
});
afterAll(() => {
  (config.apps as { enabled: boolean }).enabled = originalAppsEnabled;
});

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
    (request as any).user = { id: userId, email: "test@test.com", name: "T" };
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

  await app.register(mcpAppProxyRoutes);
  return app;
}

const JSON_RPC_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

describe("mcpAppProxyRoutes POST /api/mcp/app/:appId", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  test("returns 404 when the apps feature is disabled", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const created = await makeApp();
    const user = await makeUser();
    await makeMember(user.id, created.organizationId, { role: "member" });
    (config.apps as { enabled: boolean }).enabled = false;
    app = await buildApp(user.id, created.organizationId);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${created.id}`,
      headers: JSON_RPC_HEADERS,
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    (config.apps as { enabled: boolean }).enabled = true;
    expect(response.statusCode).toBe(404);
  });

  test("returns 403 when the user cannot access the app", async ({
    makeUser,
    makeOrganization,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    app = await buildApp(user.id, org.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${crypto.randomUUID()}`,
      headers: JSON_RPC_HEADERS,
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error?.message).toBe("Forbidden");
  });

  test("rejects tools/call for a tool not assigned to the app", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const created = await makeApp();
    const user = await makeUser();
    await makeMember(user.id, created.organizationId, { role: "member" });
    app = await buildApp(user.id, created.organizationId);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${created.id}`,
      headers: JSON_RPC_HEADERS,
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "server__not_assigned", arguments: {} },
        id: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.error?.code).toBe(-32601);
    expect(body.error?.message).toContain("not assigned to this app");
  });

  test("rejects tools/call for an assigned tool whose visibility excludes 'app'", async ({
    makeApp,
    makeUser,
    makeMember,
    makeTool,
    makeAppTool,
    makeInternalMcpCatalog,
  }) => {
    const created = await makeApp();
    const user = await makeUser();
    await makeMember(user.id, created.organizationId, { role: "member" });
    const catalog = await makeInternalMcpCatalog({
      name: "test-server",
      serverUrl: "https://example.com/mcp/",
    });
    const tool = await makeTool({
      name: "server__model_only",
      parameters: {},
      catalogId: catalog.id,
    });
    await db
      .update(schema.toolsTable)
      .set({ meta: { _meta: { ui: { visibility: ["model"] } } } })
      .where(eq(schema.toolsTable.id, tool.id));
    await makeAppTool(created.id, tool.id);
    app = await buildApp(user.id, created.organizationId);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${created.id}`,
      headers: JSON_RPC_HEADERS,
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

  // An app runtime has no agentId, so the agent-assignment check is skipped;
  // dispatch must still refuse Archestra management tools (create_app, …) even
  // when the session user has RBAC for them.
  test("refuses a non-data Archestra management tool from the app runtime", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const created = await makeApp();
    const user = await makeUser();
    await makeMember(user.id, created.organizationId, { role: "member" });
    app = await buildApp(user.id, created.organizationId);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${created.id}`,
      headers: JSON_RPC_HEADERS,
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: getArchestraToolFullName(TOOL_CREATE_APP_SHORT_NAME),
          arguments: { name: "Sneaky", html: "<p/>", scope: "org" },
        },
        id: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().error?.code).toBe(-32601);
  });

  test("tools/list advertises the App Data Store tools", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const created = await makeApp();
    const user = await makeUser();
    await makeMember(user.id, created.organizationId, { role: "member" });
    app = await buildApp(user.id, created.organizationId);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${created.id}`,
      headers: JSON_RPC_HEADERS,
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    expect(response.statusCode).toBe(200);
    const names = response
      .json()
      .result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain(
      getArchestraToolFullName(TOOL_APP_DATA_SET_SHORT_NAME),
    );
  });

  test("resources/read serves the app's head-version HTML", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const created = await makeApp({ html: "<h1>hello app</h1>" });
    const user = await makeUser();
    await makeMember(user.id, created.organizationId, { role: "member" });
    app = await buildApp(user.id, created.organizationId);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${created.id}`,
      headers: JSON_RPC_HEADERS,
      payload: {
        jsonrpc: "2.0",
        method: "resources/read",
        params: { uri: `ui://app/${created.id}` },
        id: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    const content = response.json().result.contents[0];
    expect(content.text).toBe("<h1>hello app</h1>");
    expect(content.mimeType).toContain("text/html");
  });

  // Regression: appId is derived from the route param, never from the request.
  // An App Data Store write through one app's endpoint must land on that app and
  // never touch another app the same user can also access (the tool args carry
  // no appId — strict schemas reject one — so the route is the sole source).
  test("binds the data store to the route appId, isolated from other apps", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const routeApp = await makeApp();
    const otherApp = await makeApp({ organizationId: routeApp.organizationId });
    const user = await makeUser();
    await makeMember(user.id, routeApp.organizationId, { role: "member" });
    app = await buildApp(user.id, routeApp.organizationId);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${routeApp.id}`,
      headers: JSON_RPC_HEADERS,
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: getArchestraToolFullName(TOOL_APP_DATA_SET_SHORT_NAME),
          arguments: { key: "secret", value: { n: 42 } },
        },
        id: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.result?.isError ?? false).toBe(false);

    // The write landed on the route app, never on the other accessible app.
    expect(await AppDataModel.get(routeApp.id, "secret")).toEqual({ n: 42 });
    expect(await AppDataModel.get(otherApp.id, "secret")).toBeNull();
  });
});
