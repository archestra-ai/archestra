import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { HttpResponse, http } from "msw";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import resourcePermissionRoutes from "@/routes/resource-permission/resource-permission.routes";
import { beforeEach, describe, expect, test } from "@/test";
import { autoRouterId, configureAutoRouting } from "@/test/auto-routing";
import { useMswServer } from "@/test/msw";
import { useRouteTestApp } from "@/test/route-test-app";
import autoRoutingRoutes from "./auto-routing.routes";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

const routes: FastifyPluginAsyncZod = async (fastify) => {
  await fastify.register(autoRoutingRoutes);
  await fastify.register(resourcePermissionRoutes);
};

describe("the session scorer and a Jev key's grants", () => {
  const ctx = useRouteTestApp(routes);
  const server = useMswServer();
  let jevCalls: number;

  beforeEach(async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    await configureAutoRouting(ctx.organizationId);
    jevCalls = 0;
    server.use(
      http.post(JEV_ENDPOINT, () => {
        jevCalls += 1;
        return HttpResponse.json({
          model: "jev-1.13.0",
          answers: {
            tier_needed: {
              type: "score",
              score: 1.1,
              confidence: 0.6,
              probabilities: { "0": 0.2, "1": 0.5, "2": 0.3 },
            },
            long_context: { type: "noul", noul: 0.35 },
          },
        });
      }),
    );
  });

  test("a key with the create dialog's default grants leaves scoring blocked until it is shared organization-wide", async ({
    makeSecret,
  }) => {
    // What POST /api/llm-provider-api-keys writes for `shared: true, initialGrants: []`.
    const secret = await makeSecret({ secret: { apiKey: "sk-jev" } });
    const key = await LlmProviderApiKeyModel.create(
      {
        organizationId: ctx.organizationId,
        createdBy: ctx.user.id,
        name: "Jev",
        provider: "jev",
        secretId: secret.id,
        scope: "org",
        userId: null,
        teamId: null,
      },
      { initialPermissionGrants: [], apiKeyValue: "sk-jev" },
    );
    const inject = ctx.app.inject.bind(ctx.app);
    const scorer = async () =>
      (
        await inject({ method: "GET", url: "/api/auto-routing/routers" })
      ).json()[0].status.scorer;
    const routerId = await autoRouterId(ctx.organizationId);
    const score = () =>
      inject({
        method: "POST",
        url: `/api/auto-routing/routers/${routerId}/preview`,
        payload: { text: "Refactor the billing module" },
      });

    expect(await scorer()).toBe("no_jev_key");
    const refused = await score();
    expect(refused.statusCode, refused.body).toBe(400);
    expect(jevCalls).toBe(0);

    const url = `/api/resource-permissions/llmProviderApiKey/${key.id}`;
    const policy = (await inject({ method: "GET", url })).json();
    const granted = await inject({
      method: "PUT",
      url,
      payload: {
        revision: policy.revision,
        grants: [
          ...policy.grants.map(({ subject, actions }: typeof everyone) => ({
            subject,
            actions,
          })),
          everyone,
        ],
      },
    });
    expect(granted.statusCode, granted.body).toBe(200);

    expect(await scorer()).toBe("ready");
    const scored = await score();
    expect(scored.statusCode, scored.body).toBe(200);
    expect(jevCalls).toBe(1);
  });
});

const everyone = {
  subject: { type: "organization", id: "*" },
  actions: ["read", "use"],
};
