import { createHash } from "node:crypto";
import { prepareAppEnvelope } from "@archestra/app-runtime-rs";
import {
  getArchestraAppResourceUri,
  getArchestraToolFullName,
  TOOL_APP_DATA_GET_SHORT_NAME,
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
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import { AppDataModel, TeamTokenModel, UserTokenModel } from "@/models";
import {
  appConnectorAudienceRef,
  buildConnectorResourceUri,
} from "@/services/apps/app-connector-resource";
import { APP_PLATFORM_CSP } from "@/services/apps/app-ui-policy";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import mcpAppProxyRoutes from "./mcp-app-proxy";

// The app HTML envelope (injection bytes) lives in app_runtime_core and is
// covered by its table tests + the app-runtime-rs smoke test. Mock the native
// here so the route tests run without the built .node (matching the sandbox-rs
// convention) and assert the gateway's wiring rather than the envelope bytes.
vi.mock("@archestra/app-runtime-rs", () => ({
  prepareAppEnvelope: vi.fn((html: string) => `<!--app-envelope-->${html}`),
}));

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

// External-client harness: no session preHandler, mirroring how the auth
// middleware skips its session check for Bearer requests to this path. The
// route must authenticate the Bearer token itself.
async function buildBearerApp(): Promise<FastifyInstance> {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
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

const bearer = (token: string) => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  authorization: `Bearer ${token}`,
});

const JSON_RPC_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

