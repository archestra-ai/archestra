import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import { prepareMessagesForProvider } from "./prepare-for-provider";

const CSV = "a,b,c\n1,2,3";

function csvAttachmentMessage(): ChatMessage {
  return {
    role: "user",
    parts: [
      { type: "text", text: "summarize" },
      {
        type: "file",
        url: `data:text/csv;base64,${Buffer.from(CSV, "utf8").toString("base64")}`,
        mediaType: "text/csv",
        filename: "data.csv",
      },
    ],
  };
}

const YAML = "name: archestra\nversion: 1";

function yamlAttachmentMessage(): ChatMessage {
  return {
    role: "user",
    parts: [
      { type: "text", text: "summarize" },
      {
        type: "file",
        url: `data:application/x-yaml;base64,${Buffer.from(YAML, "utf8").toString("base64")}`,
        mediaType: "application/x-yaml",
        filename: "config.yaml",
      },
    ],
  };
}

describe("prepareMessagesForProvider — anthropic endpoint branch", () => {
  it("native Anthropic keeps the document file part (rewritten to text/plain)", () => {
    const [message] = prepareMessagesForProvider({
      messages: [csvAttachmentMessage()],
      provider: "anthropic",
      anthropicNativeEndpoint: true,
    });

    const filePart = message.parts?.find((p) => p.type === "file");
    expect(filePart).toBeDefined();
    // Anthropic's SDK base64-decodes a text/plain document natively.
    expect(filePart?.mediaType).toBe("text/plain");
    // No text part inlining the content — it travels as a document block.
    const textParts = message.parts?.filter((p) => p.type === "text") ?? [];
    expect(textParts).toHaveLength(1);
    expect(textParts[0].text).toBe("summarize");
  });

  it("Anthropic-compatible endpoint inlines the document as decoded text (data not dropped)", () => {
    const [message] = prepareMessagesForProvider({
      messages: [csvAttachmentMessage()],
      provider: "anthropic",
      anthropicNativeEndpoint: false,
    });

    // The file part is gone — replaced by a text part carrying the decoded CSV,
    // so no native `document` block reaches the compatible upstream and the
    // bytes are preserved (decoded), not dropped.
    expect(message.parts?.some((p) => p.type === "file")).toBe(false);
    const inlined = message.parts?.find(
      (p) => p.type === "text" && p.text?.includes(CSV),
    );
    expect(inlined).toBeDefined();
  });

  it("defaults to native behavior when the flag is omitted", () => {
    const [message] = prepareMessagesForProvider({
      messages: [csvAttachmentMessage()],
      provider: "anthropic",
    });
    expect(message.parts?.find((p) => p.type === "file")?.mediaType).toBe(
      "text/plain",
    );
  });

  it("rewrites a broadened text type (YAML) to a text/plain document block", () => {
    const [message] = prepareMessagesForProvider({
      messages: [yamlAttachmentMessage()],
      provider: "anthropic",
      anthropicNativeEndpoint: true,
    });
    expect(message.parts?.find((p) => p.type === "file")?.mediaType).toBe(
      "text/plain",
    );
  });
});

describe("prepareMessagesForProvider — generic and gemini providers", () => {
  it("inlines a broadened text type (YAML) as decoded text for a generic provider", () => {
    const [message] = prepareMessagesForProvider({
      messages: [yamlAttachmentMessage()],
      provider: "openai",
    });
    expect(message.parts?.some((p) => p.type === "file")).toBe(false);
    const inlined = message.parts?.find(
      (p) => p.type === "text" && p.text?.includes(YAML),
    );
    expect(inlined).toBeDefined();
  });

  it("inlines text documents as decoded text for gemini instead of passing them through as inlineData", () => {
    const [message] = prepareMessagesForProvider({
      messages: [csvAttachmentMessage()],
      provider: "gemini",
    });
    expect(message.parts?.some((p) => p.type === "file")).toBe(false);
    const inlined = message.parts?.find(
      (p) => p.type === "text" && p.text?.includes(CSV),
    );
    expect(inlined).toBeDefined();
  });

  it("normalizes a broadened text type (YAML) to a text/plain document block for bedrock", () => {
    const [message] = prepareMessagesForProvider({
      messages: [yamlAttachmentMessage()],
      provider: "bedrock",
    });
    // Bedrock has no native YAML document format, so it travels as a
    // text/plain document block the SDK can relay.
    expect(message.parts?.find((p) => p.type === "file")?.mediaType).toBe(
      "text/plain",
    );
  });
});

