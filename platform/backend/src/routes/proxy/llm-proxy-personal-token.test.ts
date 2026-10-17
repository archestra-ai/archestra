import { CHAT_API_KEY_ID_HEADER } from "@archestra/shared";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { internalCallHeader } from "@/clients/internal-call";
import db, { schema } from "@/database";
import { UserTokenModel, VirtualApiKeyModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  createOpenAiTestClient,
  type OpenAiStubOptions,
} from "@/test/llm-provider-stubs";
import { type Agent, ApiError } from "@/types";
import { ollamaAdapterFactory, openaiAdapterFactory } from "./adapters";
import ollamaProxyRoutes from "./routes/ollama";
import openAiProxyRoutes from "./routes/openai";

/**
 * A personal platform token authenticates a call to the LLM proxy as its
 * user. The upstream key is the provider key named by CHAT_API_KEY_ID. An
 * external caller may use it only when the key is shared with the token's
 * user; in-process chat has already authorized the key for that user.
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
    vi.spyOn(ollamaAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient(openAiStubOptions) as never,
    );
    testAgent = await makeAgent({ name: "Personal token agent" });
    await app.register(ollamaProxyRoutes);
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
    const [interaction] = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.profileId, testAgent.id));
    expect(interaction.userId).toBe(user.id);
    expect(interaction.authMethod).toBe("personal_token");
  });

  test("authenticates a call through a keyless provider key", async ({
    makeUser,
    makeLlmProviderApiKey,
    makeMember,
  }) => {
    const user = await makeUser();
    await makeMember(user.id, testAgent.organizationId);
    const keylessKey = await makeLlmProviderApiKey(
      testAgent.organizationId,
      null,
      { provider: "ollama" },
    );
    const userToken = await UserTokenModel.ensureUserToken(
      user.id,
      testAgent.organizationId,
    );
    const tokenValue = await UserTokenModel.getTokenValue(userToken.id);

    const response = await app.inject({
      method: "POST",
      url: `/v1/ollama/${testAgent.id}/chat/completions`,
      headers: {
        authorization: `Bearer ${tokenValue}`,
        [CHAT_API_KEY_ID_HEADER]: keylessKey.id,
      },
      payload: { ...chatPayload, model: "llama3" },
    });

    expect(response.statusCode, response.body).toBe(200);
  });

  test("in-process chat may use the agent's key without a grant on it", async ({
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
    makeMember,
  }) => {
    // Chat admits the agent's configured key through agent access
    // (getCurrentApiKey), so the proxy must not re-check key grants for it.
    const owner = await makeUser();
    const chatUser = await makeUser();
    await makeMember(chatUser.id, testAgent.organizationId);
    const secret = await makeSecret({ secret: { apiKey: "sk-owner" } });
    const agentKey = await makeLlmProviderApiKey(
      testAgent.organizationId,
      secret.id,
      { provider: "openai", userId: owner.id },
    );
    const userToken = await UserTokenModel.ensureUserToken(
      chatUser.id,
      testAgent.organizationId,
    );
    const tokenValue = await UserTokenModel.getTokenValue(userToken.id);

    const response = await app.inject({
      method: "POST",
      url: completionUrl(),
      headers: {
        ...internalCallHeader(),
        authorization: `Bearer ${tokenValue}`,
        [CHAT_API_KEY_ID_HEADER]: agentKey.id,
      },
      payload: chatPayload,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(openaiAdapterFactory.createClient).toHaveBeenCalledWith(
      "sk-owner",
      expect.anything(),
    );
    const [interaction] = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.profileId, testAgent.id));
    expect(interaction.userId).toBe(chatUser.id);
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
