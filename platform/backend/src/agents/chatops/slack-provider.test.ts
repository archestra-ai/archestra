import { createHmac } from "node:crypto";
import { SLACK_REQUIRED_BOT_SCOPES } from "@shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CacheKey, cacheManager } from "@/cache-manager";
import SlackProvider from "./slack-provider";

// =============================================================================
// Helpers
// =============================================================================

const SIGNING_SECRET = "test-signing-secret";

function createProvider(overrides?: { botUserId?: string }): SlackProvider {
  const provider = new SlackProvider({
    enabled: true,
    botToken: "xoxb-test",
    signingSecret: SIGNING_SECRET,
    appId: "A12345",
  });
  // biome-ignore lint/suspicious/noExplicitAny: test-only — bypass private field
  (provider as any).botUserId = overrides?.botUserId || "UBOT123";
  // biome-ignore lint/suspicious/noExplicitAny: test-only — bypass private field
  (provider as any).client = {}; // truthy so methods don't bail
  return provider;
}

function makeTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

function computeSignature(
  timestamp: string,
  body: string,
  secret: string = SIGNING_SECRET,
): string {
  const sigBaseString = `v0:${timestamp}:${body}`;
  const hash = createHmac("sha256", secret).update(sigBaseString).digest("hex");
  return `v0=${hash}`;
}

function makeEventPayload(
  overrides: Record<string, unknown> = {},
  eventOverrides: Record<string, unknown> = {},
) {
  return {
    type: "event_callback",
    team_id: "T12345",
    event: {
      type: "app_mention",
      channel: "C12345",
      channel_type: "channel",
      user: "U_SENDER",
      text: "<@UBOT123> hello world",
      ts: "1234567890.123456",
      ...eventOverrides,
    },
    ...overrides,
  };
}

// =============================================================================
// validateWebhookRequest
// =============================================================================

describe("SlackProvider.validateWebhookRequest", () => {
  test("valid signature returns true", async () => {
    const provider = createProvider();
    const timestamp = makeTimestamp();
    const body = JSON.stringify({ type: "event_callback" });
    const signature = computeSignature(timestamp, body);

    const result = await provider.validateWebhookRequest(body, {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    });

    expect(result).toBe(true);
  });

  test("invalid signature returns false", async () => {
    const provider = createProvider();
    const timestamp = makeTimestamp();
    const body = JSON.stringify({ type: "event_callback" });

    const result = await provider.validateWebhookRequest(body, {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature":
        "v0=0000000000000000000000000000000000000000000000000000000000000000",
    });

    expect(result).toBe(false);
  });

  test("missing x-slack-request-timestamp returns false", async () => {
    const provider = createProvider();

    const result = await provider.validateWebhookRequest("{}", {
      "x-slack-signature": "v0=abc",
    });

    expect(result).toBe(false);
  });

  test("missing x-slack-signature returns false", async () => {
    const provider = createProvider();

    const result = await provider.validateWebhookRequest("{}", {
      "x-slack-request-timestamp": makeTimestamp(),
    });

    expect(result).toBe(false);
  });

  test("missing both headers returns false", async () => {
    const provider = createProvider();

    const result = await provider.validateWebhookRequest("{}", {});

    expect(result).toBe(false);
  });

  test("replay attack (timestamp >5 min old) returns false", async () => {
    const provider = createProvider();
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600); // 10 minutes ago
    const body = JSON.stringify({ type: "event_callback" });
    const signature = computeSignature(oldTimestamp, body);

    const result = await provider.validateWebhookRequest(body, {
      "x-slack-request-timestamp": oldTimestamp,
      "x-slack-signature": signature,
    });

    expect(result).toBe(false);
  });

  test("timestamp exactly at 5 min boundary is accepted", async () => {
    const provider = createProvider();
    // 299 seconds ago — within the 300-second window
    const timestamp = String(Math.floor(Date.now() / 1000) - 299);
    const body = JSON.stringify({ type: "event_callback" });
    const signature = computeSignature(timestamp, body);

    const result = await provider.validateWebhookRequest(body, {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    });

    expect(result).toBe(true);
  });

  test("JSON string payload verifies correctly", async () => {
    const provider = createProvider();
    const timestamp = makeTimestamp();
    const body = JSON.stringify({ type: "event_callback", team_id: "T123" });
    const signature = computeSignature(timestamp, body);

    const result = await provider.validateWebhookRequest(body, {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    });

    expect(result).toBe(true);
  });

  test("wrong signing secret produces invalid signature", async () => {
    const provider = createProvider();
    const timestamp = makeTimestamp();
    const body = JSON.stringify({ type: "event_callback" });
    const wrongSignature = computeSignature(timestamp, body, "wrong-secret");

    const result = await provider.validateWebhookRequest(body, {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": wrongSignature,
    });

    expect(result).toBe(false);
  });
});

