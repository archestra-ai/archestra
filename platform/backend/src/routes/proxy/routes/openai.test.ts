/**
 * OpenAI Proxy Tests
 *
 * Tests for the unified OpenAI proxy routes covering:
 * - Streaming response format validation
 * - Cost tracking in database
 * - Interaction recording
 * - Interrupted stream handling
 * - HTTP proxy routing (UUID stripping)
 *
 * Current behavior notes:
 * - Streaming headers are written alongside SSE chunks sent through
 *   reply.raw.write(), so inject-based assertions focus on the body format.
 * - The adapter forwards only chunks with actual delta content.
 * - Interrupted streams may not record interactions before usage data arrives.
 */

import { createHash } from "node:crypto";
import { LLM_PROXY_OAUTH_SCOPE } from "@shared";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import {
  InteractionModel,
  LlmOauthClientModel,
  LlmProviderApiKeyModel,
  ModelModel,
  OAuthAccessTokenModel,
  OAuthClientModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { createOpenAiTestClient } from "@/test/llm-provider-stubs";
import { ApiError, type OpenAi } from "@/types";
import {
  openAiResponsesAdapterFactory,
  openaiAdapterFactory,
} from "../adapters";
import openAiProxyRoutes from "./openai";

function createOpenAiResponsesTestClient() {
  return {
    responses: {
      create: async (params: { stream?: boolean }) => {
        if (params.stream) {
          return {
            [Symbol.asyncIterator]: async function* () {
              yield {
                type: "response.created",
                response: {
                  id: "resp-test-openai",
                  object: "response",
                  created_at: Math.floor(Date.now() / 1000),
                  model: "gpt-4o",
                  status: "in_progress",
                  output: [],
                },
              };
              yield {
                type: "response.output_text.delta",
                delta: "Hello from Responses",
              };
              yield {
                type: "response.completed",
                response: {
                  id: "resp-test-openai",
                  object: "response",
                  created_at: Math.floor(Date.now() / 1000),
                  model: "gpt-4o",
                  status: "completed",
                  output: [
                    {
                      id: "msg-test-openai",
                      type: "message",
                      role: "assistant",
                      status: "completed",
                      content: [
                        {
                          type: "output_text",
                          text: "Hello from Responses",
                          annotations: [],
                        },
                      ],
                    },
                  ],
                  usage: {
                    input_tokens: 12,
                    output_tokens: 10,
                    total_tokens: 22,
                  },
                },
              };
            },
          };
        }

        return {
          id: "resp-test-openai",
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          model: "gpt-4o",
          status: "completed",
          output: [
            {
              id: "msg-test-openai",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "Hello from Responses",
                  annotations: [],
                },
              ],
            },
          ],
          usage: {
            input_tokens: 12,
            output_tokens: 10,
            total_tokens: 22,
          },
        };
      },
    },
  };
}

function createOpenAiRouteTestApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: {
          message: error.message,
          type: error.type,
        },
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return reply.status(500).send({
      error: {
        message,
        type: "internal_server_error",
      },
    });
  });
  return app;
}

