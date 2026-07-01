import { createHmac } from "node:crypto";
import {
  SLACK_REQUIRED_BOT_SCOPES,
  SLACK_SLASH_COMMANDS,
} from "@archestra/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// In-memory stand-in for the distributed cache so the sticky-thread activation
// gate (channel-activation.ts) works without starting the real cache manager.
// The `mock`-prefixed name is referenced lazily inside the factory so it
// survives vi.mock hoisting. Tests that need specific cache behavior still
// vi.spyOn(cacheManager, ...) and restore afterwards.
const mockCacheStore = new Map<string, unknown>();
vi.mock("@/cache-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cache-manager")>();
  return {
    ...actual,
    cacheManager: {
      async get(key: string) {
        return mockCacheStore.get(key);
      },
      async set(key: string, value: unknown) {
        mockCacheStore.set(key, value);
        return true;
      },
      async delete(key: string) {
        return mockCacheStore.delete(key);
      },
    },
  };
});

// The native image shrinker is a compiled addon not built in the unit-test
// env. Mock it at the boundary; real conversion is covered by the image-core
// Rust tests. Provider tests here exercise the branching (converted vs skipped).
vi.mock("@archestra/image-rs", () => ({
  shrinkImageToFit: vi.fn(),
}));

import { shrinkImageToFit } from "@archestra/image-rs";
import { CacheKey, cacheManager } from "@/cache-manager";
import { markChannelThreadActive } from "./channel-activation";
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
      conversationType: "channel",
      botMentioned: true,
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

  test("channel message metadata carries conversationType and botMentioned", async () => {
    const provider = createProvider();
    const payload = makeEventPayload();

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result?.metadata?.conversationType).toBe("channel");
    expect(result?.metadata?.botMentioned).toBe(true);
  });

  test("DM metadata carries conversationType=personal and botMentioned=false", async () => {
    const provider = createProvider();
    const payload = makeEventPayload(
      {},
      {
        type: "message",
        channel: "D12345",
        channel_type: "im",
        text: "no mention needed",
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result?.metadata?.conversationType).toBe("personal");
    expect(result?.metadata?.botMentioned).toBe(false);
  });

  test("group DM (mpim) maps to conversationType=groupChat", async () => {
    const provider = createProvider();
    const payload = makeEventPayload(
      {},
      {
        channel: "G_MPIM",
        channel_type: "mpim",
        text: "<@UBOT123> hello",
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result?.metadata?.conversationType).toBe("groupChat");
  });

  test("mentionedOthers resolves other mentioned users, excluding the bot", async () => {
    const provider = createProvider();
    // biome-ignore lint/suspicious/noExplicitAny: test-only — stub Slack client
    (provider as any).client = {
      users: {
        info: vi.fn(async ({ user }: { user: string }) => ({
          user: { real_name: user === "UALICE1" ? "Alice" : "Bob" },
        })),
      },
    };
    const payload = makeEventPayload(
      {},
      { text: "<@UBOT123> ask <@UALICE1> and <@UBOB22>" },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result?.metadata?.mentionedOthers).toEqual(["Alice", "Bob"]);
  });

  test("mentionedOthers is omitted when only the bot is mentioned", async () => {
    const provider = createProvider();
    const payload = makeEventPayload();

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result?.metadata?.mentionedOthers).toBeUndefined();
  });

  test("botName carries the bot's Slack display name when resolvable", async () => {
    const provider = createProvider();
    // biome-ignore lint/suspicious/noExplicitAny: test-only — stub Slack client
    (provider as any).client = {
      users: {
        info: vi.fn(async () => ({ user: { real_name: "Ildestra" } })),
      },
    };
    const payload = makeEventPayload();

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result?.metadata?.botName).toBe("Ildestra");
  });

  test("botName is omitted when the display name can't be resolved", async () => {
    // Default test client has no users.info — resolution falls back to the
    // raw user id, which must NOT be surfaced as a display name.
    const provider = createProvider();
    const payload = makeEventPayload();

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result?.metadata?.botName).toBeUndefined();
  });
});

// =============================================================================
// Sticky channel auto-reply (mention once, then reply to the whole thread)
// =============================================================================

