import { vi } from "vitest";
import { auth as betterAuth } from "@/auth/better-auth";
import { authPlugin } from "@/auth/fastify-plugin/plugin";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import OrganizationModel from "@/models/organization";
import autoRoutingRoutes from "@/routes/auto-routing/auto-routing.routes";
import organizationRoutes from "@/routes/organization";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { configureAutoRouting, makeRoutingModel } from "@/test/auto-routing";

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
    await OrganizationModel.patch(organizationId, { defaultAutoModel: true });
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
      defaultAutoModel: true,
      autoRouting: {
        active: true,
        tiers: { fast: ref(fast), normal: ref(normal), smart: ref(smart) },
      },
    });
  });

  test("names the organization's default model, and offers auto, while the default is not auto", async () => {
    const [fast, normal, smart] = await configureAutoRouting(organizationId);
    const ref = (tier: typeof fast) => ({
      id: tier.id,
      provider: tier.provider,
      displayName: tier.modelId,
    });
    const model = await makeRoutingModel();
    await OrganizationModel.patch(organizationId, { defaultModelId: model.id });

    const response = await get("/api/organization/default-model");

    expect(response.json()).toEqual({
      model: {
        id: model.id,
        provider: model.provider,
        displayName: model.description || model.modelId,
      },
      defaultAutoModel: false,
      autoRouting: {
        active: true,
        tiers: { fast: ref(fast), normal: ref(normal), smart: ref(smart) },
      },
    });
  });

  test("names the normal tier, which an auto default runs on, while routing is off", async () => {
    const [, normal] = await configureAutoRouting(organizationId);
    await OrganizationModel.patch(organizationId, { defaultAutoModel: true });
    await AutoRoutingSettingsModel.update(organizationId, { enabled: false });

    const response = await get("/api/organization/default-model");

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      model: {
        id: normal.id,
        provider: normal.provider,
        displayName: normal.modelId,
      },
      defaultAutoModel: true,
      autoRouting: { active: false },
    });
  });
});
