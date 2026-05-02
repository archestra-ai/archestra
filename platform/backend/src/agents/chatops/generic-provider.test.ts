import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import GenericChatOpsProvider, { namespaceId } from "./generic-provider";

function makeMessagePayload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "v1" as const,
    messageId: "msg-001",
    sender: {
      externalId: "user-42",
      name: "Alice",
      email: "alice@example.com",
    },
    channel: {
      externalId: "ch-99",
      name: "general",
      kind: "channel" as const,
    },
    workspace: {
      externalId: "ws-1",
      name: "Acme",
    },
    thread: {
      externalId: "thr-1",
    },
    text: "Hello bot",
    rawText: "Hello bot",
    timestamp: new Date().toISOString(),
    isThreadReply: false,
    replyContext: { token: "rc-123" },
    ...overrides,
  };
}

function makeProvider(overrides: Record<string, unknown> = {}) {
  return new GenericChatOpsProvider({
    adapterId: "test-adapter",
    baseUrl: "http://localhost:3200",
    workspaceId: "ws-default",
    workspaceName: "Default WS",
    ...overrides,
  });
}

describe("namespaceId", () => {
  test("produces namespaced id with sha256 prefix", () => {
    const result = namespaceId("my-adapter", "message", "ext-123");
    const expectedHash = createHash("sha256")
      .update("ext-123")
      .digest("hex")
      .slice(0, 16);
    expect(result).toBe(`generic:my-adapter:message:${expectedHash}`);
  });

  test("different external ids produce different hashes", () => {
    const a = namespaceId("adapter", "message", "id-a");
    const b = namespaceId("adapter", "message", "id-b");
    expect(a).not.toBe(b);
  });

  test("same external id with different kinds produces different ids", () => {
    const msg = namespaceId("adapter", "message", "ext-1");
    const ch = namespaceId("adapter", "channel", "ext-1");
    expect(msg).not.toBe(ch);
  });
});

