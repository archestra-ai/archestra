import { ADMIN_ROLE_NAME, getArchestraAppResourceUri } from "@archestra/shared";
import mcpClient from "@/clients/mcp-client";
import config from "@/config";
import {
  AgentModel,
  AppModel,
  InternalMcpCatalogModel,
  McpServerModel,
  ToolModel,
} from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import type { User } from "@/types";

describe("MCP backing for apps", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  const appsEnabled = config.apps.enabled;
  beforeAll(() => {
    (config.apps as { enabled: boolean }).enabled = true;
  });
  afterAll(() => {
    (config.apps as { enabled: boolean }).enabled = appsEnabled;
  });

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: appRoutes } = await import("./app.routes");
    await app.register(appRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function createApp(scope: "personal" | "org" = "org"): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "Dashboard",
        html: "<html><head></head><body><h1>ok</h1></body></html>",
        scope,
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json().id as string;
  }

  test("creating an app provisions a serverType:'app' catalog, server, and show_app tool", async () => {
    const appId = await createApp();

    const created = await AppModel.findById(appId);
    expect(created?.mcpServerId).toBeTruthy();

    const server = await McpServerModel.findById(created!.mcpServerId!);
    expect(server?.serverType).toBe("app");
    expect(server?.catalogId).toBeTruthy();

    const catalog = await InternalMcpCatalogModel.findById(server!.catalogId);
    expect(catalog?.serverType).toBe("app");

    const tools = await ToolModel.findByCatalogIdWithMeta(server!.catalogId);
    const showApp = tools.find((t) => t.name === "show_app");
    expect(showApp).toBeTruthy();
    // The tool points at the app's ui:// resource and stores no CSP (the CSP
    // floor is applied at serve time, never persisted).
    const ui = (showApp?.meta as { _meta?: { ui?: Record<string, unknown> } })
      ?._meta?.ui;
    expect(ui?.resourceUri).toBe(getArchestraAppResourceUri(appId));
    expect(ui?.csp).toBeUndefined();
  });

  test("the app backing server is excluded from external UI-capable detection (no double-listing)", async () => {
    const appId = await createApp();
    const created = await AppModel.findById(appId);

    const uiCapable = await McpServerModel.findUiCapableForCaller({
      userId: user.id,
      isMcpServerAdmin: true,
    });
    expect(uiCapable.some((s) => s.mcpServerId === created!.mcpServerId)).toBe(
      false,
    );
  });

  test("app resource is served only to an agent that has the show_app tool (IDOR gate)", async ({
    makeAgent,
  }) => {
    const appId = await createApp();
    const uri = getArchestraAppResourceUri(appId);
    const tokenAuth = {
      tokenId: "t",
      teamId: null,
      isOrganizationToken: false,
      organizationId,
      userId: user.id,
    };

    // The creator's personal gateway was auto-assigned show_app → authorized.
    const personalGateway = await AgentModel.ensurePersonalMcpGateway({
      userId: user.id,
      organizationId,
    });
    const served = await mcpClient.readResource(
      uri,
      personalGateway.id,
      tokenAuth,
    );
    expect(served.contents[0]?.uri).toBe(uri);

    // An agent that was never assigned show_app must not be able to read the
    // app's HTML by id alone.
    const otherAgent = await makeAgent({ organizationId, name: "Other" });
    await expect(
      mcpClient.readResource(uri, otherAgent.id, tokenAuth),
    ).rejects.toThrow();
  });

  test("an app's backing catalog cannot be hijacked via the generic catalog update", async () => {
    const appId = await createApp();
    const created = await AppModel.findById(appId);
    const server = await McpServerModel.findById(created!.mcpServerId!);
    const catalogId = server!.catalogId;

    const catalogApp = createFastifyInstance();
    catalogApp.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });
    const { default: catalogRoutes } = await import("../internal-mcp-catalog");
    await catalogApp.register(catalogRoutes);

    // Attempt to flip the app catalog to a deployable type and inject a command.
    const res = await catalogApp.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalogId}`,
      payload: { serverType: "local", installationCommand: "echo pwned" },
    });
    expect(res.statusCode).toBe(200);

    const after = await InternalMcpCatalogModel.findById(catalogId);
    expect(after?.serverType).toBe("app");
    expect(after?.installationCommand ?? null).toBeNull();

    await catalogApp.close();
  });

  test("editing an app catalog's scope propagates to the app and backing server", async () => {
    const appId = await createApp("personal");
    const created = await AppModel.findById(appId);
    const server = await McpServerModel.findById(created!.mcpServerId!);
    const catalogId = server!.catalogId;

    const catalogApp = createFastifyInstance();
    catalogApp.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });
    const { default: catalogRoutes } = await import("../internal-mcp-catalog");
    await catalogApp.register(catalogRoutes);

    const res = await catalogApp.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalogId}`,
      payload: { serverType: "app", scope: "org" },
    });
    expect(res.statusCode).toBe(200);

    expect((await McpServerModel.findById(server!.id))?.scope).toBe("org");
    expect((await AppModel.findById(appId))?.scope).toBe("org");

    await catalogApp.close();
  });

  test("editing an app via REST PATCH propagates name + scope to the backing catalog", async () => {
    const appId = await createApp("personal");
    const created = await AppModel.findById(appId);
    const catalogId = (await McpServerModel.findById(created!.mcpServerId!))!
      .catalogId;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/apps/${appId}`,
      payload: { name: "Renamed Dashboard", scope: "org" },
    });
    expect(res.statusCode).toBe(200);

    const catalog = await InternalMcpCatalogModel.findById(catalogId);
    expect(catalog?.name).toBe("Renamed Dashboard");
    expect(catalog?.scope).toBe("org");
    expect((await McpServerModel.findById(created!.mcpServerId!))?.scope).toBe(
      "org",
    );
  });

  test("deleting an app tears down its backing catalog and server", async () => {
    const appId = await createApp();
    const created = await AppModel.findById(appId);
    const mcpServerId = created!.mcpServerId!;
    const server = await McpServerModel.findById(mcpServerId);
    const catalogId = server!.catalogId;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/apps/${appId}`,
    });
    expect(del.statusCode).toBe(200);

    expect(await McpServerModel.findById(mcpServerId)).toBeNull();
    expect(await InternalMcpCatalogModel.findById(catalogId)).toBeNull();
  });
});
