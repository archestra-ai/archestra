import { ChatErrorCode } from "@archestra/shared";
import {
  ConversationChatErrorModel,
  ConversationModel,
  InteractionModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import interactionRoutes from "./interaction";

describe("GET /api/interactions/sessions/:sessionId/chat-errors", () => {
  const ctx = useRouteTestApp(interactionRoutes);
  beforeEach(async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "member" });
  });
  const read = (sessionId: string) =>
    ctx.app.inject({
      method: "GET",
      url: `/api/interactions/sessions/${encodeURIComponent(sessionId)}/chat-errors`,
    });

  test("returns the errors the chat showed for the caller's own session", async ({
    makeAgent,
  }) => {
    const sessionId = await makeChatSession({
      agentId: (await makeAgent({ organizationId: ctx.organizationId })).id,
      userId: ctx.user.id,
      organizationId: ctx.organizationId,
    });

    const response = await read(sessionId);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().chatErrors).toEqual([
      expect.objectContaining({
        conversationId: sessionId,
        error: expect.objectContaining({
          code: ChatErrorCode.Unknown,
          message: "Guardrails could not settle a withheld tool call",
        }),
      }),
    ]);
  });

  test("shows a member nothing of another user's session", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const other = await makeUser();
    await makeMember(other.id, ctx.organizationId, { role: "member" });
    const sessionId = await makeChatSession({
      agentId: (await makeAgent({ organizationId: ctx.organizationId })).id,
      userId: other.id,
      organizationId: ctx.organizationId,
    });

    const response = await read(sessionId);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ chatErrors: [] });
  });

  test("returns no errors for a session that is no chat conversation", async () => {
    const response = await read("claude-code-session");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ chatErrors: [] });
  });
});

/** A chat conversation with one logged request and one error card. */
async function makeChatSession(params: {
  agentId: string;
  userId: string;
  organizationId: string;
}): Promise<string> {
  const conversation = await ConversationModel.create(params);
  await InteractionModel.create({
    profileId: params.agentId,
    userId: params.userId,
    sessionId: conversation.id,
    request: { model: "gpt-4", messages: [] },
    response: {
      id: "r",
      object: "chat.completion",
      created: Date.now(),
      model: "gpt-4",
      choices: [],
    },
    type: "openai:chatCompletions",
  });
  await ConversationChatErrorModel.create({
    conversationId: conversation.id,
    error: {
      code: ChatErrorCode.Unknown,
      message: "Guardrails could not settle a withheld tool call",
      isRetryable: false,
    },
  });
  return conversation.id;
}
