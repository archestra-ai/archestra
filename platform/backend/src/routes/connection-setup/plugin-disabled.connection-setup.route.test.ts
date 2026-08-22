import { vi } from "vitest";
import { PluginModel } from "@/models";
import { describe, expect, test, useRouteTestApp } from "@/test";
import connectionSetupRoutes from "./connection-setup.routes";

vi.mock("@/auth");
vi.mock("@/cache-manager");
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    plugins: { enabled: false },
  }),
);

describe("connection setup Plugin feature gate", () => {
  const ctx = useRouteTestApp(connectionSetupRoutes);

  test("rejects explicitly reviewed plugins while the feature is disabled", async () => {
    const plugin = await PluginModel.create({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      input: {
        displayName: "Disabled feature plugin",
        description: "Feature gate test",
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

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        platform: "macos",
        baseUrl: "http://localhost:9000/v1",
        pluginIds: [plugin.id],
      },
    });
    expect(response.statusCode).toBe(404);
  });
});
