import { randomUUID } from "node:crypto";
import { API_BASE_URL, UI_BASE_URL } from "../../consts";
import { expect, test } from "./fixtures";

// Valid v4 UUIDs for testing (these won't exist in the database)
const NONEXISTENT_MESSAGE_ID = "1d6934ea-eb0d-452d-abf3-72122d140c49";

test.describe("PATCH /api/chat/messages/:id - API Validation", () => {
  test("returns 404 for non-existent message", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: `/api/chat/messages/${NONEXISTENT_MESSAGE_ID}`,
      data: {
        partIndex: 0,
        text: "Updated text",
      },
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(404);
  });

  test("validates minimum text length", async ({ request, makeApiRequest }) => {
    // Use a valid v4 UUID - validation happens before checking if message exists
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: `/api/chat/messages/${NONEXISTENT_MESSAGE_ID}`,
      data: {
        partIndex: 0,
        text: "",
      },
      ignoreStatusCheck: true,
    });

    // Zod validation errors return 400 (Bad Request)
    expect(response.status()).toBe(400);
  });

  test("validates partIndex is a number", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: `/api/chat/messages/${NONEXISTENT_MESSAGE_ID}`,
      data: {
        partIndex: "not-a-number" as unknown as number,
        text: "Updated text",
      },
      ignoreStatusCheck: true,
    });

    // Zod validation errors return 400 (Bad Request)
    expect(response.status()).toBe(400);
  });

  test("validates partIndex is non-negative", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: `/api/chat/messages/${NONEXISTENT_MESSAGE_ID}`,
      data: {
        partIndex: -1,
        text: "Updated text",
      },
      ignoreStatusCheck: true,
    });

    // Zod validation errors return 400 (Bad Request)
    expect(response.status()).toBe(400);
  });

  test("validates request body schema", async ({ request, makeApiRequest }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: `/api/chat/messages/${NONEXISTENT_MESSAGE_ID}`,
      data: {},
      ignoreStatusCheck: true,
    });

    // Zod validation errors return 400 (Bad Request)
    expect(response.status()).toBe(400);
  });

  test("validates UUID format in path parameter", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/chat/messages/invalid-uuid",
      data: {
        partIndex: 0,
        text: "Updated text",
      },
      ignoreStatusCheck: true,
    });

    // Invalid UUID format in path returns 400 (Zod validation error)
    expect(response.status()).toBe(400);
  });
});

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

      const chatResponse = await request.post(`${API_BASE_URL}/api/chat`, {
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

      // The streaming response has status 200 (stream started) but contains error data
      expect(chatResponse.status()).toBe(200);

      // Consume the stream body to ensure the response is fully processed
      await chatResponse.text();

      // 4. Wait for the async message persistence (fire-and-forget in onError handler)
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // 5. Verify the user message was persisted to the database
      const getConvResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/chat/conversations/${conversation.id}`,
      });
      const updatedConversation = await getConvResponse.json();

      expect(updatedConversation.messages.length).toBeGreaterThan(0);

      const userMessage = updatedConversation.messages.find(
        (m: { role: string }) => m.role === "user",
      );
      expect(userMessage).toBeDefined();
      expect(userMessage.id).toBeDefined();

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

      const chatResponse = await request.post(`${API_BASE_URL}/api/chat`, {
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

      // Wait for async persistence to complete
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Verify: there should be exactly 1 user message (not duplicated)
      const getConvResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/chat/conversations/${conversation.id}`,
      });
      const updatedConversation = await getConvResponse.json();

      const userMessages = updatedConversation.messages.filter(
        (m: { role: string }) => m.role === "user",
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

      const chat1 = await request.post(`${API_BASE_URL}/api/chat`, {
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
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Check messages after first error
      const afterFirst = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/chat/conversations/${conversation.id}`,
      });
      const conv1 = await afterFirst.json();
      const firstCount = conv1.messages.length;

      // 2. "Retry" — send the same conversation with the same user message
      // (simulating the frontend resending after the error)
      const chat2 = await request.post(`${API_BASE_URL}/api/chat`, {
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
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Check messages after retry
      const afterRetry = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/chat/conversations/${conversation.id}`,
      });
      const conv2 = await afterRetry.json();

      const userMessages = conv2.messages.filter(
        (m: { role: string }) => m.role === "user",
      );

      // There should be exactly 1 user message across all retries
      expect(userMessages.length).toBe(1);

      // Message count should not grow after retry (same messages, just re-attempted)
      expect(conv2.messages.length).toBeLessThanOrEqual(firstCount + 2);
    } finally {
      await deleteAgent(request, agent.id);
    }
  });
});
