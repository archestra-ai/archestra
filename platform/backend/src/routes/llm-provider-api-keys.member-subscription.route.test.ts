import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { userHasPermission } from "@/auth";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import agentRoutes from "@/routes/agent";
import chatRoutes from "@/routes/chat/routes";
import llmProviderApiKeyRoutes from "@/routes/llm-provider-api-keys";
import llmModelsRoutes from "@/routes/llm-provider-models";
import { afterEach, describe, expect, test } from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
import { useMswServer as setupMswServer } from "@/test/msw";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";

vi.mock("@/observability");

const server = setupMswServer();
let app: FastifyInstanceWithZod | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("Member personal subscription usage", () => {
  test("can connect a personal subscription for agents and chats without shared-key permission", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    server.use(
      http.get("https://api.anthropic.com/v1/models", () =>
        HttpResponse.json({
          data: [
            {
              id: "claude-sonnet-4-5",
              display_name: "Claude Sonnet 4.5",
              type: "model",
              created_at: "2025-01-01T00:00:00Z",
            },
          ],
          has_more: false,
          first_id: "claude-sonnet-4-5",
          last_id: "claude-sonnet-4-5",
        }),
      ),
      http.get("https://models.dev/api.json", () => HttpResponse.json({})),
    );
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    app = await authenticatedRouteApp({
      organizationId: org.id,
      routes: [
        llmProviderApiKeyRoutes,
        llmModelsRoutes,
        chatRoutes,
        agentRoutes,
      ],
    });
    const headers = { [USER_HEADER]: user.id };
    const created = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      headers,
      payload: {
        name: "My Claude",
        provider: "anthropic",
        apiKey: "sk-ant-oat01-abcdef",
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const key = created.json();
    expect(key).toMatchObject({
      provider: "anthropic",
      userId: user.id,
      scope: "personal",
    });
    const list = await app.inject({
      method: "GET",
      url: "/api/llm-provider-api-keys",
      headers,
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().data ?? list.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: key.id })]),
    );
    const avail = await app.inject({
      method: "GET",
      url: "/api/llm-provider-api-keys/available",
      headers,
    });
    expect(avail.statusCode, avail.body).toBe(200);
    expect(avail.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: key.id })]),
    );
    const models = await app.inject({
      method: "GET",
      url: "/api/llm-models/available",
      headers,
    });
    expect(models.statusCode, models.body).toBe(200);
    expect(models.json().length).toBeGreaterThan(0);
    const resolved = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "anthropic",
    });
    expect(resolved).toMatchObject({
      chatApiKeyId: key.id,
      apiKey: "sk-ant-oat01-abcdef",
    });
    expect(
      await userHasPermission(user.id, org.id, "llmProviderApiKey", "create"),
    ).toBe(false);
    const selectedModel = models
      .json()
      .find((model: { id: string }) => model.id === "claude-sonnet-4-5");
    expect(selectedModel).toBeDefined();
    const createdAgent = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers,
      payload: {
        name: "Personal subscription agent",
        agentType: "agent",
        llmApiKeyId: key.id,
        modelId: selectedModel.dbId,
      },
    });
    expect(createdAgent.statusCode, createdAgent.body).toBe(200);
    const agent = createdAgent.json();
    expect(agent).toMatchObject({
      llmApiKeyId: key.id,
      modelId: selectedModel.dbId,
    });
    const conv = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers,
      payload: { agentId: agent.id, chatApiKeyId: key.id },
    });
    expect(conv.statusCode, conv.body).toBe(200);
    expect(conv.json()).toMatchObject({
      chatApiKeyId: key.id,
      userId: user.id,
    });
    const other = await makeUser();
    await makeMember(other.id, org.id, { role: "member" });
    const otherHeaders = { [USER_HEADER]: other.id };
    const otherKeys = await app.inject({
      method: "GET",
      url: "/api/llm-provider-api-keys/available",
      headers: otherHeaders,
    });
    expect(otherKeys.statusCode, otherKeys.body).toBe(200);
    expect(otherKeys.json()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: key.id })]),
    );
    const otherModels = await app.inject({
      method: "GET",
      url: "/api/llm-models/available?provider=anthropic",
      headers: otherHeaders,
    });
    expect(otherModels.statusCode, otherModels.body).toBe(200);
    expect(otherModels.json()).toEqual([]);
    const otherResolution = await resolveProviderApiKey({
      organizationId: org.id,
      userId: other.id,
      provider: "anthropic",
    });
    expect(otherResolution.apiKey).toBeUndefined();
    const sharedAgent = await makeAgent({ organizationId: org.id });
    const forbiddenConversation = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      headers: otherHeaders,
      payload: { agentId: sharedAgent.id, chatApiKeyId: key.id },
    });
    expect(forbiddenConversation.statusCode, forbiddenConversation.body).toBe(
      403,
    );
  });
});
