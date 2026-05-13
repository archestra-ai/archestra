import { ChatErrorCode } from "@shared";
import ConversationModel from "@/models/conversation";
import ConversationChatErrorModel from "@/models/conversation-chat-error";
import InteractionModel from "@/models/interaction";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("interaction routes", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeOrganization }) => {
    currentUser = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: interactionRoutes } = await import("./interaction");
    await app.register(interactionRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("lists interactions without requiring chat errors", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "org",
    });
    await InteractionModel.create({
      profileId: agent.id,
      request: {
        model: "gpt-4",
        messages: [{ role: "user", content: "Hello" }],
      },
      response: {
        id: "test-response",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hi there",
              refusal: null,
            },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      },
      type: "openai:chatCompletions",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/interactions?limit=10&offset=0&sortBy=createdAt&sortDirection=desc",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
  });

  test("returns chat errors on interaction detail for chat sessions", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "org",
    });
    const conversation = await ConversationModel.create({
      userId: currentUser.id,
      organizationId,
      agentId: agent.id,
      selectedModel: "gpt-4",
    });
    await ConversationChatErrorModel.create({
      conversationId: conversation.id,
      error: {
        code: ChatErrorCode.ServerError,
        message: "Provider failed.",
        isRetryable: true,
      },
    });
    const interaction = await InteractionModel.create({
      profileId: agent.id,
      sessionId: conversation.id,
      request: {
        model: "gpt-4",
        messages: [{ role: "user", content: "Hello" }],
      },
      response: {
        id: "test-response",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hi there",
              refusal: null,
            },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      },
      type: "openai:chatCompletions",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/interactions/${interaction.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().chatErrors).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        error: {
          code: ChatErrorCode.ServerError,
          message: "Provider failed.",
          isRetryable: true,
        },
      }),
    ]);
  });
});