describe("OpenAI proxy streaming", () => {
  let openAiStubOptions: { interruptAtChunk?: number };

  beforeEach(() => {
    openAiStubOptions = {};
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient(openAiStubOptions) as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("streaming response has SSE format", async ({ makeAgent }) => {
    const app = createOpenAiRouteTestApp();
    await app.register(openAiProxyRoutes);

    const agent = await makeAgent({ name: "Test Streaming Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello!" }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);

    // The route uses reply.raw.write() which produces SSE format
    const body = response.body;
    expect(body).toContain("data: ");
    expect(body).toContain("data: [DONE]");
  });

  test("streaming response contains content chunks", async ({ makeAgent }) => {
    const app = createOpenAiRouteTestApp();
    await app.register(openAiProxyRoutes);

    const agent = await makeAgent({ name: "Test Streaming Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello!" }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);

    //  adapter only emits chunks with actual content
    const chunks = response.body
      .split("\n")
      .filter(
        (line: string) => line.startsWith("data: ") && line !== "data: [DONE]",
      )
      .map((line: string) => JSON.parse(line.substring(6)));

    // Should have content chunks
    expect(chunks.length).toBeGreaterThan(0);

    // At least one chunk should have content
    const contentChunks = chunks.filter(
      (chunk: OpenAi.Types.ChatCompletionChunk) =>
        chunk.choices?.[0]?.delta?.content,
    );
    expect(contentChunks.length).toBeGreaterThan(0);
  });
});

describe("OpenAI cost tracking", () => {
  beforeEach(() => {
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient() as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("stores cost and baselineCost in interaction", async ({ makeAgent }) => {
    const app = createOpenAiRouteTestApp();
    await app.register(openAiProxyRoutes);

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

    const agent = await makeAgent({ name: "Test Cost Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);

    const { InteractionModel } = await import("@/models");
    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBeGreaterThan(0);

    const interaction = interactions[interactions.length - 1];
    expect(interaction.cost).toBeTruthy();
    expect(interaction.baselineCost).toBeTruthy();
    expect(typeof interaction.cost).toBe("string");
    expect(typeof interaction.baselineCost).toBe("string");
  });

  test("accepts LLM OAuth client credentials on provider-specific proxy routes", async ({
    makeAgent,
    makeLlmProviderApiKey,
    makeOrganization,
    makeSecret,
  }) => {
    const app = createOpenAiRouteTestApp();
    await app.register(openAiProxyRoutes);

    const organization = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-openai" } });
    const providerKey = await makeLlmProviderApiKey(
      organization.id,
      secret.id,
      {
        provider: "openai",
      },
    );
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "OAuth OpenAI Proxy",
      agentType: "llm_proxy",
    });
    const { oauthClient } = await LlmOauthClientModel.create({
      organizationId: organization.id,
      name: "Backend Service",
      allowedLlmProxyIds: [agent.id],
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: providerKey.id },
      ],
    });
    const accessToken = "llm-provider-route-oauth-token";
    await OAuthAccessTokenModel.createClientCredentialsToken({
      tokenHash: createHash("sha256").update(accessToken).digest("base64url"),
      clientId: oauthClient.clientId,
      expiresAt: new Date(Date.now() + 60_000),
      scopes: [LLM_PROXY_OAUTH_SCOPE],
      referenceId: `llm-proxy:${oauthClient.id}`,
    });
    let capturedApiKey: string | undefined;
    vi.mocked(openaiAdapterFactory.createClient).mockImplementation(
      (apiKey) => {
        capturedApiKey = apiKey;
        return createOpenAiTestClient() as never;
      },
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);

    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    const interaction = interactions[interactions.length - 1];
    expect(interaction.authMethod).toBe("oauth_client_credentials");
    expect(interaction.authenticatedAppId).toBe(oauthClient.id);
    expect(interaction.authenticatedAppName).toBe("Backend Service");
    expect(capturedApiKey).toBe("sk-openai");
  });

  test("accepts user OAuth access tokens on provider-specific proxy routes", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeSecret,
    makeUser,
  }) => {
    const app = createOpenAiRouteTestApp();
    await app.register(openAiProxyRoutes);

    const organization = await makeOrganization();
    const user = await makeUser({ email: "oauth-route-user@example.com" });
    await makeMember(user.id, organization.id);
    const secret = await makeSecret({ secret: { apiKey: "sk-user-openai" } });
    await LlmProviderApiKeyModel.create({
      organizationId: organization.id,
      secretId: secret.id,
      name: "User OpenAI Key",
      provider: "openai",
      scope: "personal",
      userId: user.id,
      teamId: null,
      isPrimary: true,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "User OAuth OpenAI Proxy",
      agentType: "llm_proxy",
      scope: "org",
    });
    const clientId = `https://example.com/${crypto.randomUUID()}/client.json`;
    const oauthClientId = crypto.randomUUID();
    await OAuthClientModel.upsertFromCimd({
      id: oauthClientId,
      clientId,
      name: "Route OAuth App",
      redirectUris: ["http://localhost:3107/callback"],
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      isPublic: true,
      metadata: { test: true },
    });
    const oauthClient = await OAuthClientModel.findByClientId(clientId);
    if (!oauthClient) {
      throw new Error("Expected OAuth client");
    }
    const accessToken = `user-provider-route-token-${crypto.randomUUID()}`;
    await OAuthAccessTokenModel.create({
      tokenHash: createHash("sha256").update(accessToken).digest("base64url"),
      clientId,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
      scopes: [LLM_PROXY_OAUTH_SCOPE],
    });
    let capturedApiKey: string | undefined;
    vi.mocked(openaiAdapterFactory.createClient).mockImplementation(
      (apiKey) => {
        capturedApiKey = apiKey;
        return createOpenAiTestClient() as never;
      },
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(capturedApiKey).toBe("sk-user-openai");

    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    const interaction = interactions[interactions.length - 1];
    expect(interaction.authMethod).toBe("oauth_user");
    expect(interaction.authenticatedAppId).toBe(oauthClientId);
    expect(oauthClient.id).toBe(oauthClientId);
    expect(interaction.authenticatedAppName).toBe("Route OAuth App");
    expect(interaction.userId).toBe(user.id);
  });

  test("rejects LLM OAuth client credentials without a matching provider mapping", async ({
    makeAgent,
    makeLlmProviderApiKey,
    makeOrganization,
    makeSecret,
  }) => {
    const app = createOpenAiRouteTestApp();
    await app.register(openAiProxyRoutes);

    const organization = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-anthropic" } });
    const providerKey = await makeLlmProviderApiKey(
      organization.id,
      secret.id,
      { provider: "anthropic" },
    );
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Unmapped OAuth OpenAI Proxy",
      agentType: "llm_proxy",
    });
    const { oauthClient } = await LlmOauthClientModel.create({
      organizationId: organization.id,
      name: "Unmapped Backend Service",
      allowedLlmProxyIds: [agent.id],
      providerApiKeys: [
        { provider: "anthropic", providerApiKeyId: providerKey.id },
      ],
    });
    const accessToken = "llm-provider-route-unmapped-token";
    await OAuthAccessTokenModel.createClientCredentialsToken({
      tokenHash: createHash("sha256").update(accessToken).digest("base64url"),
      clientId: oauthClient.clientId,
      expiresAt: new Date(Date.now() + 60_000),
      scopes: [LLM_PROXY_OAUTH_SCOPE],
      referenceId: `llm-proxy:${oauthClient.id}`,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe(
      'LLM OAuth client is not mapped to provider "openai".',
    );
  });

  test("rejects expired LLM OAuth access tokens on provider-specific proxy routes", async ({
    makeAgent,
    makeLlmProviderApiKey,
    makeOrganization,
    makeSecret,
  }) => {
    const app = createOpenAiRouteTestApp();
    await app.register(openAiProxyRoutes);

    const organization = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-openai" } });
    const providerKey = await makeLlmProviderApiKey(
      organization.id,
      secret.id,
      { provider: "openai" },
    );
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Expired OAuth OpenAI Proxy",
      agentType: "llm_proxy",
    });
    const { oauthClient } = await LlmOauthClientModel.create({
      organizationId: organization.id,
      name: "Expired Backend Service",
      allowedLlmProxyIds: [agent.id],
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: providerKey.id },
      ],
    });
    const accessToken = "llm-provider-route-expired-token";
    await OAuthAccessTokenModel.createClientCredentialsToken({
      tokenHash: createHash("sha256").update(accessToken).digest("base64url"),
      clientId: oauthClient.clientId,
      expiresAt: new Date(Date.now() - 60_000),
      scopes: [LLM_PROXY_OAUTH_SCOPE],
      referenceId: `llm-proxy:${oauthClient.id}`,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toBe(
      "Invalid LLM OAuth access token.",
    );
  });

  test("rejects LLM OAuth access tokens for disabled clients on provider-specific proxy routes", async ({
    makeAgent,
    makeLlmProviderApiKey,
    makeOrganization,
    makeSecret,
  }) => {
    const app = createOpenAiRouteTestApp();
    await app.register(openAiProxyRoutes);

    const organization = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-openai" } });
    const providerKey = await makeLlmProviderApiKey(
      organization.id,
      secret.id,
      { provider: "openai" },
    );
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Disabled OAuth OpenAI Proxy",
      agentType: "llm_proxy",
    });
    const { oauthClient } = await LlmOauthClientModel.create({
      organizationId: organization.id,
      name: "Disabled Backend Service",
      allowedLlmProxyIds: [agent.id],
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: providerKey.id },
      ],
    });
    await db
      .update(schema.oauthClientsTable)
      .set({ disabled: true })
      .where(eq(schema.oauthClientsTable.id, oauthClient.id));
    const accessToken = "llm-provider-route-disabled-client-token";
    await OAuthAccessTokenModel.createClientCredentialsToken({
      tokenHash: createHash("sha256").update(accessToken).digest("base64url"),
      clientId: oauthClient.clientId,
      expiresAt: new Date(Date.now() + 60_000),
      scopes: [LLM_PROXY_OAUTH_SCOPE],
      referenceId: `llm-proxy:${oauthClient.id}`,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toBe("LLM OAuth client is disabled.");
  });

  test("rejects access tokens linked to revoked refresh tokens on provider-specific proxy routes", async ({
    makeAgent,
    makeLlmProviderApiKey,
    makeOrganization,
    makeSecret,
    makeUser,
  }) => {
    const app = createOpenAiRouteTestApp();
    await app.register(openAiProxyRoutes);

    const organization = await makeOrganization();
    const user = await makeUser({ email: "revoked-oauth@example.com" });
    const secret = await makeSecret({ secret: { apiKey: "sk-openai" } });
    const providerKey = await makeLlmProviderApiKey(
      organization.id,
      secret.id,
      { provider: "openai" },
    );
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Revoked OAuth OpenAI Proxy",
      agentType: "llm_proxy",
    });
    const { oauthClient } = await LlmOauthClientModel.create({
      organizationId: organization.id,
      name: "Revoked Backend Service",
      allowedLlmProxyIds: [agent.id],
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: providerKey.id },
      ],
    });
    const refreshId = crypto.randomUUID();
    await db.insert(schema.oauthRefreshTokensTable).values({
      id: refreshId,
      token: "revoked-refresh-token",
      clientId: oauthClient.clientId,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
      revoked: new Date(),
      scopes: [LLM_PROXY_OAUTH_SCOPE],
    });
    const accessToken = "llm-provider-route-revoked-refresh-token";
    const createdAccessToken =
      await OAuthAccessTokenModel.createClientCredentialsToken({
        tokenHash: createHash("sha256").update(accessToken).digest("base64url"),
        clientId: oauthClient.clientId,
        expiresAt: new Date(Date.now() + 60_000),
        scopes: [LLM_PROXY_OAUTH_SCOPE],
        referenceId: `llm-proxy:${oauthClient.id}`,
      });
    await db
      .update(schema.oauthAccessTokensTable)
      .set({ refreshId })
      .where(eq(schema.oauthAccessTokensTable.id, createdAccessToken.id));

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toBe(
      "Invalid LLM OAuth access token.",
    );
  });

  test("rejects LLM OAuth access tokens missing the proxy scope", async ({
    makeAgent,
    makeLlmProviderApiKey,
    makeOrganization,
    makeSecret,
  }) => {
    const app = createOpenAiRouteTestApp();
    await app.register(openAiProxyRoutes);

    const organization = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-openai" } });
    const providerKey = await makeLlmProviderApiKey(
      organization.id,
      secret.id,
      { provider: "openai" },
    );
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Wrong Scope OAuth OpenAI Proxy",
      agentType: "llm_proxy",
    });
    const { oauthClient } = await LlmOauthClientModel.create({
      organizationId: organization.id,
      name: "Wrong Scope Backend Service",
      allowedLlmProxyIds: [agent.id],
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: providerKey.id },
      ],
    });
    const accessToken = "llm-provider-route-wrong-scope-token";
    await OAuthAccessTokenModel.createClientCredentialsToken({
      tokenHash: createHash("sha256").update(accessToken).digest("base64url"),
      clientId: oauthClient.clientId,
      expiresAt: new Date(Date.now() + 60_000),
      scopes: ["mcp"],
      referenceId: `llm-proxy:${oauthClient.id}`,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toBe(
      "Access token is missing LLM proxy scope.",
    );
  });
});

