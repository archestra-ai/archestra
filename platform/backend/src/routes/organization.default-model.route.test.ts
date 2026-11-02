import { vi } from "vitest";
import { betterAuth } from "@/auth";
import { authPlugin } from "@/auth/fastify-plugin/plugin";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import autoRoutingRoutes from "@/routes/auto-routing/auto-routing.routes";
import organizationRoutes from "@/routes/organization";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { configureAutoRouting } from "@/test/auto-routing";

describe("GET /api/organization/default-model", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  const autoRoutingDeployed = config.autoRouting.enabled;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeCustomRole,
      makeMember,
      makeSession,
    }) => {
      config.autoRouting.enabled = true;
      organizationId = (await makeOrganization()).id;
      const user = await makeUser();
      // A member who may use agents but not read the auto-routing settings.
      const { role } = await makeCustomRole(organizationId, {
        permission: { agent: ["read"] },
      });
      await makeMember(user.id, organizationId, { role });
      const session = await makeSession(user.id, {
        activeOrganizationId: organizationId,
      });
      vi.spyOn(betterAuth.api, "getSession").mockResolvedValue({
        response: { user, session },
        headers: new Headers(),
      } as never);
      app = createFastifyInstance();
      await app.register(authPlugin);
      await app.register(organizationRoutes);
      await app.register(autoRoutingRoutes);
    },
  );

  afterEach(async () => {
    config.autoRouting.enabled = autoRoutingDeployed;
    await app.close();
    vi.restoreAllMocks();
  });

  const get = (url: string) => app.inject({ method: "GET", url });

  test("names the routed tiers to a member without llmProxy:read", async () => {
    const [fast, normal, smart] = await configureAutoRouting(organizationId);
    const ref = (model: typeof fast) => ({
      id: model.id,
      provider: model.provider,
      displayName: model.modelId,
    });

    const settings = await get("/api/auto-routing/settings");
    const response = await get("/api/organization/default-model");

    expect(settings.statusCode).toBe(403);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      model: ref(normal),
      autoRouting: {
        active: true,
        tiers: { fast: ref(fast), normal: ref(normal), smart: ref(smart) },
      },
    });
  });

  test("names only the default model while routing is off", async () => {
    const [, normal] = await configureAutoRouting(organizationId);
    await AutoRoutingSettingsModel.update(organizationId, { enabled: false });

    const response = await get("/api/organization/default-model");

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      model: {
        id: normal.id,
        provider: normal.provider,
        displayName: normal.modelId,
      },
      autoRouting: { active: false },
    });
  });
});
