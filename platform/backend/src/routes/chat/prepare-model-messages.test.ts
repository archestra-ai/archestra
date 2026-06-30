import type { ModelMessage } from "ai";
import config from "@/config";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import { expect, test } from "@/test";
import type { ChatMessage } from "@/types";
import { buildContextWindowBreakdown } from "./context-window-breakdown";
import {
  assertWithinContextWindow,
  ContextWindowExceededError,
} from "./normalization/enforce-context-window-limit";
import { __test, buildModelMessages } from "./prepare-model-messages";

function messagesSegmentTokens(
  breakdown: ReturnType<typeof buildContextWindowBreakdown>,
): number {
  return (
    breakdown.segments.find((segment) => segment.category === "messages")
      ?.tokens ?? 0
  );
}

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
    ({ modelMessages } = await __test.buildModelMessagesForProvider({
      messages,
      provider: "anthropic",
      conversationId: conversation.id,
      ingestibleMimeTypes: INGESTIBLE,
      anthropicNativeEndpoint: false,
      sandboxAvailable: false,
    }));
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
    ({ modelMessages } = await __test.buildModelMessagesForProvider({
      messages,
      provider: "anthropic",
      conversationId: conversation.id,
      ingestibleMimeTypes: INGESTIBLE,
      anthropicNativeEndpoint: true,
      sandboxAvailable: false,
    }));
  } finally {
    config.skillsSandbox.enabled = prevEnabled;
  }

  // Native path keeps the document as a file part and marks it for caching.
  expect(hasFilePart(modelMessages)).toBe(true);
  expect(anthropicCacheControlSeen(modelMessages)).toBe(true);
});

// End-to-end through the public entry point: buildModelMessages must resolve
// the agent's sandbox availability itself and thread it into materialization,
// so the sandbox pointer follows the agent — not just the global feature flag.
test("buildModelMessages emits the sandbox pointer when the agent can use the sandbox", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeCustomRole,
  makeAgent,
  makeConversation,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const role = await makeCustomRole(org.id, {
    permission: { sandbox: ["execute"] },
  });
  await makeMember(user.id, org.id, { role: role.role });
  // accessAllTools makes the sandbox usable via dynamic dispatch, so this also
  // covers the predicate's dynamic-access branch end-to-end.
  const agent = await makeAgent({
    organizationId: org.id,
    accessAllTools: true,
  });
  const conversation = await makeConversation(agent.id, {
    organizationId: org.id,
  });
  const messages = await csvRefMessage(conversation.id, user.id, org.id);

  const prevEnabled = config.skillsSandbox.enabled;
  config.skillsSandbox.enabled = true;
  let modelMessages: ModelMessage[];
  try {
    ({ modelMessages } = await buildModelMessages({
      messages,
      conversationId: conversation.id,
      organizationId: org.id,
      userId: user.id,
      agentId: agent.id,
      provider: "anthropic",
      selectedModel: "claude-test-model",
      emit: () => {},
    }));
  } finally {
    config.skillsSandbox.enabled = prevEnabled;
  }

  expect(textContent(modelMessages)).toContain("/home/sandbox/attachments");
});

test("buildModelMessages omits the sandbox pointer when the agent cannot use the sandbox", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeCustomRole,
  makeAgent,
  makeConversation,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const role = await makeCustomRole(org.id, {
    permission: { sandbox: ["execute"] },
  });
  await makeMember(user.id, org.id, { role: role.role });
  // No assigned sandbox tools and no accessAllTools: the agent can't run it,
  // even though the feature flag is on below.
  const agent = await makeAgent({ organizationId: org.id });
  const conversation = await makeConversation(agent.id, {
    organizationId: org.id,
  });
  const messages = await csvRefMessage(conversation.id, user.id, org.id);

  const prevEnabled = config.skillsSandbox.enabled;
  config.skillsSandbox.enabled = true;
  let modelMessages: ModelMessage[];
  try {
    ({ modelMessages } = await buildModelMessages({
      messages,
      conversationId: conversation.id,
      organizationId: org.id,
      userId: user.id,
      agentId: agent.id,
      provider: "anthropic",
      selectedModel: "claude-test-model",
      emit: () => {},
    }));
  } finally {
    config.skillsSandbox.enabled = prevEnabled;
  }

  expect(textContent(modelMessages)).not.toContain("/home/sandbox/attachments");
});

function inlinePdfMessage(base64Length: number): ChatMessage[] {
  return [
    {
      role: "user",
      parts: [
        { type: "text", text: "Can you read this PDF?" },
        {
          type: "file",
          url: `data:application/pdf;base64,${"A".repeat(base64Length)}`,
          mediaType: "application/pdf",
          filename: "big.pdf",
        },
      ],
    },
  ];
}

test("bedrock: an inline PDF whose payload exceeds the provider limit is rejected, reporting the decoded file size", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  // 40 MiB of base64 decodes to a ~30 MB file, over Bedrock's 20 MB cap.
  const messages = inlinePdfMessage(40 * 1024 * 1024);

  const prevEnabled = config.skillsSandbox.enabled;
  config.skillsSandbox.enabled = false;
  try {
    const error = await __test
      .buildModelMessagesForProvider({
        messages,
        provider: "bedrock",
        conversationId: conversation.id,
        sandboxAvailable: false,
      })
      .then(
        () => null,
        (e) => e,
      );
    expect(error).toBeInstanceOf(Error);
    // Reports the real decoded file size (30 MB), not the inflated ~40 MB wire size.
    expect(error.message).toMatch(/\bThis file is 30 MB\b/);
    expect(error.message).not.toMatch(/40 MB/);
    expect(error.message).toContain("AWS Bedrock");
    expect(error.message).toContain("20 MB");
    expect(error.message).toContain(
      "platform.claude.com/docs/en/api/overview#request-size-limits",
    );
  } finally {
    config.skillsSandbox.enabled = prevEnabled;
  }
});

