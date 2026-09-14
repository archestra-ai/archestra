import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HttpResponse, http } from "msw";
import config from "@/config";
import { expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import anthropicProxyRoutes from "./anthropic";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper, not a React hook
const server = useMswServer();

test.each([
  { token: "sk-ant-oat01-subscription", subscription: true },
  { token: "sk-ant-api03-metered", subscription: false },
])("discovers models for a bearer credential (subscription=$subscription)", async ({
  token,
  subscription,
}) => {
  config.llm.anthropic.baseUrl = "https://api.anthropic.com";
  config.llm.anthropic.vertexAi.enabled = false;
  server.use(
    http.get("https://api.anthropic.com/v1/models", ({ request }) => {
      const headers = request.headers;
      const authenticated = subscription
        ? headers.get("authorization") === `Bearer ${token}` &&
          headers.get("x-api-key") === null &&
          headers.get("anthropic-beta")?.split(",").includes("oauth-2025-04-20")
        : headers.get("x-api-key") === token &&
          headers.get("authorization") === null;
      if (!authenticated) {
        return HttpResponse.json(
          { error: "Invalid credential transport" },
          { status: 401 },
        );
      }
      return HttpResponse.json({
        data: [{ id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" }],
        has_more: false,
      });
    }),
  );

  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(anthropicProxyRoutes);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/anthropic/v1/models",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [
        {
          type: "model",
          id: "claude-sonnet-4-6",
          display_name: "Claude Sonnet 4.6",
        },
      ],
      has_more: false,
    });
  } finally {
    await app.close();
  }
});
