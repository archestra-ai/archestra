/**
 * Virtual API key auth on the LLM proxy.
 *
 * Ported from the `virtual-api-keys.spec.ts` e2e: a virtual key created against
 * a real provider API key authenticates an (external, non-loopback) proxy
 * request end to end and resolves to the underlying provider secret. The
 * downstream provider is stubbed at the adapter-client boundary (same approach
 * as llm-proxy-handler.test.ts), so no real network call is made.
 */

import { hasArchestraTokenPrefix } from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { ModelModel, VirtualApiKeyModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { createOpenAiTestClient } from "@/test/llm-provider-stubs";
import type { Agent } from "@/types";
import { openaiAdapterFactory } from "./adapters";
import { virtualKeyRateLimiter } from "./llm-proxy-auth";
import openAiProxyRoutes from "./routes/openai";

describe("Virtual API Keys - LLM Proxy", () => {
  let app: FastifyInstance;
  let proxy: Agent;
  const createClientSpy = vi.fn();

  beforeEach(async ({ makeAgent }) => {
    vi.clearAllMocks();

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      (apiKey, options) => {
        createClientSpy(apiKey, options);
        return createOpenAiTestClient({}) as never;
      },
    );
    // The cache-backed rate limiter isn't started under PGLite tests; stub it
    // so the virtual-key validation path exercises auth, not cache I/O.
    vi.spyOn(virtualKeyRateLimiter, "check").mockResolvedValue(undefined);
    vi.spyOn(virtualKeyRateLimiter, "recordFailure").mockResolvedValue(
      undefined,
    );

    proxy = await makeAgent({ name: "e2e-vk-proxy", agentType: "llm_proxy" });

    await app.register(openAiProxyRoutes);
    await ModelModel.upsert({
      externalId: "openai/gpt-4o-mini",
      provider: "openai",
      modelId: "gpt-4o-mini",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "0.15",
      customPricePerMillionOutput: "0.60",
      lastSyncedAt: new Date(),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("virtual key authenticates an external proxy request", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({
      secret: { apiKey: "sk-e2e-test-key" },
    });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });

    const { value: virtualKey } = await VirtualApiKeyModel.create({
      name: "test-vk",
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
    });
    expect(hasArchestraTokenPrefix(virtualKey)).toBe(true);

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${proxy.id}/chat/completions`,
      // Non-loopback: the 200 is due to the virtual key, not a localhost bypass.
      remoteAddress: "203.0.113.5",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${virtualKey}`,
      },
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    // The virtual key resolved to the underlying provider secret, not forwarded
    // as the arch_ token.
    expect(createClientSpy).toHaveBeenCalledWith(
      "sk-e2e-test-key",
      expect.any(Object),
    );
  });
});
