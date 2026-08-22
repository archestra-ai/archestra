import { vi } from "vitest";
import { describe, expect, test, useRouteTestApp } from "@/test";
import pluginRoutes from "./plugin.routes";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    plugins: { enabled: false },
  }),
);

describe("plugin feature gate", () => {
  const ctx = useRouteTestApp(pluginRoutes);

  test("returns not found while the deployment gate is off", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/plugins",
    });
    expect(response.statusCode).toBe(404);
  });
});
