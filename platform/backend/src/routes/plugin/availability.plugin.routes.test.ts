import { describe, expect } from "vitest";
import config from "@/config";
import { test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import pluginRoutes from "./plugin.routes";

describe("plugins with beta disabled", () => {
  const ctx = useRouteTestApp(pluginRoutes);

  test("lists plugins while beta is off", async () => {
    config.beta = false;
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/plugins",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});
