import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorSyncBatch } from "@/types";
import { SlackConnector } from "./slack-connector";

// ===== Mock @slack/web-api =====
const mockAuthTest = vi.fn();
const mockConversationsList = vi.fn();
const mockConversationsHistory = vi.fn();
const mockConversationsReplies = vi.fn();
const mockUsersInfo = vi.fn();

vi.mock("@slack/web-api", () => {
  class MockWebClient {
    auth = { test: (...args: unknown[]) => mockAuthTest(...args) };
    conversations = {
      list: (...args: unknown[]) => mockConversationsList(...args),
      history: (...args: unknown[]) => mockConversationsHistory(...args),
      replies: (...args: unknown[]) => mockConversationsReplies(...args),
    };
    users = {
      info: (...args: unknown[]) => mockUsersInfo(...args),
    };
  }
  return { WebClient: MockWebClient };
});

// ===== Mock quick-lru (use a plain Map so tests stay deterministic) =====
vi.mock("quick-lru", () => {
  return {
    default: class FakeLRU<K, V> extends Map<K, V> {
      constructor(_opts?: unknown) {
        super();
      }
    },
  };
});

const credentials = { apiToken: "xoxb-test-token" };

function makeChannel(id: string, name: string, isMember = true) {
  return { id, name, is_member: isMember };
}

function makeMessage(
  ts: string,
  text: string,
  opts?: {
    user?: string;
    bot_id?: string;
    subtype?: string;
    reply_count?: number;
    thread_ts?: string;
  },
) {
  return { ts, text, ...opts };
}

