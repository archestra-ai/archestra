import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import {
  applyFeedbackToMessages,
  applyTextEditToMessages,
  chatDraftStorageKey,
  conversationStorageKeys,
  getChatExternalAgentId,
  getConversationDisplayTitle,
  getManualCompactionSkippedMessage,
  getMessageFeedback,
  mergePersistedMessageMetadata,
  migrateLegacyNewChatDraft,
  NEW_CHAT_DRAFT_STORAGE_KEY,
  PERSISTED_MESSAGE_ID_METADATA_KEY,
  resolveCanonicalMessageId,
} from "./chat-utils";

/** Minimal in-memory localStorage stand-in for the draft migration tests. */
function makeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    snapshot: () => Object.fromEntries(map),
  };
}

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

  // Regression: during rapid queue drain the persisted snapshot trails the live
  // thread, so the just-sent user turn (and its streaming reply) are not in it
  // yet. The merge must keep every live message — it feeds setMessages, so
  // dropping the unpersisted tail here would erase the in-flight user bubble
  // from the thread until a reload.
  it("preserves the in-flight tail when the live thread is longer than persisted", () => {
    const liveMessages = [
      {
        id: "live-user-1",
        role: "user",
        parts: [{ type: "text", text: "first" }],
      },
      {
        id: "live-assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "reply" }],
      },
      // in-flight turn the backend has not persisted yet
      {
        id: "live-user-2",
        role: "user",
        parts: [{ type: "text", text: "second" }],
      },
      {
        id: "live-assistant-2",
        role: "assistant",
        parts: [{ type: "text", text: "streaming…" }],
      },
    ] as UIMessage[];
    const persistedMessages = [
      {
        id: "db-user-1",
        role: "user",
        parts: [{ type: "text", text: "first" }],
      },
      {
        id: "db-assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "reply" }],
      },
    ] as UIMessage[];

    const mergedMessages = mergePersistedMessageMetadata({
      liveMessages,
      persistedMessages,
    });

    expect(mergedMessages.map((message) => message.id)).toEqual([
      "live-user-1",
      "live-assistant-1",
      "live-user-2",
      "live-assistant-2",
    ]);
    // the unpersisted in-flight user turn keeps its text
    expect(mergedMessages[2]?.parts).toEqual([
      { type: "text", text: "second" },
    ]);
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

  const hookRunPart = (fileName: string) => ({
    type: "data-hook-run",
    data: {
      hookEventName: "PreToolUse",
      fileName,
      outcome: "proceed",
      exitCode: 0,
    },
  });

  it("splices persisted hook-run parts into the live message at their persisted slot", () => {
    const liveMessages = [
      {
        id: "live-assistant-1",
        role: "assistant",
        parts: [
          { type: "text", text: "running the tool" },
          {
            type: "tool-run_command",
            toolCallId: "tc-1",
            state: "output-available",
          },
        ],
      },
    ] as UIMessage[];
    const persistedMessages = [
      {
        id: "db-assistant-1",
        role: "assistant",
        parts: [
          { type: "text", text: "running the tool" },
          hookRunPart("guard.py"),
          {
            type: "tool-run_command",
            toolCallId: "tc-1",
            state: "output-available",
          },
          hookRunPart("audit.py"),
        ],
      },
    ] as UIMessage[];

    const mergedMessages = mergePersistedMessageMetadata({
      liveMessages,
      persistedMessages,
    });

    expect(mergedMessages[0]?.parts.map((part) => part.type)).toEqual([
      "text",
      "data-hook-run",
      "tool-run_command",
      "data-hook-run",
    ]);
  });

  it("strips live hook-run parts the server no longer returns", () => {
    const liveMessages = [
      {
        id: "live-assistant-1",
        role: "assistant",
        metadata: {
          [PERSISTED_MESSAGE_ID_METADATA_KEY]: "db-assistant-1",
        },
        parts: [
          hookRunPart("guard.py"),
          { type: "text", text: "already saved" },
        ],
      },
    ] as UIMessage[];
    const persistedMessages = [
      {
        id: "db-assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "already saved" }],
      },
    ] as UIMessage[];

    const mergedMessages = mergePersistedMessageMetadata({
      liveMessages,
      persistedMessages,
    });

    expect(mergedMessages[0]?.parts.map((part) => part.type)).toEqual(["text"]);
  });

  it("returns the original array when live hook-run parts already match", () => {
    const parts = [
      hookRunPart("guard.py"),
      { type: "text", text: "already saved" },
    ];
    const liveMessages = [
      {
        id: "live-assistant-1",
        role: "assistant",
        metadata: {
          [PERSISTED_MESSAGE_ID_METADATA_KEY]: "db-assistant-1",
        },
        parts,
      },
    ] as UIMessage[];
    // structurally equal but different object identities, like a refetch
    const persistedMessages = [
      {
        id: "db-assistant-1",
        role: "assistant",
        parts: structuredClone(parts),
      },
    ] as UIMessage[];

    const mergedMessages = mergePersistedMessageMetadata({
      liveMessages,
      persistedMessages,
    });

    expect(mergedMessages).toBe(liveMessages);
  });

  it("keeps live hook-run parts when stripping would leave nothing renderable", () => {
    const liveMessages = [
      {
        id: "live-assistant-1",
        role: "assistant",
        metadata: {
          [PERSISTED_MESSAGE_ID_METADATA_KEY]: "db-assistant-1",
        },
        parts: [{ type: "step-start" }, hookRunPart("guard.py")],
      },
    ] as UIMessage[];
    const persistedMessages = [
      {
        id: "db-assistant-1",
        role: "assistant",
        parts: [{ type: "step-start" }],
      },
    ] as UIMessage[];

    const mergedMessages = mergePersistedMessageMetadata({
      liveMessages,
      persistedMessages,
    });

    expect(mergedMessages[0]?.parts).toBe(liveMessages[0]?.parts);
  });
});

