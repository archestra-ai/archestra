import { CHAT_API_KEY_ID_HEADER } from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { UserTokenModel, VirtualApiKeyModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  createOpenAiTestClient,
  type OpenAiStubOptions,
} from "@/test/llm-provider-stubs";
import { type Agent, ApiError } from "@/types";
import { openaiAdapterFactory } from "./adapters";
import openAiProxyRoutes from "./routes/openai";

/**
 * A personal platform token authenticates a call to the LLM proxy as its
 * user. The upstream key is the provider key named by CHAT_API_KEY_ID, and
 * only a user the key is shared with may use it.
 */
describe("LLM proxy with a personal platform token", () => {
  let app: FastifyInstance;
  let testAgent: Agent;
  let openAiStubOptions: OpenAiStubOptions;

  beforeEach(async ({ makeAgent }) => {
    vi.clearAllMocks();
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) =>
      reply.status(error instanceof ApiError ? error.statusCode : 500).send({
        error: {
          message: error instanceof Error ? error.message : String(error),
          type:
            error instanceof ApiError
              ? error.type
              : "api_internal_server_error",
        },
      }),
    );
    openAiStubOptions = {};
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient(openAiStubOptions) as never,
    );
    testAgent = await makeAgent({ name: "Personal token agent" });
    await app.register(openAiProxyRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const completionUrl = () => `/v1/openai/${testAgent.id}/chat/completions`;

  const chatPayload = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
  };

  test("accepts the token when the user may use the named key", async ({
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
    makeMember,
  }) => {
    const user = await makeUser();
    await makeMember(user.id, testAgent.organizationId);
    const secret = await makeSecret({ secret: { apiKey: "sk-test" } });
    const providerKey = await makeLlmProviderApiKey(
      testAgent.organizationId,
      secret.id,
      { provider: "openai" },
    );
    const userToken = await UserTokenModel.ensureUserToken(
      user.id,
      testAgent.organizationId,
    );
    const tokenValue = await UserTokenModel.getTokenValue(userToken.id);

    const response = await app.inject({
      method: "POST",
      url: completionUrl(),
      headers: {
        authorization: `Bearer ${tokenValue}`,
        [CHAT_API_KEY_ID_HEADER]: providerKey.id,
      },
      payload: chatPayload,
    });

    expect(response.statusCode, response.body).toBe(200);
  });

  test("rejects the token when the named key is not shared with its user", async ({
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
    makeMember,
  }) => {
    const owner = await makeUser();
    const other = await makeUser();
    await makeMember(other.id, testAgent.organizationId);
    const secret = await makeSecret({ secret: { apiKey: "sk-test" } });
    // Personal to the owner, so the other user may not use it.
    const ownersKey = await makeLlmProviderApiKey(
      testAgent.organizationId,
      secret.id,
      { provider: "openai", userId: owner.id },
    );
    const otherToken = await UserTokenModel.ensureUserToken(
      other.id,
      testAgent.organizationId,
    );
    const tokenValue = await UserTokenModel.getTokenValue(otherToken.id);

    const response = await app.inject({
      method: "POST",
      url: completionUrl(),
      headers: {
        authorization: `Bearer ${tokenValue}`,
        [CHAT_API_KEY_ID_HEADER]: ownersKey.id,
      },
      payload: chatPayload,
    });

    expect(response.statusCode, response.body).toBe(403);
  });

  test("requires the named provider key to match the route provider", async ({
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
    makeMember,
  }) => {
    const user = await makeUser();
    await makeMember(user.id, testAgent.organizationId);
    const secret = await makeSecret({ secret: { apiKey: "sk-ant-test" } });
    const anthropicKey = await makeLlmProviderApiKey(
      testAgent.organizationId,
      secret.id,
      { provider: "anthropic" },
    );
    const userToken = await UserTokenModel.ensureUserToken(
      user.id,
      testAgent.organizationId,
    );
    const tokenValue = await UserTokenModel.getTokenValue(userToken.id);

    const response = await app.inject({
      method: "POST",
      url: completionUrl(),
      headers: {
        authorization: `Bearer ${tokenValue}`,
        [CHAT_API_KEY_ID_HEADER]: anthropicKey.id,
      },
      payload: chatPayload,
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(openaiAdapterFactory.createClient).not.toHaveBeenCalled();
  });

  test("rejects the token when another credential identifies a different user", async ({
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
    makeMember,
  }) => {
    const user = await makeUser();
    const other = await makeUser();
    await makeMember(user.id, testAgent.organizationId);
    await makeMember(other.id, testAgent.organizationId);
    const secret = await makeSecret({ secret: { apiKey: "sk-test" } });
    const providerKey = await makeLlmProviderApiKey(
      testAgent.organizationId,
      secret.id,
      { provider: "openai" },
    );
    const userToken = await UserTokenModel.ensureUserToken(
      user.id,
      testAgent.organizationId,
    );
    const tokenValue = await UserTokenModel.getTokenValue(userToken.id);
    const { value: othersPassthroughKey } = await VirtualApiKeyModel.create({
      organizationId: testAgent.organizationId,
      name: "other-user-passthrough",
      keyType: "passthrough",
      scope: "personal",
      authorId: other.id,
    });

    const response = await app.inject({
      method: "POST",
      url: completionUrl(),
      headers: {
        authorization: `Bearer ${tokenValue}`,
        [CHAT_API_KEY_ID_HEADER]: providerKey.id,
        "x-archestra-virtual-key": othersPassthroughKey,
      },
      payload: chatPayload,
    });

    expect(response.statusCode, response.body).toBe(401);
  });

  test("rejects the token when no provider key is named", async ({
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    await makeMember(user.id, testAgent.organizationId);
    const userToken = await UserTokenModel.ensureUserToken(
      user.id,
      testAgent.organizationId,
    );
    const tokenValue = await UserTokenModel.getTokenValue(userToken.id);

    const response = await app.inject({
      method: "POST",
      url: completionUrl(),
      headers: { authorization: `Bearer ${tokenValue}` },
      payload: chatPayload,
    });

    expect(response.statusCode, response.body).toBe(400);
  });
});
