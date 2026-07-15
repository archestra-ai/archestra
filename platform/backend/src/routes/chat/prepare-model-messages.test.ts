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

const RENDER_APP_APP_ID = "402e041f-a78c-40a0-b8b3-a14d91633fce";

// Mirrors an owned-app chat seeded by createSeededAppConversation: the first
// message is a synthetic render_app assistant tool-call, followed by the user's
// first real prompt.
function renderAppSeedMessages(): ChatMessage[] {
  return [
    {
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "archestra__render_app",
          toolCallId: "call_render_1",
          state: "output-available",
          input: { appId: RENDER_APP_APP_ID },
          output: { content: [{ type: "text", text: "app rendered" }] },
        },
      ],
    },
    {
      role: "user",
      parts: [{ type: "text", text: "make a simple shopping list app" }],
    },
  ] as unknown as ChatMessage[];
}

function firstToolCall(
  messages: ModelMessage[],
): { toolName?: string; input?: unknown } | undefined {
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if ((part as { type?: string }).type === "tool-call") {
        return part as { toolName?: string; input?: unknown };
      }
    }
  }
  return undefined;
}

test("gemini: render_app-seeded history gets a leading user turn so contents don't open with a functionCall", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });

  const { modelMessages } = await __test.buildModelMessagesForProvider({
    messages: renderAppSeedMessages(),
    provider: "gemini",
    conversationId: conversation.id,
    sandboxAvailable: false,
  });

  // The whole sequence must map to valid Gemini contents: a leading user turn,
  // then the seed's functionCall (assistant) immediately paired with its
  // functionResponse (tool), then the real user prompt — i.e.
  // user -> model(functionCall) -> user(functionResponse) -> user(text). Pin the
  // full order so a regression that strands the functionCall (Gemini 400) is
  // caught here, not only in an end-to-end call.
  expect(modelMessages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "user",
  ]);
  // The functionCall/functionResponse pair references the same seeded tool call.
  const toolCall = firstToolCall(modelMessages);
  expect(toolCall?.toolName).toBe("archestra__render_app");
  // The render_app seed is preserved (not dropped) — its tool result carries the
  // app id the app tools require to edit the bound app.
  expect(JSON.stringify(toolCall?.input)).toContain(RENDER_APP_APP_ID);
});

test("openai: render_app-seeded history keeps the assistant tool-call first (openai accepts an assistant-first turn, so no leading user turn is injected)", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });

  const { modelMessages } = await __test.buildModelMessagesForProvider({
    messages: renderAppSeedMessages(),
    provider: "openai",
    conversationId: conversation.id,
    sandboxAvailable: false,
  });

  expect(modelMessages[0]?.role).toBe("assistant");
});

test("bedrock: render_app-seeded history gets a leading user turn so the assistant tool_use isn't rejected", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });

  // Real owned-app seed shape: render_app assistant tool-call, a separate
  // greeting assistant message, then the user's first prompt.
  const messages: ChatMessage[] = [
    {
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "archestra__render_app",
          toolCallId: "call_render_1",
          state: "output-available",
          input: { appId: RENDER_APP_APP_ID },
          output: { content: [{ type: "text", text: "app rendered" }] },
        },
      ],
    },
    { role: "assistant", parts: [{ type: "text", text: "Here's the app." }] },
    { role: "user", parts: [{ type: "text", text: "can I ask you things?" }] },
  ] as unknown as ChatMessage[];

  const { modelMessages } = await __test.buildModelMessagesForProvider({
    messages,
    provider: "bedrock",
    conversationId: conversation.id,
    sandboxAvailable: false,
  });

  // Bedrock's Converse API rejects a history that opens with an assistant
  // tool_use ("`tool_use` ids were found without `tool_result` blocks
  // immediately after"). Pin the full well-formed order: a leading user turn,
  // the seed's tool-call immediately paired with its tool-result, the greeting,
  // then the real prompt.
  expect(modelMessages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "assistant",
    "user",
  ]);

  // The render_app seed is preserved (its result carries the app id app tools
  // need), and the tool-call assistant message is NOT polluted with a bogus
  // "(no content)" placeholder.
  const toolCall = firstToolCall(modelMessages);
  expect(toolCall?.toolName).toBe("archestra__render_app");
  expect(JSON.stringify(toolCall?.input)).toContain(RENDER_APP_APP_ID);
  const toolCallMessage = modelMessages[1];
  expect(Array.isArray(toolCallMessage.content)).toBe(true);
  expect(
    (toolCallMessage.content as { type: string; text?: string }[]).some(
      (part) => part.type === "text" && part.text === "(no content)",
    ),
  ).toBe(false);
});