// =============================================================================
// handleValidationChallenge
// =============================================================================

describe("SlackProvider.handleValidationChallenge", () => {
  test("url_verification payload returns challenge", () => {
    const provider = createProvider();

    const result = provider.handleValidationChallenge({
      type: "url_verification",
      challenge: "abc123challenge",
    });

    expect(result).toEqual({ challenge: "abc123challenge" });
  });

  test("non-url_verification type returns null", () => {
    const provider = createProvider();

    const result = provider.handleValidationChallenge({
      type: "event_callback",
      challenge: "abc123challenge",
    });

    expect(result).toBeNull();
  });

  test("url_verification without challenge field returns null", () => {
    const provider = createProvider();

    const result = provider.handleValidationChallenge({
      type: "url_verification",
    });

    expect(result).toBeNull();
  });

  test("empty payload returns null", () => {
    const provider = createProvider();

    const result = provider.handleValidationChallenge({});

    expect(result).toBeNull();
  });

  test("null payload returns null", () => {
    const provider = createProvider();

    const result = provider.handleValidationChallenge(null);

    expect(result).toBeNull();
  });
});

// =============================================================================
// parseWebhookNotification
// =============================================================================

describe("SlackProvider.parseWebhookNotification", () => {
  test("app_mention event returns parsed IncomingChatMessage", async () => {
    const provider = createProvider();
    const payload = makeEventPayload();

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.text).toBe("hello world");
    expect(result?.rawText).toBe("<@UBOT123> hello world");
    expect(result?.channelId).toBe("C12345");
    expect(result?.senderId).toBe("U_SENDER");
    expect(result?.workspaceId).toBe("T12345");
    expect(result?.messageId).toBe("1234567890.123456");
    expect(result?.isThreadReply).toBe(false);
    expect(result?.metadata).toEqual({
      eventType: "app_mention",
      channelType: "channel",
    });
  });

  test("message event returns parsed IncomingChatMessage", async () => {
    const provider = createProvider();
    const payload = makeEventPayload({}, { type: "message" });

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.text).toBe("hello world");
  });

  test("bot message with bot_id returns null", async () => {
    const provider = createProvider();
    const payload = makeEventPayload({}, { bot_id: "B_OTHER_BOT" });

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).toBeNull();
  });

  test("bot message with subtype bot_message returns null", async () => {
    const provider = createProvider();
    const payload = makeEventPayload({}, { subtype: "bot_message" });

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).toBeNull();
  });

  test("message from the bot itself (matching botUserId) returns null", async () => {
    const provider = createProvider({ botUserId: "UBOT123" });
    const payload = makeEventPayload({}, { user: "UBOT123" });

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).toBeNull();
  });

  test("non-event_callback type returns null", async () => {
    const provider = createProvider();
    const payload = makeEventPayload({ type: "url_verification" });

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).toBeNull();
  });

  test("unsupported event type returns null", async () => {
    const provider = createProvider();
    const payload = makeEventPayload({}, { type: "reaction_added" });

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).toBeNull();
  });

  test("missing event object returns null", async () => {
    const provider = createProvider();

    const result = await provider.parseWebhookNotification(
      { type: "event_callback" },
      {},
    );

    expect(result).toBeNull();
  });

  test("empty text after cleaning bot mention for app_mention is still processed", async () => {
    const provider = createProvider();
    const payload = makeEventPayload({}, { text: "<@UBOT123>" });

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.text).toBe("");
  });

  test("whitespace-only text after app_mention is still processed", async () => {
    const provider = createProvider();
    const payload = makeEventPayload({}, { text: "<@UBOT123>   " });

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.text).toBe("");
  });

  test("thread reply (has thread_ts) returns isThreadReply=true with correct threadId", async () => {
    const provider = createProvider();
    const payload = makeEventPayload(
      {},
      {
        thread_ts: "1111111111.000000",
        ts: "1234567890.123456",
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.isThreadReply).toBe(true);
    expect(result?.threadId).toBe("1111111111.000000");
    expect(result?.messageId).toBe("1234567890.123456");
  });

  test("non-thread message uses ts as threadId", async () => {
    const provider = createProvider();
    const payload = makeEventPayload({}, { ts: "9999999999.999999" });

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.threadId).toBe("9999999999.999999");
    expect(result?.isThreadReply).toBe(false);
  });

  test("bot mention cleaning: <@UBOT123> hello becomes 'hello'", async () => {
    const provider = createProvider({ botUserId: "UBOT123" });
    const payload = makeEventPayload({}, { text: "<@UBOT123> hello" });

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.text).toBe("hello");
  });

  test("multiple bot mentions are all cleaned", async () => {
    const provider = createProvider({ botUserId: "UBOT123" });
    const payload = makeEventPayload(
      {},
      { text: "<@UBOT123> hey <@UBOT123> there" },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.text).toBe("hey  there");
  });

  test("mentions of other users are NOT cleaned", async () => {
    const provider = createProvider({ botUserId: "UBOT123" });
    const payload = makeEventPayload(
      {},
      { text: "<@UBOT123> talk to <@UOTHER456>" },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.text).toBe("talk to <@UOTHER456>");
  });

  test("timestamp is parsed from ts field", async () => {
    const provider = createProvider();
    const payload = makeEventPayload({}, { ts: "1700000000.000000" });

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.timestamp).toEqual(new Date(1700000000 * 1000));
  });

  test("missing team_id returns null workspaceId", async () => {
    const provider = createProvider();
    const payload = makeEventPayload({ team_id: undefined });

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.workspaceId).toBeNull();
  });

  test("missing user defaults to 'unknown' senderId", async () => {
    const provider = createProvider();
    const payload = makeEventPayload({}, { user: undefined });

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.senderId).toBe("unknown");
    expect(result?.senderName).toBe("Unknown User");
  });
});

