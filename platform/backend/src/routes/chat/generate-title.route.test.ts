import type { SupportedProvider } from "@archestra/shared";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import ConversationModel from "@/models/conversation";
import MessageModel from "@/models/message";
import ModelModel from "@/models/model";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});

vi.mock("@/secrets-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/secrets-manager")>();
  return {
    ...actual,
    getSecretValueForLlmProviderApiKey: vi.fn(),
  };
});

const mockGenerateText = vi.mocked(generateText);
const mockGetSecretValue = vi.mocked(getSecretValueForLlmProviderApiKey);

describe("POST /api/chat/conversations/:id/generate-title", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    mockGetSecretValue.mockResolvedValue("test-secret-value");

    currentUser = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(currentUser.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: chatRoutes } = await import("./routes");
    await app.register(chatRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  /**
   * Creates a conversation holding one user/assistant exchange, untitled unless
   * a placeholder is given (what the client sends when it opens a new chat).
   */
  async function makeConversationWithExchange(agentId: string, title?: string) {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      payload: title ? { agentId, title } : { agentId },
    });
    expect(createResponse.statusCode).toBe(200);
    const conversation = createResponse.json();

    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: { role: "user", parts: [{ type: "text", text: "Hi!" }] },
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: {
        role: "assistant",
        parts: [{ type: "text", text: "Hello! How can I help?" }],
      },
    });

    return conversation as { id: string };
  }

  /** Points the org default at the given (model, key) so the title LLM resolution is deterministic. */
  async function setOrganizationDefaultLlm(modelId: string, apiKeyId: string) {
    await db
      .update(schema.organizationsTable)
      .set({ defaultModelId: modelId, defaultLlmApiKeyId: apiKeyId })
      .where(eq(schema.organizationsTable.id, organizationId));
  }

  function makeModelRow(provider: SupportedProvider, modelId: string) {
    return ModelModel.create({
      externalId: `${provider}/${modelId}`,
      provider,
      modelId,
      description: modelId,
      contextLength: 100_000,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: false,
      promptPricePerToken: null,
      completionPricePerToken: null,
      ignored: false,
      lastSyncedAt: new Date(),
    });
  }

  test("skips generation when the title LLM resolves to Microsoft 365 Copilot", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    // Copilot's Graph Chat API has a fixed persona that ignores our title
    // instructions (it answers the message instead — a greeting became the
    // title), so the route must not call the LLM at all.
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    const conversation = await makeConversationWithExchange(agent.id);

    const secret = await makeSecret({ secret: { apiKey: "refresh-token" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "microsoft-365-copilot",
      scope: "personal",
      userId: currentUser.id,
      name: "Microsoft 365 Copilot",
    });
    const model = await makeModelRow(
      "microsoft-365-copilot",
      "microsoft-365-copilot",
    );
    await setOrganizationDefaultLlm(model.id, apiKey.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/generate-title`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().title).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test("generates a title through a system-prompt-capable provider", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    // Control case: with a provider that honors system prompts the route
    // calls the LLM and persists its output.
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    const conversation = await makeConversationWithExchange(agent.id);

    const secret = await makeSecret({ secret: { apiKey: "sk-ant-test" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "anthropic",
      scope: "org",
      name: "Anthropic",
    });
    const model = await makeModelRow("anthropic", "claude-sonnet-5");
    await setOrganizationDefaultLlm(model.id, apiKey.id);

    mockGenerateText.mockResolvedValue({
      text: "Friendly greeting",
    } as Awaited<ReturnType<typeof generateText>>);

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/generate-title`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().title).toBe("Friendly greeting");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  test("keeps the placeholder when the model answers instead of titling", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    // A new chat is created holding the opening words of the first message, and
    // the client asks for a regeneration over that placeholder. When the model
    // replies to the conversation rather than naming it, persisting a truncated
    // answer would read worse in the sidebar than the placeholder — so the
    // route settles on the placeholder, which here is already the stored title.
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    const conversation = await makeConversationWithExchange(agent.id, "Hi!");

    const secret = await makeSecret({ secret: { apiKey: "sk-ant-test" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "anthropic",
      scope: "org",
      name: "Anthropic",
    });
    const model = await makeModelRow("anthropic", "claude-sonnet-5");
    await setOrganizationDefaultLlm(model.id, apiKey.id);

    mockGenerateText.mockResolvedValue({
      text: "Hello there! I am happy to help you with anything you need. ".repeat(
        5,
      ),
    } as Awaited<ReturnType<typeof generateText>>);

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/generate-title`,
      payload: { regenerate: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().title).toBe("Hi!");
  });

  test("titles an untitled conversation from its opening words when the model answers instead", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    // Conversations opened outside the chat UI carry no placeholder, so there is
    // nothing to fall back to on the client. The route derives one from the
    // first message rather than leaving the chat permanently untitled.
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    const conversation = await makeConversationWithExchange(agent.id);

    const secret = await makeSecret({ secret: { apiKey: "sk-ant-test" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "anthropic",
      scope: "org",
      name: "Anthropic",
    });
    const model = await makeModelRow("anthropic", "claude-sonnet-5");
    await setOrganizationDefaultLlm(model.id, apiKey.id);

    mockGenerateText.mockResolvedValue({
      text: "Hello there! I am happy to help you with anything you need. ".repeat(
        5,
      ),
    } as Awaited<ReturnType<typeof generateText>>);

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/generate-title`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().title).toBe("Hi!");
  });

  test("falls back to the opening words when the provider call fails", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    const conversation = await makeConversationWithExchange(agent.id);

    const secret = await makeSecret({ secret: { apiKey: "sk-ant-test" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "anthropic",
      scope: "org",
      name: "Anthropic",
    });
    const model = await makeModelRow("anthropic", "claude-sonnet-5");
    await setOrganizationDefaultLlm(model.id, apiKey.id);

    mockGenerateText.mockRejectedValue(new Error("provider unavailable"));

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/generate-title`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().title).toBe("Hi!");
  });

  test("returns 200 (not 500) when the conversation is deleted mid-generation", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    // Title generation is a slow async LLM call; the user can delete the
    // conversation before the generated title is written back. That benign race
    // used to raise a 500 ("Failed to update conversation with title") which was
    // captured as a server exception — it must now fall through gracefully.
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    const conversation = await makeConversationWithExchange(agent.id);

    const secret = await makeSecret({ secret: { apiKey: "sk-ant-test" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "anthropic",
      scope: "org",
      name: "Anthropic",
    });
    const model = await makeModelRow("anthropic", "claude-sonnet-5");
    await setOrganizationDefaultLlm(model.id, apiKey.id);

    // Delete the conversation from inside the mocked generation, reproducing a
    // concurrent delete landing while the title LLM call is in flight — right
    // before the route writes the title back.
    mockGenerateText.mockImplementation(async () => {
      await ConversationModel.delete(
        conversation.id,
        currentUser.id,
        organizationId,
      );
      return { text: "A title" } as Awaited<ReturnType<typeof generateText>>;
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/generate-title`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });
});