describe("GenericChatOpsProvider", () => {
  let provider: GenericChatOpsProvider;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    provider = makeProvider();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200, statusText: "OK" }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isConfigured", () => {
    test("returns true when baseUrl is set", () => {
      expect(provider.isConfigured()).toBe(true);
    });

    test("returns false when baseUrl is empty", () => {
      const p = makeProvider({ baseUrl: "" });
      expect(p.isConfigured()).toBe(false);
    });
  });

  describe("parseWebhookNotification", () => {
    test("correctly namespaces all ids", async () => {
      const payload = makeMessagePayload();
      const result = await provider.parseWebhookNotification(payload, {});

      expect(result).not.toBeNull();
      expect(result!.messageId).toBe(
        namespaceId("test-adapter", "message", "msg-001"),
      );
      expect(result!.channelId).toBe(
        namespaceId("test-adapter", "channel", "ch-99"),
      );
      expect(result!.workspaceId).toBe(
        namespaceId("test-adapter", "workspace", "ws-1"),
      );
      expect(result!.threadId).toBe(
        namespaceId("test-adapter", "thread", "thr-1"),
      );
      expect(result!.senderId).toBe(
        namespaceId("test-adapter", "sender", "user-42"),
      );
    });

    test("sets channel metadata correctly", async () => {
      const payload = makeMessagePayload({
        channel: { externalId: "dm-1", name: null, kind: "dm" },
      });
      const result = await provider.parseWebhookNotification(payload, {});
      expect(result!.metadata?.channelType).toBe("im");
    });

    test("caches reply context", async () => {
      const payload = makeMessagePayload({
        replyContext: { myToken: 42 },
      });
      await provider.parseWebhookNotification(payload, {});

      const namespacedMsgId = namespaceId(
        "test-adapter",
        "message",
        "msg-001",
      );
      const cached = (provider as any).getReplyContext(namespacedMsgId);
      expect(cached).toEqual({ myToken: 42 });
    });

    test("caches channel name when present", async () => {
      const payload = makeMessagePayload();
      await provider.parseWebhookNotification(payload, {});

      const namespacedChannelId = namespaceId(
        "test-adapter",
        "channel",
        "ch-99",
      );
      const name = await provider.getChannelName(namespacedChannelId);
      expect(name).toBe("general");
    });

    test("handles null workspace", async () => {
      const payload = makeMessagePayload({ workspace: null });
      const result = await provider.parseWebhookNotification(payload, {});
      expect(result!.workspaceId).toBeNull();
    });

    test("handles null thread", async () => {
      const payload = makeMessagePayload({ thread: null });
      const result = await provider.parseWebhookNotification(payload, {});
      expect(result!.threadId).toBeUndefined();
    });

    test("passes sender email through", async () => {
      const payload = makeMessagePayload();
      const result = await provider.parseWebhookNotification(payload, {});
      expect(result!.senderEmail).toBe("alice@example.com");
    });
  });

  describe("sendReply", () => {
    test("makes POST to /reply callback URL", async () => {
      const payload = makeMessagePayload();
      const message = (await provider.parseWebhookNotification(payload, {}))!;

      const deliveryId = await provider.sendReply({
        originalMessage: message,
        text: "Hello!",
      });

      expect(deliveryId).toMatch(/^delivery-/);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("http://localhost:3200/reply");
      expect(init?.method).toBe("POST");

      const body = JSON.parse(init?.body as string);
      expect(body.schemaVersion).toBe("v1");
      expect(body.text).toBe("Hello!");
      expect(body.replyContext).toEqual({ token: "rc-123" });
    });

    test("includes footer when provided", async () => {
      const payload = makeMessagePayload();
      const message = (await provider.parseWebhookNotification(payload, {}))!;

      await provider.sendReply({
        originalMessage: message,
        text: "Done",
        footer: "Powered by Bot",
      });

      const body = JSON.parse(
        (fetchSpy.mock.calls[0][1] as any).body as string,
      );
      expect(body.footer).toBe("Powered by Bot");
    });
  });

  describe("sendAgentSelectionCard", () => {
    test("makes POST to /agent-selection with agent list", async () => {
      const payload = makeMessagePayload();
      const message = (await provider.parseWebhookNotification(payload, {}))!;

      const agents = [
        { id: "agent-uuid-1", name: "Sales" },
        { id: "agent-uuid-2", name: "Support" },
      ];

      await provider.sendAgentSelectionCard({
        message,
        agents,
        isWelcome: true,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("http://localhost:3200/agent-selection");

      const body = JSON.parse(init?.body as string);
      expect(body.schemaVersion).toBe("v1");
      expect(body.isWelcome).toBe(true);
      expect(body.agents).toEqual(agents);
      expect(body.replyContext).toEqual({ token: "rc-123" });
    });
  });

  describe("addApprovalRequestForm", () => {
    test("makes POST to /reply with approval metadata", async () => {
      const payload = makeMessagePayload();
      const message = (await provider.parseWebhookNotification(payload, {}))!;

      await provider.addApprovalRequestForm({
        originalMessage: message,
        taskId: "task-1",
        approvalId: "approval-1",
        toolName: "delete_record",
        channelId: "channel-1",
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(
        (fetchSpy.mock.calls[0][1] as any).body as string,
      );
      expect(body.metadata.approvalRequest).toEqual({
        taskId: "task-1",
        approvalId: "approval-1",
        toolName: "delete_record",
      });
      expect(body.text).toContain("delete_record");
    });
  });

  describe("parseInteractivePayload", () => {
    test("parses select-agent action with namespaced ids", () => {
      const payload = {
        schemaVersion: "v1",
        eventId: "evt-001",
        action: "select-agent" as const,
        agentId: "agent-uuid-1",
        sender: {
          externalId: "user-42",
          name: "Alice",
        },
        channel: {
          externalId: "ch-99",
          kind: "channel" as const,
        },
        workspace: {
          externalId: "ws-1",
        },
        thread: {
          externalId: "thr-1",
        },
        timestamp: new Date().toISOString(),
        replyContext: { interactive: true },
      };

      const result = provider.parseInteractivePayload(payload);

      expect(result).not.toBeNull();
      expect(result!.agentId).toBe("agent-uuid-1");
      expect(result!.channelId).toBe(
        namespaceId("test-adapter", "channel", "ch-99"),
      );
      expect(result!.workspaceId).toBe(
        namespaceId("test-adapter", "workspace", "ws-1"),
      );
      expect(result!.threadTs).toBe(
        namespaceId("test-adapter", "thread", "thr-1"),
      );
      expect(result!.userId).toBe(
        namespaceId("test-adapter", "sender", "user-42"),
      );
      expect(result!.userName).toBe("Alice");
    });

    test("returns null for non-select-agent action", () => {
      const result = provider.parseInteractivePayload({
        action: "other",
      });
      expect(result).toBeNull();
    });

    test("returns null when agentId is missing", () => {
      const result = provider.parseInteractivePayload({
        action: "select-agent",
      });
      expect(result).toBeNull();
    });
  });

  describe("reply context cache", () => {
    test("stores and retrieves reply context", async () => {
      const payload = makeMessagePayload({
        replyContext: { sessionId: "abc" },
      });
      await provider.parseWebhookNotification(payload, {});

      const namespacedId = namespaceId(
        "test-adapter",
        "message",
        "msg-001",
      );
      const cached = (provider as any).getReplyContext(namespacedId);
      expect(cached).toEqual({ sessionId: "abc" });
    });

    test("returns undefined for missing key", () => {
      const cached = (provider as any).getReplyContext("nonexistent");
      expect(cached).toBeUndefined();
    });

    test("evicts expired entries on save", () => {
      vi.useFakeTimers();

      const payload = makeMessagePayload({
        replyContext: { old: true },
      });
      provider.parseWebhookNotification(payload, {});

      vi.advanceTimersByTime(16 * 60 * 1000);

      const payload2 = makeMessagePayload({
        messageId: "msg-002",
        replyContext: { fresh: true },
      });
      provider.parseWebhookNotification(payload2, {});

      const oldKey = namespaceId("test-adapter", "message", "msg-001");
      expect((provider as any).getReplyContext(oldKey)).toBeUndefined();

      vi.useRealTimers();
    });
  });

  describe("syncChannels", () => {
    test("populates channel cache with namespaced ids", async () => {
      provider.syncChannels([
        { externalId: "ch-a", name: "Alpha", kind: "channel" },
        { externalId: "ch-b", name: null, kind: "dm" },
      ]);

      const idA = namespaceId("test-adapter", "channel", "ch-a");
      const nameA = await provider.getChannelName(idA);
      expect(nameA).toBe("Alpha");

      const idB = namespaceId("test-adapter", "channel", "ch-b");
      const nameB = await provider.getChannelName(idB);
      expect(nameB).toBeNull();
    });

    test("clears previous channels before syncing", async () => {
      provider.syncChannels([
        { externalId: "ch-old", name: "Old", kind: "channel" },
      ]);
      provider.syncChannels([
        { externalId: "ch-new", name: "New", kind: "channel" },
      ]);

      const oldId = namespaceId("test-adapter", "channel", "ch-old");
      expect(await provider.getChannelName(oldId)).toBeNull();

      const newId = namespaceId("test-adapter", "channel", "ch-new");
      expect(await provider.getChannelName(newId)).toBe("New");
    });
  });

  describe("getWorkspaceId / getWorkspaceName", () => {
    test("returns configured workspace id and name", () => {
      expect(provider.getWorkspaceId()).toBe("ws-default");
      expect(provider.getWorkspaceName()).toBe("Default WS");
    });

    test("returns null when not configured", () => {
      const p = new GenericChatOpsProvider({
        adapterId: "bare",
        baseUrl: "http://localhost:3200",
      });
      expect(p.getWorkspaceId()).toBeNull();
      expect(p.getWorkspaceName()).toBeNull();
    });
  });

  describe("displayName", () => {
    test("uses provided display name", () => {
      const p = makeProvider({ displayName: "Custom Adapter" });
      expect(p.displayName).toBe("Custom Adapter");
    });

    test("falls back to default display name", () => {
      const p = new GenericChatOpsProvider({
        adapterId: "my-adp",
        baseUrl: "http://localhost:3200",
      });
      expect(p.displayName).toBe("Generic (my-adp)");
    });
  });
});