// =============================================================================
// sendReply
// =============================================================================

describe("SlackProvider.sendReply", () => {
  test("sends native markdown blocks and includes footer in fallback text", async () => {
    const provider = createProvider();
    const postMessage = vi.fn().mockResolvedValue({ ts: "2222222222.000000" });
    // biome-ignore lint/suspicious/noExplicitAny: test-only — mock Slack client
    (provider as any).client = {
      chat: { postMessage },
    };

    const result = await provider.sendReply({
      originalMessage: {
        messageId: "1234567890.123456",
        channelId: "C12345",
        workspaceId: "T12345",
        threadId: "1111111111.000000",
        senderId: "U_SENDER",
        senderName: "Test User",
        text: "hello",
        rawText: "hello",
        timestamp: new Date(),
        isThreadReply: false,
      },
      text: "# Heading\n\n- [x] Done\n| A | B |",
      footer: "Footer text",
    });

    expect(result).toBe("2222222222.000000");
    expect(postMessage).toHaveBeenCalledWith({
      channel: "C12345",
      text: "# Heading\n\n- [x] Done\n| A | B |\n\nFooter text",
      blocks: [
        {
          type: "markdown",
          text: "# Heading\n\n- [x] Done\n| A | B |",
        },
        {
          type: "context",
          elements: [
            {
              type: "plain_text",
              text: "Footer text",
              emoji: true,
            },
          ],
        },
      ],
      thread_ts: "1111111111.000000",
    });
  });
});

// =============================================================================
// parseInteractivePayload
// =============================================================================

describe("SlackProvider.parseInteractivePayload", () => {
  test("valid block_actions with select_agent dropdown returns agent ID and context", () => {
    const provider = createProvider();

    const result = provider.parseInteractivePayload({
      type: "block_actions",
      actions: [
        {
          action_id: "select_agent",
          selected_option: { value: "agent-uuid-123" },
        },
      ],
      user: { id: "U_CLICKER", name: "Alice" },
      channel: { id: "C12345" },
      team: { id: "T12345" },
      message: { ts: "1234567890.123456", thread_ts: "1111111111.000000" },
      response_url: "https://hooks.slack.com/actions/T12345/response",
    });

    expect(result).not.toBeNull();
    expect(result?.agentId).toBe("agent-uuid-123");
    expect(result?.channelId).toBe("C12345");
    expect(result?.workspaceId).toBe("T12345");
    expect(result?.threadTs).toBe("1111111111.000000");
    expect(result?.userId).toBe("U_CLICKER");
    expect(result?.userName).toBe("Alice");
    expect(result?.responseUrl).toBe(
      "https://hooks.slack.com/actions/T12345/response",
    );
  });

  test("non-block_actions type returns null", () => {
    const provider = createProvider();

    const result = provider.parseInteractivePayload({
      type: "view_submission",
      actions: [
        { action_id: "select_agent", selected_option: { value: "abc" } },
      ],
    });

    expect(result).toBeNull();
  });

  test("block_actions with no actions array returns null", () => {
    const provider = createProvider();

    const result = provider.parseInteractivePayload({
      type: "block_actions",
    });

    expect(result).toBeNull();
  });

  test("block_actions with empty actions array returns null", () => {
    const provider = createProvider();

    const result = provider.parseInteractivePayload({
      type: "block_actions",
      actions: [],
    });

    expect(result).toBeNull();
  });

  test("block_actions with non-select_agent action_id returns null", () => {
    const provider = createProvider();

    const result = provider.parseInteractivePayload({
      type: "block_actions",
      actions: [{ action_id: "some_other_action", value: "abc" }],
    });

    expect(result).toBeNull();
  });

  test("block_actions with select_agent but no selected_option returns null", () => {
    const provider = createProvider();

    const result = provider.parseInteractivePayload({
      type: "block_actions",
      actions: [{ action_id: "select_agent" }],
    });

    expect(result).toBeNull();
  });

  test("message without thread_ts falls back to ts", () => {
    const provider = createProvider();

    const result = provider.parseInteractivePayload({
      type: "block_actions",
      actions: [
        { action_id: "select_agent", selected_option: { value: "abc" } },
      ],
      message: { ts: "9999999999.000000" },
    });

    expect(result).not.toBeNull();
    expect(result?.threadTs).toBe("9999999999.000000");
  });

  test("missing optional fields default gracefully", () => {
    const provider = createProvider();

    const result = provider.parseInteractivePayload({
      type: "block_actions",
      actions: [
        { action_id: "select_agent", selected_option: { value: "abc" } },
      ],
    });

    expect(result).not.toBeNull();
    expect(result?.channelId).toBe("");
    expect(result?.workspaceId).toBeNull();
    expect(result?.threadTs).toBeUndefined();
    expect(result?.userId).toBe("unknown");
    expect(result?.userName).toBe("Unknown");
    expect(result?.responseUrl).toBe("");
  });
});

