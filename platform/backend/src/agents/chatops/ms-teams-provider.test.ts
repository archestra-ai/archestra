import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import MSTeamsProvider from "./ms-teams-provider";

/**
 * Tests for bot @mention detection (wasBotMentioned).
 *
 * In team channels the bot stays quiet until @mentioned, then keeps replying
 * to the thread. That gating now lives in the webhook route (mention detection
 * + channel-activation); parseWebhookNotification no longer drops un-mentioned
 * channel messages. These tests cover the mention-detection primitive and the
 * fact that parsing itself is mention-agnostic.
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
  const provider = new MSTeamsProvider({
    enabled: true,
    appId: "app-id-123",
    appSecret: "test-secret",
    tenantId: "tenant-1",
    graphTenantId: "tenant-1",
    graphClientId: "app-id-123",
    graphClientSecret: "test-secret",
  });
  // Set adapter to truthy value so parseWebhookNotification doesn't bail early.
  // The adapter is only existence-checked (not called) during parsing.
  // biome-ignore lint/suspicious/noExplicitAny: test-only — bypass private field
  (provider as any).adapter = {};
  return provider;
}

describe("MSTeamsProvider.wasBotMentioned", () => {
  test("true when the bot is @mentioned", () => {
    const provider = createProvider();
    expect(provider.wasBotMentioned(makeActivity())).toBe(true);
  });

  test("false when there are no mention entities", () => {
    const provider = createProvider();
    expect(provider.wasBotMentioned(makeActivity({ entities: [] }))).toBe(
      false,
    );
  });

  test("false when the entities array is missing", () => {
    const provider = createProvider();
    expect(
      provider.wasBotMentioned(makeActivity({ entities: undefined })),
    ).toBe(false);
  });

  test("false when a DIFFERENT user is mentioned", () => {
    const provider = createProvider();
    expect(
      provider.wasBotMentioned(
        makeActivity({
          entities: [
            {
              type: "mention",
              mentioned: { id: "other-user-id", name: "SomeoneElse" },
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  test("matches when mentioned.id has 28: prefix but recipient.id does not", () => {
    const provider = createProvider();
    expect(
      provider.wasBotMentioned(
        makeActivity({
          recipient: { id: "app-id-123", name: "TestBot" },
          entities: [
            {
              type: "mention",
              mentioned: { id: "28:app-id-123", name: "TestBot" },
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  test("matches IDs case-insensitively", () => {
    const provider = createProvider();
    expect(
      provider.wasBotMentioned(
        makeActivity({
          recipient: { id: "28:APP-ID-123", name: "TestBot" },
          entities: [
            {
              type: "mention",
              mentioned: { id: "28:app-id-123", name: "TestBot" },
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  test("false when the bot has no recipient id", () => {
    const provider = createProvider();
    expect(
      provider.wasBotMentioned(makeActivity({ recipient: { name: "Bot" } })),
    ).toBe(false);
  });
});

describe("MSTeamsProvider.parseMuteReaction", () => {
  const CHANNEL = "19:abcdef@thread.tacv2";
  const ROOT = "1700000000000";
  const channelReaction = (overrides: Record<string, unknown> = {}) => ({
    type: "messageReaction",
    conversation: {
      id: `${CHANNEL};messageid=${ROOT}`,
      conversationType: "channel",
    },
    channelData: { channel: { id: CHANNEL } },
    reactionsAdded: [{ type: "1f507_mutedspeaker" }],
    ...overrides,
  });

  test("returns channel + thread (root from conversation id) for a mute reaction", () => {
    const provider = createProvider();
    expect(provider.parseMuteReaction(channelReaction())).toEqual({
      channelId: CHANNEL,
      threadId: ROOT,
    });
  });

  test("accepts the shushing-face reaction id too", () => {
    const provider = createProvider();
    expect(
      provider.parseMuteReaction(
        channelReaction({ reactionsAdded: [{ type: "lipssealed" }] }),
      ),
    ).not.toBeNull();
  });

  test("derives the thread root from conversation id, NOT replyToId", () => {
    const provider = createProvider();
    // replyToId points at the reacted (bot reply) message, which must be ignored.
    const result = provider.parseMuteReaction(
      channelReaction({ replyToId: "9999-bot-reply-message-id" }),
    );
    expect(result?.threadId).toBe(ROOT);
  });

  test("null for a non-mute reaction", () => {
    const provider = createProvider();
    expect(
      provider.parseMuteReaction(
        channelReaction({ reactionsAdded: [{ type: "like" }] }),
      ),
    ).toBeNull();
  });

  test("null when the activity is not a messageReaction", () => {
    const provider = createProvider();
    expect(
      provider.parseMuteReaction(channelReaction({ type: "message" })),
    ).toBeNull();
  });

  test("null outside team channels (no sticky state to clear)", () => {
    const provider = createProvider();
    expect(
      provider.parseMuteReaction(
        channelReaction({
          conversation: {
            id: `${CHANNEL};messageid=${ROOT}`,
            conversationType: "groupChat",
          },
        }),
      ),
    ).toBeNull();
  });

  test("null when the thread root can't be resolved (no false mute)", () => {
    const provider = createProvider();
    // conversation id without ;messageid= — we must NOT guess a key.
    expect(
      provider.parseMuteReaction(
        channelReaction({
          conversation: { id: CHANNEL, conversationType: "channel" },
        }),
      ),
    ).toBeNull();
  });
});

describe("MSTeamsProvider.parseWebhookNotification is mention-agnostic", () => {
  test("channel message WITH @mention is parsed", async () => {
    const provider = createProvider();
    const result = await provider.parseWebhookNotification(makeActivity(), {});

    expect(result).not.toBeNull();
    expect(result?.text).toBe("hello world");
  });

  test("channel message WITHOUT @mention is still parsed (gating moved to the route)", async () => {
    const provider = createProvider();
    const result = await provider.parseWebhookNotification(
      makeActivity({ entities: [] }),
      {},
    );

    expect(result).not.toBeNull();
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

describe("MSTeamsProvider file attachment downloads", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("message without attachments has no attachments field", async () => {
    const provider = createProvider();
    const result = await provider.parseWebhookNotification(makeActivity(), {});

    expect(result).not.toBeNull();
    expect(result?.attachments).toBeUndefined();
  });

  test("skips Adaptive Card attachments", async () => {
    const provider = createProvider();
    const result = await provider.parseWebhookNotification(
      makeActivity({
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: JSON.stringify({ type: "AdaptiveCard" }),
          },
        ],
      }),
      {},
    );

    expect(result).not.toBeNull();
    expect(result?.attachments).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("skips hero card attachments", async () => {
    const provider = createProvider();
    const result = await provider.parseWebhookNotification(
      makeActivity({
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.hero",
            content: "{}",
          },
        ],
      }),
      {},
    );

    expect(result).not.toBeNull();
    expect(result?.attachments).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("file-only message (empty text + file attachment) is parsed with attachments", async () => {
    const provider = createProvider();
    const fileContent = Buffer.from("file-only teams message");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(fileContent, { status: 200 }),
    );

    const result = await provider.parseWebhookNotification(
      makeActivity({
        text: undefined,
        attachments: [
          {
            contentType: "application/pdf",
            contentUrl: "https://teams.blob.core.windows.net/files/report.pdf",
            name: "report.pdf",
          },
        ],
      }),
      {},
    );

    expect(result).not.toBeNull();
    expect(result?.text).toBe("");
    expect(result?.attachments).toHaveLength(1);
    expect(result?.attachments?.[0].name).toBe("report.pdf");
  });

  test("message with neither text nor attachments returns null", async () => {
    const provider = createProvider();

    const result = await provider.parseWebhookNotification(
      makeActivity({ text: undefined, attachments: undefined }),
      {},
    );

    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("file-only message whose download fails is dropped (no empty turn)", async () => {
    const provider = createProvider();

    // The download fails (e.g. expired/oversized), so no attachment survives.
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 404 }));

    const result = await provider.parseWebhookNotification(
      makeActivity({
        text: undefined,
        attachments: [
          {
            contentType: "application/pdf",
            contentUrl: "https://teams.blob.core.windows.net/files/report.pdf",
            name: "report.pdf",
          },
        ],
      }),
      {},
    );

    expect(result).toBeNull();
  });

  test("card-only message with empty text returns null (cards are not files)", async () => {
    const provider = createProvider();

    const result = await provider.parseWebhookNotification(
      makeActivity({
        text: undefined,
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: JSON.stringify({ type: "AdaptiveCard" }),
          },
        ],
      }),
      {},
    );

    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("downloads file attachment and returns base64 content", async () => {
    const provider = createProvider();
    const fileContent = Buffer.from("image bytes here");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(fileContent, { status: 200 }),
    );

    const result = await provider.parseWebhookNotification(
      makeActivity({
        attachments: [
          {
            contentType: "image/png",
            contentUrl: "https://teams.blob.core.windows.net/files/photo.png",
            name: "photo.png",
          },
        ],
      }),
      {},
    );

    expect(result).not.toBeNull();
    expect(result?.attachments).toHaveLength(1);
    expect(result?.attachments?.[0]).toEqual({
      contentType: "image/png",
      contentBase64: fileContent.toString("base64"),
      name: "photo.png",
    });

    // Blob URLs are not on the serviceUrl domain — no auth header sent
    expect(fetch).toHaveBeenCalledWith(
      "https://teams.blob.core.windows.net/files/photo.png",
      undefined,
    );
  });

  test("sends auth header when contentUrl matches serviceUrl domain", async () => {
    const provider = createProvider();
    const fileContent = Buffer.from("authenticated data");

    // First call: token request to Azure AD
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "bot-token-123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      // Second call: actual file download
      .mockResolvedValueOnce(new Response(fileContent, { status: 200 }));

    const result = await provider.parseWebhookNotification(
      makeActivity({
        // serviceUrl is set in makeActivity to https://smba.trafficmanager.net/amer/
        attachments: [
          {
            contentType: "image/png",
            contentUrl:
              "https://smba.trafficmanager.net/amer/v3/attachments/photo.png",
            name: "sharepoint-photo.png",
          },
        ],
      }),
      {},
    );

    expect(result).not.toBeNull();
    expect(result?.attachments).toHaveLength(1);
    expect(result?.attachments?.[0].name).toBe("sharepoint-photo.png");

    // Token request should be first
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token",
    );

    // File download should include auth header
    expect(vi.mocked(fetch).mock.calls[1]).toEqual([
      "https://smba.trafficmanager.net/amer/v3/attachments/photo.png",
      { headers: { Authorization: "Bearer bot-token-123" } },
    ]);
  });

  test("skips attachments without contentUrl", async () => {
    const provider = createProvider();
    const result = await provider.parseWebhookNotification(
      makeActivity({
        attachments: [
          {
            contentType: "image/png",
            name: "no-url.png",
            // no contentUrl
          },
        ],
      }),
      {},
    );

    expect(result).not.toBeNull();
    expect(result?.attachments).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("skips file when download returns non-200 status", async () => {
    const provider = createProvider();

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("Forbidden", { status: 403 }),
    );

    const result = await provider.parseWebhookNotification(
      makeActivity({
        attachments: [
          {
            contentType: "image/jpeg",
            contentUrl: "https://teams.blob.core.windows.net/files/secret.jpg",
            name: "secret.jpg",
          },
        ],
      }),
      {},
    );

    expect(result).not.toBeNull();
    expect(result?.attachments).toBeUndefined();
  });

  test("skips file exceeding individual size limit after download", async () => {
    const provider = createProvider();
    const hugeContent = Buffer.alloc(11 * 1024 * 1024, "x"); // 11MB

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(hugeContent, { status: 200 }),
    );

    const result = await provider.parseWebhookNotification(
      makeActivity({
        attachments: [
          {
            contentType: "application/octet-stream",
            contentUrl: "https://teams.blob.core.windows.net/files/huge.bin",
            name: "huge.bin",
          },
        ],
      }),
      {},
    );

    expect(result).not.toBeNull();
    expect(result?.attachments).toBeUndefined();
  });

  test("stops downloading when total size exceeds 25MB limit", async () => {
    const provider = createProvider();
    const file1Content = Buffer.alloc(9 * 1024 * 1024, "a"); // 9MB
    const file2Content = Buffer.alloc(9 * 1024 * 1024, "b"); // 9MB
    const file3Content = Buffer.alloc(9 * 1024 * 1024, "c"); // 9MB — exceeds limit

    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(file1Content, { status: 200 }))
      .mockResolvedValueOnce(new Response(file2Content, { status: 200 }))
      .mockResolvedValueOnce(new Response(file3Content, { status: 200 }));

    const result = await provider.parseWebhookNotification(
      makeActivity({
        attachments: [
          {
            contentType: "image/png",
            contentUrl: "https://teams.blob.core.windows.net/f1",
            name: "f1.png",
          },
          {
            contentType: "image/png",
            contentUrl: "https://teams.blob.core.windows.net/f2",
            name: "f2.png",
          },
          {
            contentType: "image/png",
            contentUrl: "https://teams.blob.core.windows.net/f3",
            name: "f3.png",
          },
        ],
      }),
      {},
    );

    expect(result).not.toBeNull();
    // All 3 are downloaded (Teams checks size post-download), but third is discarded
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result?.attachments).toHaveLength(2);
  });

  test("continues downloading after fetch error on one attachment", async () => {
    const provider = createProvider();
    const file2Content = Buffer.from("ok data");

    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error("Network timeout"))
      .mockResolvedValueOnce(new Response(file2Content, { status: 200 }));

    const result = await provider.parseWebhookNotification(
      makeActivity({
        attachments: [
          {
            contentType: "image/png",
            contentUrl: "https://teams.blob.core.windows.net/fail",
            name: "fail.png",
          },
          {
            contentType: "image/jpeg",
            contentUrl: "https://teams.blob.core.windows.net/ok",
            name: "ok.jpg",
          },
        ],
      }),
      {},
    );

    expect(result).not.toBeNull();
    expect(result?.attachments).toHaveLength(1);
    expect(result?.attachments?.[0].name).toBe("ok.jpg");
  });

  test("downloads multiple files successfully", async () => {
    const provider = createProvider();
    const img1 = Buffer.from("image1");
    const img2 = Buffer.from("image2");

    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(img1, { status: 200 }))
      .mockResolvedValueOnce(new Response(img2, { status: 200 }));

    const result = await provider.parseWebhookNotification(
      makeActivity({
        attachments: [
          {
            contentType: "image/png",
            contentUrl: "https://teams.blob.core.windows.net/img1",
            name: "img1.png",
          },
          {
            contentType: "image/jpeg",
            contentUrl: "https://teams.blob.core.windows.net/img2",
            name: "img2.jpg",
          },
        ],
      }),
      {},
    );

    expect(result).not.toBeNull();
    expect(result?.attachments).toHaveLength(2);
    expect(result?.attachments?.[0]).toEqual({
      contentType: "image/png",
      contentBase64: img1.toString("base64"),
      name: "img1.png",
    });
    expect(result?.attachments?.[1]).toEqual({
      contentType: "image/jpeg",
      contentBase64: img2.toString("base64"),
      name: "img2.jpg",
    });
  });

  test("mixes file and card attachments — only downloads files", async () => {
    const provider = createProvider();
    const imgContent = Buffer.from("img data");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(imgContent, { status: 200 }),
    );

    const result = await provider.parseWebhookNotification(
      makeActivity({
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: "{}",
          },
          {
            contentType: "image/png",
            contentUrl: "https://teams.blob.core.windows.net/img",
            name: "screenshot.png",
          },
          {
            contentType: "application/vnd.microsoft.card.hero",
            content: "{}",
          },
        ],
      }),
      {},
    );

    expect(result).not.toBeNull();
    expect(result?.attachments).toHaveLength(1);
    expect(result?.attachments?.[0].name).toBe("screenshot.png");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// convertToThreadMessages — file metadata
// =============================================================================

describe("MSTeamsProvider.convertToThreadMessages file metadata", () => {
  test("includes file metadata from Graph API ChatMessage attachments", () => {
    const provider = createProvider();

    // biome-ignore lint/suspicious/noExplicitAny: test-only — invoke private method
    const result = (provider as any).convertToThreadMessages(
      [
        {
          id: "msg-1",
          from: { user: { id: "user-1", displayName: "Alice" } },
          body: { content: "Check out this image" },
          createdDateTime: new Date().toISOString(),
          attachments: [
            {
              contentType: "image/png",
              contentUrl: "https://teams.blob.core.windows.net/img/photo.png",
              name: "photo.png",
            },
          ],
        },
        {
          id: "msg-2",
          from: {
            application: { id: "app-id-123", displayName: "TestBot" },
          },
          body: { content: "I see a cat!" },
          createdDateTime: new Date().toISOString(),
          attachments: [],
        },
        {
          id: "msg-3",
          from: { user: { id: "user-1", displayName: "Alice" } },
          body: { content: "What breed?" },
          createdDateTime: new Date().toISOString(),
          attachments: undefined,
        },
      ],
      undefined,
    );

    expect(result).toHaveLength(3);

    // First message should have file metadata
    expect(result[0].files).toEqual([
      {
        url: "https://teams.blob.core.windows.net/img/photo.png",
        mimetype: "image/png",
        name: "photo.png",
      },
    ]);

    // Bot message has no file attachments
    expect(result[1].files).toBeUndefined();

    // Third message has no attachments
    expect(result[2].files).toBeUndefined();
  });

  test("excludes Adaptive Card attachments from file metadata", () => {
    const provider = createProvider();

    // biome-ignore lint/suspicious/noExplicitAny: test-only — invoke private method
    const result = (provider as any).convertToThreadMessages(
      [
        {
          id: "msg-1",
          from: { user: { id: "user-1", displayName: "Alice" } },
          body: { content: "Message with card" },
          createdDateTime: new Date().toISOString(),
          attachments: [
            {
              contentType: "application/vnd.microsoft.card.adaptive",
              content: "{}",
            },
            {
              contentType: "image/jpeg",
              contentUrl: "https://teams.blob.core.windows.net/img/photo.jpg",
              name: "vacation.jpg",
            },
          ],
        },
      ],
      undefined,
    );

    expect(result).toHaveLength(1);
    // Only the image should be in files, not the Adaptive Card
    expect(result[0].files).toEqual([
      {
        url: "https://teams.blob.core.windows.net/img/photo.jpg",
        mimetype: "image/jpeg",
        name: "vacation.jpg",
      },
    ]);
  });
});

describe("MSTeamsProvider.sendReply", () => {
  // Drives a reply through the conversationReference branch (no live
  // turnContext) and returns the text handed to context.sendActivity.
  async function captureReplyText(
    options: Pick<
      Parameters<MSTeamsProvider["sendReply"]>[0],
      "footer" | "hint"
    >,
  ): Promise<string> {
    const provider = createProvider();
    const sendActivity = vi.fn().mockResolvedValue({ id: "reply-1" });
    const continueConversationAsync = vi.fn(
      async (
        _appId: string,
        _ref: unknown,
        callback: (context: {
          sendActivity: typeof sendActivity;
        }) => Promise<void>,
      ) => {
        await callback({ sendActivity });
      },
    );
    // biome-ignore lint/suspicious/noExplicitAny: test-only — mock adapter
    (provider as any).adapter = { continueConversationAsync };

    await provider.sendReply({
      originalMessage: {
        messageId: "msg-1",
        channelId: "19:abc@thread.tacv2",
        workspaceId: "team-uuid",
        senderId: "user-1",
        senderName: "Alice",
        text: "hi",
        rawText: "hi",
        timestamp: new Date(),
        isThreadReply: false,
        metadata: { conversationReference: { foo: "bar" } },
      },
      text: "Here is your answer",
      ...options,
    });

    return sendActivity.mock.calls[0][0] as string;
  }

  test("puts the mute hint on its own italic line above the footer", async () => {
    const text = await captureReplyText({
      footer: "🤖 Agent",
      hint: 'Reply "mute" to stop',
    });

    expect(text).toBe(
      'Here is your answer\n\n---\n\n_Reply "mute" to stop_\n\n🤖 Agent',
    );
  });

  test("renders the hint under its own separator when there is no footer", async () => {
    const text = await captureReplyText({ hint: 'Reply "mute" to stop' });

    expect(text).toBe('Here is your answer\n\n---\n\n_Reply "mute" to stop_');
  });
});

describe("MSTeamsProvider.addApprovalRequestForm", () => {
  // Drives the form through the conversationReference branch (no live
  // turnContext) and captures the Adaptive Card sent to the channel.
  async function captureApprovalCard(options: {
    toolName: string;
    toolArgs?: Record<string, unknown>;
  }): Promise<{ body: Array<Record<string, unknown>> }> {
    const provider = createProvider();
    const sendActivity = vi.fn().mockResolvedValue(undefined);
    const continueConversationAsync = vi.fn(
      async (
        _appId: string,
        _ref: unknown,
        callback: (context: {
          sendActivity: typeof sendActivity;
        }) => Promise<void>,
      ) => {
        await callback({ sendActivity });
      },
    );
    // biome-ignore lint/suspicious/noExplicitAny: test-only — mock adapter
    (provider as any).adapter = { continueConversationAsync };

    await provider.addApprovalRequestForm({
      channelId: "19:abc@thread.tacv2",
      threadId: "19:abc@thread.tacv2",
      approvalId: "appr-1",
      taskId: "task-1",
      toolName: options.toolName,
      toolArgs: options.toolArgs,
      originalMessage: {
        messageId: "msg-1",
        channelId: "19:abc@thread.tacv2",
        workspaceId: "team-uuid",
        senderId: "user-1",
        senderEmail: "user@example.com",
        senderName: "Alice",
        text: "do it",
        rawText: "do it",
        timestamp: new Date(),
        isThreadReply: false,
        metadata: { conversationReference: { foo: "bar" } },
      },
    });

    const activity = sendActivity.mock.calls[0][0];
    return activity.attachments[0].content as {
      body: Array<Record<string, unknown>>;
    };
  }

  test("renders the tool's arguments as a monospace block when provided", async () => {
    const card = await captureApprovalCard({
      toolName: "github__create_issue",
      toolArgs: { repo: "octo/repo", title: "Bug" },
    });

    const textBlocks = card.body.filter((b) => b.type === "TextBlock");
    expect(textBlocks[0].text).toBe("`github__create_issue`");
    const argsBlock = textBlocks.find((b) => b.fontType === "Monospace");
    expect(argsBlock).toBeDefined();
    expect(argsBlock?.text).toContain('"repo": "octo/repo"');
    expect(argsBlock?.text).toContain('"title": "Bug"');
  });

  test("omits the arguments block when there are no arguments", async () => {
    const card = await captureApprovalCard({
      toolName: "dangerous_tool",
      toolArgs: {},
    });

    const textBlocks = card.body.filter((b) => b.type === "TextBlock");
    expect(textBlocks[0].text).toBe("`dangerous_tool`");
    expect(textBlocks.some((b) => b.fontType === "Monospace")).toBe(false);
  });
});
