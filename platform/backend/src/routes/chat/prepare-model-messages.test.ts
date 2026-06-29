import type { ModelMessage } from "ai";
import config from "@/config";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import { expect, test } from "@/test";
import type { ChatMessage } from "@/types";
import { __test } from "./prepare-model-messages";

const CSV = "a,b,c\n1,2,3";
const INGESTIBLE = new Set(["text/csv"]);

async function csvRefMessage(
  conversationId: string,
  userId: string,
  organizationId: string,
) {
  const bytes = Buffer.from(CSV, "utf8");
  const row = await ConversationAttachmentModel.create({
    organizationId,
    conversationId,
    uploadedByUserId: userId,
    originalName: "data.csv",
    mimeType: "text/csv",
    fileSize: bytes.byteLength,
    contentHash: ConversationAttachmentModel.computeContentHash(bytes),
    fileData: bytes,
  });
  const messages: ChatMessage[] = [
    {
      role: "user",
      parts: [
        { type: "text", text: "summarize" },
        {
          type: "file",
          url: `/api/chat/attachments/${row.id}/content`,
          mediaType: "text/csv",
          filename: "data.csv",
        },
      ],
    },
  ];
  return messages;
}

function anthropicCacheControlSeen(messages: ModelMessage[]): boolean {
  return messages.some((m) => {
    const onMessage = (
      m.providerOptions as
        | { anthropic?: { cacheControl?: unknown } }
        | undefined
    )?.anthropic?.cacheControl;
    if (onMessage) return true;
    if (!Array.isArray(m.content)) return false;
    return m.content.some((part) => {
      const opts = (
        part as { providerOptions?: { anthropic?: { cacheControl?: unknown } } }
      ).providerOptions;
      return Boolean(opts?.anthropic?.cacheControl);
    });
  });
}

function textContent(messages: ModelMessage[]): string {
  return messages
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as unknown[]) : []))
    .filter((p) => (p as { type?: string }).type === "text")
    .map((p) => (p as { text?: string }).text ?? "")
    .join("\n");
}

function hasFilePart(messages: ModelMessage[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((p) => (p as { type?: string }).type === "file"),
  );
}

test("anthropic non-native endpoint: bytes inlined as text, no cache_control, no sandbox pointer", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const messages = await csvRefMessage(
    conversation.id,
    conversation.userId,
    conversation.organizationId,
  );

  const prevEnabled = config.skillsSandbox.enabled;
  config.skillsSandbox.enabled = false;
  let modelMessages: ModelMessage[];
  try {
    modelMessages = await __test.buildModelMessagesForProvider({
      messages,
      provider: "anthropic",
      conversationId: conversation.id,
      ingestibleMimeTypes: INGESTIBLE,
      anthropicNativeEndpoint: false,
    });
  } finally {
    config.skillsSandbox.enabled = prevEnabled;
  }

  // data: bytes are decoded into the message (not dropped, not a document block).
  expect(textContent(modelMessages)).toContain(CSV);
  expect(hasFilePart(modelMessages)).toBe(false);
  // No Anthropic-only cache_control marker reaches the compatible endpoint.
  expect(anthropicCacheControlSeen(modelMessages)).toBe(false);
  // No sandbox pointer (sandbox disabled, ingestible inline path).
  expect(textContent(modelMessages)).not.toContain("/home/sandbox");
});

test("native Anthropic (default flag): document file part survives with cache_control", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const messages = await csvRefMessage(
    conversation.id,
    conversation.userId,
    conversation.organizationId,
  );

  const prevEnabled = config.skillsSandbox.enabled;
  config.skillsSandbox.enabled = false;
  let modelMessages: ModelMessage[];
  try {
    modelMessages = await __test.buildModelMessagesForProvider({
      messages,
      provider: "anthropic",
      conversationId: conversation.id,
      ingestibleMimeTypes: INGESTIBLE,
      anthropicNativeEndpoint: true,
    });
  } finally {
    config.skillsSandbox.enabled = prevEnabled;
  }

  // Native path keeps the document as a file part and marks it for caching.
  expect(hasFilePart(modelMessages)).toBe(true);
  expect(anthropicCacheControlSeen(modelMessages)).toBe(true);
});
