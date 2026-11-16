// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OAUTH_CLIENT_REFERENCE_PREFIX } from "@archestra/shared";
import { HttpResponse, http, passthrough } from "msw";
import {
  guardrailCallHeader,
  internalCallHeader,
} from "@/clients/internal-call";
import mcpClient from "@/clients/mcp-client";
import config from "@/config";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ManagedOauthClientModel from "@/models/managed-oauth-client";
import ModelModel from "@/models/model";
import OAuthAccessTokenModel from "@/models/oauth-access-token";
import OrganizationModel from "@/models/organization";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import openAiRoutes from "../proxy/routes/openai";
import a2aV1Routes from "./v1";
import a2aV2Routes from "./v2";

describe("service-account A2A private model grants over HTTP", () => {
  setupTestCacheManager();
  const network = useMswServer();
  let app: FastifyInstanceWithZod;
  let upstream: Server;
  let baseUrl: string;
  let appUrl: string;
  let requests: IncomingHttpHeaders[];
  let mcpCalls: string[];

  beforeEach(async () => {
    requests = [];
    mcpCalls = [];
    upstream = createServer(async (request, response) => {
      requests.push(request.headers);
      let body = "";
      for await (const part of request) body += part;
      const input = JSON.parse(body);
      const callTool =
        input.tools?.length &&
        !input.messages.some(
          (message: { role: string }) => message.role === "tool",
        );
      const common = {
        id: "synthetic",
        created: 1,
        model: "gpt-4o-mini",
        object: "chat.completion.chunk",
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (callTool) {
        response.end(
          `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "synthetic-tool-call", type: "function", function: { name: input.tools.find((tool: { function: { name: string } }) => tool.function.name.endsWith("__echo")).function.name, arguments: "{}" } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
        );
        return;
      }
      response.end(
        `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: "assistant", content: "Private model answered." }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
    app = createFastifyInstance();
    await app.register(openAiRoutes);
    await app.register(a2aV1Routes);
    await app.register(a2aV2Routes);
    await app.listen({ port: 0, host: "127.0.0.1" });
    config.api.port = (app.server.address() as AddressInfo).port;
    appUrl = `http://127.0.0.1:${config.api.port}`;
  });

  afterEach(async () => {
    await mcpClient.disconnectAll();
    await app?.close();
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
  });

  for (const version of ["v1", "v2"] as const) {
    for (const credential of [
      "service-account",
      "bound-oauth",
      "fireworks-alias",
    ] as const) {
      test(`${version} ${credential}: only a current use grant reaches the provider`, async ({
        makeOrganization,
        makeUser,
        makeMember,
        makeCustomRole,
        makeTeam,
        makeServiceAccountToken,
        makeInternalAgent,
        makeSecret,
        makeLlmProviderApiKey,
        makeInternalMcpCatalog,
        makeMcpServer,
        makeTool,
        makeAgentTool,
      }) => {
        const fireworks = credential === "fireworks-alias";
        if (fireworks)
          network.use(
            http.post(
              "https://api.fireworks.ai/inference/v1/chat/completions",
              async ({ request }) => {
                requests.push(Object.fromEntries(request.headers));
                return new HttpResponse(
                  `data: ${JSON.stringify({ id: "synthetic", created: 1, model: "accounts/fireworks/models/synthetic-model", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Private model answered." }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "synthetic", created: 1, model: "accounts/fireworks/models/synthetic-model", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
                  { headers: { "content-type": "text/event-stream" } },
                );
              },
            ),
          );
        const org = await makeOrganization();
        const owner = await makeUser();
        await makeMember(owner.id, org.id, { role: "admin" });
        const role = await makeCustomRole(org.id, { permission: {} });
        const team = await makeTeam(org.id, owner.id);
        const { serviceAccount, value } = await makeServiceAccountToken({
          organizationId: org.id,
          role: role.role,
          teamId: team.id,
        });
        const key = await makeLlmProviderApiKey(
          org.id,
          (
            await makeSecret({
              secret: { apiKey: "sk-synthetic-private-model" },
            })
          ).id,
          {
            provider: "openai",
            baseUrl: fireworks
              ? "https://api.fireworks.ai/inference/v1"
              : baseUrl,
          },
        );
        const keyPolicy = {
          organizationId: org.id,
          resource: "llmProviderApiKey" as const,
          scope: key.id,
        };
        const existingKeyPolicy =
          await ResourcePermissionPolicyModel.find(keyPolicy);
        await ResourcePermissionPolicyModel.replace({
          ...keyPolicy,
          revision: existingKeyPolicy?.revision ?? 0,
          grants: [
            {
              subject: { type: "serviceAccount", id: serviceAccount.id },
              actions: ["read", "use"],
            },
          ],
        });
        const model = await ModelModel.create({
          externalId: fireworks
            ? "openai/accounts/fireworks/models/synthetic-model"
            : "openai/gpt-4o-mini",
          provider: "openai",
          modelId: fireworks
            ? "accounts/fireworks/models/synthetic-model"
            : "gpt-4o-mini",
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportsToolCalling: true,
        });
        await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
          model.id,
        ]);
        const agent = await makeInternalAgent({
          organizationId: org.id,
          accessAllTools: false,
          toolExposureMode: "full",
          llmApiKeyId: version === "v1" ? key.id : null,
          modelId: version === "v1" ? model.id : null,
        });
        if (!fireworks) {
          const mcpUrl = "https://synthetic-attribution.example/mcp";
          network.use(
            http.get(mcpUrl, () => new HttpResponse(null, { status: 405 })),
            http.delete(mcpUrl, () => new HttpResponse(null, { status: 200 })),
            http.post(mcpUrl, async ({ request }) => {
              const input = (await request.json()) as {
                id?: number;
                method: string;
                params?: { name: string };
              };
              if (input.id === undefined)
                return new HttpResponse(null, { status: 202 });
              let result: unknown = {};
              if (input.method === "initialize") {
                result = {
                  protocolVersion: "2025-03-26",
                  capabilities: { tools: {} },
                  serverInfo: { name: "synthetic", version: "1" },
                };
              } else if (input.method === "tools/list") {
                result = {
                  tools: [
                    {
                      name: "echo",
                      inputSchema: { type: "object", properties: {} },
                    },
                  ],
                };
              } else if (input.method === "tools/call") {
                mcpCalls.push(input.params?.name ?? "");
                result = {
                  content: [{ type: "text", text: "Synthetic tool answered." }],
                };
              }
              return HttpResponse.json({
                jsonrpc: "2.0",
                id: input.id,
                result,
              });
            }),
          );
          const catalog = await makeInternalMcpCatalog({
            organizationId: org.id,
            name: "synthetic-attribution",
            serverType: "remote",
            serverUrl: mcpUrl,
          });
          const server = await makeMcpServer({
            catalogId: catalog.id,
            name: "synthetic-org-install",
            serverType: "remote",
            scope: "org",
          });
          await makeMcpServer({
            catalogId: catalog.id,
            name: "synthetic-team-install",
            serverType: "remote",
            scope: "team",
            teamId: team.id,
          });
          const tool = await makeTool({
            name: "synthetic-attribution__echo",
            rawName: "echo",
            catalogId: catalog.id,
            parameters: { type: "object", properties: {} },
          });
          await makeAgentTool(agent.id, tool.id, {
            mcpServerId: server.id,
            credentialResolutionMode: "dynamic",
          });
        }
        network.use(
          http.post(`${appUrl}/${version}/a2a/${agent.id}`, () =>
            passthrough(),
          ),
          http.post(`${appUrl}/v1/openai/${agent.id}/chat/completions`, () =>
            passthrough(),
          ),
          http.post(`${baseUrl}/chat/completions`, () => passthrough()),
        );
        if (version === "v2") {
          await OrganizationModel.patch(org.id, {
            defaultModelId: model.id,
            defaultLlmApiKeyId: key.id,
          });
        }
        const agentPolicy = {
          organizationId: org.id,
          resource: "agent" as const,
          scope: agent.id,
        };
        const existingAgentPolicy =
          await ResourcePermissionPolicyModel.find(agentPolicy);
        await ResourcePermissionPolicyModel.replace({
          ...agentPolicy,
          revision: existingAgentPolicy?.revision ?? 0,
          grants: [
            {
              subject: { type: "serviceAccount", id: serviceAccount.id },
              actions: ["read", "use"],
            },
          ],
        });
        let bearer = value;
        let expectedApp:
          | { id: string; name: string; clientId: string }
          | undefined;
        if (credential === "bound-oauth") {
          const { oauthClient } = await ManagedOauthClientModel.create({
            organizationId: org.id,
            authorId: owner.id,
            name: "Synthetic bound application",
            grantType: "client_credentials",
            scopes: ["a2a"],
            serviceAccountId: serviceAccount.id,
            allowedGatewayIds: [agent.id],
          });
          expectedApp = oauthClient;
          bearer = crypto.randomUUID();
          await OAuthAccessTokenModel.createClientCredentialsToken({
            tokenHash: OAuthAccessTokenModel.hashTokenForLookup(bearer),
            clientId: oauthClient.clientId,
            expiresAt: new Date(Date.now() + 60_000),
            scopes: ["a2a"],
            referenceId: `${OAUTH_CLIENT_REFERENCE_PREFIX}${oauthClient.id}`,
          });
        }
        const policyKey = {
          organizationId: org.id,
          resource: "llmModel" as const,
          scope: model.id,
        };
        const alias = fireworks
          ? await ModelModel.create({
              externalId: "openai/synthetic-model",
              provider: "openai",
              modelId: "synthetic-model",
              inputModalities: ["text"],
              outputModalities: ["text"],
            })
          : null;
        const grant = async (actions: ("read" | "use")[]) => {
          if (alias) {
            const aliasKey = { ...policyKey, scope: alias.id };
            const aliasPolicy =
              await ResourcePermissionPolicyModel.find(aliasKey);
            await ResourcePermissionPolicyModel.replace({
              ...aliasKey,
              revision: aliasPolicy?.revision ?? 0,
              grants: actions.length
                ? [
                    {
                      subject: {
                        type: "serviceAccount",
                        id: serviceAccount.id,
                      },
                      actions,
                    },
                  ]
                : [],
            });
          }
          const current = await ResourcePermissionPolicyModel.find(policyKey);
          await ResourcePermissionPolicyModel.replace({
            ...policyKey,
            revision: current?.revision ?? 0,
            grants: actions.length
              ? [
                  {
                    subject: { type: "serviceAccount", id: serviceAccount.id },
                    actions,
                  },
                ]
              : [],
          });
        };
        const ask = async () => {
          const response = await fetch(`${appUrl}/${version}/a2a/${agent.id}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${bearer}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: version === "v1" ? "message/send" : "SendMessage",
              params: {
                message: {
                  messageId: crypto.randomUUID(),
                  role: version === "v1" ? "user" : "ROLE_USER",
                  parts: [{ kind: "text", text: "Reply briefly." }],
                },
              },
            }),
          });
          expect(response.status).toBe(200);
          return response.json();
        };
        await grant(["read"]);
        expect(JSON.stringify(await ask())).not.toContain(
          "Private model answered.",
        );
        expect(requests).toHaveLength(0);
        await grant(["read", "use"]);
        const forgedHeaders: Record<string, string>[] = [
          {
            ...internalCallHeader(),
            "x-archestra-user-id": `service-account:${serviceAccount.id}`,
          },
          {
            "x-archestra-internal-call": "forged",
            "x-archestra-internal-service-account": serviceAccount.id,
          },
          {
            ...guardrailCallHeader(),
            "x-archestra-internal-service-account": serviceAccount.id,
          },
        ];
        for (const forged of forgedHeaders) {
          const denied = await fetch(
            `${appUrl}/v1/openai/${agent.id}/chat/completions`,
            {
              method: "POST",
              headers: {
                ...forged,
                authorization: "Bearer sk-synthetic-private-model",
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model: model.modelId,
                messages: [{ role: "user", content: "Unauthorized control" }],
              }),
            },
          );
          expect([401, 403]).toContain(denied.status);
          await denied.text();
          expect(requests).toHaveLength(0);
        }
        const allowed = await ask();
        expect(JSON.stringify(allowed)).toContain("Private model answered.");
        expect(requests).toHaveLength(fireworks ? 1 : 2);
        const interactions = await db.select().from(schema.interactionsTable);
        const successful = interactions.filter(
          (row) => row.outputTokens !== null,
        );
        expect(successful).toHaveLength(fireworks ? 1 : 2);
        for (const row of successful) {
          expect(row).toMatchObject({
            serviceAccountId: serviceAccount.id,
            userId: null,
            authenticatedAppId: expectedApp?.id ?? null,
            authenticatedAppName: expectedApp?.name ?? null,
          });
        }
        if (!fireworks) {
          expect(mcpCalls).toEqual(["echo"]);
          const toolLogs = await db.select().from(schema.mcpToolCallsTable);
          expect(toolLogs).toHaveLength(1);
          expect(toolLogs[0]).toMatchObject({
            method: "tools/call",
            mcpServerName:
              credential === "service-account"
                ? "synthetic-org-install"
                : "synthetic-team-install",
            serviceAccountId: serviceAccount.id,
            userId: null,
            oauthClientId: expectedApp?.clientId ?? null,
            isError: false,
            llmToolCallId: "synthetic-tool-call",
          });
        }
        for (const headers of requests) {
          expect(headers).not.toHaveProperty("x-archestra-internal-call");
          expect(headers).not.toHaveProperty(
            "x-archestra-internal-service-account",
          );
        }
        await grant([]);
        expect(JSON.stringify(await ask())).not.toContain(
          "Private model answered.",
        );
        expect(requests).toHaveLength(fireworks ? 1 : 2);
      });
    }
  }
});