describe("OpenAI Responses proxy", () => {
  beforeEach(() => {
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiResponsesTestClient() as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("creates a response and records an openai responses interaction", async ({
    makeAgent,
  }) => {
    const app = createOpenAiRouteTestApp();
    await app.register(openAiProxyRoutes);

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

    const agent = await makeAgent({ name: "Test Responses Agent" });
    const { InteractionModel } = await import("@/models");
    const initialInteractions =
      await InteractionModel.getAllInteractionsForProfile(agent.id);

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        input: "Hello!",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "response",
      model: "gpt-4o",
      output: [
        expect.objectContaining({
          type: "message",
        }),
      ],
    });

    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBe(initialInteractions.length + 1);
    const interaction = interactions[interactions.length - 1];
    expect(interaction.type).toBe("openai:responses");
    expect(interaction.model).toBe("gpt-4o");
    expect(interaction.inputTokens).toBe(12);
    expect(interaction.outputTokens).toBe(10);
  });

  test("streams responses as OpenAI Responses SSE events", async ({
    makeAgent,
  }) => {
    const app = createOpenAiRouteTestApp();
    await app.register(openAiProxyRoutes);

    const agent = await makeAgent({ name: "Test Streaming Responses Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        input: "Hello!",
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("data: ");
    expect(response.body).toContain('"type":"response.output_text.delta"');
    expect(response.body).toContain("data: [DONE]");
  });
});

describe("OpenAI streaming mode", () => {
  let openAiStubOptions: { interruptAtChunk?: number };

  beforeEach(() => {
    openAiStubOptions = {};
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient(openAiStubOptions) as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("streaming mode completes normally and records interaction", async ({
    makeAgent,
  }) => {
    const app = createOpenAiRouteTestApp();
    await app.register(openAiProxyRoutes);

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

    const agent = await makeAgent({ name: "Test Streaming Agent" });

    const { InteractionModel } = await import("@/models");

    const initialInteractions =
      await InteractionModel.getAllInteractionsForProfile(agent.id);
    const initialCount = initialInteractions.length;

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.body;
    expect(body).toContain("data: ");
    expect(body).toContain('"finish_reason":"stop"');

    await new Promise((resolve) => setTimeout(resolve, 100));

    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBe(initialCount + 1);

    const interaction = interactions[interactions.length - 1];

    expect(interaction.type).toBe("openai:chatCompletions");
    expect(interaction.model).toBe("gpt-4o");
    expect(interaction.inputTokens).toBe(12);
    expect(interaction.outputTokens).toBe(10);
    expect(interaction.cost).toBeTruthy();
    expect(interaction.baselineCost).toBeTruthy();
    expect(typeof interaction.cost).toBe("string");
    expect(typeof interaction.baselineCost).toBe("string");
  });

  test("streaming mode interrupted still records interaction", {
    timeout: 10000,
  }, async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // Configure stub to interrupt at chunk 4 (after usage chunk but before stream completes)
    openAiStubOptions.interruptAtChunk = 4;

    await app.register(openAiProxyRoutes);

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

    const agent = await makeAgent({
      name: "Test Interrupted Streaming Agent",
    });

    const { InteractionModel } = await import("@/models");

    const initialInteractions =
      await InteractionModel.getAllInteractionsForProfile(agent.id);
    const initialCount = initialInteractions.length;

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: true,
      },
    });

    // Stream ends early but request should complete successfully
    expect(response.statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify interaction was still recorded despite interruption
    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBe(initialCount + 1);

    const interaction = interactions[interactions.length - 1];

    expect(interaction.type).toBe("openai:chatCompletions");
    expect(interaction.model).toBe("gpt-4o");
    expect(interaction.inputTokens).toBe(12);
    expect(interaction.outputTokens).toBe(10);
    expect(interaction.cost).toBeTruthy();
    expect(interaction.baselineCost).toBeTruthy();
  });

  test("streaming mode interrupted before usage handles gracefully", {
    timeout: 10000,
  }, async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // Configure stub to interrupt at chunk 2 (before usage chunk)
    openAiStubOptions.interruptAtChunk = 2;

    await app.register(openAiProxyRoutes);

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

    const agent = await makeAgent({
      name: "Test Interrupted Before Usage Agent",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: true,
      },
    });

    // Request should complete without error even when stream is interrupted
    expect(response.statusCode).toBe(200);

    // Response should have partial SSE data
    expect(response.body).toContain("data: ");
  });
});