describe("SlackProvider file attachment downloads", () => {
  function createProviderWithConfig(overrides?: {
    botUserId?: string;
  }): SlackProvider {
    const provider = new SlackProvider({
      enabled: true,
      botToken: "xoxb-test-bot-token",
      signingSecret: SIGNING_SECRET,
      appId: "A12345",
    });
    // biome-ignore lint/suspicious/noExplicitAny: test-only — bypass private field
    (provider as any).botUserId = overrides?.botUserId || "UBOT123";
    // biome-ignore lint/suspicious/noExplicitAny: test-only — bypass private field
    (provider as any).client = {}; // truthy so methods don't bail
    return provider;
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("message without files has no attachments field", async () => {
    const provider = createProviderWithConfig();
    const payload = makeEventPayload();

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.attachments).toBeUndefined();
  });

  test("message with empty files array has no attachments field", async () => {
    const provider = createProviderWithConfig();
    const payload = makeEventPayload({}, { files: [] });

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.attachments).toBeUndefined();
  });

  test("downloads file and returns attachment with base64 content", async () => {
    const provider = createProviderWithConfig();
    const fileContent = Buffer.from("hello image data");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(fileContent, { status: 200 }),
    );

    const payload = makeEventPayload(
      {},
      {
        files: [
          {
            id: "F123",
            name: "screenshot.png",
            mimetype: "image/png",
            size: fileContent.length,
            url_private:
              "https://files.slack.com/files-pri/T123/screenshot.png",
          },
        ],
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.attachments).toHaveLength(1);
    expect(result?.attachments?.[0]).toEqual({
      contentType: "image/png",
      contentBase64: fileContent.toString("base64"),
      name: "screenshot.png",
    });

    // Verify auth header was sent (fetchSlackFile uses redirect: "manual")
    expect(fetch).toHaveBeenCalledWith(
      "https://files.slack.com/files-pri/T123/screenshot.png",
      {
        headers: { Authorization: "Bearer xoxb-test-bot-token" },
        redirect: "manual",
      },
    );
  });

  test("prefers url_private_download over url_private", async () => {
    const provider = createProviderWithConfig();
    const fileContent = Buffer.from("file data");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(fileContent, { status: 200 }),
    );

    const payload = makeEventPayload(
      {},
      {
        files: [
          {
            id: "F123",
            name: "doc.pdf",
            mimetype: "application/pdf",
            size: fileContent.length,
            url_private: "https://files.slack.com/url_private",
            url_private_download:
              "https://files.slack.com/url_private_download",
          },
        ],
      },
    );

    await provider.parseWebhookNotification(payload, {});

    expect(fetch).toHaveBeenCalledWith(
      "https://files.slack.com/url_private_download",
      expect.any(Object),
    );
  });

  test("skips files without download URL", async () => {
    const provider = createProviderWithConfig();

    const payload = makeEventPayload(
      {},
      {
        files: [
          {
            id: "F123",
            name: "no-url.txt",
            mimetype: "text/plain",
            size: 100,
            // no url_private or url_private_download
          },
        ],
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.attachments).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("skips files exceeding individual size limit (10MB)", async () => {
    const provider = createProviderWithConfig();

    const payload = makeEventPayload(
      {},
      {
        files: [
          {
            id: "F_BIG",
            name: "huge.bin",
            mimetype: "application/octet-stream",
            size: 11 * 1024 * 1024, // 11MB > 10MB limit
            url_private: "https://files.slack.com/huge",
          },
        ],
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.attachments).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("skips files when total size would exceed 25MB limit", async () => {
    const provider = createProviderWithConfig();

    const file1Content = Buffer.alloc(9 * 1024 * 1024, "a"); // 9MB
    const file2Content = Buffer.alloc(9 * 1024 * 1024, "b"); // 9MB

    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(file1Content, { status: 200 }))
      .mockResolvedValueOnce(new Response(file2Content, { status: 200 }));

    const payload = makeEventPayload(
      {},
      {
        files: [
          {
            id: "F1",
            name: "file1.bin",
            mimetype: "application/octet-stream",
            size: 9 * 1024 * 1024,
            url_private: "https://files.slack.com/f1",
          },
          {
            id: "F2",
            name: "file2.bin",
            mimetype: "application/octet-stream",
            size: 9 * 1024 * 1024,
            url_private: "https://files.slack.com/f2",
          },
          {
            id: "F3",
            name: "file3.bin",
            mimetype: "application/octet-stream",
            size: 9 * 1024 * 1024,
            url_private: "https://files.slack.com/f3",
          },
        ],
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    // Only first 2 files should be downloaded (18MB total), 3rd skipped (would be 27MB)
    expect(result?.attachments).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("continues downloading after fetch error on one file", async () => {
    const provider = createProviderWithConfig();
    const file2Content = Buffer.from("file2 data");

    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(new Response(file2Content, { status: 200 }));

    const payload = makeEventPayload(
      {},
      {
        files: [
          {
            id: "F1",
            name: "fail.png",
            mimetype: "image/png",
            size: 100,
            url_private: "https://files.slack.com/f1",
          },
          {
            id: "F2",
            name: "ok.png",
            mimetype: "image/png",
            size: file2Content.length,
            url_private: "https://files.slack.com/f2",
          },
        ],
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.attachments).toHaveLength(1);
    expect(result?.attachments?.[0].name).toBe("ok.png");
  });

  test("skips file when fetch returns non-200 status", async () => {
    const provider = createProviderWithConfig();

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("Not Found", { status: 404 }),
    );

    const payload = makeEventPayload(
      {},
      {
        files: [
          {
            id: "F404",
            name: "missing.png",
            mimetype: "image/png",
            size: 100,
            url_private: "https://files.slack.com/missing",
          },
        ],
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.attachments).toBeUndefined();
  });

  test("uses application/octet-stream when mimetype is missing", async () => {
    const provider = createProviderWithConfig();
    const fileContent = Buffer.from("mystery data");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(fileContent, { status: 200 }),
    );

    const payload = makeEventPayload(
      {},
      {
        files: [
          {
            id: "F_NO_MIME",
            name: "unknown",
            size: fileContent.length,
            url_private: "https://files.slack.com/unknown",
            // no mimetype
          },
        ],
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.attachments).toHaveLength(1);
    expect(result?.attachments?.[0].contentType).toBe(
      "application/octet-stream",
    );
  });

  test("limits to max 20 files per message", async () => {
    const provider = createProviderWithConfig();
    const fileContent = Buffer.from("small");

    // Create 25 files
    const files = Array.from({ length: 25 }, (_, i) => ({
      id: `F${i}`,
      name: `file${i}.txt`,
      mimetype: "text/plain",
      size: fileContent.length,
      url_private: `https://files.slack.com/f${i}`,
    }));

    // Mock fetch for exactly 20 calls (the max limit)
    for (let i = 0; i < 20; i++) {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(fileContent, { status: 200 }),
      );
    }

    const payload = makeEventPayload({}, { files });

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.attachments).toHaveLength(20);
    expect(fetch).toHaveBeenCalledTimes(20);
  });

  test("downloads multiple files successfully", async () => {
    const provider = createProviderWithConfig();
    const img1 = Buffer.from("image1 data");
    const img2 = Buffer.from("image2 data");

    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(img1, { status: 200 }))
      .mockResolvedValueOnce(new Response(img2, { status: 200 }));

    const payload = makeEventPayload(
      {},
      {
        files: [
          {
            id: "F1",
            name: "photo1.jpg",
            mimetype: "image/jpeg",
            size: img1.length,
            url_private: "https://files.slack.com/f1",
          },
          {
            id: "F2",
            name: "photo2.png",
            mimetype: "image/png",
            size: img2.length,
            url_private: "https://files.slack.com/f2",
          },
        ],
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.attachments).toHaveLength(2);
    expect(result?.attachments?.[0]).toEqual({
      contentType: "image/jpeg",
      contentBase64: img1.toString("base64"),
      name: "photo1.jpg",
    });
    expect(result?.attachments?.[1]).toEqual({
      contentType: "image/png",
      contentBase64: img2.toString("base64"),
      name: "photo2.png",
    });
  });

  test("skips file when actual download size exceeds limit (post-download check)", async () => {
    const provider = createProviderWithConfig();
    // File reports small size but actual content is huge
    const hugeContent = Buffer.alloc(11 * 1024 * 1024, "x"); // 11MB

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(hugeContent, { status: 200 }),
    );

    const payload = makeEventPayload(
      {},
      {
        files: [
          {
            id: "F_LIE",
            name: "lying-file.bin",
            mimetype: "application/octet-stream",
            size: 100, // Claims small but actually huge
            url_private: "https://files.slack.com/liar",
          },
        ],
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.attachments).toBeUndefined();
  });

  test("skips files from non-Slack domains (SSRF protection)", async () => {
    const provider = createProviderWithConfig();

    const payload = makeEventPayload(
      {},
      {
        files: [
          {
            id: "F_EVIL",
            name: "evil.png",
            mimetype: "image/png",
            size: 100,
            url_private: "https://evil.attacker.com/steal-token",
          },
        ],
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.attachments).toBeUndefined();
    // Should not have sent any request (no Slack domain)
    expect(fetch).not.toHaveBeenCalled();
  });

  test("stops when post-download total size exceeds 25MB (file.size was missing)", async () => {
    const provider = createProviderWithConfig();
    const file1Content = Buffer.alloc(9 * 1024 * 1024, "a"); // 9MB (under 10MB individual limit)
    const file2Content = Buffer.alloc(9 * 1024 * 1024, "b"); // 9MB
    const file3Content = Buffer.alloc(9 * 1024 * 1024, "c"); // 9MB — would push total to 27MB

    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(file1Content, { status: 200 }))
      .mockResolvedValueOnce(new Response(file2Content, { status: 200 }))
      .mockResolvedValueOnce(new Response(file3Content, { status: 200 }));

    const payload = makeEventPayload(
      {},
      {
        files: [
          {
            id: "F1",
            name: "big1.bin",
            mimetype: "application/octet-stream",
            // size intentionally omitted — pre-download check can't catch this
            url_private: "https://files.slack.com/f1",
          },
          {
            id: "F2",
            name: "big2.bin",
            mimetype: "application/octet-stream",
            url_private: "https://files.slack.com/f2",
          },
          {
            id: "F3",
            name: "big3.bin",
            mimetype: "application/octet-stream",
            url_private: "https://files.slack.com/f3",
          },
        ],
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    // All 3 downloaded but third discarded because post-download total exceeds 25MB
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result?.attachments).toHaveLength(2);
    expect(result?.attachments?.[0]?.name).toBe("big1.bin");
    expect(result?.attachments?.[1]?.name).toBe("big2.bin");
  });

  test("returns no attachments when client is null", async () => {
    const provider = new SlackProvider({
      enabled: true,
      botToken: "xoxb-test",
      signingSecret: SIGNING_SECRET,
      appId: "A12345",
    });
    // biome-ignore lint/suspicious/noExplicitAny: test-only — bypass private field
    (provider as any).botUserId = "UBOT123";
    // client is null (not initialized) — but parseWebhookNotification returns null
    // because client check is further up; test downloadSlackFiles directly
    // biome-ignore lint/suspicious/noExplicitAny: test-only — invoke private method
    const result = await (provider as any).downloadSlackFiles([
      {
        id: "F1",
        name: "test.png",
        mimetype: "image/png",
        size: 100,
        url_private: "https://files.slack.com/f1",
      },
    ]);

    expect(result).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// =============================================================================
// getThreadHistory — file metadata
// =============================================================================

describe("SlackProvider.getThreadHistory file metadata", () => {
  test("includes file metadata from thread messages", async () => {
    const provider = createProvider();

    // Mock conversations.replies to return messages with files
    // biome-ignore lint/suspicious/noExplicitAny: test-only — mock Slack client
    (provider as any).client = {
      conversations: {
        replies: vi.fn().mockResolvedValue({
          messages: [
            {
              ts: "1000.001",
              user: "U_ALICE",
              text: "Check out this image",
              files: [
                {
                  id: "F1",
                  name: "photo.png",
                  mimetype: "image/png",
                  size: 5000,
                  url_private_download:
                    "https://files.slack.com/files-pri/T123/photo.png",
                },
              ],
            },
            {
              ts: "1000.002",
              user: "UBOT123",
              bot_id: "B123",
              text: "I see a cat!",
            },
            {
              ts: "1000.003",
              user: "U_ALICE",
              text: "What breed is it?",
            },
          ],
        }),
      },
    };

    const result = await provider.getThreadHistory({
      channelId: "C_TEST",
      workspaceId: "T_TEST",
      threadId: "1000.001",
    });

    expect(result).toHaveLength(3);

    // First message should have file metadata
    expect(result[0].files).toEqual([
      {
        url: "https://files.slack.com/files-pri/T123/photo.png",
        mimetype: "image/png",
        name: "photo.png",
        size: 5000,
      },
    ]);

    // Bot message should have no files
    expect(result[1].files).toBeUndefined();

    // Third message should have no files
    expect(result[2].files).toBeUndefined();
  });

  test("skips files without download URL", async () => {
    const provider = createProvider();

    // biome-ignore lint/suspicious/noExplicitAny: test-only — mock Slack client
    (provider as any).client = {
      conversations: {
        replies: vi.fn().mockResolvedValue({
          messages: [
            {
              ts: "1000.001",
              user: "U_ALICE",
              text: "Some message",
              files: [
                {
                  id: "F1",
                  name: "no-url.png",
                  mimetype: "image/png",
                  // No url_private or url_private_download
                },
              ],
            },
          ],
        }),
      },
    };

    const result = await provider.getThreadHistory({
      channelId: "C_TEST",
      workspaceId: "T_TEST",
      threadId: "1000.001",
    });

    expect(result).toHaveLength(1);
    expect(result[0].files).toBeUndefined();
  });
});

// =============================================================================
// parseGrantedScopes
// =============================================================================

describe("SlackProvider scope detection", () => {
  function createUninitializedProvider(): SlackProvider {
    return new SlackProvider({
      enabled: true,
      botToken: "xoxb-test",
      signingSecret: SIGNING_SECRET,
      appId: "A12345",
    });
  }

  test("detects missing scopes from x-oauth-scopes header", () => {
    const provider = createUninitializedProvider();

    const grantedScopes = SLACK_REQUIRED_BOT_SCOPES.filter(
      (s) => s !== "files:read" && s !== "users:read.email",
    ).join(",");

    // biome-ignore lint/suspicious/noExplicitAny: test-only — invoke private method
    (provider as any).parseGrantedScopes(grantedScopes);

    expect(provider.hasMissingScopes()).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: test-only — access private field
    const missing = (provider as any).missingScopes as string[];
    expect(missing).toEqual(
      expect.arrayContaining(["files:read", "users:read.email"]),
    );
    expect(missing).toHaveLength(2);
  });

  test("reports no missing scopes when all are granted", () => {
    const provider = createUninitializedProvider();

    // biome-ignore lint/suspicious/noExplicitAny: test-only — invoke private method
    (provider as any).parseGrantedScopes(SLACK_REQUIRED_BOT_SCOPES.join(","));

    expect(provider.hasMissingScopes()).toBe(false);
  });

  test("handles null header gracefully", () => {
    const provider = createUninitializedProvider();

    // biome-ignore lint/suspicious/noExplicitAny: test-only — invoke private method
    (provider as any).parseGrantedScopes(null);

    expect(provider.hasMissingScopes()).toBe(false);
  });

  test("handles extra scopes beyond required without error", () => {
    const provider = createUninitializedProvider();

    const scopeHeader = [...SLACK_REQUIRED_BOT_SCOPES, "extra:scope"].join(",");

    // biome-ignore lint/suspicious/noExplicitAny: test-only — invoke private method
    (provider as any).parseGrantedScopes(scopeHeader);

    expect(provider.hasMissingScopes()).toBe(false);
  });
});

// =============================================================================
// notifyMissingScopes
// =============================================================================

describe("SlackProvider.notifyMissingScopes", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createProviderWithMissingScopes(
    missingScopes: string[],
  ): SlackProvider {
    const provider = new SlackProvider({
      enabled: true,
      botToken: "xoxb-test",
      signingSecret: SIGNING_SECRET,
      appId: "A12345",
    });
    // biome-ignore lint/suspicious/noExplicitAny: test-only — set private fields
    (provider as any).botUserId = "UBOT123";
    // biome-ignore lint/suspicious/noExplicitAny: test-only — set private fields
    (provider as any).teamId = "T12345";
    // biome-ignore lint/suspicious/noExplicitAny: test-only — set private fields
    (provider as any).missingScopes = missingScopes;
    const mockPostMessage = vi.fn().mockResolvedValue({ ok: true });
    // biome-ignore lint/suspicious/noExplicitAny: test-only — mock Slack client
    (provider as any).client = {
      chat: { postMessage: mockPostMessage },
    };
    return provider;
  }

  const fakeMessage = {
    messageId: "1234567890.123456",
    channelId: "C12345",
    workspaceId: "T12345",
    threadId: "1111111111.000000",
    senderId: "U_SENDER",
    senderName: "Test User",
    text: "hello",
    rawText: "hello",
    timestamp: new Date(),
    isThreadReply: false,
  };

  test("sends notification with missing scopes list", async () => {
    const provider = createProviderWithMissingScopes(["files:read"]);

    // Ensure cache returns undefined (not notified yet)
    vi.spyOn(cacheManager, "get").mockResolvedValue(undefined);
    vi.spyOn(cacheManager, "set").mockResolvedValue(true);

    await provider.notifyMissingScopes(fakeMessage);

    // biome-ignore lint/suspicious/noExplicitAny: test-only — access mock
    const mockPostMessage = (provider as any).client.chat.postMessage;
    expect(mockPostMessage).toHaveBeenCalledTimes(1);

    const callArgs = mockPostMessage.mock.calls[0][0];
    expect(callArgs.channel).toBe("C12345");
    expect(callArgs.thread_ts).toBe("1111111111.000000");
    expect(callArgs.text).toContain("`files:read`");
    expect(callArgs.text).toContain("missing required scopes");
    expect(callArgs.text).toContain(
      "https://app.slack.com/app-settings/T12345/A12345/oauth",
    );
  });

  test("does not send notification when already notified (cache hit)", async () => {
    const provider = createProviderWithMissingScopes(["files:read"]);

    vi.spyOn(cacheManager, "get").mockResolvedValue(true);

    await provider.notifyMissingScopes(fakeMessage);

    // biome-ignore lint/suspicious/noExplicitAny: test-only — access mock
    const mockPostMessage = (provider as any).client.chat.postMessage;
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  test("sets cache with 30-day TTL after sending", async () => {
    const provider = createProviderWithMissingScopes(["files:read"]);

    vi.spyOn(cacheManager, "get").mockResolvedValue(undefined);
    const setSpy = vi.spyOn(cacheManager, "set").mockResolvedValue(true);

    await provider.notifyMissingScopes(fakeMessage);

    expect(setSpy).toHaveBeenCalledWith(
      `${CacheKey.SlackScopeNotification}-T12345`,
      true,
      30 * 24 * 60 * 60 * 1000, // 30 days in ms
    );
  });

  test("does nothing when no missing scopes", async () => {
    const provider = createProviderWithMissingScopes([]);

    vi.spyOn(cacheManager, "get").mockResolvedValue(undefined);

    await provider.notifyMissingScopes(fakeMessage);

    // biome-ignore lint/suspicious/noExplicitAny: test-only — access mock
    const mockPostMessage = (provider as any).client.chat.postMessage;
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  test("lists multiple missing scopes", async () => {
    const provider = createProviderWithMissingScopes([
      "files:read",
      "users:read.email",
    ]);

    vi.spyOn(cacheManager, "get").mockResolvedValue(undefined);
    vi.spyOn(cacheManager, "set").mockResolvedValue(true);

    await provider.notifyMissingScopes(fakeMessage);

    // biome-ignore lint/suspicious/noExplicitAny: test-only — access mock
    const callArgs = (provider as any).client.chat.postMessage.mock.calls[0][0];
    expect(callArgs.text).toContain("`files:read`");
    expect(callArgs.text).toContain("`users:read.email`");
  });

  test("handles postMessage failure gracefully", async () => {
    const provider = createProviderWithMissingScopes(["files:read"]);

    vi.spyOn(cacheManager, "get").mockResolvedValue(undefined);
    // biome-ignore lint/suspicious/noExplicitAny: test-only — access mock
    (provider as any).client.chat.postMessage.mockRejectedValue(
      new Error("channel_not_found"),
    );

    // Should not throw
    await provider.notifyMissingScopes(fakeMessage);
  });

  test("uses fallback URL when appId is not set", async () => {
    const provider = new SlackProvider({
      enabled: true,
      botToken: "xoxb-test",
      signingSecret: SIGNING_SECRET,
      appId: "",
    });
    // biome-ignore lint/suspicious/noExplicitAny: test-only — set private fields
    (provider as any).botUserId = "UBOT123";
    // biome-ignore lint/suspicious/noExplicitAny: test-only — set private fields
    (provider as any).teamId = "T12345";
    // biome-ignore lint/suspicious/noExplicitAny: test-only — set private fields
    (provider as any).missingScopes = ["files:read"];
    const mockPostMessage = vi.fn().mockResolvedValue({ ok: true });
    // biome-ignore lint/suspicious/noExplicitAny: test-only — mock Slack client
    (provider as any).client = {
      chat: { postMessage: mockPostMessage },
    };

    vi.spyOn(cacheManager, "get").mockResolvedValue(undefined);
    vi.spyOn(cacheManager, "set").mockResolvedValue(true);

    await provider.notifyMissingScopes(fakeMessage);

    const callArgs = mockPostMessage.mock.calls[0][0];
    expect(callArgs.text).toContain(
      "<https://api.slack.com/apps|Slack app settings>",
    );
    expect(callArgs.text).not.toContain("A12345");
  });
});
