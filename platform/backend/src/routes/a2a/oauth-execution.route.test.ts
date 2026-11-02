import { OAUTH_CLIENT_REFERENCE_PREFIX } from "@archestra/shared";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { HttpResponse, http } from "msw";
import { describe, vi } from "vitest";
import * as llmClient from "@/clients/llm-client";
import { createFastifyInstance } from "@/fastify-instance";
import {
  A2AContextModel,
  A2ATaskModel,
  LlmProviderApiKeyModelLinkModel,
  ManagedOauthClientModel,
  ModelModel,
  OAuthAccessTokenModel,
} from "@/models";
import { expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import a2aV1Routes from "./v1";
import a2aV2Routes from "./v2";

describe("OAuth A2A execution", () => {
  const external = useMswServer();

  for (const { version, revocation, runtime } of (["v1", "v2"] as const)
    .flatMap((version) =>
      (
        [
          "none",
          "before-tool",
          "after-tool",
          "summary-none",
          "summary-revoke",
          "repair-none",
          "repair-revoke",
          "transport-none",
          "transport-revoke",
        ] as const
      ).map((revocation) => ({
        version,
        revocation,
        runtime: false,
      })),
    )
    .concat([
      { version: "v1", revocation: "none", runtime: true },
      { version: "v1", revocation: "after-tool", runtime: true },
    ])) {
    test(`${version} unbound OAuth executes a team-scoped agent's real MCP tool (${revocation}, runtime=${runtime})`, async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeInternalAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
      makeAgentTool,
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      const team = await makeTeam(org.id, user.id);
      const compaction = revocation.startsWith("summary-");
      const repair = revocation.startsWith("repair-");
      const summaryModel = compaction
        ? await ModelModel.create({
            externalId: "synthetic-summary",
            provider: "openai",
            modelId: "synthetic-summary",
            description: "Synthetic summary model",
            contextLength: 20000,
            outputLength: null,
            inputModalities: ["text"],
            outputModalities: ["text"],
            supportsToolCalling: true,
            promptPricePerToken: null,
            completionPricePerToken: null,
            lastSyncedAt: new Date(),
          })
        : null;
      const summaryKey = summaryModel
        ? await makeLlmProviderApiKey(org.id, null, { provider: "openai" })
        : null;
      if (summaryKey && summaryModel)
        await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
          summaryKey.id,
          [summaryModel],
          "openai",
        );
      const agent = await makeInternalAgent({
        organizationId: org.id,
        access: { teams: [team.id] },
        toolExposureMode: "full",
        ...(runtime && {
          runtime: {
            image: "example.invalid/oauth-runtime:test",
            command: null,
            inferenceProtocol: "openai_responses" as const,
            backend: "kubernetes" as const,
            steerMode: "pipe" as const,
            privileged: false,
            environment: null,
            credentials: null,
            ttlHours: null,
            idleTimeoutMinutes: null,
          },
        }),
        ...(summaryModel &&
          summaryKey && {
            modelId: summaryModel.id,
            llmApiKeyId: summaryKey.id,
          }),
      });
      const catalog = await makeInternalMcpCatalog({
        organizationId: org.id,
        serverType: "remote",
        serverUrl: "https://synthetic.example.com/mcp",
      });
      const installation = await makeMcpServer({
        catalogId: catalog.id,
        serverType: "remote",
        scope: "org",
      });
      const tool = await makeTool({
        catalogId: catalog.id,
        name: "synthetic__echo",
        rawName: "echo",
        parameters: { type: "object", properties: {} },
      });
      await makeAgentTool(agent.id, tool.id, {
        mcpServerId: installation.id,
      });
      let invocations = 0;
      let invalidateToken = async () => {};
      external.use(
        http.post("https://synthetic.example.com/mcp", async ({ request }) => {
          const body = (await request.json()) as {
            id?: number;
            method: string;
          };
          if (body.id === undefined)
            return new HttpResponse(null, { status: 202 });
          let result: unknown = {};
          if (body.method === "initialize") {
            result = {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "synthetic", version: "1" },
            };
          } else if (body.method === "tools/call") {
            invocations++;
            if (revocation === "after-tool") await invalidateToken();
            result = {
              content: [{ type: "text", text: "synthetic tool OK" }],
            };
          }
          return HttpResponse.json({ jsonrpc: "2.0", id: body.id, result });
        }),
        http.get(
          "https://synthetic.example.com/mcp",
          () => new HttpResponse(null, { status: 405 }),
        ),
        http.delete(
          "https://synthetic.example.com/mcp",
          () => new HttpResponse(null, { status: 200 }),
        ),
      );
      let providerCalls = 0;
      let summaryCalls = 0;
      const model = new MockLanguageModelV3({
        doGenerate: async () => {
          providerCalls++;
          summaryCalls++;
          if (
            (revocation === "summary-revoke" ||
              revocation === "repair-revoke") &&
            summaryCalls === 1
          )
            await invalidateToken();
          if (repair && summaryCalls === 1)
            throw new APICallError({
              message: "Synthetic transient failure",
              url: "https://synthetic.example.com",
              requestBodyValues: {},
              statusCode: 503,
              isRetryable: true,
            });
          return {
            content: [
              {
                type: "text",
                text: repair
                  ? "{}"
                  : summaryCalls === 1
                    ? "Deliberately untagged summary"
                    : "<summary>Synthetic summary</summary>",
              },
            ],
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
          };
        },
        doStream: async ({ prompt }) => {
          providerCalls++;
          if (revocation.startsWith("transport-") && providerCalls === 1) {
            if (revocation === "transport-revoke") await invalidateToken();
            throw new APICallError({
              message: "Synthetic transient failure",
              url: "https://synthetic.example.com",
              requestBodyValues: {},
              statusCode: 503,
              isRetryable: true,
            });
          }
          const finished = prompt.some((message) => message.role === "tool");
          if (!finished && revocation === "before-tool")
            await invalidateToken();
          const chunks = finished
            ? ([
                { type: "text-start", id: "text" },
                {
                  type: "text-delta",
                  id: "text",
                  delta: "synthetic tool OK",
                },
                { type: "text-end", id: "text" },
              ] as const)
            : ([
                {
                  type: "tool-call",
                  toolCallId: "echo-call",
                  toolName: tool.name,
                  input: repair ? '{"message">"malformed"}' : "{}",
                },
              ] as const);
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk);
                controller.enqueue({
                  type: "finish",
                  finishReason: {
                    unified: finished ? "stop" : "tool-calls",
                    raw: undefined,
                  },
                  usage: {
                    inputTokens: {
                      total: 1,
                      noCache: 1,
                      cacheRead: 0,
                      cacheWrite: 0,
                    },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                });
                controller.close();
              },
            }),
          };
        },
      });
      vi.spyOn(llmClient, "createLLMModelForAgent").mockResolvedValue({
        model,
        provider: "openai",
        apiKeySource: "org",
        anthropicNativeEndpoint: false,
      });
      const { oauthClient } = await ManagedOauthClientModel.create({
        organizationId: org.id,
        authorId: user.id,
        name: "Synthetic application",
        grantType: "client_credentials",
        scopes: ["a2a"],
        allowedGatewayIds: [agent.id],
      });
      const bearer = crypto.randomUUID();
      await OAuthAccessTokenModel.createClientCredentialsToken({
        tokenHash: OAuthAccessTokenModel.hashTokenForLookup(bearer),
        clientId: oauthClient.clientId,
        expiresAt: new Date(Date.now() + 60_000),
        scopes: ["a2a"],
        referenceId: `${OAUTH_CLIENT_REFERENCE_PREFIX}${oauthClient.id}`,
      });
      invalidateToken = async () => {
        await OAuthAccessTokenModel.deleteByTokenHash(
          OAuthAccessTokenModel.hashTokenForLookup(bearer),
        );
      };
      const app = createFastifyInstance();
      await app.register(a2aV1Routes);
      await app.register(a2aV2Routes);
      try {
        const response = await app.inject({
          method: "POST",
          url: `/${version}/a2a/${agent.id}`,
          headers: { authorization: `Bearer ${bearer}` },
          payload: {
            jsonrpc: "2.0",
            id: 1,
            method: version === "v1" ? "message/send" : "SendMessage",
            params: {
              message: {
                messageId: crypto.randomUUID(),
                role: version === "v1" ? "user" : "ROLE_USER",
                parts: [
                  {
                    kind: "text",
                    text:
                      "Call echo." +
                      (compaction
                        ? " Synthetic transcript context.".repeat(10000)
                        : ""),
                  },
                ],
              },
            },
          },
        });
        if (revocation === "summary-revoke" || revocation === "repair-revoke") {
          expect(summaryCalls, response.body).toBe(1);
          expect(providerCalls).toBe(2);
          expect(invocations).toBe(compaction ? 1 : 0);
          expect(response.json().error, response.body).toBeDefined();
          return;
        }
        if (revocation === "transport-revoke") {
          expect(providerCalls).toBe(1);
          expect(invocations).toBe(0);
          expect(response.json().error, response.body).toBeDefined();
          return;
        }
        if (revocation === "summary-none" || revocation === "repair-none") {
          expect(summaryCalls, response.body).toBe(2);
          expect(providerCalls).toBe(4);
        } else if (revocation === "transport-none") {
          expect(providerCalls).toBe(3);
        } else if (revocation !== "none") {
          await new Promise((resolve) => setTimeout(resolve, 100));
          expect(providerCalls).toBe(1);
          expect(invocations).toBe(revocation === "after-tool" ? 1 : 0);
          expect(response.json().error, response.body).toBeDefined();
          return;
        }
        expect(response.json().error, response.body).toBeUndefined();
        expect(invocations).toBe(1);
        expect(response.body).toContain("synthetic tool OK");
        if (version === "v2" && revocation === "none") {
          const contextId = response.json().result.message.contextId;
          const context = await A2AContextModel.findById(contextId);
          expect(context).toMatchObject({
            actorKind: "oauthClient",
            actorId: oauthClient.clientId,
          });
          expect(JSON.stringify(context)).not.toContain(bearer);
          expect(JSON.stringify(context)).not.toContain(
            OAuthAccessTokenModel.hashTokenForLookup(bearer),
          );
          const task = await A2ATaskModel.create({
            contextId,
            agentId: agent.id,
            state: "TASK_STATE_WORKING",
          });
          const rotated = crypto.randomUUID();
          await OAuthAccessTokenModel.createClientCredentialsToken({
            tokenHash: OAuthAccessTokenModel.hashTokenForLookup(rotated),
            clientId: oauthClient.clientId,
            expiresAt: new Date(Date.now() + 60_000),
            scopes: ["a2a"],
            referenceId: `${OAUTH_CLIENT_REFERENCE_PREFIX}${oauthClient.id}`,
          });
          await OAuthAccessTokenModel.deleteByTokenHash(
            OAuthAccessTokenModel.hashTokenForLookup(bearer),
          );
          const call = (token: string, method: string, params: unknown) =>
            app.inject({
              method: "POST",
              url: `/v2/a2a/${agent.id}`,
              headers: { authorization: `Bearer ${token}` },
              payload: { jsonrpc: "2.0", id: 2, method, params },
            });
          const own = await call(rotated, "GetTask", { id: task.id });
          expect(own.json().error, own.body).toBeUndefined();
          const revoked = await call(bearer, "GetTask", { id: task.id });
          expect(revoked.json().error, revoked.body).toBeDefined();
          const other = await ManagedOauthClientModel.create({
            organizationId: org.id,
            authorId: user.id,
            name: "Other app",
            grantType: "client_credentials",
            scopes: ["a2a"],
            allowedGatewayIds: [agent.id],
          });
          const foreign = crypto.randomUUID();
          await OAuthAccessTokenModel.createClientCredentialsToken({
            tokenHash: OAuthAccessTokenModel.hashTokenForLookup(foreign),
            clientId: other.oauthClient.clientId,
            expiresAt: new Date(Date.now() + 60_000),
            scopes: ["a2a"],
            referenceId: `${OAUTH_CLIENT_REFERENCE_PREFIX}${other.oauthClient.id}`,
          });
          expect(
            (await call(foreign, "GetTask", { id: task.id })).json().error
              ?.code,
          ).toBe(-32001);
          const followup = await call(rotated, "SendMessage", {
            message: {
              messageId: crypto.randomUUID(),
              contextId,
              role: "ROLE_USER",
              parts: [{ text: "Continue." }],
            },
          });
          expect(followup.json().error, followup.body).toBeUndefined();
          expect(followup.json().result.message.contextId).toBe(contextId);
        }
      } finally {
        await app.close();
        vi.restoreAllMocks();
      }
    });
  }
});
