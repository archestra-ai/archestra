import { describe, expect, test } from "vitest";
import MSTeamsProvider from "./ms-teams-provider";

/**
 * Tests for @mention filtering in parseWebhookNotification.
 *
 * In team channels (conversationType === "channel"), the bot should only
 * respond when explicitly @mentioned. Group chats and personal chats are
 * unaffected — all messages are processed.
 */

function makeActivity(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    id: "msg-1",
    text: "<at>TestBot</at> hello world",
    channelId: "msteams",
    conversation: {
      id: "19:abc@thread.tacv2",
      conversationType: "channel",
    },
    from: { id: "user-1", name: "Alice", aadObjectId: "aad-user-1" },
    recipient: { id: "28:app-id-123", name: "TestBot" },
    timestamp: new Date().toISOString(),
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    channelData: {
      team: { id: "19:general@thread.tacv2", aadGroupId: "team-uuid" },
      channel: { id: "19:abc@thread.tacv2" },
      tenant: { id: "tenant-1" },
    },
    entities: [
      {
        type: "mention",
        mentioned: { id: "28:app-id-123", name: "TestBot" },
      },
    ],
    ...overrides,
  };
}

function createProvider(): MSTeamsProvider {
  const provider = new MSTeamsProvider();
  // Set adapter to truthy value so parseWebhookNotification doesn't bail early.
  // The adapter is only existence-checked (not called) during parsing.
  // biome-ignore lint/suspicious/noExplicitAny: test-only — bypass private field
  (provider as any).adapter = {};
  return provider;
}

describe("MSTeamsProvider @mention filtering", () => {
  test("channel message WITH bot @mention returns parsed message", async () => {
    const provider = createProvider();
    const result = await provider.parseWebhookNotification(makeActivity(), {});

    expect(result).not.toBeNull();
    expect(result?.text).toBe("hello world");
  });

  test("channel message WITHOUT bot @mention returns null", async () => {
    const provider = createProvider();
    const result = await provider.parseWebhookNotification(
      makeActivity({ entities: [] }),
      {},
    );

    expect(result).toBeNull();
  });

  test("channel message with @mention of DIFFERENT user returns null", async () => {
    const provider = createProvider();
    const result = await provider.parseWebhookNotification(
      makeActivity({
        entities: [
          {
            type: "mention",
            mentioned: { id: "other-user-id", name: "SomeoneElse" },
          },
        ],
      }),
      {},
    );

    expect(result).toBeNull();
  });

  test("matches when mentioned.id has 28: prefix but recipient.id does not", async () => {
    const provider = createProvider();
    const result = await provider.parseWebhookNotification(
      makeActivity({
        recipient: { id: "app-id-123", name: "TestBot" },
        entities: [
          {
            type: "mention",
            mentioned: { id: "28:app-id-123", name: "TestBot" },
          },
        ],
      }),
      {},
    );

    expect(result).not.toBeNull();
  });

  test("matches IDs case-insensitively", async () => {
    const provider = createProvider();
    const result = await provider.parseWebhookNotification(
      makeActivity({
        recipient: { id: "28:APP-ID-123", name: "TestBot" },
        entities: [
          {
            type: "mention",
            mentioned: { id: "28:app-id-123", name: "TestBot" },
          },
        ],
      }),
      {},
    );

    expect(result).not.toBeNull();
  });

  test("channel message with no entities array returns null", async () => {
    const provider = createProvider();
    const result = await provider.parseWebhookNotification(
      makeActivity({ entities: undefined }),
      {},
    );

    expect(result).toBeNull();
  });

  test("group chat message without @mention returns parsed message", async () => {
    const provider = createProvider();
    const result = await provider.parseWebhookNotification(
      makeActivity({
        conversation: {
          id: "19:meeting_abc@thread.v2",
          conversationType: "groupChat",
        },
        entities: [],
        channelData: { tenant: { id: "tenant-1" } },
      }),
      {},
    );

    expect(result).not.toBeNull();
    expect(result?.text).toBe("hello world");
  });

  test("personal chat message without @mention returns parsed message", async () => {
    const provider = createProvider();
    const result = await provider.parseWebhookNotification(
      makeActivity({
        conversation: { id: "a:b", conversationType: "personal" },
        entities: [],
        channelData: { tenant: { id: "tenant-1" } },
      }),
      {},
    );

    expect(result).not.toBeNull();
  });
});