test("gemini: a normal user-first history is left unchanged (no synthetic turn added)", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });

  const messages: ChatMessage[] = [
    { role: "user", parts: [{ type: "text", text: "hello" }] },
  ] as unknown as ChatMessage[];

  const { modelMessages } = await __test.buildModelMessagesForProvider({
    messages,
    provider: "gemini",
    conversationId: conversation.id,
    sandboxAvailable: false,
  });

  expect(modelMessages).toHaveLength(1);
  expect(modelMessages[0]?.role).toBe("user");
});

test("synthesizes an interrupted tool result for a tool call parked at approval-requested", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });

  // The user never resolved the approval and sent a new message instead. On
  // replay the pending call converts to a tool-call with no tool-result, which
  // providers reject — permanently breaking the conversation.
  const messages: ChatMessage[] = [
    { role: "user", parts: [{ type: "text", text: "delete the file" }] },
    {
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "filesystem__delete",
          toolCallId: "call-pending-approval",
          state: "approval-requested",
          input: { path: "/tmp/x" },
          approval: { id: "approval-1" },
        },
      ],
    },
    {
      role: "user",
      parts: [{ type: "text", text: "never mind, what is 2+2?" }],
    },
  ] as unknown as ChatMessage[];

  const { modelMessages } = await __test.buildModelMessagesForProvider({
    messages,
    provider: "anthropic",
    conversationId: conversation.id,
    sandboxAvailable: false,
  });

  const assistantIndex = modelMessages.findIndex(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.content) &&
      m.content.some((p) => (p as { type?: string }).type === "tool-call"),
  );
  expect(assistantIndex).toBeGreaterThanOrEqual(0);

  // The synthetic result must directly follow the assistant tool-call turn.
  const toolMessage = modelMessages[assistantIndex + 1];
  expect(toolMessage?.role).toBe("tool");
  const results = (toolMessage?.content ?? []) as Array<{
    type: string;
    toolCallId: string;
    output: { type: string; value: string };
  }>;
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    type: "tool-result",
    toolCallId: "call-pending-approval",
    output: { type: "error-text" },
  });
  expect(results[0].output.value).toContain("interrupted");
});

test("does NOT synthesize an interrupted result for an approved tool call (the SDK executes it on resume)", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });

  // Resume turn: the model called a tool that needs approval and the user
  // approved it. The tool has not executed yet — the AI SDK executes an
  // approved call itself on this request, but only when no tool-result exists
  // for the call. Fabricating an "interrupted" result here strands the approval
  // and the tool silently never runs.
  const messages: ChatMessage[] = [
    { role: "user", parts: [{ type: "text", text: "delete the file" }] },
    {
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "filesystem__delete",
          toolCallId: "call-approved",
          state: "approval-responded",
          input: { path: "/tmp/x" },
          approval: { id: "approval-1", approved: true },
        },
      ],
    },
  ] as unknown as ChatMessage[];

  const { modelMessages } = await __test.buildModelMessagesForProvider({
    messages,
    provider: "anthropic",
    conversationId: conversation.id,
    sandboxAvailable: false,
  });

  // Sanity: the approval-response the SDK needs to resume execution is present.
  const approvalResponses = modelMessages
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as unknown[]) : []))
    .filter((p) => (p as { type?: string }).type === "tool-approval-response");
  expect(approvalResponses).toHaveLength(1);

  // The exclusion maps approvalId -> toolCallId via the assistant's
  // tool-approval-request part. convertToModelMessages (not the internal
  // language-model converter that strips them later) emits it into the
  // assistant content; if a future SDK stopped doing so the exclusion would
  // silently break and drop the approved call again.
  const approvalRequests = modelMessages
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as unknown[]) : []))
    .filter((p) => (p as { type?: string }).type === "tool-approval-request");
  expect(approvalRequests).toHaveLength(1);

  // The approved tool-call itself must survive — it is what the SDK executes on
  // resume. A regression that dropped it entirely would also produce no
  // fabricated result, so assert its presence, not just the absence below.
  const approvedToolCall = modelMessages
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as unknown[]) : []))
    .find(
      (p) =>
        (p as { type?: string }).type === "tool-call" &&
        (p as { toolCallId?: string }).toolCallId === "call-approved",
    );
  expect(approvedToolCall).toBeDefined();

  // The bug: a synthetic error-text tool-result is fabricated for the approved
  // call, so the SDK's collectToolApprovals skips executing it.
  const fabricated = modelMessages
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as unknown[]) : []))
    .find(
      (p) =>
        (p as { type?: string }).type === "tool-result" &&
        (p as { toolCallId?: string }).toolCallId === "call-approved",
    );
  expect(fabricated).toBeUndefined();
});

