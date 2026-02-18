import { SESSION_ID_HEADER } from "@shared";
import { describe, expect, test } from "vitest";
import { extractSessionInfo } from "./session-id";

const sessionHeaderKey = SESSION_ID_HEADER.toLowerCase();

describe("extractSessionInfo", () => {
  test("extracts session ID from X-Archestra-Session-Id header", () => {
    const result = extractSessionInfo(
      { [sessionHeaderKey]: "my-session-123" },
      undefined,
    );

    expect(result).toEqual({
      sessionId: "my-session-123",
      sessionSource: "header",
    });
  });

  test("extracts session ID from x-openwebui-chat-id header", () => {
    const result = extractSessionInfo(
      { "x-openwebui-chat-id": "af85aa87-3b22-4015-ba65-30012b27204c" },
      undefined,
    );

    expect(result).toEqual({
      sessionId: "af85aa87-3b22-4015-ba65-30012b27204c",
      sessionSource: "openwebui_chat",
    });
  });

  test("extracts session ID from Claude Code metadata.user_id", () => {
    const result = extractSessionInfo(
      {},
      {
        metadata: {
          user_id:
            "user_abc123_account_456_session_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        },
      },
    );

    expect(result).toEqual({
      sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      sessionSource: "claude_code",
    });
  });

  test("extracts session ID from OpenAI user field", () => {
    const result = extractSessionInfo({}, { user: "user-abc-123" });

    expect(result).toEqual({
      sessionId: "user-abc-123",
      sessionSource: "openai_user",
    });
  });

  test("returns null when no session info is available", () => {
    const result = extractSessionInfo({}, undefined);

    expect(result).toEqual({ sessionId: null, sessionSource: null });
  });

  test("prefers X-Archestra-Session-Id over x-openwebui-chat-id", () => {
    const result = extractSessionInfo(
      {
        [sessionHeaderKey]: "archestra-session",
        "x-openwebui-chat-id": "openwebui-chat-id",
      },
      undefined,
    );

    expect(result).toEqual({
      sessionId: "archestra-session",
      sessionSource: "header",
    });
  });

  test("prefers x-openwebui-chat-id over Claude Code metadata", () => {
    const result = extractSessionInfo(
      { "x-openwebui-chat-id": "openwebui-chat-id" },
      {
        metadata: {
          user_id: "user_abc_session_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        },
      },
    );

    expect(result).toEqual({
      sessionId: "openwebui-chat-id",
      sessionSource: "openwebui_chat",
    });
  });

  test("prefers Claude Code metadata over OpenAI user field", () => {
    const result = extractSessionInfo(
      {},
      {
        metadata: {
          user_id: "user_abc_session_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        },
        user: "openai-user",
      },
    );

    expect(result).toEqual({
      sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      sessionSource: "claude_code",
    });
  });

  test("falls back to OpenAI user when Claude Code metadata has no session", () => {
    const result = extractSessionInfo(
      {},
      {
        metadata: { user_id: "user_abc_no_session_here" },
        user: "openai-user",
      },
    );

    expect(result).toEqual({
      sessionId: "openai-user",
      sessionSource: "openai_user",
    });
  });

  test("handles array header values", () => {
    const result = extractSessionInfo(
      { [sessionHeaderKey]: ["session-1", "session-2"] },
      undefined,
    );

    expect(result).toEqual({
      sessionId: "session-1",
      sessionSource: "header",
    });
  });

  test("handles array x-openwebui-chat-id header values", () => {
    const result = extractSessionInfo(
      { "x-openwebui-chat-id": ["chat-1", "chat-2"] },
      undefined,
    );

    expect(result).toEqual({
      sessionId: "chat-1",
      sessionSource: "openwebui_chat",
    });
  });

  test("ignores whitespace-only header values", () => {
    const result = extractSessionInfo(
      { [sessionHeaderKey]: "   ", "x-openwebui-chat-id": "  " },
      { user: "fallback-user" },
    );

    expect(result).toEqual({
      sessionId: "fallback-user",
      sessionSource: "openai_user",
    });
  });

  test("trims header values", () => {
    const result = extractSessionInfo(
      { [sessionHeaderKey]: "  my-session  " },
      undefined,
    );

    expect(result).toEqual({
      sessionId: "my-session",
      sessionSource: "header",
    });
  });

  test("ignores null metadata user_id", () => {
    const result = extractSessionInfo(
      {},
      {
        metadata: { user_id: null },
        user: "fallback",
      },
    );

    expect(result).toEqual({
      sessionId: "fallback",
      sessionSource: "openai_user",
    });
  });

  test("ignores empty string OpenAI user field", () => {
    const result = extractSessionInfo({}, { user: "" });

    expect(result).toEqual({ sessionId: null, sessionSource: null });
  });

  test("ignores whitespace-only OpenAI user field", () => {
    const result = extractSessionInfo({}, { user: "   " });

    expect(result).toEqual({ sessionId: null, sessionSource: null });
  });
});
