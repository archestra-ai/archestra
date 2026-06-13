import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { applyPromptCacheBreakpoints } from "./apply-prompt-cache";

const EPHEMERAL = { type: "ephemeral" };

function userMessage(text: string): ModelMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function anthropicCacheControl(message: ModelMessage) {
  return (
    message.providerOptions as
      | { anthropic?: { cacheControl?: unknown } }
      | undefined
  )?.anthropic?.cacheControl;
}

function bedrockCachePoint(message: ModelMessage) {
  return (
    message.providerOptions as
      | { bedrock?: { cachePoint?: unknown } }
      | undefined
  )?.bedrock?.cachePoint;
}

// A message whose content part already carries an Anthropic cache_control
// marker, as `materializeAttachments` produces for file/document parts.
function messageWithMarkedPart(text: string): ModelMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text,
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
    ],
  };
}

// A user message carrying a text part plus a file part of the given media type,
// as `materializeAttachments` produces for an attachment.
function messageWithFile(text: string, mediaType: string): ModelMessage {
  return {
    role: "user",
    content: [
      { type: "text", text },
      { type: "file", mediaType, data: "data:..." },
    ],
  };
}

describe("applyPromptCacheBreakpoints", () => {
  it("marks the first and last message for Anthropic", () => {
    const result = applyPromptCacheBreakpoints({
      provider: "anthropic",
      messages: [userMessage("a"), userMessage("b"), userMessage("c")],
    });

    expect(anthropicCacheControl(result[0])).toEqual(EPHEMERAL);
    expect(anthropicCacheControl(result[1])).toBeUndefined();
    expect(anthropicCacheControl(result[2])).toEqual(EPHEMERAL);
  });

  it("marks a single message exactly once (no first/last collision)", () => {
    const result = applyPromptCacheBreakpoints({
      provider: "anthropic",
      messages: [userMessage("only")],
    });

    expect(result).toHaveLength(1);
    expect(anthropicCacheControl(result[0])).toEqual(EPHEMERAL);
  });

  it("does not annotate messages for auto-caching providers", () => {
    const messages = [userMessage("a"), userMessage("b")];

    for (const provider of ["openai", "gemini", "deepseek"]) {
      const result = applyPromptCacheBreakpoints({ provider, messages });
      expect(result).toBe(messages);
      expect(anthropicCacheControl(result[0])).toBeUndefined();
      expect(bedrockCachePoint(result[0])).toBeUndefined();
    }
  });

  it("returns the empty list unchanged for Anthropic", () => {
    const messages: ModelMessage[] = [];
    expect(
      applyPromptCacheBreakpoints({ provider: "anthropic", messages }),
    ).toBe(messages);
  });

  it("preserves existing providerOptions while adding cacheControl", () => {
    const message: ModelMessage = {
      role: "user",
      content: [{ type: "text", text: "a" }],
      providerOptions: {
        anthropic: { existingFlag: true },
        openai: { foo: "bar" },
      },
    };

    const [result] = applyPromptCacheBreakpoints({
      provider: "anthropic",
      messages: [message],
    });

    const providerOptions = result.providerOptions as {
      anthropic: { existingFlag: boolean; cacheControl: unknown };
      openai: { foo: string };
    };
    expect(providerOptions.anthropic.cacheControl).toEqual(EPHEMERAL);
    expect(providerOptions.anthropic.existingFlag).toBe(true);
    expect(providerOptions.openai).toEqual({ foo: "bar" });
  });

  it("does not mutate the input messages", () => {
    const message = userMessage("a");
    applyPromptCacheBreakpoints({ provider: "anthropic", messages: [message] });
    expect(message.providerOptions).toBeUndefined();
  });

  it("adds nothing when existing breakpoints already saturate the budget", () => {
    // 4 attachment-marked parts == Anthropic's max of 4 breakpoints.
    const messages = [
      messageWithMarkedPart("a"),
      messageWithMarkedPart("b"),
      messageWithMarkedPart("c"),
      messageWithMarkedPart("d"),
      userMessage("e"),
    ];

    const result = applyPromptCacheBreakpoints({
      provider: "anthropic",
      messages,
    });

    expect(result).toBe(messages);
    // The unmarked first/last messages stay unmarked — no message-level marker.
    expect(anthropicCacheControl(result[4])).toBeUndefined();
  });

  it("spends the remaining budget on the last message before the first", () => {
    // 3 existing breakpoints → budget of 1 → only the last gets a marker.
    const messages = [
      userMessage("first"),
      messageWithMarkedPart("b"),
      messageWithMarkedPart("c"),
      messageWithMarkedPart("d"),
      userMessage("last"),
    ];

    const result = applyPromptCacheBreakpoints({
      provider: "anthropic",
      messages,
    });

    expect(anthropicCacheControl(result[4])).toEqual(EPHEMERAL);
    expect(anthropicCacheControl(result[0])).toBeUndefined();
  });

  it("skips a candidate that already carries a breakpoint and uses the budget elsewhere", () => {
    // Last message is already marked (attachment) → first message gets the marker.
    const messages = [userMessage("first"), messageWithMarkedPart("last")];

    const result = applyPromptCacheBreakpoints({
      provider: "anthropic",
      messages,
    });

    expect(anthropicCacheControl(result[0])).toEqual(EPHEMERAL);
    // The already-marked message keeps only its part-level marker.
    expect(anthropicCacheControl(result[1])).toBeUndefined();
  });

  it("marks the first and last message for Bedrock with cachePoint", () => {
    const result = applyPromptCacheBreakpoints({
      provider: "bedrock",
      messages: [userMessage("a"), userMessage("b"), userMessage("c")],
    });

    expect(bedrockCachePoint(result[0])).toEqual({ type: "default" });
    expect(bedrockCachePoint(result[1])).toBeUndefined();
    expect(bedrockCachePoint(result[2])).toEqual({ type: "default" });
    // Bedrock uses cachePoint, not Anthropic's cacheControl.
    expect(anthropicCacheControl(result[0])).toBeUndefined();
  });

  it("skips the Bedrock cachePoint on a message containing a document", () => {
    // A trailing standalone cachePoint after a document block makes Bedrock
    // reject the request, so a document-bearing last message must not be marked.
    const result = applyPromptCacheBreakpoints({
      provider: "bedrock",
      messages: [
        userMessage("first"),
        messageWithFile("here is a file", "application/pdf"),
      ],
    });

    expect(bedrockCachePoint(result[1])).toBeUndefined();
    // Budget is spent on the document-free first message instead.
    expect(bedrockCachePoint(result[0])).toEqual({ type: "default" });
  });

  it("does not mark either message when both carry a document for Bedrock", () => {
    const messages = [
      messageWithFile("doc a", "application/pdf"),
      messageWithFile("doc b", "text/plain"),
    ];

    const result = applyPromptCacheBreakpoints({
      provider: "bedrock",
      messages,
    });

    expect(result).toBe(messages);
    expect(bedrockCachePoint(result[0])).toBeUndefined();
    expect(bedrockCachePoint(result[1])).toBeUndefined();
  });

  it("still marks a Bedrock message that carries an image (not a document)", () => {
    const result = applyPromptCacheBreakpoints({
      provider: "bedrock",
      messages: [
        userMessage("first"),
        messageWithFile("here is an image", "image/png"),
      ],
    });

    // A cachePoint after an image block is accepted by Bedrock, so the
    // image-bearing last message keeps its breakpoint.
    expect(bedrockCachePoint(result[1])).toEqual({ type: "default" });
  });

  it("does not skip document messages for Anthropic", () => {
    // Anthropic merges the breakpoint into providerOptions (no standalone
    // block), so a document-bearing message is still marked.
    const result = applyPromptCacheBreakpoints({
      provider: "anthropic",
      messages: [
        userMessage("first"),
        messageWithFile("here is a file", "application/pdf"),
      ],
    });

    expect(anthropicCacheControl(result[1])).toEqual(EPHEMERAL);
  });

  it("ignores Anthropic markers when budgeting Bedrock cachePoints", () => {
    // 4 parts carry an Anthropic cacheControl marker, but those do not count as
    // Bedrock cache points, so Bedrock still has its full budget of 4.
    const messages = [
      messageWithMarkedPart("a"),
      messageWithMarkedPart("b"),
      messageWithMarkedPart("c"),
      messageWithMarkedPart("d"),
      userMessage("e"),
    ];

    const result = applyPromptCacheBreakpoints({
      provider: "bedrock",
      messages,
    });

    expect(bedrockCachePoint(result[0])).toEqual({ type: "default" });
    expect(bedrockCachePoint(result[4])).toEqual({ type: "default" });
  });

  it("uses a 1h TTL for Anthropic models that support it", () => {
    const [result] = applyPromptCacheBreakpoints({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      messages: [userMessage("a")],
    });
    expect(anthropicCacheControl(result)).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  it("uses a 1h TTL for a Bedrock Sonnet 4.5+ inference profile", () => {
    const [result] = applyPromptCacheBreakpoints({
      provider: "bedrock",
      model: "us.anthropic.claude-opus-4-6-v1:0",
      messages: [userMessage("a")],
    });
    expect(bedrockCachePoint(result)).toEqual({ type: "default", ttl: "1h" });
  });

  it("keeps the 5m default for older models and when model is absent", () => {
    const [sonnet4] = applyPromptCacheBreakpoints({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      messages: [userMessage("a")],
    });
    expect(anthropicCacheControl(sonnet4)).toEqual({ type: "ephemeral" });

    const [noModel] = applyPromptCacheBreakpoints({
      provider: "anthropic",
      messages: [userMessage("a")],
    });
    expect(anthropicCacheControl(noModel)).toEqual({ type: "ephemeral" });
  });

  it("stays 5m for a 1h-capable model when an attachment breakpoint already exists", () => {
    // A 5m attachment marker placed before a 1h marker would violate the
    // provider's "longer TTL must precede shorter" rule, so the request that
    // already carries any breakpoint stays uniformly 5m.
    const result = applyPromptCacheBreakpoints({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      messages: [userMessage("first"), messageWithMarkedPart("withFile")],
    });

    // The unmarked first message gets a marker (last already has its own), 5m.
    expect(anthropicCacheControl(result[0])).toEqual({ type: "ephemeral" });
  });
});
