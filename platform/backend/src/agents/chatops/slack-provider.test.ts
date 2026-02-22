import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
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

  test("empty text after cleaning bot mention returns null", async () => {
    const provider = createProvider();
    const payload = makeEventPayload({}, { text: "<@UBOT123>" });

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).toBeNull();
  });

  test("whitespace-only text after cleaning returns null", async () => {
    const provider = createProvider();
    const payload = makeEventPayload({}, { text: "<@UBOT123>   " });

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).toBeNull();
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
// parseInteractivePayload
// =============================================================================

describe("SlackProvider.parseInteractivePayload", () => {
  test("valid block_actions with select_agent_ action returns agent ID and context", () => {
    const provider = createProvider();

    const result = provider.parseInteractivePayload({
      type: "block_actions",
      actions: [
        {
          action_id: "select_agent_agent-uuid-123",
          value: "agent-uuid-123",
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
      actions: [{ action_id: "select_agent_abc", value: "abc" }],
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

  test("block_actions with select_agent_ but no value returns null", () => {
    const provider = createProvider();

    const result = provider.parseInteractivePayload({
      type: "block_actions",
      actions: [{ action_id: "select_agent_abc", value: "" }],
    });

    expect(result).toBeNull();
  });

  test("message without thread_ts falls back to ts", () => {
    const provider = createProvider();

    const result = provider.parseInteractivePayload({
      type: "block_actions",
      actions: [{ action_id: "select_agent_abc", value: "abc" }],
      message: { ts: "9999999999.000000" },
    });

    expect(result).not.toBeNull();
    expect(result?.threadTs).toBe("9999999999.000000");
  });

  test("missing optional fields default gracefully", () => {
    const provider = createProvider();

    const result = provider.parseInteractivePayload({
      type: "block_actions",
      actions: [{ action_id: "select_agent_abc", value: "abc" }],
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
