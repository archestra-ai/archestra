import type { SupportedProvider } from "@archestra/shared";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
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
  return { ...actual, getSecretValueForLlmProviderApiKey: vi.fn() };
});

const mockGenerateText = vi.mocked(generateText);
const mockGetSecretValue = vi.mocked(getSecretValueForLlmProviderApiKey);

/** Long enough that a short summary is a genuine token saving. */
const LONG_TURN = "background detail ".repeat(80);

describe("POST /api/chat/conversations/:id/compact", () => {
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
      ignored: false,
      lastSyncedAt: new Date(),
    });
  }

  /**
   * A conversation whose last turn is an assistant reply, so the whole history
   * is compactable (no unresolved user turn is held back as the recent suffix).
   */
  async function makeCompactableConversation(agentId: string) {
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
      content: {
        role: "user",
        parts: [{ type: "text", text: `Plan the migration. ${LONG_TURN}` }],
      },
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: {
        role: "assistant",
        parts: [{ type: "text", text: `Here is the plan. ${LONG_TURN}` }],
      },
    });

    return conversation;
  }

  test("summarizes on the conversation's own model, not the organization default", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    // `/compact` always takes the transcript path (manual compaction never
    // reuses the in-context turn), which used to resolve the organization
    // default. A chat running on one self-hosted model then had its history
    // summarized by another — and the summary is what the conversation carries
    // forward, so the swap is invisible but permanent.
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "personal",
    });
    const conversation = await makeCompactableConversation(agent.id);

    const orgSecret = await makeSecret({ secret: { apiKey: "ollama-key" } });
    const orgApiKey = await makeLlmProviderApiKey(
      organizationId,
      orgSecret.id,
      {
        provider: "ollama",
        scope: "org",
        name: "Ollama",
      },
    );
    const orgModel = await makeModelRow("ollama", "llama3.1");
    await db
      .update(schema.organizationsTable)
      .set({ defaultModelId: orgModel.id, defaultLlmApiKeyId: orgApiKey.id })
      .where(eq(schema.organizationsTable.id, organizationId));

    const chatSecret = await makeSecret({ secret: { apiKey: "vllm-key" } });
    const chatApiKey = await makeLlmProviderApiKey(
      organizationId,
      chatSecret.id,
      { provider: "vllm", scope: "org", name: "vLLM" },
    );
    const chatModel = await makeModelRow("vllm", "qwen3-32b");
    await db
      .update(schema.conversationsTable)
      .set({ modelId: chatModel.id, chatApiKeyId: chatApiKey.id })
      .where(eq(schema.conversationsTable.id, conversation.id));

    mockGenerateText.mockResolvedValue({
      text: "<summary>Migration plan agreed.</summary>",
    } as Awaited<ReturnType<typeof generateText>>);

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/compact`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("created");
    expect(mockGenerateText.mock.calls[0][0].model).toMatchObject({
      modelId: "qwen3-32b",
    });
    // The stored record names the model that actually wrote the summary, so
    // the conversation timeline doesn't attribute it to the wrong one.
    expect(response.json().compaction).toMatchObject({
      provider: "vllm",
      model: "qwen3-32b",
    });
  });
});
