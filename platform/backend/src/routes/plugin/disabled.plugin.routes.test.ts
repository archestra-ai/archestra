import { describe, expect } from "vitest";
import config from "@/config";
import { test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import pluginRoutes from "./plugin.routes";

describe("plugin feature gate", () => {
  const ctx = useRouteTestApp(pluginRoutes);

  test("returns not found while the deployment gate is off", async () => {
    config.plugins.enabled = false;
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/plugins",
    });
    expect(response.statusCode).toBe(404);
  });
});