describe("OpenAI proxy routing", () => {
  let app: FastifyInstance;
  let mockUpstream: FastifyInstance;
  let upstreamPort: number;

  beforeEach(async () => {
    mockUpstream = Fastify();

    mockUpstream.get("/v1/models", async () => ({
      object: "list",
      data: [
        {
          id: "gpt-4",
          object: "model",
          created: 1687882411,
          owned_by: "openai",
        },
        {
          id: "gpt-3.5-turbo",
          object: "model",
          created: 1677610602,
          owned_by: "openai",
        },
      ],
    }));

    mockUpstream.get("/v1/models/:model", async (request) => ({
      id: (request.params as { model: string }).model,
      object: "model",
      created: 1687882411,
      owned_by: "openai",
    }));

    await mockUpstream.listen({ port: 0 });
    const address = mockUpstream.server.address();
    upstreamPort = typeof address === "string" ? 0 : address?.port || 0;

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const originalBaseUrl = config.llm.openai.baseUrl;
    config.llm.openai.baseUrl = `http://localhost:${upstreamPort}`;

    await app.register(async (fastify) => {
      const fastifyHttpProxy = (await import("@fastify/http-proxy")).default;
      const API_PREFIX = "/v1/openai";
      const CHAT_COMPLETIONS_SUFFIX = "chat/completions";

      await fastify.register(fastifyHttpProxy, {
        upstream: `http://localhost:${upstreamPort}`,
        prefix: API_PREFIX,
        rewritePrefix: "/v1",
        preHandler: (request, reply, next) => {
          const urlPath = request.url.split("?")[0];
          if (
            request.method === "POST" &&
            urlPath.endsWith(CHAT_COMPLETIONS_SUFFIX)
          ) {
            reply.code(400).send({
              error: {
                message:
                  "Chat completions requests should use the dedicated endpoint",
                type: "invalid_request_error",
              },
            });
            return;
          }

          const pathAfterPrefix = request.url.replace(API_PREFIX, "");
          const uuidMatch = pathAfterPrefix.match(
            /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i,
          );

          if (uuidMatch) {
            const remainingPath = uuidMatch[2] || "";
            request.raw.url = `${API_PREFIX}${remainingPath}`;
          }

          next();
        },
      });
    });

    config.llm.openai.baseUrl = originalBaseUrl;
  });

  afterEach(async () => {
    await app.close();
    await mockUpstream.close();
  });

  test("proxies /v1/openai/models without UUID", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/openai/models",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(2);
  });

  test("strips UUID and proxies /v1/openai/:uuid/models", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/openai/44f56e01-7167-42c1-88ee-64b566fbc34d/models",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(2);
  });

  test("strips UUID and proxies /v1/openai/:uuid/models/:model", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/openai/44f56e01-7167-42c1-88ee-64b566fbc34d/models/gpt-4",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.id).toBe("gpt-4");
    expect(body.object).toBe("model");
  });

  test("does not strip non-UUID segments", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/openai/not-a-uuid/models",
    });

    // This should try to proxy to /v1/not-a-uuid/models which won't exist
    expect(response.statusCode).toBe(404);
  });

  test("skips proxy for chat/completions routes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/openai/chat/completions",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello!" }],
      },
    });

    // Should get 400 because the preHandler blocks proxy forwarding with a clean error response
    expect(response.statusCode).toBe(400);
  });

  test("skips proxy for chat/completions routes with UUID", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/openai/44f56e01-7167-42c1-88ee-64b566fbc34d/chat/completions",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello!" }],
      },
    });

    // Should get 400 because the preHandler blocks proxy forwarding with a clean error response
    expect(response.statusCode).toBe(400);
  });
});
