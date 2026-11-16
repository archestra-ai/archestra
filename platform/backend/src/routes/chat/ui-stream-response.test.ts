import { ChatErrorCode } from "@archestra/shared";
import type { UIMessageChunk } from "ai";
import Fastify from "fastify";
import { vi } from "vitest";
import ActiveChatRunModel from "@/models/chat-active-run";
import { ActiveChatRunShutdownError } from "@/services/active-chat-run";
import { expect, test } from "@/test";
import { sendGatedUiMessageStreamResponse } from "./ui-stream-response";

// A chat source that, like streamText, keeps producing until it is aborted.
function chatUntilAborted(signal: AbortSignal): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue({ type: "start" });
      signal.addEventListener("abort", () => {
        controller.enqueue({ type: "finish" });
        controller.close();
      });
    },
  });
}

async function respond(params: {
  runId: string;
  conversationId: string;
  abortController: AbortController;
  stream?: ReadableStream<UIMessageChunk>;
  userStops: boolean;
  /** Abort mid-stream for this reason, as server shutdown does. */
  abortReason?: Error;
}): Promise<UIMessageChunk[]> {
  const app = Fastify();
  app.post("/chat", (_request, reply) =>
    sendGatedUiMessageStreamResponse({
      reply,
      stream: params.stream ?? chatUntilAborted(params.abortController.signal),
      runId: params.runId,
      conversationId: params.conversationId,
      abortController: params.abortController,
      getTerminalStatus: async () => ({ status: "completed" }),
    }),
  );
  if (params.userStops || params.abortReason) {
    setTimeout(() => params.abortController.abort(params.abortReason), 200);
  }
  const response = await app.inject({ method: "POST", url: "/chat" });
  await app.close();
  return response.body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

test("a chat stopped because its events cannot be saved ends with an error", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const run = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });
  const appendSpy = vi
    .spyOn(ActiveChatRunModel, "appendEvents")
    .mockRejectedValue(new Error("Connection terminated unexpectedly"));

  const chunks = await respond({
    runId: run?.id ?? "",
    conversationId: conversation.id,
    abortController: new AbortController(),
    userStops: false,
  });
  appendSpy.mockRestore();

  expect(chunks.at(-1)?.type).toBe("error");
});

test("a chat whose last save fails after the model finished ends with an error", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const run = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });
  const appendSpy = vi
    .spyOn(ActiveChatRunModel, "appendEvents")
    .mockRejectedValue(new Error("Connection terminated unexpectedly"));

  const chunks = await respond({
    runId: run?.id ?? "",
    conversationId: conversation.id,
    abortController: new AbortController(),
    stream: new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue({ type: "start" });
        controller.enqueue({ type: "finish" });
        controller.close();
      },
    }),
    userStops: false,
  });
  appendSpy.mockRestore();

  expect(chunks.at(-1)?.type).toBe("error");
});

test("a chat stopped by server shutdown ends with an error the client retries", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const run = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });

  const chunks = await respond({
    runId: run?.id ?? "",
    conversationId: conversation.id,
    abortController: new AbortController(),
    userStops: false,
    abortReason: new ActiveChatRunShutdownError(),
  });

  const last = chunks.at(-1);
  expect(last?.type).toBe("error");
  // The frontend auto-retries only a retryable network error, which sends the
  // turn to a replica that is not shutting down.
  expect(
    JSON.parse(last?.type === "error" ? last.errorText : "{}"),
  ).toMatchObject({ code: ChatErrorCode.NetworkError, isRetryable: true });
});

test("a chat the user stops ends without an error", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const run = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });

  const chunks = await respond({
    runId: run?.id ?? "",
    conversationId: conversation.id,
    abortController: new AbortController(),
    userStops: true,
  });

  expect(chunks.map((chunk) => chunk.type)).not.toContain("error");
});
