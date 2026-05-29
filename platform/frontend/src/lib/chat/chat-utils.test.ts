import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import {
  getChatExternalAgentId,
  getConversationDisplayTitle,
  getManualCompactionSkippedMessage,
  mergePersistedMessageMetadata,
  PERSISTED_MESSAGE_ID_METADATA_KEY,
} from "./chat-utils";

const DEFAULT_SESSION_NAME = "New Chat Session";

describe("getConversationDisplayTitle", () => {
  it("returns the title if provided", () => {
    expect(getConversationDisplayTitle("My Chat Title", [])).toBe(
      "My Chat Title",
    );
  });

  it("returns the title even if messages exist", () => {
    const messages = [
      {
        role: "user",
        parts: [{ type: "text", text: "Hello from message" }],
      },
    ];
    expect(getConversationDisplayTitle("Explicit Title", messages)).toBe(
      "Explicit Title",
    );
  });

  it("extracts text from first user message when no title", () => {
    const messages = [
      {
        role: "user",
        parts: [{ type: "text", text: "What is the weather?" }],
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: "The weather is sunny" }],
      },
    ];
    expect(getConversationDisplayTitle(null, messages)).toBe(
      "What is the weather?",
    );
  });

  it("skips assistant messages to find first user message", () => {
    const messages = [
      {
        role: "assistant",
        parts: [{ type: "text", text: "Welcome!" }],
      },
      {
        role: "user",
        parts: [{ type: "text", text: "User question here" }],
      },
    ];
    expect(getConversationDisplayTitle(null, messages)).toBe(
      "User question here",
    );
  });

  it("handles messages with multiple parts", () => {
    const messages = [
      {
        role: "user",
        parts: [
          { type: "image", url: "http://example.com/img.png" },
          { type: "text", text: "Describe this image" },
        ],
      },
    ];
    expect(getConversationDisplayTitle(null, messages)).toBe(
      "Describe this image",
    );
  });

  it("returns default session name when no title and no messages", () => {
    expect(getConversationDisplayTitle(null, [])).toBe(DEFAULT_SESSION_NAME);
    expect(getConversationDisplayTitle(null, undefined)).toBe(
      DEFAULT_SESSION_NAME,
    );
    expect(getConversationDisplayTitle(null)).toBe(DEFAULT_SESSION_NAME);
  });

  it("returns default session name when messages have no text parts", () => {
    const messages = [
      {
        role: "user",
        parts: [{ type: "image", url: "http://example.com/img.png" }],
      },
    ];
    expect(getConversationDisplayTitle(null, messages)).toBe(
      DEFAULT_SESSION_NAME,
    );
  });

  it("returns default session name when user message has no parts", () => {
    const messages = [
      {
        role: "user",
        parts: [],
      },
    ];
    expect(getConversationDisplayTitle(null, messages)).toBe(
      DEFAULT_SESSION_NAME,
    );
  });

  it("returns default session name when user message has undefined parts", () => {
    const messages = [
      {
        role: "user",
      },
    ];
    expect(getConversationDisplayTitle(null, messages)).toBe(
      DEFAULT_SESSION_NAME,
    );
  });
});

describe("getChatExternalAgentId", () => {
  it("returns appName suffixed with Chat", () => {
    expect(getChatExternalAgentId("Archestra")).toBe("Archestra Chat");
  });

  it("strips emoji characters (non-ISO-8859-1)", () => {
    expect(getChatExternalAgentId("My App 🚀")).toBe("My App Chat");
  });

  it("strips CJK characters", () => {
    expect(getChatExternalAgentId("应用")).toBe("Chat");
  });

  it("preserves ISO-8859-1 accented characters", () => {
    expect(getChatExternalAgentId("Café")).toBe("Café Chat");
  });

  it("handles empty appName", () => {
    expect(getChatExternalAgentId("")).toBe("Chat");
  });

  it("strips leading emoji", () => {
    expect(getChatExternalAgentId("🚀 My App")).toBe("My App Chat");
  });

  it("handles mixed ASCII and non-ISO-8859-1 characters", () => {
    expect(getChatExternalAgentId("Hello 世界 App")).toBe("Hello App Chat");
  });
});

describe("getManualCompactionSkippedMessage", () => {
  it("explains when only the current user turn is available", () => {
    expect(getManualCompactionSkippedMessage("nothing_to_compact")).toBe(
      "Only the latest user turn is available, so there is no completed earlier context to compact yet.",
    );
  });

  it("explains when the existing compaction already covers all older context", () => {
    expect(
      getManualCompactionSkippedMessage("nothing_to_compact", "existing"),
    ).toBe(
      "Conversation is already compacted; there is no new older context to compact yet.",
    );
  });

  it("explains when message ids are missing", () => {
    expect(
      getManualCompactionSkippedMessage("missing_boundary_message_id"),
    ).toBe(
      "Older context exists, but it cannot be compacted because saved message IDs are missing.",
    );
  });

  it("explains when the generated summary would not reduce context", () => {
    expect(getManualCompactionSkippedMessage("not_beneficial")).toBe(
      "Context compaction was skipped because the generated summary would not reduce context usage.",
    );
  });

  it("explains when the latest summary is already being used", () => {
    expect(getManualCompactionSkippedMessage("using_existing_summary")).toBe(
      "Conversation is already using compacted context.",
    );
  });

  it("falls back for unknown skip reasons", () => {
    expect(getManualCompactionSkippedMessage("other_reason")).toBe(
      "There is no completed earlier context to compact yet.",
    );
  });
});

