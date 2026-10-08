import { describe, expect, test } from "vitest";
import type { ChatMessage, ChatMessagePart } from "@/types";
import type { ConversationCompaction } from "@/types/conversation-compaction";
import { estimateFileTokens } from "../normalization/estimate-message-tokens";
import { buildContextCompactionStreamData } from "./compact-messages";
import {
  resolveCompactionBoundaryMessageId,
  resolveUsableCompaction,
  splitMessagesForCompaction,
} from "./history";
import {
  buildCompactionPrompt,
  decodeDataUrl,
  estimateChatMessagesTokens,
  getDataUrlMediaType,
} from "./message-text";

const msg = (
  id: string,
  role: ChatMessage["role"],
  text: string,
): ChatMessage => ({
  id,
  role,
  parts: [{ type: "text", text }],
});

describe("context compaction helpers", () => {
  test("keeps only the latest unresolved real user message live", () => {
    const messages = [
      msg("u1", "user", "one"),
      msg("a1", "assistant", "one reply"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", "two reply"),
      msg("u3", "user", "three"),
      msg("a3", "assistant", "three reply"),
      msg("u4", "user", "four"),
      msg("a4", "assistant", "four reply"),
      msg("u5", "user", "five"),
    ];

    const split = splitMessagesForCompaction(messages);

    expect(split.compactable.map((m) => m.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
      "u3",
      "a3",
      "u4",
      "a4",
    ]);
    expect(split.recent.map((m) => m.id)).toEqual(["u5"]);
  });

  test("treats tool-result-only user messages as compactable, not as recent user turns", () => {
    const toolResultPart: ChatMessagePart = {
      type: "tool-foo",
      toolName: "foo",
      state: "output-available",
      output: { ok: true },
    };
    const toolResultUserMessage: ChatMessage = {
      id: "tr1",
      role: "user",
      parts: [toolResultPart],
    };
    const split = splitMessagesForCompaction([
      msg("u1", "user", "kick off"),
      msg("a1", "assistant", "calling foo"),
      toolResultUserMessage,
      msg("u2", "user", "now do the next step"),
    ]);

    expect(split.compactable.map((m) => m.id)).toEqual(["u1", "a1", "tr1"]);
    expect(split.recent.map((m) => m.id)).toEqual(["u2"]);
  });

  test("compacts historical tool-result payloads even when they appear as role: user", () => {
    const largeToolResult = "x".repeat(50_000);
    const toolResultPart: ChatMessagePart = {
      type: "tool-search",
      toolName: "search",
      state: "output-available",
      output: { data: largeToolResult },
    };
    const toolResultUserMessage: ChatMessage = {
      id: "tr1",
      role: "user",
      parts: [toolResultPart],
    };
    const split = splitMessagesForCompaction([
      toolResultUserMessage,
      msg("a1", "assistant", "summary of search"),
      msg("u2", "user", "now build on that"),
    ]);

    expect(split.compactable.map((m) => m.id)).toEqual(["tr1", "a1"]);
    expect(split.recent.map((m) => m.id)).toEqual(["u2"]);
  });

  test("compacts short older work while keeping the latest user turn live", () => {
    const split = splitMessagesForCompaction([
      msg("u1", "user", "one"),
      msg("a1", "assistant", "one reply"),
      msg("u2", "user", "two"),
    ]);

    expect(split.compactable.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(split.recent.map((m) => m.id)).toEqual(["u2"]);
  });

  test("compacts completed low-turn conversations without a size gate", () => {
    const split = splitMessagesForCompaction([
      msg("u1", "user", "one"),
      msg("a1", "assistant", "one reply"),
    ]);

    expect(split.compactable.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(split.recent).toEqual([]);
  });

  test("does not compact a single unresolved user turn", () => {
    const split = splitMessagesForCompaction([
      msg("u1", "user", "start this work"),
    ]);

    expect(split.compactable).toEqual([]);
    expect(split.recent.map((m) => m.id)).toEqual(["u1"]);
  });

  test("serializes skipped compaction stream data with reason", () => {
    expect(
      buildContextCompactionStreamData({
        messages: [],
        status: "skipped",
        compaction: null,
        reason: "nothing_to_compact",
      }),
    ).toEqual({ status: "skipped", reason: "nothing_to_compact" });
  });

  test("serializes created compaction stream data without summary", () => {
    const compaction = {
      id: "compaction-1",
      conversationId: "conversation-1",
      summary: "summary text",
      compactedThroughMessageId: "a1",
      trigger: "manual",
      provider: "openai",
      model: "gpt-4o-mini",
      originalTokenEstimate: 1000,
      compactedTokenEstimate: 100,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    } satisfies ConversationCompaction;

    expect(
      buildContextCompactionStreamData({
        messages: [],
        status: "created",
        compaction,
      }),
    ).toEqual({
      status: "created",
      compactionId: "compaction-1",
      trigger: "manual",
      originalTokenEstimate: 1000,
      compactedTokenEstimate: 100,
    });
  });

  test("keeps the latest unresolved user turn live while compacting prior low-turn work", () => {
    const split = splitMessagesForCompaction([
      msg("u1", "user", "run the full workflow"),
      msg("a1", "assistant", "step one"),
      msg("a2", "assistant", "step two"),
      msg("a3", "assistant", "step three"),
      msg("a4", "assistant", "step four"),
      msg("a5", "assistant", "step five"),
      msg("u2", "user", "continue from the result"),
    ]);

    expect(split.compactable.map((m) => m.id)).toEqual([
      "u1",
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
    ]);
    expect(split.recent.map((m) => m.id)).toEqual(["u2"]);
  });

  test("uses latest compaction only when its boundary message exists", () => {
    const messages = [
      msg("u1", "user", "one"),
      msg("a1", "assistant", "one reply"),
      msg("u2", "user", "two"),
    ];

    const result = resolveUsableCompaction(
      messages,
      { summary: "Earlier work was about one." },
      ["a1"],
    );

    expect(result.compaction?.summary).toBe("Earlier work was about one.");
    expect(result.boundaryIndex).toBe(1);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].parts?.[0].text).toContain(
      "Earlier work was about one.",
    );
    expect(result.messages[1].id).toBe("u2");
  });

  test("ignores latest compaction when its boundary message is missing", () => {
    const messages = [
      msg("u1", "user", "one"),
      msg("a1", "assistant", "one reply"),
      msg("u2", "user", "two"),
    ];

    const result = resolveUsableCompaction(
      messages,
      { summary: "Earlier work was about deleted messages." },
      ["deleted-message"],
    );

    expect(result.compaction).toBeNull();
    expect(result.boundaryIndex).toBe(-1);
    expect(result.messages).toBe(messages);
  });

  test("uses compaction boundary aliases for live temporary message ids", () => {
    const messages = [
      msg("client-u1", "user", "one"),
      msg("client-a1", "assistant", "one reply"),
      msg("client-u2", "user", "two"),
    ];

    const result = resolveUsableCompaction(
      messages,
      { summary: "Earlier work was about one." },
      ["db-a1", "client-a1"],
    );

    expect(result.compaction?.summary).toBe("Earlier work was about one.");
    expect(result.boundaryIndex).toBe(1);
    expect(result.messages[1].id).toBe("client-u2");
  });

  test("uses persisted message metadata as a compaction boundary", () => {
    const messages = [
      msg("client-u1", "user", "one"),
      {
        ...msg("client-a1", "assistant", "one reply"),
        metadata: { persistedMessageId: "db-a1" },
      } as ChatMessage,
      msg("client-u2", "user", "two"),
    ];

    const result = resolveUsableCompaction(
      messages,
      { summary: "Earlier work was about one." },
      ["db-a1"],
    );

    expect(result.boundaryIndex).toBe(1);
    expect(result.messages[1].id).toBe("client-u2");
  });

  test("uses persisted message metadata when selecting a new compaction boundary", async () => {
    const boundaryMessageId = await resolveCompactionBoundaryMessageId(
      {
        ...msg("client-a1", "assistant", "one reply"),
        metadata: { persistedMessageId: "db-a1" },
      } as ChatMessage,
      "conversation-1",
    );

    expect(boundaryMessageId).toBe("db-a1");
  });

  test("token estimates include inline file payloads", () => {
    const small = estimateChatMessagesTokens({
      provider: "openai",
      messages: [msg("u1", "user", "Use this file")],
    });
    const filePayload = Buffer.from("a".repeat(1000), "utf8").toString(
      "base64",
    );
    const withInlineFile = estimateChatMessagesTokens({
      provider: "openai",
      messages: [
        {
          id: "u1",
          role: "user",
          parts: [
            { type: "text", text: "Use this file" },
            {
              type: "file",
              filename: "large.txt",
              mediaType: "text/plain",
              url: `data:text/plain;base64,${filePayload}`,
            },
          ],
        } as ChatMessage,
      ],
    });

    expect(withInlineFile).toBeGreaterThan(small + 100);
  });

  test("token estimates count binary inline files by decoded bytes instead of raw data URL text", () => {
    const pdfPayload = Buffer.alloc(12_000, 1).toString("base64");
    const estimate = estimateChatMessagesTokens({
      provider: "openai",
      messages: [
        {
          id: "u1",
          role: "user",
          parts: [
            { type: "text", text: "Use this PDF" },
            {
              type: "file",
              filename: "tax.pdf",
              mediaType: "application/pdf",
              url: `data:application/pdf;base64,${pdfPayload}`,
            },
          ],
        } as ChatMessage,
      ],
    });

    expect(estimate).toBeGreaterThan(900);
    expect(estimate).toBeLessThan(1_500);
  });

  test("compaction prompt preserves recent user messages outside the bounded transcript", async () => {
    const prompt = await buildCompactionPrompt({
      previousSummary: null,
      conversationId: "test-conversation-id",
      messages: [
        msg("u1", "user", "Critical original request: keep this exact goal."),
        msg("a1", "assistant", "x".repeat(130_000)),
      ],
    });

    expect(prompt).toContain(
      "Critical original request: keep this exact goal.",
    );
  });

  test("compaction prompt extracts text from data URL file parts without mediaType metadata", async () => {
    const prompt = await buildCompactionPrompt({
      previousSummary: null,
      conversationId: "test-conversation-id",
      messages: [
        {
          id: "u1",
          role: "user",
          parts: [
            { type: "text", text: "Use this uploaded file later." },
            {
              type: "file",
              filename: "notes.txt",
              url: "data:text/plain;base64,Tm90ZXM6IGtlZXAgdGhlIG9yY2hpZCB0aHVuZGVyIGZhY3Qu",
            },
          ],
        } as ChatMessage,
      ],
    });

    expect(prompt).toContain("[file notes.txt text/plain]");
    expect(prompt).toContain("Notes: keep the orchid thunder fact.");
  });

  test("compaction prompt parses data URLs with intermediate media type parameters", async () => {
    const prompt = await buildCompactionPrompt({
      previousSummary: null,
      conversationId: "test-conversation-id",
      messages: [
        {
          id: "u1",
          role: "user",
          parts: [
            { type: "text", text: "Use this uploaded file later." },
            {
              type: "file",
              filename: "notes.txt",
              url: "data:text/plain;charset=utf-8;base64,SGVsbG8sIHdvcmxkIQ==",
            },
          ],
        } as ChatMessage,
      ],
    });

    expect(prompt).toContain("[file notes.txt text/plain]");
    expect(prompt).toContain("Hello, world!");
  });

  describe("data URL parsing", () => {
    test("decodes base64 payloads with intermediate parameters", () => {
      const result = decodeDataUrl(
        "data:text/plain;charset=utf-8;base64,SGVsbG8sIHdvcmxkIQ==",
      );
      expect(result?.mediaType).toBe("text/plain");
      expect(result?.buffer.toString("utf8")).toBe("Hello, world!");
    });

    test("decodes plain (non-base64) payloads with intermediate parameters", () => {
      const result = decodeDataUrl(
        "data:text/plain;charset=utf-8,Hello%2C%20world!",
      );
      expect(result?.mediaType).toBe("text/plain");
      expect(result?.buffer.toString("utf8")).toBe("Hello, world!");
    });

    test("decodes simple base64 data URLs", () => {
      const result = decodeDataUrl("data:text/plain;base64,SGVsbG8=");
      expect(result?.mediaType).toBe("text/plain");
      expect(result?.buffer.toString("utf8")).toBe("Hello");
    });

    test("defaults media type to application/octet-stream when omitted", () => {
      expect(getDataUrlMediaType("data:,Hello")).toBe(
        "application/octet-stream",
      );
      expect(getDataUrlMediaType("data:;base64,SGVsbG8=")).toBe(
        "application/octet-stream",
      );
    });

    test("returns null for non-data URLs", () => {
      expect(decodeDataUrl("https://example.com/file.txt")).toBeNull();
    });

    test("returns null for malformed percent-encoding instead of throwing", () => {
      // a lone '%' makes decodeURIComponent throw URIError; the token-estimate
      // hot path must degrade rather than abort the chat turn.
      expect(decodeDataUrl("data:text/plain,%")).toBeNull();
    });
  });

  describe("estimateFileTokens", () => {
    test("caps image estimates at the per-image ceiling", () => {
      const fourMb = 4 * 1024 * 1024;
      expect(
        estimateFileTokens({
          mediaType: "image/png",
          byteLength: fourMb,
        }),
      ).toBe(1_600);
    });

    test("does not cap non-image binaries", () => {
      const fourMb = 4 * 1024 * 1024;
      expect(
        estimateFileTokens({
          mediaType: "application/octet-stream",
          byteLength: fourMb,
        }),
      ).toBeGreaterThan(1_600);
    });

    test("a small image estimates below the ceiling", () => {
      expect(
        estimateFileTokens({
          mediaType: "image/jpeg",
          byteLength: 2_000,
        }),
      ).toBe(500);
    });
  });
});