// The OAuth path validates the token's audience against the connector URI the
// route derives from the request origin, so pin the host and bind tokens to the
// matching canonical URI.
const bearerLocal = (token: string) => ({
  ...bearer(token),
  host: "localhost",
});
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
const connectorRef = (appId: string) =>
  appConnectorAudienceRef(
    buildConnectorResourceUri("http://localhost", appId) as string,
  );

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

  // Dispatch (mcp-client validateAndGetTool) resolves an unprefixed name via
  // the "__<name>" suffix fallback; the guard must apply the same resolution
  // or a tool reachable at dispatch is rejected before execution.
  test("the suffix form of an assigned tool passes the guard; an unassigned suffix does not", async ({
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
      name: "server__suffix_reachable",
      parameters: {},
      catalogId: catalog.id,
    });
    await makeAppTool(created.id, tool.id);
    app = await buildApp(user.id, created.organizationId);

    const call = (name: string) =>
      app.inject({
        method: "POST",
        url: `/api/mcp/app/${created.id}`,
        headers: JSON_RPC_HEADERS,
        payload: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name, arguments: {} },
          id: 1,
        },
      });

    // bare suffix of an assigned tool: past the guard (the call then proceeds
    // to real dispatch, whose own failure modes are not the guard's -32601)
    const allowed = await call("suffix_reachable");
    expect(allowed.statusCode).toBe(200);
    expect(JSON.stringify(allowed.json())).not.toContain(
      "not assigned to this app",
    );

    const denied = await call("not_a_tool");
    expect(denied.json().error?.message).toContain("not assigned to this app");
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

  test("resources/read serves the app's head-version HTML with the runtime bridge injected", async ({
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
        params: { uri: getArchestraAppResourceUri(created.id) },
        id: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    const content = response.json().result.contents[0];
    // The envelope transform (anchor/escaping/injection bytes) is covered by the
    // app_runtime_core table tests; here we assert the gateway invoked it with
    // the stored HTML and the per-viewer context, and served its output back.
    expect(content.text).toContain("<h1>hello app</h1>");
    expect(content.text.startsWith("<!--app-envelope-->")).toBe(true);
    expect(vi.mocked(prepareAppEnvelope)).toHaveBeenCalledWith(
      "<h1>hello app</h1>",
      expect.stringContaining(`"id":"${user.id}"`),
      expect.any(String),
      expect.any(String),
    );
    expect(content.mimeType).toContain("text/html");
  });

  test("resources/read pins the platform CSP", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const created = await makeApp({ html: "<h1>locked</h1>" });
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
        params: { uri: getArchestraAppResourceUri(created.id) },
        id: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    const meta = response.json().result.contents[0]._meta;
    expect(meta.ui.csp).toEqual(APP_PLATFORM_CSP);
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

    // The write landed on the route app — in the session user's partition,
    // since scope defaults to "user" — and never on the other accessible app.
    expect(
      await AppDataModel.get({
        appId: routeApp.id,
        userId: user.id,
        key: "secret",
      }),
    ).toMatchObject({ key: "secret", value: { n: 42 }, owner: null });
    expect(
      await AppDataModel.get({
        appId: routeApp.id,
        userId: null,
        key: "secret",
      }),
    ).toBeNull();
    expect(
      await AppDataModel.get({
        appId: otherApp.id,
        userId: user.id,
        key: "secret",
      }),
    ).toBeNull();
  });

  test("tools/list advertises the synthetic launch tool with its UI resource", async ({
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
    const launch = response
      .json()
      .result.tools.find((t: { name: string }) => t.name === "open");
    expect(launch?._meta?.ui?.resourceUri).toBe(
      getArchestraAppResourceUri(created.id),
    );
  });

  test("the launch tool is callable and returns the app's UI resource", async ({
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
        params: { name: "open", arguments: {} },
        id: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Not rejected by the assignment gate, and carries the UI resource.
    expect(JSON.stringify(body)).not.toContain("not assigned to this app");
    expect(body.result?._meta?.ui?.resourceUri).toBe(
      getArchestraAppResourceUri(created.id),
    );
  });

  test("resources/read rejects a URI that is not this app's own", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const created = await makeApp();
    const other = await makeApp({ organizationId: created.organizationId });
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
        params: { uri: getArchestraAppResourceUri(other.id) },
        id: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().error?.code).toBe(-32002);
  });

  // ---- External MCP clients (Bearer token) ----

  test("a user token round-trips the App Data Store over the Bearer path", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const created = await makeApp();
    const user = await makeUser();
    await makeMember(user.id, created.organizationId, { role: "member" });
    const { value } = await UserTokenModel.create(
      user.id,
      created.organizationId,
    );
    app = await buildBearerApp();

    const set = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${created.id}`,
      headers: bearer(value),
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: getArchestraToolFullName(TOOL_APP_DATA_SET_SHORT_NAME),
          arguments: { key: "k", value: { v: 1 } },
        },
        id: 1,
      },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().result?.isError ?? false).toBe(false);

    const get = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${created.id}`,
      headers: bearer(value),
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: getArchestraToolFullName(TOOL_APP_DATA_GET_SHORT_NAME),
          arguments: { key: "k" },
        },
        id: 2,
      },
    });
    expect(get.statusCode).toBe(200);
    // The viewer bound from the token wrote/read its own partition.
    expect(
      await AppDataModel.get({ appId: created.id, userId: user.id, key: "k" }),
    ).toMatchObject({ value: { v: 1 } });
  });

  test("rejects an organization token (no viewer) with a clear error", async ({
    makeApp,
  }) => {
    const created = await makeApp();
    const { value } = await TeamTokenModel.create({
      organizationId: created.organizationId,
      teamId: null,
      isOrganizationToken: true,
      name: "Org Token",
    });
    app = await buildBearerApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${created.id}`,
      headers: bearer(value),
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error?.message).toContain("user-scoped token");
  });

  test("rejects an invalid Bearer token", async ({ makeApp }) => {
    const created = await makeApp();
    app = await buildBearerApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${created.id}`,
      headers: bearer("archestra_not_a_real_token"),
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    expect(response.statusCode).toBe(401);
    // No valid token → RFC 9728 challenge so the client can discover the AS.
    expect(response.headers["www-authenticate"]).toContain("resource_metadata");
  });

  test("a user token cannot reach an app its viewer may not see", async ({
    makeApp,
    makeUser,
    makeMember,
    makeOrganization,
  }) => {
    const created = await makeApp({ scope: "personal" });
    // A user in a different organization holds a valid token, but cannot view
    // this app — visibility is enforced from the token's viewer.
    const otherOrg = await makeOrganization();
    const outsider = await makeUser();
    await makeMember(outsider.id, otherOrg.id, { role: "admin" });
    const { value } = await UserTokenModel.create(outsider.id, otherOrg.id);
    app = await buildBearerApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${created.id}`,
      headers: bearer(value),
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    expect(response.statusCode).toBe(403);
  });

  test("returns 404 on the Bearer path when the apps feature is disabled", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const created = await makeApp();
    const user = await makeUser();
    await makeMember(user.id, created.organizationId, { role: "member" });
    const { value } = await UserTokenModel.create(
      user.id,
      created.organizationId,
    );
    (config.apps as { enabled: boolean }).enabled = false;
    app = await buildBearerApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${created.id}`,
      headers: bearer(value),
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    (config.apps as { enabled: boolean }).enabled = true;
    expect(response.statusCode).toBe(404);
  });

  test("accepts an audience-bound OAuth token and hides llm_complete from the model", async ({
    makeApp,
    makeUser,
    makeMember,
    makeOAuthClient,
    makeOAuthAccessToken,
  }) => {
    const created = await makeApp();
    const user = await makeUser();
    await makeMember(user.id, created.organizationId, { role: "admin" });
    const client = await makeOAuthClient({ userId: user.id });
    const rawToken = `connector-${crypto.randomUUID()}`;
    await makeOAuthAccessToken(client.clientId, user.id, {
      token: sha256(rawToken),
      referenceId: connectorRef(created.id),
      scopes: ["mcp"],
    });
    app = await buildBearerApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${created.id}`,
      headers: bearerLocal(rawToken),
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    expect(response.statusCode).toBe(200);
    const tools = response.json().result.tools as Array<{
      name: string;
      _meta?: { ui?: { visibility?: string[] } };
    }>;
    expect(tools.map((t) => t.name)).toContain("open");
    // The runtime LLM completion stays listed but app-only, so a foreign host's
    // model can't invoke it; the data store stays model-visible.
    const llm = tools.find((t) => t.name === "archestra__llm_complete");
    expect(llm?._meta?.ui?.visibility).toEqual(["app"]);
    const dataGet = tools.find((t) => t.name === "archestra__app_data_get");
    expect(dataGet).toBeDefined();
    expect(dataGet?._meta?.ui?.visibility).not.toEqual(["app"]);
  });

  test("rejects an OAuth token bound to another app's connector (wrong audience)", async ({
    makeApp,
    makeUser,
    makeMember,
    makeOAuthClient,
    makeOAuthAccessToken,
  }) => {
    const created = await makeApp();
    const otherApp = await makeApp();
    const user = await makeUser();
    await makeMember(user.id, created.organizationId, { role: "member" });
    const client = await makeOAuthClient({ userId: user.id });
    const rawToken = `connector-${crypto.randomUUID()}`;
    await makeOAuthAccessToken(client.clientId, user.id, {
      token: sha256(rawToken),
      referenceId: connectorRef(otherApp.id),
      scopes: ["mcp"],
    });
    app = await buildBearerApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${created.id}`,
      headers: bearerLocal(rawToken),
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("resource_metadata");
  });

  test("rejects an unbound OAuth token (no audience)", async ({
    makeApp,
    makeUser,
    makeMember,
    makeOAuthClient,
    makeOAuthAccessToken,
  }) => {
    const created = await makeApp();
    const user = await makeUser();
    await makeMember(user.id, created.organizationId, { role: "member" });
    const client = await makeOAuthClient({ userId: user.id });
    const rawToken = `connector-${crypto.randomUUID()}`;
    await makeOAuthAccessToken(client.clientId, user.id, {
      token: sha256(rawToken),
      referenceId: null,
      scopes: ["mcp"],
    });
    app = await buildBearerApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${created.id}`,
      headers: bearerLocal(rawToken),
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    expect(response.statusCode).toBe(401);
  });

  test("rejects an audience-bound OAuth token lacking the mcp scope", async ({
    makeApp,
    makeUser,
    makeMember,
    makeOAuthClient,
    makeOAuthAccessToken,
  }) => {
    const created = await makeApp();
    const user = await makeUser();
    await makeMember(user.id, created.organizationId, { role: "admin" });
    const client = await makeOAuthClient({ userId: user.id });
    const rawToken = `connector-${crypto.randomUUID()}`;
    // Correctly audience-bound to this connector, but consented only to a lesser
    // scope — audience binding is not consent, so the connector must reject it.
    await makeOAuthAccessToken(client.clientId, user.id, {
      token: sha256(rawToken),
      referenceId: connectorRef(created.id),
      scopes: ["openid", "profile"],
    });
    app = await buildBearerApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${created.id}`,
      headers: bearerLocal(rawToken),
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("resource_metadata");
  });

  test("rejects an expired audience-bound OAuth token", async ({
    makeApp,
    makeUser,
    makeMember,
    makeOAuthClient,
    makeOAuthAccessToken,
  }) => {
    const created = await makeApp();
    const user = await makeUser();
    await makeMember(user.id, created.organizationId, { role: "member" });
    const client = await makeOAuthClient({ userId: user.id });
    const rawToken = `connector-${crypto.randomUUID()}`;
    await makeOAuthAccessToken(client.clientId, user.id, {
      token: sha256(rawToken),
      referenceId: connectorRef(created.id),
      scopes: ["mcp"],
      expiresAt: new Date(Date.now() - 1000),
    });
    app = await buildBearerApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${created.id}`,
      headers: bearerLocal(rawToken),
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    expect(response.statusCode).toBe(401);
  });

  test("rejects an audience-bound OAuth token whose refresh token was revoked", async ({
    makeApp,
    makeUser,
    makeMember,
    makeOAuthClient,
    makeOAuthRefreshToken,
    makeOAuthAccessToken,
  }) => {
    const created = await makeApp();
    const user = await makeUser();
    await makeMember(user.id, created.organizationId, { role: "member" });
    const client = await makeOAuthClient({ userId: user.id });
    const refresh = await makeOAuthRefreshToken(client.clientId, user.id, {
      revoked: new Date(),
    });
    const rawToken = `connector-${crypto.randomUUID()}`;
    await makeOAuthAccessToken(client.clientId, user.id, {
      token: sha256(rawToken),
      referenceId: connectorRef(created.id),
      scopes: ["mcp"],
      refreshId: refresh.id,
    });
    app = await buildBearerApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${created.id}`,
      headers: bearerLocal(rawToken),
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    expect(response.statusCode).toBe(401);
  });

  test("rejects an audience-bound OAuth token whose viewer is not a member of the app's org", async ({
    makeApp,
    makeUser,
    makeOAuthClient,
    makeOAuthAccessToken,
  }) => {
    const created = await makeApp();
    // A valid, correctly-bound token, but the viewer never joined the app's org.
    const outsider = await makeUser();
    const client = await makeOAuthClient({ userId: outsider.id });
    const rawToken = `connector-${crypto.randomUUID()}`;
    await makeOAuthAccessToken(client.clientId, outsider.id, {
      token: sha256(rawToken),
      referenceId: connectorRef(created.id),
      scopes: ["mcp"],
    });
    app = await buildBearerApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/app/${created.id}`,
      headers: bearerLocal(rawToken),
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    expect(response.statusCode).toBe(401);
  });
});
