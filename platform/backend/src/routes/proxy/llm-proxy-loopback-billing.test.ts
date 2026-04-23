import { BILLED_USER_ID_HEADER } from "@shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import {
  LimitValidationService,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { createOpenAiTestClient } from "@/test/llm-provider-stubs";
import { openaiAdapterFactory } from "./adapters";
import openAiProxyRoutes from "./routes/openai";

vi.mock("@/guardrails/tool-invocation", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/guardrails/tool-invocation")>();
  return {
    ...original,
    evaluatePolicies: async () => null,
    getGlobalToolPolicy: async () => "permissive",
  };
});

describe("LLM Proxy — loopback BILLED_USER_ID_HEADER guard", () => {
  let app: FastifyInstance;
  let checkLimitsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient({}) as never,
    );
    checkLimitsSpy = vi
      .spyOn(LimitValidationService, "checkLimitsBeforeRequest")
      .mockResolvedValue(null);

    await ModelModel.upsert({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "2.50",
      customPricePerMillionOutput: "10.00",
      lastSyncedAt: new Date(),
    });

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(openAiProxyRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("loopback request honors BILLED_USER_ID_HEADER", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "loopback-agent" });

    await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        [BILLED_USER_ID_HEADER]: "user-from-header",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      },
    });

    expect(checkLimitsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ billedUserId: "user-from-header" }),
    );
  });

  test("non-loopback request ignores BILLED_USER_ID_HEADER", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id, name: "remote" });
    const secret = await makeSecret({ secret: { apiKey: "sk-upstream" } });
    const chatKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      scope: "org",
    });
    const { value: vkey } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatKey.id,
      name: "remote-test-vkey",
    });

    await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      remoteAddress: "203.0.113.7",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${vkey}`,
        [BILLED_USER_ID_HEADER]: "user-from-header",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      },
    });

    expect(checkLimitsSpy).toHaveBeenCalled();
    for (const call of checkLimitsSpy.mock.calls) {
      expect(call[0].billedUserId).toBeUndefined();
    }
  });

  test("personal-scope virtual key attributes spend to its author", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser({ email: "vkey-owner@test.com" });
    const agent = await makeAgent({ organizationId: org.id, name: "personal" });
    const secret = await makeSecret({ secret: { apiKey: "sk-upstream" } });
    const chatKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      scope: "personal",
    });
    const { value: vkey } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatKey.id,
      name: "personal-test-vkey",
      scope: "personal",
      authorId: author.id,
    });

    await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      remoteAddress: "203.0.113.7",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${vkey}`,
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      },
    });

    expect(checkLimitsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        billedUserId: author.id,
        virtualKeyId: expect.any(String),
      }),
    );
  });
});
