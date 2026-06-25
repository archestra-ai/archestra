import { ChatErrorCode } from "@archestra/shared";
import ConversationModel from "@/models/conversation";
import ConversationChatErrorModel from "@/models/conversation-chat-error";
import InteractionModel from "@/models/interaction";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { InsertInteraction, User } from "@/types";

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

  test("lists interactions whose response carries a non-standard finish_reason", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "org",
    });
    // Models fronted by OpenRouter can emit finish_reason values outside the
    // canonical OpenAI set; the stored row must still serialize on read-back.
    await InteractionModel.create({
      profileId: agent.id,
      request: {
        model: "minimax/minimax-m3",
        messages: [{ role: "user", content: "Hello" }],
      },
      response: {
        id: "test-response",
        object: "chat.completion",
        created: Date.now(),
        model: "minimax/minimax-m3",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hi there",
              refusal: null,
            },
            finish_reason: "unusual_reason",
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
    expect(response.json().data[0].response.choices[0].finish_reason).toBe(
      "unusual_reason",
    );
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

  test("returns fully reconstructed request for delta-encoded Claude interactions", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: currentUser.id,
      scope: "org",
    });

    const anthropicResponse = {
      id: "msg_test",
      type: "message",
      container: null,
      role: "assistant",
      content: [{ type: "text", text: "ok", citations: [] }],
      model: "claude-3-5-sonnet",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
    const m0 = { role: "user", content: "first message in the claude session" };
    const fullMessages = [
      m0,
      { role: "assistant", content: "ack" },
      { role: "user", content: "second message" },
    ];

    const anthropicReq = (messages: unknown[]) =>
      ({
        model: "claude-3-5-sonnet",
        max_tokens: 1024,
        messages,
      }) as unknown as InsertInteraction["request"];
    const anthropicResp =
      anthropicResponse as unknown as InsertInteraction["response"];

    await InteractionModel.create({
      profileId: agent.id,
      sessionId: "route-delta-session",
      sessionSource: "claude_code",
      type: "anthropic:messages",
      request: anthropicReq([m0]),
      response: anthropicResp,
    });
    const tip = await InteractionModel.create({
      profileId: agent.id,
      sessionId: "route-delta-session",
      sessionSource: "claude_code",
      type: "anthropic:messages",
      request: anthropicReq(fullMessages),
      response: anthropicResp,
    });

    // Detail endpoint reconstructs the full request and passes response schema.
    const detail = await app.inject({
      method: "GET",
      url: `/api/interactions/${tip.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().request.messages).toEqual(fullMessages);

    // Session-filtered list reconstructs every interaction's request.
    const list = await app.inject({
      method: "GET",
      url: "/api/interactions?limit=10&offset=0&sortBy=createdAt&sortDirection=desc&sessionId=route-delta-session",
    });
    expect(list.statusCode).toBe(200);
    const tipRow = list
      .json()
      .data.find((i: { id: string }) => i.id === tip.id);
    expect(tipRow.request.messages).toEqual(fullMessages);

    // Sessions endpoint reconstructs the last interaction request.
    const sessions = await app.inject({
      method: "GET",
      url: "/api/interactions/sessions?limit=10&offset=0&sessionId=route-delta-session",
    });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json().data[0].lastInteractionRequest.messages).toEqual(
      fullMessages,
    );
  });
});
