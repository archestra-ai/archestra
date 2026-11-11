// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OAUTH_CLIENT_REFERENCE_PREFIX } from "@archestra/shared";
import { HttpResponse, http, passthrough } from "msw";
import {
  guardrailCallHeader,
  internalCallHeader,
} from "@/clients/internal-call";
import config from "@/config";
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

  beforeEach(async () => {
    requests = [];
    upstream = createServer(async (request, response) => {
      requests.push(request.headers);
      for await (const _part of request) {
        /* Drain the real SDK request. */
      }
      const common = {
        id: "synthetic",
        created: 1,
        model: "gpt-4o-mini",
        object: "chat.completion.chunk",
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: "assistant", content: "Private model answered." }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
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
        makeServiceAccountToken,
        makeInternalAgent,
        makeSecret,
        makeLlmProviderApiKey,
      }) => {
        const fireworks = credential === "fireworks-alias";
        if (fireworks)
          network.use(
            http.post(
              "https://api.fireworks.ai/inference/v1/chat/completions",
              async ({ request }) => {
                requests.push(Object.fromEntries(request.headers));
                return new HttpResponse(
                  `data: ${JSON.stringify({ id: "synthetic", created: 1, model: "accounts/fireworks/models/synthetic-model", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Private model answered." }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "synthetic", created: 1, model: "accounts/fireworks/models/synthetic-model", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
                  { headers: { "content-type": "text/event-stream" } },
                );
              },
            ),
          );
        const org = await makeOrganization();
        const owner = await makeUser();
        await makeMember(owner.id, org.id, { role: "admin" });
        const role = await makeCustomRole(org.id, { permission: {} });
        const { serviceAccount, value } = await makeServiceAccountToken({
          organizationId: org.id,
          role: role.role,
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
        expect(requests).toHaveLength(1);
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
        expect(requests).toHaveLength(1);
      });
    }
  }
});
