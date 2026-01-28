import { CHAT_DEFAULT_SESSION_NAME } from "@shared";
import { describe, expect, it } from "vitest";
import { getConversationDisplayTitle } from "./chat-sidebar-section";

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

  it("returns CHAT_DEFAULT_SESSION_NAME when no title and no messages", () => {
    expect(getConversationDisplayTitle(null, [])).toBe(
      CHAT_DEFAULT_SESSION_NAME,
    );
    expect(getConversationDisplayTitle(null, undefined)).toBe(
      CHAT_DEFAULT_SESSION_NAME,
    );
    expect(getConversationDisplayTitle(null)).toBe(CHAT_DEFAULT_SESSION_NAME);
  });

  it("returns CHAT_DEFAULT_SESSION_NAME when messages have no text parts", () => {
    const messages = [
      {
        role: "user",
        parts: [{ type: "image", url: "http://example.com/img.png" }],
      },
    ];
    expect(getConversationDisplayTitle(null, messages)).toBe(
      CHAT_DEFAULT_SESSION_NAME,
    );
  });

  it("returns CHAT_DEFAULT_SESSION_NAME when user message has no parts", () => {
    const messages = [
      {
        role: "user",
        parts: [],
      },
    ];
    expect(getConversationDisplayTitle(null, messages)).toBe(
      CHAT_DEFAULT_SESSION_NAME,
    );
  });

  it("returns CHAT_DEFAULT_SESSION_NAME when user message has undefined parts", () => {
    const messages = [
      {
        role: "user",
      },
    ];
    expect(getConversationDisplayTitle(null, messages)).toBe(
      CHAT_DEFAULT_SESSION_NAME,
    );
  });
});
