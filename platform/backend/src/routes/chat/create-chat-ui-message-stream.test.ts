import { describe, expect, it, vi } from "vitest";

const mockCreateUIMessageStream = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    createUIMessageStream: mockCreateUIMessageStream,
  };
});

import { createChatUiMessageStream } from "./create-chat-ui-message-stream";

describe("createChatUiMessageStream", () => {
  it("passes originalMessages through so UI message IDs are reused", () => {
    const originalMessages = [
      {
        id: "msg-1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "hello" }],
      },
    ];
    const onError = vi.fn(() => "error");
    const execute = vi.fn();

    createChatUiMessageStream({
      originalMessages,
      onError,
      execute,
    });

    expect(mockCreateUIMessageStream).toHaveBeenCalledWith({
      originalMessages,
      onError,
      execute,
    });
  });
});
