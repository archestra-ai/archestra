import { vi } from "vitest";
import { auth as betterAuth } from "@/auth/better-auth";
import { authPlugin } from "@/auth/fastify-plugin/plugin";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import OrganizationModel from "@/models/organization";
import autoRoutingRoutes from "@/routes/auto-routing/auto-routing.routes";
import organizationRoutes from "@/routes/organization";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  autoRouterId,
  configureAutoRouting,
  makeRoutingModel,
  setAutoRoutingEnabled,
} from "@/test/auto-routing";

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
      // A member who may use agents but not read the auto routers.
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
    const routerId = await autoRouterId(organizationId);
    await OrganizationModel.patch(organizationId, {
      defaultAutoRouterId: routerId,
    });
    const ref = (model: typeof fast) => ({
      id: model.id,
      provider: model.provider,
      displayName: model.modelId,
    });

    const settings = await get("/api/auto-routing/routers");
    const response = await get("/api/organization/default-model");

    expect(settings.statusCode).toBe(403);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      model: ref(normal),
      defaultAutoRouterId: routerId,
      autoRouters: [
        {
          id: routerId,
          name: "auto",
          tiers: { fast: ref(fast), normal: ref(normal), smart: ref(smart) },
        },
      ],
    });
  });

  test("names the organization's default model, and offers the auto routers, while the default is not a router", async () => {
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
      defaultAutoRouterId: null,
      autoRouters: [
        {
          id: await autoRouterId(organizationId),
          name: "auto",
          tiers: { fast: ref(fast), normal: ref(normal), smart: ref(smart) },
        },
      ],
    });
  });

  test("names the normal tier, which an auto default runs on, while routing is off", async () => {
    const [, normal] = await configureAutoRouting(organizationId);
    await OrganizationModel.patch(organizationId, {
      defaultAutoRouterId: await autoRouterId(organizationId),
    });
    await setAutoRoutingEnabled(organizationId, false);

    const response = await get("/api/organization/default-model");

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      model: {
        id: normal.id,
        provider: normal.provider,
        displayName: normal.modelId,
      },
      defaultAutoRouterId: await autoRouterId(organizationId),
      autoRouters: [],
    });
  });
});