test("does NOT synthesize an interrupted result for a declined tool call (the SDK denies it on resume)", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });

  // The user declined the approval. Like an approved call, the SDK's
  // approval-resume owns the outcome — it produces the denial itself — so the
  // call must be left result-less; a synthetic "interrupted" result would
  // pre-empt that and the model would see the wrong reason.
  const messages: ChatMessage[] = [
    { role: "user", parts: [{ type: "text", text: "delete the file" }] },
    {
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "filesystem__delete",
          toolCallId: "call-declined",
          state: "approval-responded",
          input: { path: "/tmp/x" },
          approval: { id: "approval-1", approved: false },
        },
      ],
    },
  ] as unknown as ChatMessage[];

  const { modelMessages } = await __test.buildModelMessagesForProvider({
    messages,
    provider: "anthropic",
    conversationId: conversation.id,
    sandboxAvailable: false,
  });

  const fabricated = modelMessages
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as unknown[]) : []))
    .find(
      (p) =>
        (p as { type?: string }).type === "tool-result" &&
        (p as { toolCallId?: string }).toolCallId === "call-declined",
    );
  expect(fabricated).toBeUndefined();
});

test("excludes every approved call when a turn carries multiple approvals", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });

  // The model requested two tools in one turn and the user approved both. The
  // exclusion must apply per-call, not just to the first, so neither approved
  // call is stranded with a synthetic result.
  const messages: ChatMessage[] = [
    { role: "user", parts: [{ type: "text", text: "do both" }] },
    {
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "tool_a",
          toolCallId: "call-a",
          state: "approval-responded",
          input: {},
          approval: { id: "approval-a", approved: true },
        },
        {
          type: "dynamic-tool",
          toolName: "tool_b",
          toolCallId: "call-b",
          state: "approval-responded",
          input: {},
          approval: { id: "approval-b", approved: true },
        },
      ],
    },
  ] as unknown as ChatMessage[];

  const { modelMessages } = await __test.buildModelMessagesForProvider({
    messages,
    provider: "anthropic",
    conversationId: conversation.id,
    sandboxAvailable: false,
  });

  const toolResults = modelMessages
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as unknown[]) : []))
    .filter((p) => (p as { type?: string }).type === "tool-result");
  expect(toolResults).toHaveLength(0);

  // Both approved calls must survive for the SDK to execute — dropping one would
  // also leave zero fabricated results, so assert presence explicitly.
  const survivingToolCallIds = modelMessages
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as unknown[]) : []))
    .filter((p) => (p as { type?: string }).type === "tool-call")
    .map((p) => (p as { toolCallId?: string }).toolCallId);
  expect(survivingToolCallIds).toEqual(
    expect.arrayContaining(["call-a", "call-b"]),
  );
});

test("merges synthetic results into an existing tool message when only some calls resolved", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });

  const messages: ChatMessage[] = [
    { role: "user", parts: [{ type: "text", text: "do both things" }] },
    {
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "tool_a",
          toolCallId: "call-finished",
          state: "output-available",
          input: {},
          output: { ok: true },
        },
        {
          type: "dynamic-tool",
          toolName: "tool_b",
          toolCallId: "call-unanswered",
          state: "approval-requested",
          input: {},
          approval: { id: "approval-2" },
        },
      ],
    },
    { role: "user", parts: [{ type: "text", text: "continue" }] },
  ] as unknown as ChatMessage[];

  const { modelMessages } = await __test.buildModelMessagesForProvider({
    messages,
    provider: "anthropic",
    conversationId: conversation.id,
    sandboxAvailable: false,
  });

  const toolMessages = modelMessages.filter((m) => m.role === "tool");
  expect(toolMessages).toHaveLength(1);
  const resultIds = (
    toolMessages[0].content as Array<{ type: string; toolCallId: string }>
  )
    .filter((p) => p.type === "tool-result")
    .map((p) => p.toolCallId);
  expect(resultIds).toEqual(
    expect.arrayContaining(["call-finished", "call-unanswered"]),
  );
});

test("leaves a fully-answered tool call history untouched", async ({
  makeAgent,
  makeConversation,
}) => {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id, {
    organizationId: agent.organizationId,
  });

  const messages: ChatMessage[] = [
    { role: "user", parts: [{ type: "text", text: "list files" }] },
    {
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "filesystem__list",
          toolCallId: "call-ok",
          state: "output-available",
          input: {},
          output: { files: [] },
        },
        { type: "text", text: "Done." },
      ],
    },
  ] as unknown as ChatMessage[];

  const { modelMessages } = await __test.buildModelMessagesForProvider({
    messages,
    provider: "anthropic",
    conversationId: conversation.id,
    sandboxAvailable: false,
  });

  const toolMessages = modelMessages.filter((m) => m.role === "tool");
  expect(toolMessages).toHaveLength(1);
  const results = toolMessages[0].content as Array<{
    type: string;
    toolCallId: string;
    output: { type: string };
  }>;
  expect(results).toHaveLength(1);
  expect(results[0].output.type).not.toBe("error-text");
});
