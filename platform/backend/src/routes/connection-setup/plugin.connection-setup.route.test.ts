import type { ResourcePermissionAction } from "@archestra/shared";
import { vi } from "vitest";
import { userHasPermission } from "@/auth";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { ConnectionSetupModel, PluginModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { PLUGIN_DELIVERY_MAX_COUNT, type User } from "@/types";

vi.mock("@/auth");
vi.mock("@/cache-manager");

const mockUserHasPermission = vi.mocked(userHasPermission);

describe("POST /api/connection-setups with plugins", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId);
    mockUserHasPermission.mockReset();
    mockUserHasPermission.mockResolvedValue(true);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });
    const { default: connectionSetupRoutes } = await import(
      "./connection-setup.routes"
    );
    await app.register(connectionSetupRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("Grok refuses explicit plugin delivery without creating a setup", async () => {
    const plugin = await seedPlugin("claude-code");
    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "grok-build",
        platform: "windows",
        baseUrl: "http://localhost:9000/v1",
        pluginIds: [plugin.id],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("native skills only");
  });

  test("freezes reviewed plugins into a plugin-only setup", async () => {
    const plugin = await seedPlugin("claude-code");
    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        platform: "macos",
        baseUrl: "http://localhost:9000/v1",
        pluginIds: [plugin.id],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().plugins).toEqual([
      {
        id: plugin.id,
        pluginSlug: plugin.pluginSlug,
        displayName: "claude-code plugin",
        clientType: "claude-code",
      },
    ]);
    expect(
      await ConnectionSetupModel.getPluginIds({
        connectionSetupId: response.json().id,
      }),
    ).toEqual([plugin.id]);
  });

  test("a Claude Desktop setup bundles Desktop plugins and refuses Claude Code ones", async ({
    makeAgent,
  }) => {
    const desktopPlugin = await seedPlugin("claude-desktop");
    const codePlugin = await seedPlugin("claude-code");
    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
      name: "Desktop plugin gateway",
    });

    const implicit = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-desktop",
        platform: "macos",
        baseUrl: "http://localhost:9000/v1",
        mcpGatewayId: gateway.id,
      },
    });
    expect(implicit.statusCode).toBe(200);
    expect(
      await ConnectionSetupModel.getPluginIds({
        connectionSetupId: implicit.json().id,
      }),
    ).toEqual([desktopPlugin.id]);

    const explicit = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-desktop",
        platform: "macos",
        baseUrl: "http://localhost:9000/v1",
        pluginIds: [codePlugin.id],
      },
    });
    expect(explicit.statusCode).toBe(400);
    expect(explicit.body).toContain(
      "Plugins must target the selected connection client",
    );
  });

  test("rejects reviewed hooks for the wrong client or Windows", async () => {
    const plugin = await seedPlugin("claude-code");

    const wrongClient = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "codex",
        platform: "macos",
        baseUrl: "http://localhost:9000/v1",
        pluginIds: [plugin.id],
      },
    });
    expect(wrongClient.statusCode).toBe(400);

    const windows = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        platform: "windows",
        baseUrl: "http://localhost:9000/v1",
        pluginIds: [plugin.id],
      },
    });
    expect(windows.statusCode).toBe(400);
  });

  test("accepts a reviewed plugin explicitly marked for Windows", async () => {
    const plugin = await seedPlugin("claude-code", ["windows"]);
    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        platform: "windows",
        baseUrl: "http://localhost:9000/v1",
        pluginIds: [plugin.id],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().plugins).toEqual([
      expect.objectContaining({
        id: plugin.id,
        displayName: "claude-code plugin",
      }),
    ]);
  });

  test("installs a plugin only with a use grant on it, and only reviewed IDs once", async ({
    makeUser,
    makeMember,
  }) => {
    const author = await makeUser();
    await makeMember(author.id, organizationId);
    const viewable = await seedPlugin("claude-code", ["posix"], {
      authorId: author.id,
      actions: ["read"],
    });
    const usable = await seedPlugin("claude-code", ["posix"], {
      authorId: author.id,
      actions: ["read", "use"],
    });
    const own = await seedPlugin("claude-code");

    const refused = await postPluginSetup([own.id, viewable.id]);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain("use every selected plugin");
    const installed = await postPluginSetup([own.id, usable.id]);
    expect(installed.statusCode, installed.body).toBe(200);
    expect(
      installed.json().plugins.map((plugin: { id: string }) => plugin.id),
    ).toEqual(expect.arrayContaining([own.id, usable.id]));

    const duplicate = await postPluginSetup([own.id, own.id]);
    expect(duplicate.statusCode).toBe(400);
  });

  test("a setup that names no plugins delivers every plugin the user may use, and no other", async ({
    makeUser,
    makeMember,
  }) => {
    const author = await makeUser();
    await makeMember(author.id, organizationId);
    const own = await seedPlugin("claude-code");
    const shared = await seedPlugin("claude-code", ["posix"], {
      authorId: author.id,
      actions: ["read", "use"],
    });
    await seedPlugin("claude-code", ["posix"], {
      authorId: author.id,
      actions: ["read"],
    });
    await seedPlugin("claude-code", ["posix"], { authorId: author.id });

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        platform: "macos",
        baseUrl: "http://localhost:9000/v1",
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(
      response
        .json()
        .plugins.map((plugin: { id: string }) => plugin.id)
        .sort(),
    ).toEqual([own.id, shared.id].sort());
  });

  test("rejects explicit plugins and omits implicit plugins when Connect delivery is disabled", async ({
    makeAgent,
  }) => {
    const plugin = await seedPlugin("claude-code");
    const { OrganizationModel } = await import("@/models");
    await OrganizationModel.patch(organizationId, {
      connectionPluginsEnabled: false,
    });

    const explicit = await postPluginSetup([plugin.id]);
    expect(explicit.statusCode).toBe(403);
    expect(explicit.body).toContain(
      "Connecting plugins is disabled for this organization",
    );

    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
      name: "Plugin policy gateway",
    });
    const implicit = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        platform: "macos",
        baseUrl: "http://localhost:9000/v1",
        mcpGatewayId: gateway.id,
      },
    });

    expect(implicit.statusCode).toBe(200);
    expect(implicit.json().plugins).toEqual([]);
    expect(
      await ConnectionSetupModel.getPluginIds({
        connectionSetupId: implicit.json().id,
      }),
    ).toEqual([]);
  });

  test("rejects disabled and cross-organization plugins", async ({
    makeOrganization,
  }) => {
    const disabled = await seedPlugin("claude-code");
    await PluginModel.update({
      id: disabled.id,
      organizationId,
      userId: user.id,
      input: { enabled: false },
    });
    expect((await postPluginSetup([disabled.id])).statusCode).toBe(404);

    const otherOrganization = await makeOrganization();
    const foreign = await PluginModel.create({
      organizationId: otherOrganization.id,
      userId: user.id,
      input: {
        displayName: "Foreign plugin",
        description: "Other organization",
        clientType: "claude-code",
        files: [
          {
            path: "hooks/hooks.json",
            content: "{}\n",
            encoding: "utf8",
            mode: "100644",
          },
        ],
      },
    });
    if (!foreign) throw new Error("failed to seed foreign plugin");
    // Grants belong to an organization: the author's grant on a plugin of
    // another organization confers nothing here.
    expect((await postPluginSetup([foreign.id])).statusCode).toBe(403);
  });

  test("rejects an implicit all-Plugin setup before loading an oversized set", async () => {
    for (let index = 0; index <= PLUGIN_DELIVERY_MAX_COUNT; index++) {
      await seedPlugin("claude-code");
    }

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        platform: "macos",
        baseUrl: "http://localhost:9000/v1",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain(
      `Plugin delivery is limited to ${PLUGIN_DELIVERY_MAX_COUNT} plugins`,
    );
  });

  function postPluginSetup(pluginIds: string[]) {
    return app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        platform: "macos",
        baseUrl: "http://localhost:9000/v1",
        pluginIds,
      },
    });
  }

  /**
   * A plugin the test user authors, or, given `sharedBy`, one another member
   * authors and grants the test user `actions` on (none when omitted).
   */
  async function seedPlugin(
    clientType: "claude-code" | "claude-desktop" | "codex",
    supportedPlatforms: Array<"posix" | "windows"> = ["posix"],
    sharedBy?: { authorId: string; actions?: ResourcePermissionAction[] },
  ) {
    const plugin = await PluginModel.create({
      organizationId,
      userId: sharedBy?.authorId ?? user.id,
      initialPermissionGrants: sharedBy?.actions
        ? [
            {
              subject: { type: "user", id: user.id },
              actions: sharedBy.actions,
            },
          ]
        : [],
      input: {
        displayName: `${clientType} plugin`,
        description: "Connection setup test",
        clientType,
        supportedPlatforms,
        files: [
          {
            path: "hooks/hooks.json",
            content: "{}\n",
            encoding: "utf8",
            mode: "100644",
          },
        ],
      },
    });
    if (!plugin) throw new Error("failed to seed plugin");
    return plugin;
  }
});
