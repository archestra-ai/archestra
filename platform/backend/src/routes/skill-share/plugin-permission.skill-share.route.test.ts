import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { vi } from "vitest";
import { userHasPermission } from "@/auth";
import { PluginModel } from "@/models";
import { describe, expect, test, useRouteTestApp } from "@/test";
import skillShareRoutes from "./skill-share.routes";

vi.mock("@/auth");
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    plugins: { enabled: true },
  }),
);

const mockUserHasPermission = vi.mocked(userHasPermission);

describe("executable marketplace link permissions", () => {
  const ctx = useRouteTestApp(skillShareRoutes);

  test("requires both plugin:read and plugin:admin", async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    const plugin = await PluginModel.create({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      input: {
        displayName: "Share permission hook",
        description: "Permission boundary test",
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
    if (!plugin) throw new Error("failed to seed plugin");

    for (const allowedAction of ["read", "admin"] as const) {
      mockUserHasPermission.mockImplementation(
        async (_userId, _organizationId, _resource, action) =>
          action === allowedAction,
      );
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/skill-share-links",
        payload: {
          skillIds: [],
          pluginIds: [plugin.id],
          pluginPlatform: "posix",
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      });
      expect(response.statusCode).toBe(403);
    }
  });
});