describe("resolveCanonicalMessageId", () => {
  const liveMessages = [
    {
      id: "nanoid-user-1",
      role: "user",
      metadata: { [PERSISTED_MESSAGE_ID_METADATA_KEY]: "db-user-1" },
      parts: [{ type: "text", text: "edited prompt" }],
    },
  ] as UIMessage[];

  it("returns the message id when the saved thread already contains it", () => {
    expect(
      resolveCanonicalMessageId({
        messageId: "db-user-1",
        liveMessages: [],
        canonicalMessages: [
          { id: "db-user-1", role: "user", parts: [] },
        ] as UIMessage[],
      }),
    ).toBe("db-user-1");
  });

  it("maps an in-session nanoid to its DB id via persisted metadata", () => {
    expect(
      resolveCanonicalMessageId({
        messageId: "nanoid-user-1",
        liveMessages,
        canonicalMessages: [
          { id: "db-user-1", role: "user", parts: [] },
        ] as UIMessage[],
      }),
    ).toBe("db-user-1");
  });

  it("returns null when the live message has no mapping into the saved thread", () => {
    expect(
      resolveCanonicalMessageId({
        messageId: "nanoid-user-1",
        liveMessages: [
          { id: "nanoid-user-1", role: "user", parts: [] },
        ] as UIMessage[],
        canonicalMessages: [
          { id: "db-user-other", role: "user", parts: [] },
        ] as UIMessage[],
      }),
    ).toBeNull();
  });

  it("returns null when the saved thread is missing", () => {
    expect(
      resolveCanonicalMessageId({
        messageId: "nanoid-user-1",
        liveMessages,
        canonicalMessages: undefined,
      }),
    ).toBeNull();
  });
});

describe("applyTextEditToMessages", () => {
  it("replaces only the targeted text part and keeps other messages untouched", () => {
    const messages = [
      {
        id: "user-1",
        role: "user",
        parts: [
          { type: "file", url: "blob:a", mediaType: "image/png" },
          { type: "text", text: "old text" },
        ],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "answer" }],
      },
    ] as UIMessage[];

    const updated = applyTextEditToMessages({
      messages,
      messageId: "user-1",
      partIndex: 1,
      text: "new text",
    });

    expect(updated[0]?.parts[1]).toMatchObject({
      type: "text",
      text: "new text",
    });
    expect(updated[0]?.parts[0]).toBe(messages[0]?.parts[0]);
    expect(updated[1]).toBe(messages[1]);
  });

  it("does not touch a part whose index matches but is not text", () => {
    const messages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "file", url: "blob:a", mediaType: "image/png" }],
      },
    ] as UIMessage[];

    const updated = applyTextEditToMessages({
      messages,
      messageId: "user-1",
      partIndex: 0,
      text: "new text",
    });

    expect(updated[0]?.parts[0]).toBe(messages[0]?.parts[0]);
  });
});

