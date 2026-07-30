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

  /** Creates an untitled conversation holding one user/assistant exchange. */
  async function makeConversationWithExchange(agentId: string) {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/chat/conversations",
      payload: { agentId },
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

  /**
   * Mirrors an app-opened chat: titled with the app's name up front and seeded
   * with the render tool call plus the canned greeting before any user message,
   * then a real exchange on top.
   */
  async function makeAppChatConversationWithExchange(
    agentId: string,
    overrides: { title?: string; titleIsPlaceholder?: boolean } = {},
  ) {
    const conversation = await ConversationModel.create({
      userId: currentUser.id,
      organizationId,
      agentId,
      title: overrides.title ?? "Expense Tracker",
      titleIsPlaceholder: overrides.titleIsPlaceholder ?? true,
      origin: "app_open",
    });

    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: {
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "render_app",
            toolCallId: "call-1",
            state: "output-available",
            input: { appId: "app-1" },
            output: { structuredContent: { name: "Expense Tracker" } },
          },
        ],
      },
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: {
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "Here's **Expense Tracker**.\n\nWant to change the app? Tell me how!",
          },
        ],
      },
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: {
        role: "user",
        parts: [{ type: "text", text: "Add a monthly budget column" }],
      },
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: {
        role: "assistant",
        parts: [{ type: "text", text: "Added a monthly budget column." }],
      },
    });

    return conversation;
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

  test("titles an app chat still carrying its seeded app name", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    const conversation = await makeAppChatConversationWithExchange(agent.id);
    const secret = await makeSecret({ secret: { apiKey: "sk-ant-test" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "anthropic",
      scope: "org",
      name: "Anthropic",
    });
    const model = await makeModelRow("anthropic", "claude-sonnet-5");
    await setOrganizationDefaultLlm(model.id, apiKey.id);

    mockGenerateText.mockResolvedValue({
      text: "Monthly budget column",
    } as Awaited<ReturnType<typeof generateText>>);

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/generate-title`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().title).toBe("Monthly budget column");
    // The client merges this straight into its conversation cache, so the
    // response has to carry the cleared flag, not just the database row.
    expect(response.json().titleIsPlaceholder).toBe(false);

    // The placeholder is spent: the flag must be off so no later exchange
    // retitles a conversation that now has a real title.
    const [stored] = await db
      .select()
      .from(schema.conversationsTable)
      .where(eq(schema.conversationsTable.id, conversation.id));
    expect(stored.titleIsPlaceholder).toBe(false);
    expect(stored.title).toBe("Monthly budget column");
  });

  test("titles an app chat from the real reply, not the seeded greeting", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    // The greeting is an assistant text message that precedes any user message,
    // so a naive "first assistant text" scan feeds the model boilerplate about
    // the app instead of the exchange the user actually had.
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    const conversation = await makeAppChatConversationWithExchange(agent.id);
    const secret = await makeSecret({ secret: { apiKey: "sk-ant-test" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "anthropic",
      scope: "org",
      name: "Anthropic",
    });
    const model = await makeModelRow("anthropic", "claude-sonnet-5");
    await setOrganizationDefaultLlm(model.id, apiKey.id);

    mockGenerateText.mockResolvedValue({
      text: "Monthly budget column",
    } as Awaited<ReturnType<typeof generateText>>);

    await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/generate-title`,
      payload: {},
    });

    const prompt = JSON.stringify(mockGenerateText.mock.calls[0]?.[0]);
    expect(prompt).toContain("Add a monthly budget column");
    expect(prompt).toContain("Added a monthly budget column.");
    expect(prompt).not.toContain("Want to change the app?");
  });

  test("leaves a renamed app chat alone", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    // Renaming clears the placeholder flag, which is what protects a name the
    // user typed from being overwritten by automatic generation.
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    const conversation = await makeAppChatConversationWithExchange(agent.id, {
      title: "Q3 budget planning",
      titleIsPlaceholder: false,
    });
    const secret = await makeSecret({ secret: { apiKey: "sk-ant-test" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "anthropic",
      scope: "org",
      name: "Anthropic",
    });
    const model = await makeModelRow("anthropic", "claude-sonnet-5");
    await setOrganizationDefaultLlm(model.id, apiKey.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/generate-title`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().title).toBe("Q3 budget planning");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test("a rename landing mid-generation survives the generated title", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    // Generation awaits a multi-second LLM call. An app chat's placeholder
    // title is unhelpful, so renaming while the reply streams is ordinary —
    // and the name the user typed has to beat the one the model guessed.
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    const conversation = await makeAppChatConversationWithExchange(agent.id);
    const secret = await makeSecret({ secret: { apiKey: "sk-ant-test" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "anthropic",
      scope: "org",
      name: "Anthropic",
    });
    const model = await makeModelRow("anthropic", "claude-sonnet-5");
    await setOrganizationDefaultLlm(model.id, apiKey.id);

    mockGenerateText.mockImplementation(async () => {
      await ConversationModel.update(
        conversation.id,
        currentUser.id,
        organizationId,
        { title: "Q3 budget planning" },
      );
      return { text: "Monthly budget column" } as Awaited<
        ReturnType<typeof generateText>
      >;
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/generate-title`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);

    const [stored] = await db
      .select()
      .from(schema.conversationsTable)
      .where(eq(schema.conversationsTable.id, conversation.id));
    expect(stored.title).toBe("Q3 budget planning");
    expect(stored.titleIsPlaceholder).toBe(false);

    // The client merges this response into its cache, so a stale title here
    // would put the placeholder back on screen despite the database being right.
    expect(response.json().title).toBe("Q3 budget planning");
    expect(response.json().titleIsPlaceholder).toBe(false);
  });

  test("keeping the app's name via rename mid-generation still blocks the overwrite", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    // The sidebar rename box prefills the current title, so saving it unchanged
    // is a real flow: the user has claimed "Expense Tracker" as their own name
    // even though the text never changed. Guarding on text alone would miss it.
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    const conversation = await makeAppChatConversationWithExchange(agent.id);
    const secret = await makeSecret({ secret: { apiKey: "sk-ant-test" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "anthropic",
      scope: "org",
      name: "Anthropic",
    });
    const model = await makeModelRow("anthropic", "claude-sonnet-5");
    await setOrganizationDefaultLlm(model.id, apiKey.id);

    mockGenerateText.mockImplementation(async () => {
      await ConversationModel.update(
        conversation.id,
        currentUser.id,
        organizationId,
        { title: "Expense Tracker" },
      );
      return { text: "Monthly budget column" } as Awaited<
        ReturnType<typeof generateText>
      >;
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/generate-title`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const [stored] = await db
      .select()
      .from(schema.conversationsTable)
      .where(eq(schema.conversationsTable.id, conversation.id));
    expect(stored.title).toBe("Expense Tracker");
    expect(stored.titleIsPlaceholder).toBe(false);
  });

  test("does not retitle an app chat a second time", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    // The flag, not a per-mount client ref, is what makes generation one-shot:
    // the client re-asks on every remount.
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    const conversation = await makeAppChatConversationWithExchange(agent.id);
    const secret = await makeSecret({ secret: { apiKey: "sk-ant-test" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "anthropic",
      scope: "org",
      name: "Anthropic",
    });
    const model = await makeModelRow("anthropic", "claude-sonnet-5");
    await setOrganizationDefaultLlm(model.id, apiKey.id);

    mockGenerateText.mockResolvedValue({
      text: "Monthly budget column",
    } as Awaited<ReturnType<typeof generateText>>);

    await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/generate-title`,
      payload: {},
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/generate-title`,
      payload: {},
    });

    expect(second.json().title).toBe("Monthly budget column");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });
});
