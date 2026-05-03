import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { getE2eRequestUrl, UI_BASE_URL } from "../consts";
import { expect, test } from "./api-fixtures";

const NONEXISTENT_MESSAGE_ID = "1d6934ea-eb0d-452d-abf3-72122d140c49";

type ConversationResponse = {
  messages: Array<{
    id: string;
    role: string;
    parts: Array<{ text?: string }>;
  }>;
  chatErrors: Array<{ error?: unknown }>;
};
type MakeApiRequest = (params: {
  request: APIRequestContext;
  method: "get";
  urlSuffix: string;
}) => Promise<{ json: () => Promise<ConversationResponse> }>;

async function waitForConversationMessages({
  request,
  makeApiRequest,
  conversationId,
  minMessages = 1,
  minChatErrors,
}: {
  request: APIRequestContext;
  makeApiRequest: MakeApiRequest;
  conversationId: string;
  minMessages?: number;
  minChatErrors?: number;
}) {
  const getLatestConversation = async () => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/chat/conversations/${conversationId}`,
    });
    return response.json();
  };

  await expect
    .poll(
      async () => {
        const latestConversation = await getLatestConversation();
        return latestConversation.messages.length;
      },
      { timeout: 15_000, intervals: [250, 500, 1_000] },
    )
    .toBeGreaterThanOrEqual(minMessages);

  if (minChatErrors !== undefined) {
    await expect
      .poll(
        async () => {
          const latestConversation = await getLatestConversation();
          return latestConversation.chatErrors.length;
        },
        { timeout: 15_000, intervals: [250, 500, 1_000] },
      )
      .toBeGreaterThanOrEqual(minChatErrors);
  }

  return getLatestConversation();
}

test.describe("Chat Messages Access Control", () => {
  test("requires authentication", async ({ playwright }) => {
    // Create a fresh request context explicitly without any auth storage state
    // Note: We must explicitly set storageState to undefined to avoid inheriting
    // the project's default storageState (adminAuthFile)
    const unauthenticatedContext = await playwright.request.newContext({
      baseURL: "http://localhost:9000",
      storageState: undefined,
    });

    try {
      const response = await unauthenticatedContext.patch(
        `/api/chat/messages/${NONEXISTENT_MESSAGE_ID}`,
        {
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost:3000",
          },
          data: {
            partIndex: 0,
            text: "Updated text",
          },
        },
      );

      expect([401, 403]).toContain(response.status());
    } finally {
      await unauthenticatedContext.dispose();
    }
  });
});

test.describe("Chat message persistence on provider error", () => {
  // Increase timeout - this test involves streaming and async persistence
  test.setTimeout(60_000);

  test("persists user messages when provider returns error, allowing edit", async ({
    request,
    makeApiRequest,
    createAgent,
    deleteAgent,
  }) => {
    // 1. Create an agent for the conversation
    const agentResponse = await createAgent(
      request,
      "Chat Error Test Agent",
      "personal",
    );
    const agent = await agentResponse.json();

    try {
      // 2. Create a conversation with the Anthropic provider
      const convResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/chat/conversations",
        data: {
          agentId: agent.id,
          title: "Error Persistence Test",
          selectedModel: "claude-3-5-sonnet-20241022",
          selectedProvider: "anthropic",
        },
      });
      const conversation = await convResponse.json();

      // 3. Send a chat message that triggers a provider error via WireMock
      // The message text contains "chat-error-persistence-test" which matches
      // the WireMock stub that returns a 500 error
      const tempMessageId = randomUUID();
      const messageText = `Hello chat-error-persistence-test ${tempMessageId}`;

      const chatResponse = await request.post(getE2eRequestUrl("/api/chat"), {
        headers: {
          "Content-Type": "application/json",
          Origin: UI_BASE_URL,
        },
        timeout: 60_000,
        data: {
          id: conversation.id,
          messages: [
            {
              id: tempMessageId,
              role: "user",
              parts: [{ type: "text", text: messageText }],
            },
          ],
        },
      });

      // The streaming response has status 200 (stream started) but contains error data
      expect(chatResponse.status()).toBe(200);

      // Consume the stream body to ensure the response is fully processed
      await chatResponse.text();

      // 4. Verify the user message was persisted to the database
      const updatedConversation = await waitForConversationMessages({
        request,
        makeApiRequest,
        conversationId: conversation.id,
        minChatErrors: 1,
      });

      expect(updatedConversation.messages.length).toBeGreaterThan(0);
      expect(updatedConversation.chatErrors).toHaveLength(1);
      expect(updatedConversation.chatErrors[0].error).toMatchObject({
        code: "server_error",
        isRetryable: true,
      });

      const userMessage = updatedConversation.messages.find(
        (m) => m.role === "user",
      );
      expect(userMessage).toBeDefined();
      if (!userMessage) {
        throw new Error("Expected persisted user message");
      }

      // Verify the message content matches what was sent
      // The API returns messages with parts flattened at the top level (not nested under content)
      expect(userMessage.parts[0].text).toBe(messageText);

      // 6. Verify the message can be edited via PATCH (this was the original bug -
      // without persistence, the message only had a temp client-side ID and PATCH returned 404)
      const editResponse = await makeApiRequest({
        request,
        method: "patch",
        urlSuffix: `/api/chat/messages/${userMessage.id}`,
        data: {
          partIndex: 0,
          text: "Edited message after provider error",
        },
      });
      expect(editResponse.ok()).toBe(true);

      // 7. Verify the edit was applied
      const editedConversation = await editResponse.json();
      const editedMessage = editedConversation.messages.find(
        (m: { id: string }) => m.id === userMessage.id,
      );
      expect(editedMessage).toBeDefined();
      if (!editedMessage) {
        throw new Error("Expected edited user message");
      }
      expect(editedMessage.parts[0].text).toBe(
        "Edited message after provider error",
      );
    } finally {
      // Cleanup
      await deleteAgent(request, agent.id);
    }
  });

  /**
   * Bug reproduction: Mid-stream error causes duplicate messages.
   *
   * When the provider errors DURING streaming (after some tokens are emitted),
   * both `toUIMessageStream.onError` and `toUIMessageStream.onFinish` fire.
   * Because `onError` sets `messagesPersisted = true` inside an async IIFE,
   * `onFinish` can check the flag before the IIFE has completed, causing
   * both callbacks to persist the same messages — resulting in duplicates.
   *
   * After the fix: `messagesPersisted` is set synchronously in `onError`,
   * so `onFinish` correctly skips persistence.
   */
  test("does not duplicate messages when provider errors mid-stream", async ({
    request,
    makeApiRequest,
    createAgent,
    deleteAgent,
  }) => {
    const agentResponse = await createAgent(
      request,
      "Chat Midstream Error Agent",
      "personal",
    );
    const agent = await agentResponse.json();

    try {
      const convResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/chat/conversations",
        data: {
          agentId: agent.id,
          title: "Midstream Error Duplicate Test",
          selectedModel: "claude-3-5-sonnet-20241022",
          selectedProvider: "anthropic",
        },
      });
      const conversation = await convResponse.json();

      // Send a message that triggers a mid-stream error via WireMock.
      // The stub returns some SSE events then an overloaded_error event.
      const tempMessageId = randomUUID();
      const messageText = `Hello chat-midstream-error-test ${tempMessageId}`;

      const chatResponse = await request.post(getE2eRequestUrl("/api/chat"), {
        headers: {
          "Content-Type": "application/json",
          Origin: UI_BASE_URL,
        },
        data: {
          id: conversation.id,
          messages: [
            {
              id: tempMessageId,
              role: "user",
              parts: [{ type: "text", text: messageText }],
            },
          ],
        },
      });

      expect(chatResponse.status()).toBe(200);
      await chatResponse.text();

      // Verify: there should be exactly 1 user message (not duplicated)
      const updatedConversation = await waitForConversationMessages({
        request,
        makeApiRequest,
        conversationId: conversation.id,
        minChatErrors: 1,
      });

      const userMessages = updatedConversation.messages.filter(
        (m) => m.role === "user",
      );

      // BUG: Without the fix, this may be 2 (or more) due to the race condition
      // between onError and onFinish both persisting the same messages.
      expect(userMessages.length).toBe(1);

      // Also check total message count - should be at most 2 (user + partial assistant)
      // not 4+ (user + assistant duplicated by both onError and onFinish)
      expect(updatedConversation.messages.length).toBeLessThanOrEqual(2);
    } finally {
      await deleteAgent(request, agent.id);
    }
  });

  /**
   * Bug reproduction: Sending a second message after error causes duplicates.
   *
   * When the first message errors and messages are persisted (possibly duplicated),
   * sending a retry/second message causes the `persistNewMessages` slice logic to
   * be off because the DB has unexpected duplicate rows from the first error.
   * After refresh, messages appear multiple times.
   */
  test("retry after error does not accumulate duplicate messages", async ({
    request,
    makeApiRequest,
    createAgent,
    deleteAgent,
  }) => {
    const agentResponse = await createAgent(
      request,
      "Chat Retry Duplicate Agent",
      "personal",
    );
    const agent = await agentResponse.json();

    try {
      const convResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/chat/conversations",
        data: {
          agentId: agent.id,
          title: "Retry Duplicate Test",
          selectedModel: "claude-3-5-sonnet-20241022",
          selectedProvider: "anthropic",
        },
      });
      const conversation = await convResponse.json();

      // 1. Send first message that errors (mid-stream error)
      const msg1Id = randomUUID();
      const msg1Text = `First chat-midstream-error-test ${msg1Id}`;

      const chat1 = await request.post(getE2eRequestUrl("/api/chat"), {
        headers: {
          "Content-Type": "application/json",
          Origin: UI_BASE_URL,
        },
        data: {
          id: conversation.id,
          messages: [
            {
              id: msg1Id,
              role: "user",
              parts: [{ type: "text", text: msg1Text }],
            },
          ],
        },
      });
      await chat1.text();

      // Check messages after first error
      const conv1 = await waitForConversationMessages({
        request,
        makeApiRequest,
        conversationId: conversation.id,
        minChatErrors: 1,
      });
      const firstCount = conv1.messages.length;
      const firstErrorCount = conv1.chatErrors.length;

      // 2. "Retry" — send the same conversation with the same user message
      // (simulating the frontend resending after the error)
      const chat2 = await request.post(getE2eRequestUrl("/api/chat"), {
        headers: {
          "Content-Type": "application/json",
          Origin: UI_BASE_URL,
        },
        data: {
          id: conversation.id,
          messages: [
            {
              id: msg1Id,
              role: "user",
              parts: [{ type: "text", text: msg1Text }],
            },
          ],
        },
      });
      await chat2.text();

      // Check messages after retry
      const conv2 = await waitForConversationMessages({
        request,
        makeApiRequest,
        conversationId: conversation.id,
        minMessages: firstCount,
        minChatErrors: firstErrorCount + 1,
      });

      const userMessages = conv2.messages.filter((m) => m.role === "user");

      // There should be exactly 1 user message across all retries
      expect(userMessages.length).toBe(1);

      // Message count should not grow after retry (same messages, just re-attempted)
      expect(conv2.messages.length).toBeLessThanOrEqual(firstCount + 2);
    } finally {
      await deleteAgent(request, agent.id);
    }
  });
});
