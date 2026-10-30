import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  OAUTH_CLIENT_REFERENCE_PREFIX,
  OAUTH_TOKEN_ID_PREFIX,
} from "@archestra/shared";
import { generateText, streamText } from "ai";
import { authorizeA2AModel } from "@/agents/a2a/oauth-model";
import { a2aOAuthExecutionHeader } from "@/clients/a2a-oauth-execution";
import {
  guardrailCallHeader,
  internalCallHeader,
} from "@/clients/internal-call";
import { createLLMModel } from "@/clients/llm-client";
import config from "@/config";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import {
  ManagedOauthClientModel,
  ModelPoolModel,
  OAuthAccessTokenModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import openAiRoutes from "./routes/openai";

describe("A2A OAuth authorization at actual proxy transport attempts", () => {
  setupTestCacheManager();
  let upstream: Server;
  let baseUrl: string;
  let app: FastifyInstanceWithZod;
  let requests: IncomingHttpHeaders[];
  let firstAttempt: (() => Promise<"drop" | "pool" | undefined>) | undefined;

  beforeEach(async () => {
    config.llmProxy.modelPoolsEnabled = true;
    requests = [];
    firstAttempt = undefined;
    upstream = createServer(async (req, res) => {
      requests.push(req.headers);
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString());
      if (requests.length === 1) {
        const failure = await firstAttempt?.();
        if (failure === "drop") {
          req.socket.destroy();
          return;
        }
        if (failure === "pool") {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "Synthetic unavailable provider" },
            }),
          );
          return;
        }
      }
      const common = { id: "synthetic", created: 1, model: "gpt-4o-mini" };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          `data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "answer" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ...common,
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "answer" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      }
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
    app = createFastifyInstance();
    await app.register(openAiRoutes);
    await app.listen({ port: 0, host: "127.0.0.1" });
    config.api.port = (app.server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await app?.close();
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
  });

  for (const stream of [false, true]) {
    for (const failure of ["drop", "pool"] as const) {
      for (const revoked of [false, true]) {
        test(`${stream ? "stream" : "generate"} ${failure}: ${revoked ? "revocation stops next attempt" : "valid retries succeed"}`, async ({
          makeAgent,
          makeUser,
          makeMember,
          makeSecret,
          makeLlmProviderApiKey,
        }) => {
          const agent = await makeAgent();
          const user = await makeUser();
          await makeMember(user.id, agent.organizationId, { role: "admin" });
          const key = await makeLlmProviderApiKey(
            agent.organizationId,
            (await makeSecret({ secret: { apiKey: "sk-synthetic" } })).id,
            { provider: "openai", baseUrl },
          );
          const secondKey = await makeLlmProviderApiKey(
            agent.organizationId,
            (await makeSecret({ secret: { apiKey: "sk-synthetic-second" } }))
              .id,
            { provider: "openai", baseUrl },
          );
          const pool =
            failure === "pool"
              ? await ModelPoolModel.create({
                  organizationId: agent.organizationId,
                  input: {
                    name: "synthetic-oauth-pool",
                    members: [key, secondKey].map((row, index) => ({
                      providerApiKeyId: row.id,
                      modelId: "gpt-4o-mini",
                      priority: index + 1,
                      weight: 1,
                      enabled: true,
                    })),
                  },
                })
              : undefined;
          const { oauthClient } = await ManagedOauthClientModel.create({
            organizationId: agent.organizationId,
            authorId: user.id,
            name: "Synthetic application",
            grantType: "client_credentials",
            scopes: ["a2a"],
            allowedGatewayIds: [agent.id],
          });
          const tokenHash = OAuthAccessTokenModel.hashTokenForLookup(
            crypto.randomUUID(),
          );
          const token =
            await OAuthAccessTokenModel.createClientCredentialsToken({
              tokenHash,
              clientId: oauthClient.clientId,
              expiresAt: new Date(Date.now() + 60_000),
              scopes: ["a2a"],
              referenceId: `${OAUTH_CLIENT_REFERENCE_PREFIX}${oauthClient.id}`,
            });
          firstAttempt = async () => {
            if (revoked)
              await OAuthAccessTokenModel.deleteByTokenHash(tokenHash);
            return failure;
          };
          const model = authorizeA2AModel({
            agentId: agent.id,
            organizationId: agent.organizationId,
            execution: {
              tokenId: `${OAUTH_TOKEN_ID_PREFIX}${token.id}`,
              clientId: oauthClient.clientId,
            },
            model: createLLMModel({
              provider: "openai",
              apiKey: "sk-synthetic",
              agentId: agent.id,
              modelName: "gpt-4o-mini",
              baseUrl,
              chatApiKeyId: key.id,
              modelPoolId: pool?.id,
              source: "api",
            }),
          });
          const result = (async () => {
            if (!stream)
              return (
                await generateText({ model, prompt: "Hello", maxRetries: 0 })
              ).text;
            let text = "";
            for await (const part of streamText({
              model,
              prompt: "Hello",
              maxRetries: 0,
            }).fullStream) {
              if (part.type === "error") throw part.error;
              if (part.type === "text-delta") text += part.text;
            }
            return text;
          })();
          if (revoked) {
            await expect(result).rejects.toThrow();
            expect(requests).toHaveLength(1);
          } else {
            expect(await result).toBe("answer");
            expect(requests).toHaveLength(2);
          }
          for (const headers of requests) {
            expect(headers).not.toHaveProperty(
              "x-archestra-a2a-oauth-execution",
            );
            expect(headers).not.toHaveProperty("x-archestra-internal-call");
          }
          const persisted = JSON.stringify(
            await db.select().from(schema.interactionsTable),
          );
          expect(persisted).not.toContain(token.id);
          expect(persisted).not.toContain(tokenHash);
          expect(persisted).not.toContain("x-archestra-a2a-oauth-execution");
        });
      }
    }
  }

  test("summary routing retains the original agent restriction and rejects a different organization", async ({
    makeAgent,
    makeUser,
    makeMember,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const original = await makeAgent();
    const summary = await makeAgent({
      organizationId: original.organizationId,
    });
    const foreign = await makeAgent({
      organizationId: (await makeOrganization()).id,
    });
    const user = await makeUser();
    await makeMember(user.id, original.organizationId, { role: "admin" });
    const { oauthClient } = await ManagedOauthClientModel.create({
      organizationId: original.organizationId,
      authorId: user.id,
      name: "Synthetic summary application",
      grantType: "client_credentials",
      scopes: ["a2a"],
      allowedGatewayIds: [original.id],
    });
    const token = await OAuthAccessTokenModel.createClientCredentialsToken({
      tokenHash: OAuthAccessTokenModel.hashTokenForLookup(crypto.randomUUID()),
      clientId: oauthClient.clientId,
      expiresAt: new Date(Date.now() + 60_000),
      scopes: ["a2a"],
      referenceId: `${OAUTH_CLIENT_REFERENCE_PREFIX}${oauthClient.id}`,
    });
    const execution = {
      tokenId: `${OAUTH_TOKEN_ID_PREFIX}${token.id}`,
      clientId: oauthClient.clientId,
    };
    for (const target of [summary, foreign]) {
      const key = await makeLlmProviderApiKey(
        target.organizationId,
        (await makeSecret({ secret: { apiKey: "sk-synthetic" } })).id,
        { provider: "openai", baseUrl },
      );
      const model = authorizeA2AModel({
        agentId: original.id,
        organizationId: original.organizationId,
        execution,
        model: createLLMModel({
          provider: "openai",
          apiKey: "sk-synthetic",
          agentId: target.id,
          modelName: "gpt-4o-mini",
          baseUrl,
          chatApiKeyId: key.id,
          source: "api",
        }),
      });
      const result = generateText({
        model,
        prompt: "Summarize",
        maxRetries: 0,
      });
      if (target === summary) expect((await result).text).toBe("answer");
      else await expect(result).rejects.toThrow();
      expect(requests).toHaveLength(1);
    }
  });

  test("forged, guardrail-only and malformed references cannot reach upstream", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const reference = a2aOAuthExecutionHeader(agent.id, {
      tokenId: "row",
      clientId: "client",
    });
    for (const headers of [
      reference,
      { ...reference, ...guardrailCallHeader() },
      {
        ...internalCallHeader(),
        "x-archestra-a2a-oauth-execution": "{malformed",
      },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/chat/completions`,
        headers,
        payload: {
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
        },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(requests).toHaveLength(0);
  });
});
