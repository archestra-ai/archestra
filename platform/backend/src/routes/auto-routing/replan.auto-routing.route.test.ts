import config from "@/config";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import { beforeEach, describe, expect, test } from "@/test";
import { configureAutoRouting } from "@/test/auto-routing";
import { useRouteTestApp } from "@/test/route-test-app";
import autoRoutingRoutes from "./auto-routing.routes";

describe("POST /api/auto-routing/replan", () => {
  const ctx = useRouteTestApp(autoRoutingRoutes);
  beforeEach(() => {
    config.autoRouting.enabled = true;
  });

  test("bumps the generation past the planned one and changes nothing else", async ({
    makeOrganization,
  }) => {
    const trio = await configureAutoRouting(ctx.organizationId);
    const other = await makeOrganization();
    await configureAutoRouting(other.id);

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/auto-routing/replan",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ generation: 2 });
    expect(
      await AutoRoutingSettingsModel.find(ctx.organizationId),
    ).toMatchObject({
      enabled: true,
      smartModelId: trio[2].id,
      generation: 2,
      plannedGeneration: 0,
    });
    expect((await AutoRoutingSettingsModel.find(other.id))?.generation).toBe(1);
  });
});
