import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
