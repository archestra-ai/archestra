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