describe("SlackConnector", () => {
  beforeEach(() => {
    mockAuthTest.mockReset();
    mockConversationsList.mockReset();
    mockConversationsHistory.mockReset();
    mockConversationsReplies.mockReset();
    mockUsersInfo.mockReset();
  });

  it("has the correct type", () => {
    const connector = new SlackConnector();
    expect(connector.type).toBe("slack");
  });

  // ===== validateConfig =====
  describe("validateConfig", () => {
    it("rejects empty config (channelIds required)", async () => {
      const connector = new SlackConnector();
      const result = await connector.validateConfig({});
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Channel IDs are required");
    });

    it("rejects config with empty channelIds array", async () => {
      const connector = new SlackConnector();
      const result = await connector.validateConfig({ channelIds: [] });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Channel IDs are required");
    });

    it("accepts config with valid channelIds", async () => {
      const connector = new SlackConnector();
      const result = await connector.validateConfig({
        channelIds: ["C12345ABC", "G98765XYZ"],
      });
      expect(result.valid).toBe(true);
    });

    it("rejects config with invalid channelIds format", async () => {
      const connector = new SlackConnector();
      const result = await connector.validateConfig({
        channelIds: ["invalid-id", "C12345"],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid Slack channel ID");
      expect(result.error).toContain("invalid-id");
    });

    it("accepts config with boolean toggle fields", async () => {
      const connector = new SlackConnector();
      const result = await connector.validateConfig({
        channelIds: ["C12345ABC"],
        skipBotMessages: false,
        includeThreadReplies: true,
        includePinnedItems: false,
      });
      expect(result.valid).toBe(true);
    });

    it("accepts config with batchSize", async () => {
      const connector = new SlackConnector();
      const result = await connector.validateConfig({
        channelIds: ["C12345ABC"],
        batchSize: 50,
      });
      expect(result.valid).toBe(true);
    });

    it("rejects invalid batchSize type", async () => {
      const connector = new SlackConnector();
      const result = await connector.validateConfig({
        channelIds: ["C12345ABC"],
        batchSize: "not-a-number",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid Slack configuration");
    });
  });

  // ===== testConnection =====
  describe("testConnection", () => {
    it("returns success when auth.test and conversations.list both succeed", async () => {
      mockAuthTest.mockResolvedValueOnce({
        ok: true,
        team: "Test Workspace",
        user: "bot-user",
        bot_id: "B123",
      });
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [makeChannel("C001", "general")],
      });

      const connector = new SlackConnector();
      const result = await connector.testConnection({
        config: { channelIds: ["C001"] },
        credentials,
      });
      expect(result.success).toBe(true);
    });

    it("returns failure when auth.test fails", async () => {
      mockAuthTest.mockResolvedValueOnce({
        ok: false,
        error: "invalid_auth",
      });

      const connector = new SlackConnector();
      const result = await connector.testConnection({
        config: { channelIds: ["C001"] },
        credentials,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Authentication failed");
    });

    it("returns failure when conversations.list fails (missing scopes)", async () => {
      mockAuthTest.mockResolvedValueOnce({ ok: true, team: "ws" });
      mockConversationsList.mockResolvedValueOnce({
        ok: false,
        error: "missing_scope",
      });

      const connector = new SlackConnector();
      const result = await connector.testConnection({
        config: { channelIds: ["C001"] },
        credentials,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Channel access failed");
      expect(result.error).toContain("channels:read");
    });

    it("returns failure when SDK throws network error", async () => {
      mockAuthTest.mockRejectedValueOnce(
        new Error("fetch failed: ECONNREFUSED"),
      );

      const connector = new SlackConnector();
      const result = await connector.testConnection({
        config: { channelIds: ["C001"] },
        credentials,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("ECONNREFUSED");
    });
  });

  // ===== estimateTotalItems =====
  describe("estimateTotalItems", () => {
    it("returns channel count for discovered channels", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [
          makeChannel("C001", "general"),
          makeChannel("C002", "random"),
        ],
        response_metadata: { next_cursor: "" },
      });

      const connector = new SlackConnector();
      const result = await connector.estimateTotalItems({
        config: { channelIds: ["C001"] },
        credentials,
        checkpoint: null,
      });
      expect(result).toBe(2);
    });

    it("returns null on failure", async () => {
      mockConversationsList.mockRejectedValueOnce(new Error("API error"));

      const connector = new SlackConnector();
      const result = await connector.estimateTotalItems({
        config: { channelIds: ["C001"] },
        credentials,
        checkpoint: null,
      });
      expect(result).toBe(null);
    });
  });

  // ===== Channel discovery =====
  describe("channel discovery", () => {
    it("paginates through multiple pages of channels", async () => {
      mockConversationsList
        .mockResolvedValueOnce({
          ok: true,
          channels: [makeChannel("C001", "general")],
          response_metadata: { next_cursor: "page2" },
        })
        .mockResolvedValueOnce({
          ok: true,
          channels: [makeChannel("C002", "random")],
          response_metadata: { next_cursor: "" },
        });

      // Set up history to return empty for both channels
      mockConversationsHistory.mockResolvedValue({
        ok: true,
        messages: [],
        has_more: false,
      });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { channelIds: ["C001"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Two channels discovered → two batches (one per channel)
      expect(batches).toHaveLength(2);
      expect(mockConversationsList).toHaveBeenCalledTimes(2);
    });

    it("filters channels by channelIds config", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [
          makeChannel("C001", "general"),
          makeChannel("C002", "random"),
          makeChannel("C003", "eng"),
        ],
        response_metadata: { next_cursor: "" },
      });

      mockConversationsHistory.mockResolvedValue({
        ok: true,
        messages: [],
        has_more: false,
      });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { channelIds: ["C001", "C003"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Only 2 of 3 channels match the filter
      expect(batches).toHaveLength(2);
    });

    it("skips channels where bot is not a member", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [
          makeChannel("C001", "general", true),
          makeChannel("C002", "random", false),
        ],
        response_metadata: { next_cursor: "" },
      });

      mockConversationsHistory.mockResolvedValue({
        ok: true,
        messages: [],
        has_more: false,
      });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { channelIds: ["C001"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Only C001 (is_member=true) → 1 batch
      expect(batches).toHaveLength(1);
    });
  });

  // ===== sync — message ingestion =====
  describe("sync — message ingestion", () => {
    it("yields documents from channel messages", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [makeChannel("C001", "general")],
        response_metadata: { next_cursor: "" },
      });

      mockConversationsHistory.mockResolvedValueOnce({
        ok: true,
        messages: [
          makeMessage("1700000001.000000", "Hello world", { user: "U001" }),
          makeMessage("1700000002.000000", "Second message", { user: "U002" }),
        ],
        has_more: false,
      });

      mockUsersInfo
        .mockResolvedValueOnce({
          user: { real_name: "Alice", profile: {}, name: "alice" },
        })
        .mockResolvedValueOnce({
          user: { real_name: "Bob", profile: {}, name: "bob" },
        });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { channelIds: ["C001"], skipBotMessages: false },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(2);
      expect(batches[0].documents[0].id).toBe("slack-C001-1700000001.000000");
      expect(batches[0].documents[0].content).toContain("Hello world");
      expect(batches[0].documents[0].title).toContain("#general");
      expect(batches[0].documents[0].title).toContain("Alice");
    });

    it("skips messages without text", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [makeChannel("C001", "general")],
        response_metadata: { next_cursor: "" },
      });

      mockConversationsHistory.mockResolvedValueOnce({
        ok: true,
        messages: [
          makeMessage("1700000001.000000", "Has text", { user: "U001" }),
          { ts: "1700000002.000000" }, // no text field
        ],
        has_more: false,
      });

      mockUsersInfo.mockResolvedValue({
        user: { real_name: "Alice", profile: {}, name: "alice" },
      });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { channelIds: ["C001"], skipBotMessages: false },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
    });
  });

  // ===== sync — bot message filtering =====
  describe("sync — bot message filtering", () => {
    it("filters bot messages when skipBotMessages is true (default)", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [makeChannel("C001", "general")],
        response_metadata: { next_cursor: "" },
      });

      mockConversationsHistory.mockResolvedValueOnce({
        ok: true,
        messages: [
          makeMessage("1700000001.000000", "Human message", { user: "U001" }),
          makeMessage("1700000002.000000", "Bot message", {
            user: "U002",
            bot_id: "B001",
          }),
          makeMessage("1700000003.000000", "Another bot", {
            subtype: "bot_message",
          }),
        ],
        has_more: false,
      });

      mockUsersInfo.mockResolvedValue({
        user: { real_name: "Alice", profile: {}, name: "alice" },
      });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { channelIds: ["C001"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // skipBotMessages defaults to true, so only the human message
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].content).toContain("Human message");
    });

    it("includes bot messages when skipBotMessages is false", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [makeChannel("C001", "general")],
        response_metadata: { next_cursor: "" },
      });

      mockConversationsHistory.mockResolvedValueOnce({
        ok: true,
        messages: [
          makeMessage("1700000001.000000", "Human message", { user: "U001" }),
          makeMessage("1700000002.000000", "Bot message", {
            user: "U002",
            bot_id: "B001",
          }),
        ],
        has_more: false,
      });

      mockUsersInfo.mockResolvedValue({
        user: { real_name: "Alice", profile: {}, name: "alice" },
      });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { channelIds: ["C001"], skipBotMessages: false },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(2);
    });
  });

  // ===== sync — subtype filtering =====
  describe("sync — subtype filtering", () => {
    it("skips channel_join and channel_leave subtypes", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [makeChannel("C001", "general")],
        response_metadata: { next_cursor: "" },
      });

      mockConversationsHistory.mockResolvedValueOnce({
        ok: true,
        messages: [
          makeMessage("1700000001.000000", "Normal message", { user: "U001" }),
          makeMessage("1700000002.000000", "User joined", {
            user: "U002",
            subtype: "channel_join",
          }),
          makeMessage("1700000003.000000", "User left", {
            user: "U003",
            subtype: "channel_leave",
          }),
        ],
        has_more: false,
      });

      mockUsersInfo.mockResolvedValue({
        user: { real_name: "Alice", profile: {}, name: "alice" },
      });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { channelIds: ["C001"], skipBotMessages: false },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].content).toContain("Normal message");
    });
  });

  // ===== sync — thread resolution =====
  describe("sync — thread resolution", () => {
    it("appends thread replies to parent message content", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [makeChannel("C001", "general")],
        response_metadata: { next_cursor: "" },
      });

      mockConversationsHistory.mockResolvedValueOnce({
        ok: true,
        messages: [
          makeMessage("1700000001.000000", "Parent message", {
            user: "U001",
            reply_count: 2,
            thread_ts: "1700000001.000000",
          }),
        ],
        has_more: false,
      });

      mockConversationsReplies.mockResolvedValueOnce({
        ok: true,
        messages: [
          // First message is the parent (skipped)
          makeMessage("1700000001.000000", "Parent message", { user: "U001" }),
          // These are replies
          makeMessage("1700000001.000100", "Reply 1", { user: "U002" }),
          makeMessage("1700000001.000200", "Reply 2", { user: "U003" }),
        ],
      });

      mockUsersInfo.mockImplementation(({ user }) => {
        if (user === "U001") {
          return Promise.resolve({
            user: { real_name: "Alice", profile: {}, name: "alice" },
          });
        }
        if (user === "U002") {
          return Promise.resolve({
            user: { real_name: "Bob", profile: {}, name: "bob" },
          });
        }
        if (user === "U003") {
          return Promise.resolve({
            user: { real_name: "Charlie", profile: {}, name: "charlie" },
          });
        }
        return Promise.resolve({ user: { real_name: "Unknown" } });
      });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          channelIds: ["C001"],
          includeThreadReplies: true,
          skipBotMessages: false,
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const doc = batches[0].documents[0];
      expect(doc.content).toContain("Parent message");
      expect(doc.content).toContain("Thread replies:");
      expect(doc.content).toContain("**Bob:** Reply 1");
      expect(doc.content).toContain("**Charlie:** Reply 2");
      expect(doc.metadata.isThread).toBe(true);
      expect(doc.metadata.replyCount).toBe(2);
    });

    it("indexes parent message without replies when replies fetch fails", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [makeChannel("C001", "general")],
        response_metadata: { next_cursor: "" },
      });

      mockConversationsHistory.mockResolvedValueOnce({
        ok: true,
        messages: [
          makeMessage("1700000001.000000", "Parent message", {
            user: "U001",
            reply_count: 2,
          }),
        ],
        has_more: false,
      });

      mockConversationsReplies.mockRejectedValueOnce(
        new Error("thread_not_found"),
      );

      mockUsersInfo.mockResolvedValue({
        user: { real_name: "Alice", profile: {}, name: "alice" },
      });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { channelIds: ["C001"], skipBotMessages: false },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Parent message is indexed without replies
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].content).toBe("Parent message");
      expect(batches[0].documents[0].content).not.toContain("Thread replies:");
    });

    it("does not fetch replies when includeThreadReplies is false", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [makeChannel("C001", "general")],
        response_metadata: { next_cursor: "" },
      });

      mockConversationsHistory.mockResolvedValueOnce({
        ok: true,
        messages: [
          makeMessage("1700000001.000000", "Parent message", {
            user: "U001",
            reply_count: 5,
          }),
        ],
        has_more: false,
      });

      mockUsersInfo.mockResolvedValue({
        user: { real_name: "Alice", profile: {}, name: "alice" },
      });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: {
          channelIds: ["C001"],
          includeThreadReplies: false,
          skipBotMessages: false,
        },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(mockConversationsReplies).not.toHaveBeenCalled();
    });
  });

  // ===== sync — user name resolution =====
  describe("sync — user name resolution", () => {
    it("caches user names to avoid redundant API calls", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [makeChannel("C001", "general")],
        response_metadata: { next_cursor: "" },
      });

      mockConversationsHistory.mockResolvedValueOnce({
        ok: true,
        messages: [
          makeMessage("1700000001.000000", "First msg", { user: "U001" }),
          makeMessage("1700000002.000000", "Second msg", { user: "U001" }),
          makeMessage("1700000003.000000", "Third msg", { user: "U001" }),
        ],
        has_more: false,
      });

      mockUsersInfo.mockResolvedValue({
        user: { real_name: "Alice", profile: {}, name: "alice" },
      });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { channelIds: ["C001"], skipBotMessages: false },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // users.info should be called only ONCE for U001 (then cached)
      expect(mockUsersInfo).toHaveBeenCalledTimes(1);
      expect(batches[0].documents).toHaveLength(3);
      // All three documents should have Alice
      for (const doc of batches[0].documents) {
        expect(doc.title).toContain("Alice");
      }
    });

    it("falls back to userId when users.info fails", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [makeChannel("C001", "general")],
        response_metadata: { next_cursor: "" },
      });

      mockConversationsHistory.mockResolvedValueOnce({
        ok: true,
        messages: [makeMessage("1700000001.000000", "Hello", { user: "U999" })],
        has_more: false,
      });

      mockUsersInfo.mockRejectedValue(new Error("user_not_found"));

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { channelIds: ["C001"], skipBotMessages: false },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].title).toContain("U999");
    });

    it("resolves Unknown for messages without user field", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [makeChannel("C001", "general")],
        response_metadata: { next_cursor: "" },
      });

      mockConversationsHistory.mockResolvedValueOnce({
        ok: true,
        messages: [makeMessage("1700000001.000000", "No user msg", {})],
        has_more: false,
      });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { channelIds: ["C001"], skipBotMessages: false },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      expect(batches[0].documents[0].title).toContain("Unknown");
    });
  });

  // ===== sync — per-channel checkpointing =====
  describe("sync — checkpointing", () => {
    it("stores per-channel cursors in checkpoint", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [
          makeChannel("C001", "general"),
          makeChannel("C002", "random"),
        ],
        response_metadata: { next_cursor: "" },
      });

      mockConversationsHistory
        .mockResolvedValueOnce({
          ok: true,
          messages: [
            makeMessage("1700000010.000000", "Msg in general", {
              user: "U001",
            }),
          ],
          has_more: false,
        })
        .mockResolvedValueOnce({
          ok: true,
          messages: [
            makeMessage("1700000020.000000", "Msg in random", {
              user: "U001",
            }),
          ],
          has_more: false,
        });

      mockUsersInfo.mockResolvedValue({
        user: { real_name: "Alice", profile: {}, name: "alice" },
      });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { channelIds: ["C001"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Two batches (one per channel)
      expect(batches).toHaveLength(2);

      // Final checkpoint should have cursors for both channels
      const finalCp = batches[1].checkpoint as Record<string, unknown>;
      expect(finalCp.type).toBe("slack");
      const cursors = finalCp.channelCursors as Record<string, string>;
      expect(cursors.C001).toBe("1700000010.000000");
      expect(cursors.C002).toBe("1700000020.000000");
    });

    it("uses existing cursor for incremental sync (oldest param)", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [makeChannel("C001", "general")],
        response_metadata: { next_cursor: "" },
      });

      mockConversationsHistory.mockResolvedValueOnce({
        ok: true,
        messages: [
          makeMessage("1700000099.000000", "New message", { user: "U001" }),
        ],
        has_more: false,
      });

      mockUsersInfo.mockResolvedValue({
        user: { real_name: "Alice", profile: {}, name: "alice" },
      });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { channelIds: ["C001"] },
        credentials,
        checkpoint: {
          type: "slack",
          channelCursors: { C001: "1700000050.000000" },
        },
      })) {
        batches.push(batch);
      }

      // Verify conversations.history was called with oldest = checkpoint ts
      expect(mockConversationsHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C001",
          oldest: "1700000050.000000",
        }),
      );
    });

    it("yields zero-update batch for no-op incremental sync", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [makeChannel("C001", "general")],
        response_metadata: { next_cursor: "" },
      });

      mockConversationsHistory.mockResolvedValueOnce({
        ok: true,
        messages: [],
        has_more: false,
      });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { channelIds: ["C001"] },
        credentials,
        checkpoint: {
          type: "slack",
          channelCursors: { C001: "1700000050.000000" },
        },
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(0);
    });
  });

  // ===== sync — per-channel failure isolation =====
  describe("sync — failure isolation", () => {
    it("continues syncing other channels when one channel fails", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [
          makeChannel("C001", "general"),
          makeChannel("C002", "random"),
        ],
        response_metadata: { next_cursor: "" },
      });

      // C001: throws an error
      mockConversationsHistory
        .mockRejectedValueOnce(new Error("channel_not_found"))
        // C002: succeeds
        .mockResolvedValueOnce({
          ok: true,
          messages: [
            makeMessage("1700000001.000000", "Good message", { user: "U001" }),
          ],
          has_more: false,
        });

      mockUsersInfo.mockResolvedValue({
        user: { real_name: "Alice", profile: {}, name: "alice" },
      });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { channelIds: ["C001"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Two batches: first is the failure batch, second is the success batch
      expect(batches).toHaveLength(2);

      // First batch: failure from C001
      expect(batches[0].documents).toHaveLength(0);
      expect(batches[0].failures).toHaveLength(1);
      expect(batches[0].failures?.[0].itemId).toBe("C001");
      expect(batches[0].hasMore).toBe(true);

      // Second batch: success from C002
      expect(batches[1].documents).toHaveLength(1);
      expect(batches[1].documents[0].content).toContain("Good message");
      expect(batches[1].hasMore).toBe(false);
    });

    it("preserves previous channel cursors when one channel fails", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [
          makeChannel("C001", "general"),
          makeChannel("C002", "random"),
        ],
        response_metadata: { next_cursor: "" },
      });

      // C001 succeeds
      mockConversationsHistory
        .mockResolvedValueOnce({
          ok: true,
          messages: [
            makeMessage("1700000010.000000", "C1 msg", { user: "U001" }),
          ],
          has_more: false,
        })
        // C002 fails
        .mockRejectedValueOnce(new Error("rate_limited"));

      mockUsersInfo.mockResolvedValue({
        user: { real_name: "Alice", profile: {}, name: "alice" },
      });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { channelIds: ["C001"] },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // C001 cursor should be set, C002 cursor should not advance
      const finalCp = batches[1].checkpoint as Record<string, unknown>;
      const cursors = finalCp.channelCursors as Record<string, string>;
      expect(cursors.C001).toBe("1700000010.000000");
      expect(cursors.C002).toBeUndefined();
    });
  });

  // ===== sync — message history pagination =====
  describe("sync — message history pagination", () => {
    it("paginates through multiple pages of messages", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [makeChannel("C001", "general")],
        response_metadata: { next_cursor: "" },
      });

      // Page 1
      mockConversationsHistory.mockResolvedValueOnce({
        ok: true,
        messages: [makeMessage("1700000001.000000", "Msg 1", { user: "U001" })],
        has_more: true,
        response_metadata: { next_cursor: "page2cursor" },
      });
      // Page 2
      mockConversationsHistory.mockResolvedValueOnce({
        ok: true,
        messages: [makeMessage("1700000002.000000", "Msg 2", { user: "U001" })],
        has_more: false,
      });

      mockUsersInfo.mockResolvedValue({
        user: { real_name: "Alice", profile: {}, name: "alice" },
      });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { channelIds: ["C001"], skipBotMessages: false },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      // Two batches from pagination
      expect(batches).toHaveLength(2);
      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(2);
      expect(allDocs[0].content).toContain("Msg 1");
      expect(allDocs[1].content).toContain("Msg 2");
    });
  });

  // ===== sync — document metadata =====
  describe("sync — document metadata", () => {
    it("includes correct metadata in document", async () => {
      mockConversationsList.mockResolvedValueOnce({
        ok: true,
        channels: [makeChannel("C001", "general")],
        response_metadata: { next_cursor: "" },
      });

      mockConversationsHistory.mockResolvedValueOnce({
        ok: true,
        messages: [
          makeMessage("1700000001.000000", "Test message", {
            user: "U001",
            thread_ts: "1700000001.000000",
            reply_count: 3,
          }),
        ],
        has_more: false,
      });

      // No thread replies fetch needed since we test metadata shape only
      mockConversationsReplies.mockResolvedValueOnce({
        ok: true,
        messages: [
          makeMessage("1700000001.000000", "Test message", { user: "U001" }),
        ],
      });

      mockUsersInfo.mockResolvedValue({
        user: { real_name: "Alice", profile: {}, name: "alice" },
      });

      const connector = new SlackConnector();
      const batches: ConnectorSyncBatch[] = [];
      for await (const batch of connector.sync({
        config: { channelIds: ["C001"], skipBotMessages: false },
        credentials,
        checkpoint: null,
      })) {
        batches.push(batch);
      }

      const metadata = batches[0].documents[0].metadata;
      expect(metadata.channelId).toBe("C001");
      expect(metadata.channelName).toBe("general");
      expect(metadata.authorId).toBe("U001");
      expect(metadata.authorName).toBe("Alice");
      expect(metadata.messageTs).toBe("1700000001.000000");
      expect(metadata.isThread).toBe(true);
      expect(metadata.replyCount).toBe(3);
    });
  });

  // ===== sync — invalid config =====
  describe("sync — invalid config", () => {
    it("throws when config is invalid", async () => {
      const connector = new SlackConnector();
      const generator = connector.sync({
        config: { batchSize: "not-a-number" },
        credentials,
        checkpoint: null,
      });
      await expect(generator.next()).rejects.toThrow(
        "Invalid Slack configuration",
      );
    });
  });
});
