import db, { schema } from "@/database";
import { seedDefaultUserAndOrg } from "@/database/seed";
import {
  AgentModel,
  ConversationChatErrorModel,
  ConversationModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  MemberModel,
  ModelModel,
  OrganizationModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import { seededChatPreviewScenarios } from "./chat-scenarios";
import { parseSeedChatScenariosArgs } from "./seed-chat-scenarios";
import {
  DEBUG_CHAT_TITLE_PREFIX,
  seedChatScenarios,
} from "./seed-chat-scenarios-service";

describe("seed chat scenarios", () => {
  test("uses the member default agent and creates one conversation per scenario", async () => {
    const results = await seedChatScenarios({
      chatBaseUrl: "http://localhost:3000",
    });

    expect(results).toHaveLength(seededChatPreviewScenarios.length);
    expect(results[0].url).toMatch(/^http:\/\/localhost:3000\/chat\//);

    const [organization] = await db.select().from(schema.organizationsTable);
    const [user] = await db.select().from(schema.usersTable);
    const defaultAgentId = await MemberModel.getDefaultAgentId(
      user.id,
      organization.id,
    );
    const agents = await AgentModel.findByOrganizationId(organization.id, {
      agentType: "agent",
    });

    expect(defaultAgentId).toEqual(expect.any(String));
    expect(
      agents.some((agent) => agent.name === "Debug Conversation Renderer"),
    ).toBe(false);

    const conversations = await ConversationModel.findAll(
      user.id,
      organization.id,
    );
    const seededConversations = conversations.filter((conversation) =>
      conversation.title?.startsWith(DEBUG_CHAT_TITLE_PREFIX),
    );

    expect(seededConversations).toHaveLength(seededChatPreviewScenarios.length);
    expect(
      seededConversations.every(
        (conversation) => conversation.agentId === defaultAgentId,
      ),
    ).toBe(true);
  });

  test("persists UIMessage content, message roles, and chat error timestamps", async () => {
    const [result] = await seedChatScenarios({
      scenarioId: "timeline-errors",
    });
    const [organization] = await db.select().from(schema.organizationsTable);
    const [user] = await db.select().from(schema.usersTable);

    const conversation = await ConversationModel.findById({
      id: result.conversationId,
      userId: user.id,
      organizationId: organization.id,
    });

    expect(conversation).toMatchObject({
      title: `${DEBUG_CHAT_TITLE_PREFIX} Timeline errors`,
      messages: [
        expect.objectContaining({
          id: expect.any(String),
          role: "user",
          parts: [{ type: "text", text: "first try" }],
          metadata: { createdAt: "2026-04-23T10:00:00.000Z" },
        }),
        expect.objectContaining({
          id: expect.any(String),
          role: "user",
          parts: [{ type: "text", text: "try again" }],
          metadata: { createdAt: "2026-04-23T10:02:00.000Z" },
        }),
      ],
    });

    const chatErrors = await ConversationChatErrorModel.findByConversation(
      result.conversationId,
    );

    expect(chatErrors).toHaveLength(1);
    expect(chatErrors[0]).toMatchObject({
      conversationId: result.conversationId,
      error: {
        code: "server_error",
        message: "Provider failed",
        isRetryable: true,
      },
    });
    expect(chatErrors[0].createdAt.toISOString()).toBe(
      "2026-04-23T10:01:00.000Z",
    );
  });

  test("rerun without keepExisting replaces prior debug conversations", async () => {
    const firstResults = await seedChatScenarios({
      scenarioId: "timeline-errors",
    });
    const secondResults = await seedChatScenarios({
      scenarioId: "timeline-errors",
    });
    const [organization] = await db.select().from(schema.organizationsTable);
    const [user] = await db.select().from(schema.usersTable);

    expect(secondResults[0].conversationId).not.toBe(
      firstResults[0].conversationId,
    );

    const conversations = await ConversationModel.findAll(
      user.id,
      organization.id,
    );
    const seededConversations = conversations.filter((conversation) =>
      conversation.title?.startsWith(DEBUG_CHAT_TITLE_PREFIX),
    );

    expect(seededConversations).toHaveLength(1);
    expect(seededConversations[0].id).toBe(secondResults[0].conversationId);
  });

  test("keepExisting preserves previous debug conversations", async () => {
    const firstResults = await seedChatScenarios({
      scenarioId: "timeline-errors",
    });
    const secondResults = await seedChatScenarios({
      scenarioId: "timeline-errors",
      keepExisting: true,
    });
    const [organization] = await db.select().from(schema.organizationsTable);
    const [user] = await db.select().from(schema.usersTable);

    const conversations = await ConversationModel.findAll(
      user.id,
      organization.id,
    );
    const seededConversationIds = conversations
      .filter((conversation) =>
        conversation.title?.startsWith(DEBUG_CHAT_TITLE_PREFIX),
      )
      .map((conversation) => conversation.id);

    expect(seededConversationIds).toEqual(
      expect.arrayContaining([
        firstResults[0].conversationId,
        secondResults[0].conversationId,
      ]),
    );
  });

  test("uses the organization default LLM key when present", async () => {
    const { user, organization } = await getDefaultLocalUserAndOrganization();
    await createProviderKeyWithBestModel({
      organizationId: organization.id,
      keyName: "Fallback key",
      provider: "anthropic",
      modelId: "claude-3-5-haiku-latest",
    });
    const defaultKey = await createProviderKeyWithBestModel({
      organizationId: organization.id,
      keyName: "Default key",
      provider: "openai",
      modelId: "gpt-4o-mini",
    });
    await OrganizationModel.patch(organization.id, {
      defaultLlmApiKeyId: defaultKey.id,
    });

    const [result] = await seedChatScenarios({
      scenarioId: "timeline-errors",
    });

    const conversation = await ConversationModel.findById({
      id: result.conversationId,
      userId: user.id,
      organizationId: organization.id,
    });

    expect(conversation).toMatchObject({
      chatApiKeyId: defaultKey.id,
      selectedModel: "gpt-4o-mini",
      selectedProvider: "openai",
    });
  });

  test("falls back to the first organization LLM key", async () => {
    const { user, organization } = await getDefaultLocalUserAndOrganization();
    const firstKey = await createProviderKeyWithBestModel({
      organizationId: organization.id,
      keyName: "First key",
      provider: "anthropic",
      modelId: "claude-3-5-haiku-latest",
    });

    const [result] = await seedChatScenarios({
      scenarioId: "timeline-errors",
    });

    const conversation = await ConversationModel.findById({
      id: result.conversationId,
      userId: user.id,
      organizationId: organization.id,
    });

    expect(conversation).toMatchObject({
      chatApiKeyId: firstKey.id,
      selectedModel: "claude-3-5-haiku-latest",
      selectedProvider: "anthropic",
    });
  });

  test("still seeds render-only conversations when no LLM key exists", async () => {
    const [result] = await seedChatScenarios({
      scenarioId: "timeline-errors",
    });
    const [organization] = await db.select().from(schema.organizationsTable);
    const [user] = await db.select().from(schema.usersTable);

    const conversation = await ConversationModel.findById({
      id: result.conversationId,
      userId: user.id,
      organizationId: organization.id,
    });

    expect(conversation).toMatchObject({
      chatApiKeyId: null,
      selectedModel: "gpt-4o",
      selectedProvider: "openai",
    });
  });

  test("unknown scenario fails with a clear error", async () => {
    await expect(
      seedChatScenarios({ scenarioId: "does-not-exist" }),
    ).rejects.toThrow('Unknown chat scenario "does-not-exist"');
  });

  test("parses CLI arguments", () => {
    expect(
      parseSeedChatScenariosArgs([
        "--scenario",
        "timeline-errors",
        "--keep-existing",
        "--chat-base-url",
        "http://localhost:3001",
      ]),
    ).toEqual({
      scenarioId: "timeline-errors",
      keepExisting: true,
      chatBaseUrl: "http://localhost:3001",
    });
  });
});

async function getDefaultLocalUserAndOrganization() {
  const user = await seedDefaultUserAndOrg();
  const organization = await OrganizationModel.getOrCreateDefaultOrganization();

  return { user, organization };
}

async function createProviderKeyWithBestModel(params: {
  organizationId: string;
  keyName: string;
  provider: "anthropic" | "openai";
  modelId: string;
}) {
  const apiKey = await LlmProviderApiKeyModel.create({
    organizationId: params.organizationId,
    name: params.keyName,
    provider: params.provider,
    scope: "org",
  });
  const model = await ModelModel.create({
    externalId: `${params.provider}/${params.modelId}`,
    provider: params.provider,
    modelId: params.modelId,
    inputModalities: null,
    outputModalities: null,
  });
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(apiKey.id, [
    model.id,
  ]);

  return apiKey;
}
