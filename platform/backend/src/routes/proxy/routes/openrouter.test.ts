import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import config from "@/config";
import { describe, expect, test } from "@/test";
import openrouterProxyRoutes from "./openrouter";

describe("OpenRouter proxy routes", () => {
  test("adds configured defaults without replacing caller attribution", async () => {
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
});