test("bedrock: a file that rounds to the limit is not rejected", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  // base64 that decodes to ~20.25 MB — rounds to the 20 MB cap, so it must pass
  // rather than reject with a contradictory "20 MB, max 20 MB".
  const messages = inlinePdfMessage(27 * 1024 * 1024);

  const prevEnabled = config.skillsSandbox.enabled;
  config.skillsSandbox.enabled = false;
  try {
    const { modelMessages } = await __test.buildModelMessagesForProvider({
      messages,
      provider: "bedrock",
      conversationId: conversation.id,
      sandboxAvailable: false,
    });
    expect(modelMessages.length).toBeGreaterThan(0);
  } finally {
    config.skillsSandbox.enabled = prevEnabled;
  }
});

test("bedrock: a small inline PDF passes the size guard", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const messages = inlinePdfMessage(2048);

  const prevEnabled = config.skillsSandbox.enabled;
  config.skillsSandbox.enabled = false;
  try {
    const { modelMessages } = await __test.buildModelMessagesForProvider({
      messages,
      provider: "bedrock",
      conversationId: conversation.id,
      sandboxAvailable: false,
    });
    expect(modelMessages.length).toBeGreaterThan(0);
  } finally {
    config.skillsSandbox.enabled = prevEnabled;
  }
});

test("exposes prepared messages the breakdown can count (the converted modelMessages cannot)", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const messages: ChatMessage[] = [
    {
      role: "user",
      parts: [{ type: "text", text: "lorem ipsum ".repeat(50) }],
    },
  ];

  const { modelMessages, preparedMessages } = await buildModelMessages({
    messages,
    conversationId: conversation.id,
    organizationId: agent.organizationId,
    userId: conversation.userId,
    agentId: agent.id,
    provider: "openai",
    selectedModel: "gpt-4o",
    emit: () => {},
  });

  const fromPrepared = buildContextWindowBreakdown({
    provider: "openai",
    model: "gpt-4o",
    contextLength: 128_000,
    messages: preparedMessages,
  });
  const fromModelMessages = buildContextWindowBreakdown({
    provider: "openai",
    model: "gpt-4o",
    contextLength: 128_000,
    messages: modelMessages as unknown as ChatMessage[],
  });

  // The prepared (parts-bearing) messages carry the conversation tokens; the
  // converted ModelMessages have no `.parts`, so the breakdown sees none —
  // exactly the latent undercount this wiring fixes.
  expect(messagesSegmentTokens(fromPrepared)).toBeGreaterThan(0);
  expect(messagesSegmentTokens(fromModelMessages)).toBe(0);
});

test("an assembled prompt larger than the model window is rejected pre-flight", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  const messages: ChatMessage[] = [
    { role: "user", parts: [{ type: "text", text: "word ".repeat(400) }] },
  ];

  const { preparedMessages } = await buildModelMessages({
    messages,
    conversationId: conversation.id,
    organizationId: agent.organizationId,
    userId: conversation.userId,
    agentId: agent.id,
    provider: "openai",
    selectedModel: "gpt-4o",
    emit: () => {},
  });

  // Same composition routes.ts performs: build the budget from the prepared
  // messages, then gate on it. A tiny window makes the turn overflow.
  const breakdown = buildContextWindowBreakdown({
    provider: "openai",
    model: "gpt-4o",
    contextLength: 50,
    messages: preparedMessages,
  });

  expect(() => assertWithinContextWindow(breakdown)).toThrow(
    ContextWindowExceededError,
  );
});

test("an inlineable text-document attachment counts toward the context gate", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });
  // openai inlines text documents into text parts, so a large CSV becomes real
  // prompt tokens. The gate must see them in `messages`, not lose them in the
  // excluded `files` segment — the bug a pre-rewrite (materialized) view had.
  const bigCsv = `col_a,col_b,col_c\n${"1,2,3\n".repeat(2000)}`;
  const bytes = Buffer.from(bigCsv, "utf8");
  const row = await ConversationAttachmentModel.create({
    organizationId: agent.organizationId,
    conversationId: conversation.id,
    uploadedByUserId: conversation.userId,
    originalName: "big.csv",
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
          filename: "big.csv",
        },
      ],
    },
  ];

  const prevEnabled = config.skillsSandbox.enabled;
  config.skillsSandbox.enabled = false;
  let preparedMessages: ChatMessage[];
  try {
    ({ preparedMessages } = await buildModelMessages({
      messages,
      conversationId: conversation.id,
      organizationId: agent.organizationId,
      userId: conversation.userId,
      agentId: agent.id,
      provider: "openai",
      selectedModel: "gpt-4o",
      emit: () => {},
    }));
  } finally {
    config.skillsSandbox.enabled = prevEnabled;
  }

  const breakdown = buildContextWindowBreakdown({
    provider: "openai",
    model: "gpt-4o",
    contextLength: 50,
    messages: preparedMessages,
  });

  expect(() => assertWithinContextWindow(breakdown)).toThrow(
    ContextWindowExceededError,
  );
});