describe("SlackProvider.parseWebhookNotification — sticky thread auto-reply", () => {
  test("un-mentioned channel message in an inactive thread returns null", async () => {
    const provider = createProvider();
    const payload = makeEventPayload(
      {},
      {
        type: "message",
        channel: "C_STICKY_INACTIVE",
        text: "no mention here",
        thread_ts: "5555555555.000001",
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).toBeNull();
  });

  test("after a mention activates a thread, un-mentioned replies in it are processed", async () => {
    const provider = createProvider();
    const threadTs = "5555555555.000002";

    // First message @mentions the bot → activates the thread.
    const mention = await provider.parseWebhookNotification(
      makeEventPayload(
        {},
        {
          channel: "C_STICKY_ACTIVE",
          text: "<@UBOT123> help me",
          thread_ts: threadTs,
        },
      ),
      {},
    );
    expect(mention).not.toBeNull();

    // Follow-up in the same thread without a mention → still processed.
    const followUp = await provider.parseWebhookNotification(
      makeEventPayload(
        {},
        {
          type: "message",
          channel: "C_STICKY_ACTIVE",
          text: "and another thing",
          ts: "5555555555.000003",
          thread_ts: threadTs,
        },
      ),
      {},
    );
    expect(followUp).not.toBeNull();
    expect(followUp?.text).toBe("and another thing");
  });

  test("activation does not leak to other threads in the same channel", async () => {
    const provider = createProvider();

    await provider.parseWebhookNotification(
      makeEventPayload(
        {},
        {
          channel: "C_STICKY_SCOPED",
          text: "<@UBOT123> hi",
          thread_ts: "5555555555.000004",
        },
      ),
      {},
    );

    const otherThread = await provider.parseWebhookNotification(
      makeEventPayload(
        {},
        {
          type: "message",
          channel: "C_STICKY_SCOPED",
          text: "unrelated message",
          ts: "5555555555.000006",
          thread_ts: "5555555555.000005",
        },
      ),
      {},
    );

    expect(otherThread).toBeNull();
  });

  test("DMs are processed without any mention or activation", async () => {
    const provider = createProvider();
    const payload = makeEventPayload(
      {},
      {
        type: "message",
        channel: "D_STICKY_DM",
        channel_type: "im",
        text: "direct message, no mention",
        thread_ts: undefined,
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.text).toBe("direct message, no mention");
  });

  test("top-level channel messages without a mention stay gated even after a thread was activated", async () => {
    const provider = createProvider();

    await provider.parseWebhookNotification(
      makeEventPayload(
        {},
        {
          channel: "C_STICKY_TOPLEVEL",
          text: "<@UBOT123> hi",
          thread_ts: "5555555555.000007",
        },
      ),
      {},
    );

    // New top-level message (its own ts becomes the thread id) → not active.
    const topLevel = await provider.parseWebhookNotification(
      makeEventPayload(
        {},
        {
          type: "message",
          channel: "C_STICKY_TOPLEVEL",
          text: "new top-level post",
          ts: "5555555555.000008",
        },
      ),
      {},
    );

    expect(topLevel).toBeNull();
  });
});

describe("SlackProvider.parseWebhookNotification — thread mute command", () => {
  // Wire a real postMessage mock so we can assert the muted-thread notice.
  function createProviderWithPostMessage(): {
    provider: SlackProvider;
    postMessage: ReturnType<typeof vi.fn>;
  } {
    const provider = createProvider();
    const postMessage = vi.fn().mockResolvedValue({ ts: "1.0" });
    // biome-ignore lint/suspicious/noExplicitAny: test-only — inject client mock
    (provider as any).client = { chat: { postMessage } };
    return { provider, postMessage };
  }

  test("'@bot mute' in an active thread mutes it: returns null, posts a notice, and gates later replies", async () => {
    const { provider, postMessage } = createProviderWithPostMessage();
    const channel = "C_MUTE_MENTION";
    const threadTs = "6666666666.000001";

    // Activate via a mention.
    const mention = await provider.parseWebhookNotification(
      makeEventPayload(
        {},
        { channel, text: "<@UBOT123> help me", thread_ts: threadTs },
      ),
      {},
    );
    expect(mention).not.toBeNull();

    // "@bot mute" → muted. Nothing is handed to the agent.
    const mute = await provider.parseWebhookNotification(
      makeEventPayload(
        {},
        { channel, text: "<@UBOT123> mute", thread_ts: threadTs },
      ),
      {},
    );
    expect(mute).toBeNull();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel, thread_ts: threadTs }),
    );

    // A subsequent un-mentioned reply in the thread is gated again.
    const afterMute = await provider.parseWebhookNotification(
      makeEventPayload(
        {},
        {
          type: "message",
          channel,
          text: "are you still there?",
          ts: "6666666666.000002",
          thread_ts: threadTs,
        },
      ),
      {},
    );
    expect(afterMute).toBeNull();
  });

  test("bare 'mute' (no mention) in an active thread mutes it without a re-mention", async () => {
    const { provider, postMessage } = createProviderWithPostMessage();
    const channel = "C_MUTE_BARE";
    const threadTs = "6666666666.000003";

    await provider.parseWebhookNotification(
      makeEventPayload(
        {},
        { channel, text: "<@UBOT123> kick things off", thread_ts: threadTs },
      ),
      {},
    );

    const mute = await provider.parseWebhookNotification(
      makeEventPayload(
        {},
        {
          type: "message",
          channel,
          text: "mute",
          ts: "6666666666.000004",
          thread_ts: threadTs,
        },
      ),
      {},
    );
    expect(mute).toBeNull();
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  test("'mute' in an inactive, un-mentioned thread is just a gated message — no mute notice", async () => {
    const { provider, postMessage } = createProviderWithPostMessage();

    const result = await provider.parseWebhookNotification(
      makeEventPayload(
        {},
        {
          type: "message",
          channel: "C_MUTE_INACTIVE",
          text: "mute",
          thread_ts: "6666666666.000005",
        },
      ),
      {},
    );
    expect(result).toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
  });

  test("a normal request mentioning the bot is not swallowed as a mute", async () => {
    const { provider } = createProviderWithPostMessage();

    const result = await provider.parseWebhookNotification(
      makeEventPayload(
        {},
        {
          channel: "C_MUTE_REAL_REQUEST",
          text: "<@UBOT123> mute the alerts channel for me",
          thread_ts: "6666666666.000006",
        },
      ),
      {},
    );
    expect(result).not.toBeNull();
    expect(result?.text).toBe("mute the alerts channel for me");
  });
});

describe("SlackProvider.parseWebhookNotification — mute reaction", () => {
  const BOT = "UBOT123";
  const CHANNEL = "C_REACT";
  const ROOT = "7777777777.000001";
  const BOT_REPLY_TS = "7777777777.000002";

  // These tests reuse one channel/thread, so reset the shared cache each time.
  beforeEach(() => mockCacheStore.clear());

  // Client with a postMessage spy and a conversations.replies that resolves the
  // thread root (messages[0].ts) for the reacted message.
  function createReactionProvider(rootTs: string | null = ROOT): {
    provider: SlackProvider;
    postMessage: ReturnType<typeof vi.fn>;
    replies: ReturnType<typeof vi.fn>;
  } {
    const provider = createProvider({ botUserId: BOT });
    const postMessage = vi.fn().mockResolvedValue({ ts: "1.0" });
    const replies = vi.fn().mockResolvedValue({
      messages: rootTs ? [{ ts: rootTs }] : [],
    });
    // biome-ignore lint/suspicious/noExplicitAny: test-only — inject client mock
    (provider as any).client = {
      chat: { postMessage },
      conversations: { replies },
    };
    return { provider, postMessage, replies };
  }

  function reactionPayload(
    reaction: string,
    overrides: Record<string, unknown> = {},
  ) {
    return makeEventPayload(
      {},
      {
        type: "reaction_added",
        // reaction events carry channel/ts under `item`, not at the top.
        channel: undefined,
        ts: undefined,
        reaction,
        item: { type: "message", channel: CHANNEL, ts: BOT_REPLY_TS },
        item_user: BOT,
        ...overrides,
      },
    );
  }

  test("🔇 on a bot reply in an active thread mutes it and posts the notice", async () => {
    const { provider, postMessage, replies } = createReactionProvider();
    await markChannelThreadActive({
      provider: "slack",
      channelId: CHANNEL,
      threadId: ROOT,
    });

    const result = await provider.parseWebhookNotification(
      reactionPayload("mute"),
      {},
    );

    expect(result).toBeNull();
    expect(replies).toHaveBeenCalledWith(
      expect.objectContaining({ channel: CHANNEL, ts: BOT_REPLY_TS }),
    );
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(
      await cacheManager.get(
        `${CacheKey.SlackThreadActive}-${CHANNEL}::${ROOT}`,
      ),
    ).toBeUndefined();
  });

  test("🤫 (shushing_face) is also a mute reaction", async () => {
    const { provider, postMessage } = createReactionProvider();
    await markChannelThreadActive({
      provider: "slack",
      channelId: CHANNEL,
      threadId: ROOT,
    });

    await provider.parseWebhookNotification(
      reactionPayload("shushing_face"),
      {},
    );
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  test("reaction on a NON-bot message is ignored (no API call, no notice)", async () => {
    const { provider, postMessage, replies } = createReactionProvider();
    await markChannelThreadActive({
      provider: "slack",
      channelId: CHANNEL,
      threadId: ROOT,
    });

    const result = await provider.parseWebhookNotification(
      reactionPayload("mute", { item_user: "U_SOMEONE_ELSE" }),
      {},
    );
    expect(result).toBeNull();
    expect(replies).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  test("a non-mute reaction is ignored", async () => {
    const { provider, postMessage, replies } = createReactionProvider();
    const result = await provider.parseWebhookNotification(
      reactionPayload("thumbsup"),
      {},
    );
    expect(result).toBeNull();
    expect(replies).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  test("mute reaction on an inactive thread posts no notice (transition rule)", async () => {
    const { provider, postMessage } = createReactionProvider();
    // Thread was never activated → clearing is a no-op → no confirmation.
    const result = await provider.parseWebhookNotification(
      reactionPayload("mute"),
      {},
    );
    expect(result).toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
  });

  test("thread-root resolution failure posts no false 'muted'", async () => {
    const { provider, postMessage } = createReactionProvider(null);
    await markChannelThreadActive({
      provider: "slack",
      channelId: CHANNEL,
      threadId: ROOT,
    });

    const result = await provider.parseWebhookNotification(
      reactionPayload("mute"),
      {},
    );
    expect(result).toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
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

  test("renders the mute hint as its own subtle context block above the footer", async () => {
    const provider = createProvider();
    const postMessage = vi.fn().mockResolvedValue({ ts: "2222222222.000000" });
    // biome-ignore lint/suspicious/noExplicitAny: test-only — mock Slack client
    (provider as any).client = { chat: { postMessage } };

    await provider.sendReply({
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
      text: "hi there",
      footer: "🤖 Agent",
      hint: 'Reply "mute" to stop',
    });

    const { blocks } = postMessage.mock.calls[0][0];
    // markdown, then the hint context, then the footer as the final block.
    expect(blocks).toEqual([
      { type: "markdown", text: "hi there" },
      {
        type: "context",
        elements: [
          { type: "plain_text", text: 'Reply "mute" to stop', emoji: true },
        ],
      },
      {
        type: "context",
        elements: [{ type: "plain_text", text: "🤖 Agent", emoji: true }],
      },
    ]);
  });

  test("splits into thread follow-ups when markdown expansion would exceed Slack's 50-block cap", async () => {
    const provider = createProvider();
    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ ts: "1000.000001" })
      .mockResolvedValueOnce({ ts: "1000.000002" })
      .mockResolvedValueOnce({ ts: "1000.000003" })
      .mockResolvedValueOnce({ ts: "1000.000004" });
    // biome-ignore lint/suspicious/noExplicitAny: test-only — mock Slack client
    (provider as any).client = { chat: { postMessage } };

    // Mirrors the actual repro from prod logs: 1 H1 + 55 sections of
    // (H2 heading + 5-row table). Slack expands the markdown block into one
    // Block Kit block per heading and one per table → 1 + 55*2 = 111 expanded
    // blocks, which exceeds Slack's 50-per-message cap.
    const section = (n: number) =>
      `## Table ${n}\n| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| 7 | 8 | 9 |`;
    const text = `# 55 Markdown Tables\n\n${Array.from({ length: 55 }, (_, i) =>
      section(i + 1),
    ).join("\n\n")}`;

    const result = await provider.sendReply({
      originalMessage: {
        messageId: "9999999999.000000",
        channelId: "C12345",
        workspaceId: "T12345",
        threadId: "1111111111.000000",
        senderId: "U_SENDER",
        senderName: "Test User",
        text: "give me 55 tables",
        rawText: "give me 55 tables",
        timestamp: new Date(),
        isThreadReply: false,
      },
      text,
      footer: "🤖 Agent",
    });

    // First message's ts is returned to callers.
    expect(result).toBe("1000.000001");

    // Must have split into at least 2 messages (single message would expand
    // to 111+ blocks server-side and Slack would reject with invalid_blocks).
    const callCount = postMessage.mock.calls.length;
    expect(callCount).toBeGreaterThanOrEqual(2);

    // All messages thread under the original thread.
    for (const [args] of postMessage.mock.calls) {
      expect(args.thread_ts).toBe("1111111111.000000");
      expect(args.channel).toBe("C12345");
    }

    // Non-final messages carry a "continued in a message below" context block.
    for (let i = 0; i < callCount - 1; i++) {
      const args = postMessage.mock.calls[i][0];
      const lastBlock = args.blocks[args.blocks.length - 1];
      expect(lastBlock).toEqual({
        type: "context",
        elements: [
          {
            type: "plain_text",
            text: "continued in a message below",
            emoji: true,
          },
        ],
      });
    }

    // Final message carries the agent footer.
    const finalArgs = postMessage.mock.calls[callCount - 1][0];
    const finalFooter = finalArgs.blocks[finalArgs.blocks.length - 1];
    expect(finalFooter).toEqual({
      type: "context",
      elements: [{ type: "plain_text", text: "🤖 Agent", emoji: true }],
    });

    // Every section's heading should appear exactly once across the split
    // messages — no content lost, no duplication.
    const allMarkdownText = postMessage.mock.calls
      .flatMap(([args]) => args.blocks)
      .filter((b: { type: string }) => b.type === "markdown")
      .map((b: { text: string }) => b.text)
      .join("\n\n");
    for (let i = 1; i <= 55; i++) {
      const occurrences = allMarkdownText.split(`## Table ${i}\n`).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  test("follow-ups thread under the first message when the original wasn't a thread", async () => {
    const provider = createProvider();
    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ ts: "2000.000001" })
      .mockResolvedValueOnce({ ts: "2000.000002" })
      .mockResolvedValueOnce({ ts: "2000.000003" });
    // biome-ignore lint/suspicious/noExplicitAny: test-only — mock Slack client
    (provider as any).client = { chat: { postMessage } };

    const section = (n: number) =>
      `## Table ${n}\n| A | B |\n|---|---|\n| 1 | 2 |`;
    const text = Array.from({ length: 55 }, (_, i) => section(i + 1)).join(
      "\n\n",
    );

    await provider.sendReply({
      originalMessage: {
        messageId: "9999999999.000000",
        channelId: "C12345",
        workspaceId: "T12345",
        // No threadId — first post lands top-level.
        senderId: "U_SENDER",
        senderName: "Test User",
        text: "long reply",
        rawText: "long reply",
        timestamp: new Date(),
        isThreadReply: false,
      },
      text,
    });

    expect(postMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    const firstArgs = postMessage.mock.calls[0][0];
    const secondArgs = postMessage.mock.calls[1][0];

    // First post is top-level (no thread).
    expect(firstArgs.thread_ts).toBeUndefined();
    // Subsequent posts thread under the first message's ts.
    expect(secondArgs.thread_ts).toBe("2000.000001");
  });

  test("truncates the text fallback for large replies to avoid msg_too_large", async () => {
    const provider = createProvider();
    const postMessage = vi.fn().mockResolvedValue({ ts: "3333333333.000000" });
    // biome-ignore lint/suspicious/noExplicitAny: test-only — mock Slack client
    (provider as any).client = { chat: { postMessage } };

    // 8,000 chars in a single paragraph → one chunk (under the 12k block cap),
    // so the rendered markdown block carries the full text but the notification
    // `text` fallback must be bounded.
    const text = "A ".repeat(4000);
    expect(text.length).toBe(8000);

    await provider.sendReply({
      originalMessage: {
        messageId: "9999999999.000000",
        channelId: "C12345",
        workspaceId: "T12345",
        threadId: "1111111111.000000",
        senderId: "U_SENDER",
        senderName: "Test User",
        text: "long single paragraph",
        rawText: "long single paragraph",
        timestamp: new Date(),
        isThreadReply: false,
      },
      text,
    });

    const args = postMessage.mock.calls[0][0];
    // Fallback text is bounded well below Slack's text-length limit.
    expect(args.text.length).toBeLessThanOrEqual(3000);
    // Rendered content (the markdown block) is NOT truncated.
    expect(args.blocks[0].text).toBe(text);
  });
});

// =============================================================================
// addApprovalRequestForm
// =============================================================================

describe("SlackProvider.addApprovalRequestForm", () => {
  test("embeds only a slimmed-down original message in the button value (msg_too_large guard)", async () => {
    const provider = createProvider();
    const postMessage = vi.fn().mockResolvedValue({ ts: "4444444444.000000" });
    // biome-ignore lint/suspicious/noExplicitAny: test-only — mock Slack client
    (provider as any).client = { chat: { postMessage } };

    await provider.addApprovalRequestForm({
      channelId: "C1",
      threadId: "T1",
      approvalId: "appr-1",
      taskId: "task-1",
      toolName: "dangerous_tool",
      originalMessage: {
        messageId: "1234567890.123456",
        channelId: "C1",
        workspaceId: "W1",
        threadId: "T1",
        senderId: "U_SENDER",
        senderEmail: "user@example.com",
        senderName: "Test User",
        text: "x".repeat(100_000),
        rawText: "x".repeat(100_000),
        timestamp: new Date(),
        isThreadReply: false,
      },
    });

    const callArgs = postMessage.mock.calls[0][0];
    const actionsBlock = callArgs.blocks.find(
      (b: { type: string }) => b.type === "actions",
    );
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock.elements.length).toBeGreaterThan(0);

    for (const btn of actionsBlock.elements) {
      const parsed = JSON.parse(btn.value);
      expect(parsed.originalMessage.text).toBeUndefined();
      expect(parsed.originalMessage.rawText).toBeUndefined();
      expect(parsed.originalMessage.attachments).toBeUndefined();
      expect(parsed.originalMessage.senderEmail).toBe("user@example.com");
      expect(parsed.originalMessage.channelId).toBe("C1");
      expect(parsed.originalMessage.threadId).toBe("T1");
      expect(btn.value.length).toBeLessThan(2000);
    }
  });

  test("renders the tool's arguments as a code block when provided", async () => {
    const provider = createProvider();
    const postMessage = vi.fn().mockResolvedValue({ ts: "4444444444.000000" });
    // biome-ignore lint/suspicious/noExplicitAny: test-only — mock Slack client
    (provider as any).client = { chat: { postMessage } };

    await provider.addApprovalRequestForm({
      channelId: "C1",
      threadId: "T1",
      approvalId: "appr-1",
      taskId: "task-1",
      toolName: "github__create_issue",
      toolArgs: { repo: "octo/repo", title: "Bug" },
      originalMessage: {
        messageId: "1234567890.123456",
        channelId: "C1",
        workspaceId: "W1",
        threadId: "T1",
        senderId: "U_SENDER",
        senderEmail: "user@example.com",
        senderName: "Test User",
        text: "do it",
        rawText: "do it",
        timestamp: new Date(),
        isThreadReply: false,
      },
    });

    const callArgs = postMessage.mock.calls[0][0];
    const sectionTexts = callArgs.blocks
      .filter((b: { type: string }) => b.type === "section")
      .map((b: { text: { text: string } }) => b.text.text);
    // The underlying tool name is shown...
    expect(sectionTexts).toContain("`github__create_issue`");
    // ...alongside a fenced code block carrying the arguments.
    const argsBlock = sectionTexts.find((t: string) => t.startsWith("```"));
    expect(argsBlock).toBeDefined();
    expect(argsBlock).toContain('"repo": "octo/repo"');
    expect(argsBlock).toContain('"title": "Bug"');
  });

  test("omits the arguments code block when there are no arguments", async () => {
    const provider = createProvider();
    const postMessage = vi.fn().mockResolvedValue({ ts: "4444444444.000000" });
    // biome-ignore lint/suspicious/noExplicitAny: test-only — mock Slack client
    (provider as any).client = { chat: { postMessage } };

    await provider.addApprovalRequestForm({
      channelId: "C1",
      threadId: "T1",
      approvalId: "appr-1",
      taskId: "task-1",
      toolName: "dangerous_tool",
      toolArgs: {},
      originalMessage: {
        messageId: "1234567890.123456",
        channelId: "C1",
        workspaceId: "W1",
        threadId: "T1",
        senderId: "U_SENDER",
        senderEmail: "user@example.com",
        senderName: "Test User",
        text: "do it",
        rawText: "do it",
        timestamp: new Date(),
        isThreadReply: false,
      },
    });

    const callArgs = postMessage.mock.calls[0][0];
    const sectionTexts = callArgs.blocks
      .filter((b: { type: string }) => b.type === "section")
      .map((b: { text: { text: string } }) => b.text.text);
    expect(sectionTexts).toContain("`dangerous_tool`");
    expect(sectionTexts.some((t: string) => t.startsWith("```"))).toBe(false);
  });
});

// =============================================================================
// parseApprovalPayload
// =============================================================================

describe("SlackProvider.parseApprovalPayload", () => {
  test("reconstructs the original message from a slimmed button value, preserving sender email", () => {
    const provider = createProvider();

    const value = JSON.stringify({
      taskId: "task-1",
      approvalId: "appr-1",
      toolName: "dangerous_tool",
      approved: true,
      originalMessage: {
        channelId: "C1",
        threadId: "T1",
        senderEmail: "user@example.com",
      },
    });

    const decision = provider.parseApprovalPayload({
      type: "block_actions",
      actions: [{ action_id: "approval_decision_appr-1_approve", value }],
      channel: { id: "C1" },
      team: { id: "W1" },
      user: { id: "U2", name: "Approver" },
      message: { ts: "9.9", thread_ts: "T1" },
      response_url: "https://hooks.slack.test/x",
    });

    expect(decision).not.toBeNull();
    expect(decision?.originalMessage.senderEmail).toBe("user@example.com");
    expect(decision?.originalMessage.channelId).toBe("C1");
    expect(decision?.originalMessage.threadId).toBe("T1");
    expect(decision?.approved).toBe(true);
    expect(decision?.taskId).toBe("task-1");
  });

  test("still parses a legacy full-message button value", () => {
    const provider = createProvider();

    const value = JSON.stringify({
      taskId: "task-1",
      approvalId: "appr-1",
      toolName: "dangerous_tool",
      approved: true,
      originalMessage: {
        messageId: "1234567890.123456",
        channelId: "C1",
        workspaceId: "W1",
        threadId: "T1",
        senderId: "U_SENDER",
        senderEmail: "legacy@example.com",
        senderName: "Legacy User",
        text: "do the thing",
        rawText: "do the thing",
        timestamp: new Date(),
        isThreadReply: false,
      },
    });

    const decision = provider.parseApprovalPayload({
      type: "block_actions",
      actions: [{ action_id: "approval_decision_appr-1_approve", value }],
      channel: { id: "C1" },
      team: { id: "W1" },
      user: { id: "U2", name: "Approver" },
      message: { ts: "9.9", thread_ts: "T1" },
      response_url: "https://hooks.slack.test/x",
    });

    expect(decision).not.toBeNull();
    expect(decision?.originalMessage.senderEmail).toBe("legacy@example.com");
  });
});

// =============================================================================
// sendAgentSelectionCard
// =============================================================================

describe("SlackProvider.sendAgentSelectionCard", () => {
  test("uses shared Slack command names in the welcome card", async () => {
    const provider = createProvider();
    const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
    // biome-ignore lint/suspicious/noExplicitAny: test-only — mock Slack client
    (provider as any).client = {
      chat: { postEphemeral },
    };

    await provider.sendAgentSelectionCard({
      message: {
        messageId: "1234567890.123456",
        channelId: "C12345",
        workspaceId: "T12345",
        senderId: "U_SENDER",
        senderName: "Test User",
        text: "hello",
        rawText: "hello",
        timestamp: new Date(),
        isThreadReply: false,
      },
      agents: [{ id: "agent-1", name: "Sales" }],
      isWelcome: true,
    });

    const callArgs = postEphemeral.mock.calls[0][0];
    expect(JSON.stringify(callArgs.blocks)).toContain(
      SLACK_SLASH_COMMANDS.SELECT_AGENT,
    );
    expect(JSON.stringify(callArgs.blocks)).toContain(
      SLACK_SLASH_COMMANDS.STATUS,
    );
    expect(JSON.stringify(callArgs.blocks)).toContain(
      SLACK_SLASH_COMMANDS.HELP,
    );
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

  test("file-only DM (empty text + files) is parsed with attachments", async () => {
    const provider = createProviderWithConfig();
    const fileContent = Buffer.from("file-only dm");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(fileContent, { status: 200 }),
    );

    const payload = makeEventPayload(
      {},
      {
        type: "message",
        channel: "D_FILE_ONLY",
        channel_type: "im",
        text: "",
        files: [
          {
            id: "F_DM",
            name: "report.pdf",
            mimetype: "application/pdf",
            size: fileContent.length,
            url_private: "https://files.slack.com/files-pri/T123/report.pdf",
          },
        ],
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.text).toBe("");
    expect(result?.attachments).toHaveLength(1);
    expect(result?.attachments?.[0].name).toBe("report.pdf");
  });

  test("file-only DM whose download fails is kept as a skipped attachment", async () => {
    const provider = createProviderWithConfig();

    // The download fails (e.g. expired/oversized). The message is kept (not
    // dropped) so the model can explain the file rather than denying it.
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 404 }));

    const payload = makeEventPayload(
      {},
      {
        type: "message",
        channel: "D_FILE_ONLY",
        channel_type: "im",
        text: "",
        files: [
          {
            id: "F_DM",
            name: "report.pdf",
            mimetype: "application/pdf",
            size: 1234,
            url_private: "https://files.slack.com/files-pri/T123/report.pdf",
          },
        ],
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.attachments).toBeUndefined();
    expect(result?.skippedAttachments).toEqual([
      { name: "report.pdf", sizeBytes: 1234, reason: "download_failed" },
    ]);
  });

  test("file-only app_mention (empty text + files) is parsed with attachments", async () => {
    const provider = createProviderWithConfig();
    const fileContent = Buffer.from("file-only mention");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(fileContent, { status: 200 }),
    );

    const payload = makeEventPayload(
      {},
      {
        type: "app_mention",
        text: "<@UBOT123>",
        files: [
          {
            id: "F_MENTION",
            name: "diagram.png",
            mimetype: "image/png",
            size: fileContent.length,
            url_private: "https://files.slack.com/files-pri/T123/diagram.png",
          },
        ],
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.text).toBe("");
    expect(result?.attachments).toHaveLength(1);
    expect(result?.attachments?.[0].name).toBe("diagram.png");
  });

  test("file-only UNADDRESSED channel message (no mention, inactive thread) is dropped", async () => {
    const provider = createProviderWithConfig();

    const payload = makeEventPayload(
      {},
      {
        type: "message",
        channel: "C_FILE_ONLY_UNADDRESSED",
        channel_type: "channel",
        text: "",
        thread_ts: "7777777777.000001",
        files: [
          {
            id: "F_UNADDRESSED",
            name: "leak.png",
            mimetype: "image/png",
            size: 100,
            url_private: "https://files.slack.com/files-pri/T123/leak.png",
          },
        ],
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).toBeNull();
    // Dropped before any download is attempted.
    expect(fetch).not.toHaveBeenCalled();
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
    // A file with no usable URL is still reported, not silently dropped.
    expect(result?.skippedAttachments).toEqual([
      { name: "no-url.txt", sizeBytes: 100, reason: "download_failed" },
    ]);
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
    // Oversized file is recorded so the model is told it existed.
    expect(result?.skippedAttachments).toEqual([
      { name: "huge.bin", sizeBytes: 11 * 1024 * 1024, reason: "too_large" },
    ]);
  });

  test("downloads an oversized image and includes the shrunk version", async () => {
    const provider = createProviderWithConfig();
    const bigImage = Buffer.alloc(16 * 1024 * 1024, 1); // 16MB — over the 10MB flat limit
    const shrunk = Buffer.from("small-jpeg-bytes");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(bigImage, { status: 200 }),
    );
    vi.mocked(shrinkImageToFit).mockResolvedValue({
      bytes: shrunk,
      contentType: "image/jpeg",
    });

    const payload = makeEventPayload(
      {},
      {
        files: [
          {
            id: "F_IMG",
            name: "IMG_0354.png",
            mimetype: "image/png",
            size: bigImage.length,
            url_private: "https://files.slack.com/big.png",
          },
        ],
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    // The image is downloaded despite exceeding the 10MB flat limit, then shrunk.
    expect(fetch).toHaveBeenCalled();
    expect(result?.attachments).toEqual([
      {
        contentType: "image/jpeg",
        contentBase64: shrunk.toString("base64"),
        name: "IMG_0354.png",
      },
    ]);
    expect(result?.skippedAttachments).toBeUndefined();
  });

  test("records an oversized image that cannot be shrunk as too large", async () => {
    const provider = createProviderWithConfig();
    const bigImage = Buffer.alloc(16 * 1024 * 1024, 1);

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(bigImage, { status: 200 }),
    );
    vi.mocked(shrinkImageToFit).mockResolvedValue(null);

    const payload = makeEventPayload(
      {},
      {
        files: [
          {
            id: "F_IMG",
            name: "IMG_0356.png",
            mimetype: "image/png",
            size: bigImage.length,
            url_private: "https://files.slack.com/big2.png",
          },
        ],
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result?.attachments).toBeUndefined();
    expect(result?.skippedAttachments).toEqual([
      { name: "IMG_0356.png", sizeBytes: bigImage.length, reason: "too_large" },
    ]);
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
    // The over-budget file is recorded, not silently dropped.
    expect(result?.skippedAttachments).toEqual([
      {
        name: "file3.bin",
        sizeBytes: 9 * 1024 * 1024,
        reason: "total_limit_reached",
      },
    ]);
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
    // The thrown-error file is recorded so the model is told it existed.
    expect(result?.skippedAttachments).toEqual([
      { name: "fail.png", sizeBytes: 100, reason: "download_failed" },
    ]);
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
    expect(result?.skippedAttachments).toEqual([
      { name: "missing.png", sizeBytes: 100, reason: "download_failed" },
    ]);
  });

  test("records an HTML response (missing files:read scope) as a skipped download", async () => {
    const provider = createProviderWithConfig();

    // Slack serves an HTML login page instead of the file when the bot lacks
    // files:read — must not be treated as file content.
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("<html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    const payload = makeEventPayload(
      {},
      {
        files: [
          {
            id: "F_HTML",
            name: "chart.png",
            mimetype: "image/png",
            size: 500,
            url_private: "https://files.slack.com/chart",
          },
        ],
      },
    );

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result).not.toBeNull();
    expect(result?.attachments).toBeUndefined();
    expect(result?.skippedAttachments).toEqual([
      { name: "chart.png", sizeBytes: 500, reason: "download_failed" },
    ]);
  });

  test("records files beyond the per-message cap as skipped", async () => {
    const provider = createProviderWithConfig();
    const fileContent = Buffer.from("small");

    const files = Array.from({ length: 22 }, (_, i) => ({
      id: `F${i}`,
      name: `file${i}.txt`,
      mimetype: "text/plain",
      size: fileContent.length,
      url_private: `https://files.slack.com/f${i}`,
    }));
    for (let i = 0; i < 20; i++) {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(fileContent, { status: 200 }),
      );
    }

    const payload = makeEventPayload({}, { files });

    const result = await provider.parseWebhookNotification(payload, {});

    expect(result?.attachments).toHaveLength(20);
    expect(result?.skippedAttachments).toHaveLength(2);
    expect(
      result?.skippedAttachments?.every((s) => s.reason === "too_many"),
    ).toBe(true);
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
    // The post-download over-budget file is recorded (on its actual bytes),
    // not silently dropped.
    expect(result?.skippedAttachments).toEqual([
      {
        name: "big3.bin",
        sizeBytes: 9 * 1024 * 1024,
        reason: "total_limit_reached",
      },
    ]);
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

    expect(result).toEqual({ attachments: [], skipped: [] });
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

// =============================================================================
// handleSlashCommandSocket — ack failure handling
// =============================================================================

describe("SlackProvider.handleSlashCommandSocket", () => {
  const slashBody = {
    command: "/test",
    text: "",
    user_id: "U_SENDER",
    user_name: "tester",
    channel_id: "C12345",
    team_id: "T12345",
    response_url: "https://hooks.slack.com/commands/T12345/123/abc",
    trigger_id: "trigger-1",
  };

  function setup() {
    const provider = createProvider();
    const response = { response_type: "ephemeral", text: "ok" };
    // biome-ignore lint/suspicious/noExplicitAny: test-only — stub method
    vi.spyOn(provider as any, "handleSlashCommand").mockResolvedValue(response);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    return { provider, response, fetchSpy };
  }

  test("ack succeeds → no response_url fallback POST", async () => {
    const { provider, response, fetchSpy } = setup();
    const ack = vi.fn().mockResolvedValue(undefined);

    // biome-ignore lint/suspicious/noExplicitAny: test-only — call private
    await (provider as any).handleSlashCommandSocket(slashBody, ack);

    expect(ack).toHaveBeenCalledWith(response);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("ack rejects → falls back to response_url POST without throwing", async () => {
    const { provider, response, fetchSpy } = setup();
    const ack = vi.fn().mockRejectedValue(new Error("socket not ready"));

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test-only — call private
      (provider as any).handleSlashCommandSocket(slashBody, ack),
    ).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(slashBody.response_url);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual(response);
  });

  test("ack rejects with no response_url → swallowed (no throw, no fetch)", async () => {
    const { provider, fetchSpy } = setup();
    const ack = vi.fn().mockRejectedValue(new Error("socket not ready"));
    const bodyWithoutUrl = { ...slashBody, response_url: undefined };

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test-only — call private
      (provider as any).handleSlashCommandSocket(bodyWithoutUrl, ack),
    ).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("handleSlashCommand throws → error response delivered", async () => {
    const provider = createProvider();
    // biome-ignore lint/suspicious/noExplicitAny: test-only — stub method
    vi.spyOn(provider as any, "handleSlashCommand").mockRejectedValue(
      new Error("boom"),
    );
    const ack = vi.fn().mockResolvedValue(undefined);

    // biome-ignore lint/suspicious/noExplicitAny: test-only — call private
    await (provider as any).handleSlashCommandSocket(slashBody, ack);

    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ response_type: "ephemeral" }),
    );
  });
});