describe("mergePersistedMessageMetadata", () => {
  it("adds persisted message ids to matching live messages", () => {
    const liveMessages = [
      {
        id: "live-assistant-1",
        role: "assistant",
        metadata: { source: "live" },
        parts: [{ type: "text", text: "already saved" }],
      },
    ] as UIMessage[];
    const persistedMessages = [
      {
        id: "db-assistant-1",
        role: "assistant",
        metadata: { persisted: true },
        parts: [{ type: "text", text: "already saved" }],
      },
    ] as UIMessage[];

    const mergedMessages = mergePersistedMessageMetadata({
      liveMessages,
      persistedMessages,
    });

    expect(mergedMessages).not.toBe(liveMessages);
    expect(mergedMessages[0]?.metadata).toMatchObject({
      persisted: true,
      source: "live",
      [PERSISTED_MESSAGE_ID_METADATA_KEY]: "db-assistant-1",
    });
  });

  it("returns the original array when no metadata changes are needed", () => {
    const liveMessages = [
      {
        id: "live-assistant-1",
        role: "assistant",
        metadata: {
          [PERSISTED_MESSAGE_ID_METADATA_KEY]: "db-assistant-1",
        },
        parts: [{ type: "text", text: "already saved" }],
      },
    ] as UIMessage[];

    const mergedMessages = mergePersistedMessageMetadata({
      liveMessages,
      persistedMessages: [],
    });

    expect(mergedMessages).toBe(liveMessages);
  });

  it("does not merge messages with different renderable text", () => {
    const liveMessages = [
      {
        id: "live-assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "live text" }],
      },
    ] as UIMessage[];
    const persistedMessages = [
      {
        id: "db-assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "persisted text" }],
      },
    ] as UIMessage[];

    const mergedMessages = mergePersistedMessageMetadata({
      liveMessages,
      persistedMessages,
    });

    expect(mergedMessages).toBe(liveMessages);
  });

  it("uses persisted user file URLs when renderable text matches", () => {
    const liveMessages = [
      {
        id: "live-user-1",
        role: "user",
        parts: [
          { type: "text", text: "read this" },
          {
            type: "file",
            url: "data:text/plain;base64,aGVsbG8=",
            mediaType: "text/plain",
            filename: "notes.txt",
          },
        ],
      },
    ] as UIMessage[];
    const persistedMessages = [
      {
        id: "db-user-1",
        role: "user",
        metadata: { persisted: true },
        parts: [
          { type: "text", text: "read this" },
          {
            type: "file",
            url: "/api/chat/attachments/11111111-1111-1111-1111-111111111111/content",
            mediaType: "text/plain",
            filename: "notes.txt",
          },
        ],
      },
    ] as UIMessage[];

    const mergedMessages = mergePersistedMessageMetadata({
      liveMessages,
      persistedMessages,
    });

    expect(mergedMessages[0]?.parts).toBe(persistedMessages[0]?.parts);
    expect(mergedMessages[0]?.metadata).toMatchObject({
      persisted: true,
      [PERSISTED_MESSAGE_ID_METADATA_KEY]: "db-user-1",
    });
  });

  it("refreshes persisted user file URLs when the live message already has a persisted id", () => {
    const liveMessages = [
      {
        id: "live-user-1",
        role: "user",
        metadata: {
          [PERSISTED_MESSAGE_ID_METADATA_KEY]: "db-user-1",
        },
        parts: [
          { type: "text", text: "read this" },
          {
            type: "file",
            url: "data:application/pdf;base64,JVBERi0=",
            mediaType: "application/pdf",
            filename: "sample.pdf",
          },
        ],
      },
    ] as UIMessage[];
    const persistedMessages = [
      {
        id: "db-user-1",
        role: "user",
        parts: [
          { type: "text", text: "read this" },
          {
            type: "file",
            url: "/api/chat/attachments/11111111-1111-1111-1111-111111111111/content",
            mediaType: "application/pdf",
            filename: "sample.pdf",
          },
        ],
      },
    ] as UIMessage[];

    const mergedMessages = mergePersistedMessageMetadata({
      liveMessages,
      persistedMessages,
    });

    expect(mergedMessages).not.toBe(liveMessages);
    expect(mergedMessages[0]?.parts).toBe(persistedMessages[0]?.parts);
  });
});