describe("message feedback helpers", () => {
  const makeAssistantMessage = (metadata?: Record<string, unknown>) =>
    ({
      id: "assistant-1",
      role: "assistant",
      metadata,
      parts: [{ type: "text", text: "answer" }],
    }) as UIMessage;

  it("getMessageFeedback reads only valid verdicts", () => {
    expect(getMessageFeedback(makeAssistantMessage({ feedback: "up" }))).toBe(
      "up",
    );
    expect(getMessageFeedback(makeAssistantMessage({ feedback: "down" }))).toBe(
      "down",
    );
    expect(getMessageFeedback(makeAssistantMessage())).toBeNull();
    expect(
      getMessageFeedback(makeAssistantMessage({ feedback: "sideways" })),
    ).toBeNull();
    expect(getMessageFeedback(undefined)).toBeNull();
  });

  it("applyFeedbackToMessages sets the target and leaves other messages untouched", () => {
    const other = makeAssistantMessage();
    const messages = [
      { ...makeAssistantMessage({ skill: { name: "s" } }), id: "target" },
      other,
    ] as UIMessage[];

    const updated = applyFeedbackToMessages({
      messages,
      messageId: "target",
      feedback: "up",
    });

    expect(getMessageFeedback(updated[0])).toBe("up");
    // Unrelated metadata survives the patch
    expect(updated[0]?.metadata).toMatchObject({ skill: { name: "s" } });
    expect(updated[1]).toBe(other);
  });

  it("applyFeedbackToMessages clears with null (round-trips through apply/rollback)", () => {
    const messages = [makeAssistantMessage({ feedback: "up" })];

    const cleared = applyFeedbackToMessages({
      messages,
      messageId: "assistant-1",
      feedback: null,
    });
    expect(getMessageFeedback(cleared[0])).toBeNull();

    const restored = applyFeedbackToMessages({
      messages: cleared,
      messageId: "assistant-1",
      feedback: "up",
    });
    expect(getMessageFeedback(restored[0])).toBe("up");
  });
});

describe("conversationStorageKeys", () => {
  it("returns conversation-scoped right-panel open + tab keys", () => {
    const keys = conversationStorageKeys("conv-123");
    expect(keys.rightPanelOpen).toBe(
      "archestra-chat-right-panel-open-conv-123",
    );
    expect(keys.rightPanelTab).toBe("archestra-chat-right-panel-tab-conv-123");
  });
});

describe("chatDraftStorageKey", () => {
  it("returns the conversation-scoped draft key for an existing conversation", () => {
    expect(chatDraftStorageKey("conv-123")).toBe(
      conversationStorageKeys("conv-123").draft,
    );
  });

  it("returns the shared new-chat key when there is no conversation", () => {
    expect(chatDraftStorageKey(undefined)).toBe(NEW_CHAT_DRAFT_STORAGE_KEY);
    expect(chatDraftStorageKey(null)).toBe(NEW_CHAT_DRAFT_STORAGE_KEY);
  });

  it("does not vary the new-chat key by agent so a typed prompt survives an agent switch", () => {
    // Regression guard: the draft key must be agent-independent. Previously it
    // embedded the agentId, so switching agents re-keyed the draft and the
    // restore effect cleared the user's in-progress prompt.
    const keyForAgentA = chatDraftStorageKey(undefined);
    const keyForAgentB = chatDraftStorageKey(undefined);
    expect(keyForAgentA).toBe(keyForAgentB);
  });
});

describe("migrateLegacyNewChatDraft", () => {
  it("adopts a pre-upgrade per-agent draft into the shared key, then clears legacy keys", () => {
    const storage = makeStorage({
      [`${NEW_CHAT_DRAFT_STORAGE_KEY}_agent-1`]: "draft I was typing",
    });

    migrateLegacyNewChatDraft(storage);

    expect(storage.snapshot()).toEqual({
      [NEW_CHAT_DRAFT_STORAGE_KEY]: "draft I was typing",
    });
  });

  it("does not overwrite an existing shared draft, but still cleans up legacy keys", () => {
    const storage = makeStorage({
      [NEW_CHAT_DRAFT_STORAGE_KEY]: "current draft",
      [`${NEW_CHAT_DRAFT_STORAGE_KEY}_agent-1`]: "stale legacy draft",
    });

    migrateLegacyNewChatDraft(storage);

    expect(storage.snapshot()).toEqual({
      [NEW_CHAT_DRAFT_STORAGE_KEY]: "current draft",
    });
  });

  it("leaves unrelated keys untouched and is a no-op without legacy keys", () => {
    const storage = makeStorage({
      [conversationStorageKeys("conv-1").draft]: "a saved conversation draft",
      "some-other-key": "value",
    });

    migrateLegacyNewChatDraft(storage);

    expect(storage.snapshot()).toEqual({
      [conversationStorageKeys("conv-1").draft]: "a saved conversation draft",
      "some-other-key": "value",
    });
  });

  it("is idempotent: a second run finds nothing left to migrate", () => {
    const storage = makeStorage({
      [`${NEW_CHAT_DRAFT_STORAGE_KEY}_agent-1`]: "draft",
    });

    migrateLegacyNewChatDraft(storage);
    const afterFirst = storage.snapshot();
    migrateLegacyNewChatDraft(storage);

    expect(storage.snapshot()).toEqual(afterFirst);
    expect(storage.snapshot()).toEqual({
      [NEW_CHAT_DRAFT_STORAGE_KEY]: "draft",
    });
  });
});