describe("prepareMessagesForProvider — tool-call id sanitization", () => {
  function toolConversation(toolCallId: string): ChatMessage[] {
    return [
      { role: "user", parts: [{ type: "text", text: "look this up" }] },
      {
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "search",
            toolCallId,
            state: "output-available",
            input: { q: "x" },
            output: { hits: 1 },
          },
        ],
      },
    ];
  }

  function extractToolCallId(messages: ChatMessage[]): string | undefined {
    return messages[1].parts?.[0]?.toolCallId as string | undefined;
  }

  it.each([
    "anthropic",
    "bedrock",
  ] as const)("%s: rewrites a foreign tool id into the accepted character set, deterministically", (provider) => {
    const prepare = () =>
      extractToolCallId(
        prepareMessagesForProvider({
          messages: toolConversation("functions.search:0"),
          provider,
        }),
      );

    const sanitized = prepare();
    expect(sanitized).toMatch(/^[a-zA-Z0-9_-]+$/);
    // Deterministic: the same original id maps to the same sanitized id on
    // every request, so tool-call/result pairing survives across turns.
    expect(prepare()).toBe(sanitized);
  });

  it("keeps already-valid tool ids untouched", () => {
    const messages = prepareMessagesForProvider({
      messages: toolConversation("toolu_01AbCdEfGh"),
      provider: "anthropic",
    });
    expect(extractToolCallId(messages)).toBe("toolu_01AbCdEfGh");
  });

  it("two distinct raw ids that clean to the same string stay distinct", () => {
    const first = extractToolCallId(
      prepareMessagesForProvider({
        messages: toolConversation("call.0"),
        provider: "anthropic",
      }),
    );
    const second = extractToolCallId(
      prepareMessagesForProvider({
        messages: toolConversation("call:0"),
        provider: "anthropic",
      }),
    );
    expect(first).not.toBe(second);
  });

  it("sanitizes on the anthropic-compatible (non-native) endpoint branch too", () => {
    const messages = prepareMessagesForProvider({
      messages: toolConversation("functions.search:0"),
      provider: "anthropic",
      anthropicNativeEndpoint: false,
    });
    expect(extractToolCallId(messages)).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it("leaves other providers' tool ids alone", () => {
    const messages = prepareMessagesForProvider({
      messages: toolConversation("functions.search:0"),
      provider: "openai",
    });
    expect(extractToolCallId(messages)).toBe("functions.search:0");
  });
});

describe("prepareMessagesForProvider — bedrock empty-content padding", () => {
  const NO_CONTENT = "(no content)";

  function hasNoContentPlaceholder(message: ChatMessage): boolean {
    return Boolean(
      message.parts?.some((p) => p.type === "text" && p.text === NO_CONTENT),
    );
  }

  it("does not pad an assistant message whose only part is a dynamic-tool (e.g. the render_app seed)", () => {
    // The owned-app render_app seed is a single `dynamic-tool` part. It is real
    // provider-visible content (a tool_use block), so Bedrock must not treat the
    // message as empty and append a bogus "(no content)" text part.
    const [message] = prepareMessagesForProvider({
      messages: [
        {
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "archestra__render_app",
              toolCallId: "call_render_1",
              state: "output-available",
              input: { appId: "402e041f-a78c-40a0-b8b3-a14d91633fce" },
              output: { content: [{ type: "text", text: "app rendered" }] },
            },
          ],
        },
      ] as unknown as ChatMessage[],
      provider: "bedrock",
    });

    expect(hasNoContentPlaceholder(message)).toBe(false);
    expect(message.parts).toHaveLength(1);
    expect(message.parts?.[0]?.type).toBe("dynamic-tool");
  });

  it("still pads a genuinely empty assistant message with a placeholder", () => {
    // Regression guard: the dynamic-tool fix must not disable the workaround for
    // an assistant turn that really has no provider-visible content.
    const [message] = prepareMessagesForProvider({
      messages: [
        { role: "assistant", parts: [{ type: "text", text: "" }] },
      ] as unknown as ChatMessage[],
      provider: "bedrock",
    });

    expect(hasNoContentPlaceholder(message)).toBe(true);
  });
});
