import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import config from "@/config";
import { OrganizationModel } from "@/models";
import { describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import openrouterProxyRoutes from "./openrouter";

// Rejected credentials count toward the failed-auth rate limit in the cache.
setupTestCacheManager();

describe("OpenRouter proxy routes", () => {
  test("adds configured defaults without replacing caller attribution", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    // The catch-all resolves the deployment's LLM proxy, so an organization
    // must exist.
    const agent = await makeAgent();
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);
    const passthroughToken = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: owner.id,
    });
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    const upstream = Fastify();
    upstream.get("/credits", (request) => {
      receivedHeaders = request.headers;
      return { data: { total_credits: 1 } };
    });
    config.llm.openrouter.baseUrl = await upstream.listen({
      port: 0,
      host: "127.0.0.1",
    });
    config.llm.openrouter.referer = "https://deployment.example";
    config.llm.openrouter.title = "Deployment";
    config.llm.openrouter.categories = "productivity";

    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(openrouterProxyRoutes);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/openrouter/credits",
        headers: {
          authorization: "Bearer test-openrouter-key",
          "x-archestra-virtual-key": passthroughToken,
          "x-openrouter-title": "Caller",
          "x-custom-auth": "keep-me",
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(receivedHeaders["http-referer"]).toBe(
        "https://deployment.example",
      );
      expect(receivedHeaders["x-openrouter-title"]).toBe("Caller");
      expect(receivedHeaders["x-title"]).toBeUndefined();
      expect(receivedHeaders["x-openrouter-categories"]).toBe("productivity");
      expect(receivedHeaders["x-custom-auth"]).toBe("keep-me");
    } finally {
      await app.close();
      await upstream.close();
    }
  });

  describe("bare provider key on a catch-all route", () => {
    test("is rejected with 401 before reaching the upstream", async ({
      makeAgent,
    }) => {
      // An organization must exist; it has not opted in.
      await makeAgent();
      const { response, upstreamCalls } = await requestCreditsWithBareKey();

      expect(response.statusCode, response.body).toBe(401);
      expect(upstreamCalls).toBe(0);
    });

    test("is forwarded once the organization allows unauthenticated proxy requests", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();
      await OrganizationModel.patch(agent.organizationId, {
        allowUnauthenticatedLlmProxyRequests: true,
      });
      const { response, upstreamCalls } = await requestCreditsWithBareKey();

      expect(response.statusCode, response.body).toBe(200);
      expect(upstreamCalls).toBe(1);
    });
  });
});

async function requestCreditsWithBareKey() {
  let upstreamCalls = 0;
  const upstream = Fastify();
  upstream.get("/credits", () => {
    upstreamCalls += 1;
    return { data: { total_credits: 1 } };
  });
  config.llm.openrouter.baseUrl = await upstream.listen({
    port: 0,
    host: "127.0.0.1",
  });

  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(openrouterProxyRoutes);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/openrouter/credits",
      headers: { authorization: "Bearer test-openrouter-key" },
    });
    return { response, upstreamCalls };
  } finally {
    await app.close();
    await upstream.close();
  }
}
