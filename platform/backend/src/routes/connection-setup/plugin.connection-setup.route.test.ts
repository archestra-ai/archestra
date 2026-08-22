import { vi } from "vitest";
import { userHasPermission } from "@/auth";
import { ConnectionSetupModel, PluginModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { PLUGIN_DELIVERY_MAX_COUNT, type User } from "@/types";

vi.mock("@/auth");
vi.mock("@/cache-manager");
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    plugins: { enabled: true },
  }),
);

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

  test("requires plugin:admin and unique reviewed IDs", async () => {
    const plugin = await seedPlugin("claude-code");
    for (const allowedAction of ["read", "admin"] as const) {
      mockUserHasPermission.mockImplementation(
        async (_userId, _organizationId, _resource, action) =>
          action === allowedAction,
      );
      expect((await postPluginSetup([plugin.id])).statusCode).toBe(403);
    }

    mockUserHasPermission.mockResolvedValue(true);
    const duplicate = await postPluginSetup([plugin.id, plugin.id]);
    expect(duplicate.statusCode).toBe(400);
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
    expect((await postPluginSetup([foreign.id])).statusCode).toBe(404);
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

  async function seedPlugin(
    clientType: "claude-code" | "codex",
    supportedPlatforms: Array<"posix" | "windows"> = ["posix"],
  ) {
    const plugin = await PluginModel.create({
      organizationId,
      userId: user.id,
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
