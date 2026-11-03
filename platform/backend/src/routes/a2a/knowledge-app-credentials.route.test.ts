// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  OAUTH_CLIENT_REFERENCE_PREFIX,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
} from "@archestra/shared";
import { MockLanguageModelV3 } from "ai/test";
import { describe, vi } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import * as llmClient from "@/clients/llm-client";
import { createFastifyInstance } from "@/fastify-instance";
import { ManagedOauthClientModel, OAuthAccessTokenModel } from "@/models";
import { expect, test } from "@/test";
import {
  configureKnowledgeSearch,
  indexKnowledgeDocument,
  indexKnowledgeFile,
  knowledgeEmbeddingHandler,
  publishKnowledgeSource,
} from "@/test/knowledge-search";
import { useMswServer } from "@/test/msw";
import a2aV1Routes from "./v1";
import a2aV2Routes from "./v2";

const KNOWLEDGE_TOOL = archestraMcpBranding.getToolName(
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
);

describe("A2A knowledge search for an unbound application", () => {
  useMswServer(knowledgeEmbeddingHandler);

  for (const version of ["v1", "v2"] as const) {
    for (const source of ["connector", "uploaded-file"] as const) {
      test(`${version} preserves the app identity through discovery and retrieval (${source})`, async ({
        makeOrganization,
        makeUser,
        makeMember,
        makeInternalAgent,
        makeKnowledgeBase,
        makeKnowledgeBaseConnector,
        makeLlmProviderApiKey,
        seedAndAssignArchestraTools,
      }) => {
        const org = await makeOrganization();
        const author = await makeUser();
        await makeMember(author.id, org.id, { role: "admin" });
        const base = await makeKnowledgeBase(org.id, { access: "org" });
        const connector =
          source === "connector"
            ? await makeKnowledgeBaseConnector(base.id, org.id, {
                name: "Published handbook",
                access: "org",
                syncPermissionsFromSource: true,
              })
            : null;
        await publishKnowledgeSource({
          organizationId: org.id,
          resource: "knowledgeBase",
          scope: base.id,
        });
        if (connector)
          await publishKnowledgeSource({
            organizationId: org.id,
            resource: "knowledgeConnector",
            scope: connector.id,
          });
        const agent = await makeInternalAgent({
          organizationId: org.id,
          knowledgeBaseIds: [base.id],
          accessAllTools: false,
          toolExposureMode: "full",
        });
        await seedAndAssignArchestraTools(agent.id);
        await configureKnowledgeSearch(org.id, makeLlmProviderApiKey);
        if (connector) {
          await indexKnowledgeDocument({
            organizationId: org.id,
            connectorId: connector.id,
            content: "The public launch code is ORBIT.",
            acl: ["org:*"],
          });
          await indexKnowledgeDocument({
            organizationId: org.id,
            connectorId: connector.id,
            content: "The author's private code is SECRET.",
            acl: [`user_email:${author.email}`],
          });
        } else {
          await indexKnowledgeFile({
            organizationId: org.id,
            knowledgeBaseId: base.id,
            uploadedBy: author.id,
            content: "The public launch code is ORBIT.",
            published: true,
          });
          await indexKnowledgeFile({
            organizationId: org.id,
            knowledgeBaseId: base.id,
            uploadedBy: author.id,
            content: "The author's private code is SECRET.",
            published: false,
          });
        }
        // The OAuth client's author must never become the acting search user.
        let offeredKnowledge = false;
        let receivedKnowledge = "";
        const model = new MockLanguageModelV3({
          doStream: async ({ prompt, tools }) => {
            offeredKnowledge ||=
              tools?.some(
                (tool) =>
                  tool.type === "function" &&
                  tool.name === KNOWLEDGE_TOOL &&
                  tool.description?.includes(
                    source === "connector"
                      ? "Published handbook"
                      : "Uploaded files",
                  ),
              ) ?? false;
            const results = prompt.filter((message) => message.role === "tool");
            const finished = results.length > 0;
            if (finished) receivedKnowledge = JSON.stringify(results);
            return {
              stream: new ReadableStream({
                start(controller) {
                  if (finished) {
                    controller.enqueue({ type: "text-start", id: "answer" });
                    controller.enqueue({
                      type: "text-delta",
                      id: "answer",
                      delta: receivedKnowledge.includes("ORBIT")
                        ? "The code is ORBIT."
                        : "No public fact returned.",
                    });
                    controller.enqueue({ type: "text-end", id: "answer" });
                  } else {
                    controller.enqueue({
                      type: "tool-call",
                      toolCallId: "knowledge-call",
                      toolName: KNOWLEDGE_TOOL,
                      input: JSON.stringify({ query: "launch code" }),
                    });
                  }
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
          authorId: author.id,
          name: "Synthetic knowledge application",
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
        const app = createFastifyInstance();
        await app.register(version === "v1" ? a2aV1Routes : a2aV2Routes);
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
                      text: "Find the launch code in knowledge.",
                    },
                  ],
                },
              },
            },
          });
          expect(response.statusCode).toBe(200);
          expect(offeredKnowledge, response.body).toBe(true);
          expect(receivedKnowledge, response.body).toContain("ORBIT");
          expect(receivedKnowledge).not.toContain("SECRET");
          expect(response.body).toContain("ORBIT");
        } finally {
          await app.close();
        }
      });
    }
  }
});
