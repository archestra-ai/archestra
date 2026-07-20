import { ADMIN_ROLE_NAME, getArchestraAppResourceUri } from "@archestra/shared";
import mcpClient from "@/clients/mcp-client";
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
  afterEach,
  beforeEach,
  describe,
  expect,
  mustExist,
  test,
} from "@/test";
import type { User } from "@/types";

describe("MCP backing for apps", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

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

  test("creating an app provisions a serverType:'app' catalog, server, and open launch tool", async () => {
    const appId = await createApp();

    const created = mustExist(await AppModel.findById(appId));
    expect(created.mcpServerId).toBeTruthy();

    const server = mustExist(
      await McpServerModel.findById(mustExist(created.mcpServerId)),
    );
    expect(server.serverType).toBe("app");
    expect(server.catalogId).toBeTruthy();

    const catalog = await InternalMcpCatalogModel.findById(server.catalogId);
    expect(catalog?.serverType).toBe("app");

    const tools = await ToolModel.findByCatalogIdWithMeta(server.catalogId);
    // The launch tool is slugified per the discovered-tool convention
    // (`<server>__open`) so apps don't collide in the gateway's
    // dedupe-by-name; it is the only tool on the app's catalog.
    expect(tools).toHaveLength(1);
    const openTool = tools[0];
    expect(openTool.name.endsWith("__open")).toBe(true);
    // The tool points at the app's ui:// resource and stores no CSP (the CSP
    // floor is applied at serve time, never persisted).
    const ui = (openTool?.meta as { _meta?: { ui?: Record<string, unknown> } })
      ?._meta?.ui;
    expect(ui?.resourceUri).toBe(getArchestraAppResourceUri(appId));
    expect(ui?.csp).toBeUndefined();
  });

  const launchToolResourceUri = (tool: {
    meta?: unknown;
  }): string | undefined =>
    (tool.meta as { _meta?: { ui?: { resourceUri?: string } } })?._meta?.ui
      ?.resourceUri;

  test("a disabled app's launch tool is withheld from dynamic discovery until enabled", async () => {
    const appId = await createApp("org");
    await AppModel.setEnabled(appId, false);
    const uri = getArchestraAppResourceUri(appId);
    const discovered = async () =>
      (
        await ToolModel.getMcpToolsAccessibleToUser({
          userId: user.id,
          organizationId,
          isAdmin: true,
          environmentId: null,
          requireUiResource: true,
        })
      ).some((t) => launchToolResourceUri(t) === uri);

    expect(await discovered()).toBe(false);
    await AppModel.setEnabled(appId, true);
    expect(await discovered()).toBe(true);
  });

  test("a disabled app's launch tool stays assigned but hidden from the author's gateway, and reappears when enabled", async () => {
    const appId = await createApp("org"); // auto-assigned to the author's gateway
    await AppModel.setEnabled(appId, false);
    const uri = getArchestraAppResourceUri(appId);
    const personalGateway = await AgentModel.ensurePersonalMcpGateway({
      userId: user.id,
      organizationId,
    });
    const gatewayHasLaunch = async () =>
      (await ToolModel.getMcpToolsByAgent(personalGateway.id)).some(
        (t) => launchToolResourceUri(t) === uri,
      );

    // Assigned at create, but withheld while disabled...
    expect(await gatewayHasLaunch()).toBe(false);
    // ...enabling surfaces it without re-assigning (the assignment persisted)...
    await AppModel.setEnabled(appId, true);
    expect(await gatewayHasLaunch()).toBe(true);
    // ...and disabling hides it again.
    await AppModel.setEnabled(appId, false);
    expect(await gatewayHasLaunch()).toBe(false);
  });

  test("a disabled app's launch tool assigned to another app is withheld until enabled, and reappears when enabled", async ({
    makeApp,
    makeAppTool,
  }) => {
    // The source app owns the launch tool being consumed elsewhere.
    const sourceAppId = await createApp("org");
    await AppModel.setEnabled(sourceAppId, false);
    const sourceServer = await McpServerModel.findById(
      (await AppModel.findById(sourceAppId))!.mcpServerId!,
    );
    const launchTool = (
      await ToolModel.findByCatalogIdWithMeta(sourceServer!.catalogId)
    )[0];

    // A second, unrelated app has the source app's launch tool assigned to it
    // (app-to-app tool assignment, e.g. one app driving another's UI resource).
    const consumerApp = await makeApp({ organizationId });
    await makeAppTool(consumerApp.id, launchTool.id);

    const consumerCanResolve = async () =>
      (
        await ToolModel.getMcpToolsAssignedToApp(
          [launchTool.name],
          consumerApp.id,
        )
      ).length > 0;

    // Withheld while the source app is disabled...
    expect(await consumerCanResolve()).toBe(false);
    // ...surfaces once enabled (the assignment was never deleted)...
    await AppModel.setEnabled(sourceAppId, true);
    expect(await consumerCanResolve()).toBe(true);
    // ...and is withheld again if the source app is disabled again.
    await AppModel.setEnabled(sourceAppId, false);
    expect(await consumerCanResolve()).toBe(false);
  });

  test("two apps get distinct slugified launch-tool names (no gateway collision)", async () => {
    const appAId = await createApp();
    const appBId = await app
      .inject({
        method: "POST",
        url: "/api/apps",
        payload: {
          name: "Second Dashboard",
          html: "<html><head></head><body><h1>2</h1></body></html>",
          scope: "org",
        },
      })
      .then((r) => r.json().id as string);

    const nameFor = async (appId: string) => {
      const a = mustExist(await AppModel.findById(appId));
      const s = mustExist(
        await McpServerModel.findById(mustExist(a.mcpServerId)),
      );
      const [t] = await ToolModel.findByCatalogIdWithMeta(s.catalogId);
      return t.name;
    };
    const nameA = await nameFor(appAId);
    const nameB = await nameFor(appBId);
    expect(nameA).not.toBe(nameB);
    expect(nameA.endsWith("__open")).toBe(true);
    expect(nameB.endsWith("__open")).toBe(true);
  });

  test("same-named apps from distinct authors get distinct launch-tool names", async ({
    makeApp,
  }) => {
    // Uniqueness is per author, so two members may each publish a shared app
    // with the same name; their launch tools must NOT both slugify to
    // `<name>__open` or one shadows the other in a shared gateway profile.
    const first = await makeApp({
      name: "Dashboard",
      scope: "org",
      organizationId,
    });
    const second = await makeApp({
      name: "Dashboard",
      scope: "org",
      organizationId,
    });
    const nameFor = async (appId: string) => {
      const a = mustExist(await AppModel.findById(appId));
      const s = mustExist(
        await McpServerModel.findById(mustExist(a.mcpServerId)),
      );
      const [t] = await ToolModel.findByCatalogIdWithMeta(s.catalogId);
      return t.name;
    };
    const nameA = await nameFor(first.id);
    const nameB = await nameFor(second.id);
    expect(nameA).not.toBe(nameB);
    expect(nameA.endsWith("__open")).toBe(true);
    expect(nameB.endsWith("__open")).toBe(true);
  });

  test("the app backing catalog is excluded from external UI-capable detection (no double-listing)", async () => {
    const appId = await createApp();
    const created = mustExist(await AppModel.findById(appId));
    const backing = mustExist(
      await McpServerModel.findById(mustExist(created.mcpServerId)),
    );

    const uiCapable = await McpServerModel.findUiCapableForCaller({
      userId: user.id,
      organizationId,
    });
    expect(uiCapable.some((c) => c.catalogId === backing.catalogId)).toBe(
      false,
    );
  });

  test("app resource read is gated by app visibility, not a claimed URI (IDOR gate)", async ({
    makeUser,
    makeMember,
  }) => {
    const appId = await createApp("personal"); // viewable only by `user`
    const uri = getArchestraAppResourceUri(appId);
    const personalGateway = await AgentModel.ensurePersonalMcpGateway({
      userId: user.id,
      organizationId,
    });
    const authFor = (userId: string, tokenId: string) => ({
      tokenId,
      teamId: null,
      isOrganizationToken: false,
      organizationId,
      userId,
    });

    // The author can view the app → served.
    const served = await mcpClient.readResource(
      uri,
      personalGateway.id,
      authFor(user.id, "t"),
    );
    expect(served.contents[0]?.uri).toBe(uri);

    // A different member who cannot view this personal app is refused, even
    // reading by the exact ui:// URI (the gate is the app's own visibility).
    const other = await makeUser();
    await makeMember(other.id, organizationId);
    await expect(
      mcpClient.readResource(uri, personalGateway.id, authFor(other.id, "t2")),
    ).rejects.toThrow();
  });

  test("an app's backing catalog cannot be hijacked via the generic catalog update", async () => {
    const appId = await createApp();
    const created = mustExist(await AppModel.findById(appId));
    const server = mustExist(
      await McpServerModel.findById(mustExist(created.mcpServerId)),
    );
    const catalogId = server.catalogId;

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
    const created = mustExist(await AppModel.findById(appId));
    const server = mustExist(
      await McpServerModel.findById(mustExist(created.mcpServerId)),
    );
    const catalogId = server.catalogId;

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

    expect((await McpServerModel.findById(server.id))?.scope).toBe("org");
    expect((await AppModel.findById(appId))?.scope).toBe("org");

    await catalogApp.close();
  });

  test("editing an app via REST PATCH propagates name + scope to the backing catalog", async () => {
    const appId = await createApp("personal");
    const created = mustExist(await AppModel.findById(appId));
    const mcpServerId = mustExist(created.mcpServerId);
    const catalogId = mustExist(
      await McpServerModel.findById(mcpServerId),
    ).catalogId;
    const [toolBefore] = await ToolModel.findByCatalogIdWithMeta(catalogId);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/apps/${appId}`,
      payload: { name: "Renamed Dashboard", scope: "org" },
    });
    expect(res.statusCode).toBe(200);

    const catalog = await InternalMcpCatalogModel.findById(catalogId);
    expect(catalog?.name).toBe("Renamed Dashboard");
    expect(catalog?.scope).toBe("org");
    const renamedServer = await McpServerModel.findById(mcpServerId);
    expect(renamedServer?.scope).toBe("org");
    expect(renamedServer?.name).toBe("Renamed Dashboard");
    // The launch tool name is id-suffixed (stable + globally unique), so a
    // rename does NOT re-slugify it — that can't reintroduce a dedupe collision.
    const [toolAfter] = await ToolModel.findByCatalogIdWithMeta(catalogId);
    expect(toolAfter.name).toBe(toolBefore.name);
    expect(toolAfter.name.endsWith("__open")).toBe(true);
    // The launch tool's derived description IS refreshed on rename, so stored
    // metadata never keeps a stale (or pre-sanitization) app name.
    expect(toolAfter.description).toContain("Renamed Dashboard");
    expect(toolAfter.description).not.toBe(toolBefore.description);
  });

  test("deleting an app tears down its backing catalog and server", async () => {
    const appId = await createApp();
    const created = mustExist(await AppModel.findById(appId));
    const mcpServerId = mustExist(created.mcpServerId);
    const server = mustExist(await McpServerModel.findById(mcpServerId));
    const catalogId = server.catalogId;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/apps/${appId}`,
    });
    expect(del.statusCode).toBe(200);

    expect(await McpServerModel.findById(mcpServerId)).toBeNull();
    expect(await InternalMcpCatalogModel.findById(catalogId)).toBeNull();
  });
});
