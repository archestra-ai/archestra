import {
  CLAUDE_METADATA_SESSION_SOURCE,
  CODEX_CLIENT_ID,
  SESSION_ID_HEADER,
} from "@archestra/shared";
import { describe, expect, test } from "vitest";
import { extractSessionInfo } from "./session-id";

const sessionHeaderKey = SESSION_ID_HEADER.toLowerCase();

describe("extractSessionInfo", () => {
  test("extracts session ID from X-Archestra-Session-Id header", () => {
    const result = extractSessionInfo({
      headers: { [sessionHeaderKey]: "my-session-123" },
      body: undefined,
      externalAgentId: undefined,
    });

    expect(result).toEqual({
      sessionId: "my-session-123",
      sessionSource: "header",
    });
  });

  test("extracts session ID from x-openwebui-chat-id header", () => {
    const result = extractSessionInfo({
      headers: {
        "x-openwebui-chat-id": "af85aa87-3b22-4015-ba65-30012b27204c",
      },
      body: undefined,
      externalAgentId: undefined,
    });

    expect(result).toEqual({
      sessionId: "af85aa87-3b22-4015-ba65-30012b27204c",
      sessionSource: "openwebui_chat",
    });
  });

  test("extracts session ID from Claude Code metadata.user_id", () => {
    const result = extractSessionInfo({
      headers: {},
      body: {
        metadata: {
          user_id:
            "user_abc123_account_456_session_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        },
      },
      externalAgentId: undefined,
    });

    expect(result).toEqual({
      sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      sessionSource: CLAUDE_METADATA_SESSION_SOURCE,
    });
  });

  test("extracts session ID from Claude Desktop JSON metadata.user_id", () => {
    const result = extractSessionInfo({
      headers: {},
      body: {
        metadata: {
          user_id: JSON.stringify({
            device_id:
              "68ccdef7c5bef524514efc6d13d1c480542af5b4f5ceeb1e9d65b5c1c9a77826",
            account_uuid: "",
            session_id: "86ce5c03-16a6-43a5-b890-e64322431a74",
          }),
        },
      },
      externalAgentId: undefined,
    });

    expect(result).toEqual({
      sessionId: "86ce5c03-16a6-43a5-b890-e64322431a74",
      sessionSource: CLAUDE_METADATA_SESSION_SOURCE,
    });
  });

  test("uses claude_metadata for the legacy non-JSON metadata.user_id format", () => {
    const result = extractSessionInfo({
      headers: {},
      body: {
        metadata: {
          user_id:
            "user_abc123_account_456_session_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        },
      },
      externalAgentId: undefined,
    });

    expect(result).toEqual({
      sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      sessionSource: CLAUDE_METADATA_SESSION_SOURCE,
    });
  });

  test("falls through when Claude Desktop JSON has no session_id", () => {
    const result = extractSessionInfo({
      headers: {},
      body: {
        metadata: {
          user_id: JSON.stringify({ device_id: "abc", account_uuid: "" }),
        },
        user: "openai-user",
      },
      externalAgentId: undefined,
    });

    expect(result).toEqual({
      sessionId: "openai-user",
      sessionSource: "openai_user",
    });
  });

  test("extracts session ID from OpenAI user field", () => {
    const result = extractSessionInfo({
      headers: {},
      body: { user: "user-abc-123" },
      externalAgentId: undefined,
    });

    expect(result).toEqual({
      sessionId: "user-abc-123",
      sessionSource: "openai_user",
    });
  });

  test("returns null when no session info is available", () => {
    const result = extractSessionInfo({
      headers: {},
      body: undefined,
      externalAgentId: undefined,
    });

    expect(result).toEqual({ sessionId: null, sessionSource: null });
  });

  test("prefers X-Archestra-Session-Id over x-openwebui-chat-id", () => {
    const result = extractSessionInfo({
      headers: {
        [sessionHeaderKey]: "archestra-session",
        "x-openwebui-chat-id": "openwebui-chat-id",
      },
      body: undefined,
      externalAgentId: undefined,
    });

    expect(result).toEqual({
      sessionId: "archestra-session",
      sessionSource: "header",
    });
  });

  test("prefers x-openwebui-chat-id over Claude Code metadata", () => {
    const result = extractSessionInfo({
      headers: { "x-openwebui-chat-id": "openwebui-chat-id" },
      body: {
        metadata: {
          user_id: "user_abc_session_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        },
      },
      externalAgentId: undefined,
    });

    expect(result).toEqual({
      sessionId: "openwebui-chat-id",
      sessionSource: "openwebui_chat",
    });
  });

  test("prefers Claude Code metadata over OpenAI user field", () => {
    const result = extractSessionInfo({
      headers: {},
      body: {
        metadata: {
          user_id: "user_abc_session_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        },
        user: "openai-user",
      },
      externalAgentId: undefined,
    });

    expect(result).toEqual({
      sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      sessionSource: CLAUDE_METADATA_SESSION_SOURCE,
    });
  });

  test("falls back to OpenAI user when Claude Code metadata has no session", () => {
    const result = extractSessionInfo({
      headers: {},
      body: {
        metadata: { user_id: "user_abc_no_session_here" },
        user: "openai-user",
      },
      externalAgentId: undefined,
    });

    expect(result).toEqual({
      sessionId: "openai-user",
      sessionSource: "openai_user",
    });
  });

  test("handles array header values", () => {
    const result = extractSessionInfo({
      headers: { [sessionHeaderKey]: ["session-1", "session-2"] },
      body: undefined,
      externalAgentId: undefined,
    });

    expect(result).toEqual({
      sessionId: "session-1",
      sessionSource: "header",
    });
  });

  test("handles array x-openwebui-chat-id header values", () => {
    const result = extractSessionInfo({
      headers: { "x-openwebui-chat-id": ["chat-1", "chat-2"] },
      body: undefined,
      externalAgentId: undefined,
    });

    expect(result).toEqual({
      sessionId: "chat-1",
      sessionSource: "openwebui_chat",
    });
  });

  test("ignores whitespace-only header values", () => {
    const result = extractSessionInfo({
      headers: { [sessionHeaderKey]: "   ", "x-openwebui-chat-id": "  " },
      body: { user: "fallback-user" },
      externalAgentId: undefined,
    });

    expect(result).toEqual({
      sessionId: "fallback-user",
      sessionSource: "openai_user",
    });
  });

  test("trims header values", () => {
    const result = extractSessionInfo({
      headers: { [sessionHeaderKey]: "  my-session  " },
      body: undefined,
      externalAgentId: undefined,
    });

    expect(result).toEqual({
      sessionId: "my-session",
      sessionSource: "header",
    });
  });

  test("ignores null metadata user_id", () => {
    const result = extractSessionInfo({
      headers: {},
      body: {
        metadata: { user_id: null },
        user: "fallback",
      },
      externalAgentId: undefined,
    });

    expect(result).toEqual({
      sessionId: "fallback",
      sessionSource: "openai_user",
    });
  });

  test("ignores empty string OpenAI user field", () => {
    const result = extractSessionInfo({
      headers: {},
      body: { user: "" },
      externalAgentId: undefined,
    });

    expect(result).toEqual({ sessionId: null, sessionSource: null });
  });

  test("ignores whitespace-only OpenAI user field", () => {
    const result = extractSessionInfo({
      headers: {},
      body: { user: "   " },
      externalAgentId: undefined,
    });

    expect(result).toEqual({ sessionId: null, sessionSource: null });
  });

  // The Codex branch is gated on the resolved client attribution the proxy
  // handler passes in (explicit X-Archestra-Agent-Id header, or client-app
  // auto-discovery from client_metadata/originator/User-Agent — see
  // client-app.test.ts for the identification paths).
  test("Codex attribution: client_metadata.session_id wins over the session-id header", () => {
    const result = extractSessionInfo({
      headers: { "session-id": "019f66bc-ffff-72d1-b927-4d96fad7dc3a" },
      body: {
        client_metadata: {
          session_id: "019f66bc-440e-72d1-b927-4d96fad7dc3a",
          thread_id: "019f66bc-aaaa-72d1-b927-4d96fad7dc3a",
        },
      },
      externalAgentId: CODEX_CLIENT_ID,
    });

    expect(result).toEqual({
      sessionId: "019f66bc-440e-72d1-b927-4d96fad7dc3a",
      sessionSource: "codex_session",
    });
  });

  test("Codex attribution: falls back to the session-id header when client_metadata is absent", () => {
    const result = extractSessionInfo({
      headers: { "session-id": "019f66bc-440e-72d1-b927-4d96fad7dc3a" },
      body: undefined,
      externalAgentId: CODEX_CLIENT_ID,
    });

    expect(result).toEqual({
      sessionId: "019f66bc-440e-72d1-b927-4d96fad7dc3a",
      sessionSource: "codex_session",
    });
  });

  test("a session-id header without Codex attribution is never read as a Codex session", () => {
    // The header name is generic; a request not attributed to a Codex client
    // must not get codex_session provenance.
    const result = extractSessionInfo({
      headers: { "session-id": "019f66bc-440e-72d1-b927-4d96fad7dc3a" },
      body: undefined,
      externalAgentId: undefined,
    });

    expect(result).toEqual({ sessionId: null, sessionSource: null });
  });

  test("Codex signals are ignored when the request is attributed to another client", () => {
    const result = extractSessionInfo({
      headers: { "session-id": "019f66bc-440e-72d1-b927-4d96fad7dc3a" },
      body: {
        client_metadata: {
          session_id: "019f66bc-ffff-72d1-b927-4d96fad7dc3a",
        },
        user: "openai-user",
      },
      externalAgentId: "my-custom-agent",
    });

    expect(result).toEqual({
      sessionId: "openai-user",
      sessionSource: "openai_user",
    });
  });

  test("a non-Codex request with a session-id header falls through to lower-priority signals", () => {
    const result = extractSessionInfo({
      headers: { "session-id": "019f66bc-440e-72d1-b927-4d96fad7dc3a" },
      body: { user: "openai-user" },
      externalAgentId: undefined,
    });

    expect(result).toEqual({
      sessionId: "openai-user",
      sessionSource: "openai_user",
    });
  });

  test("Codex attribution with a non-UUID session-id header and no client_metadata yields no session", () => {
    const result = extractSessionInfo({
      headers: { "session-id": "not-a-uuid" },
      body: undefined,
      externalAgentId: CODEX_CLIENT_ID,
    });

    expect(result).toEqual({ sessionId: null, sessionSource: null });
  });

  test("prompt_cache_key is never used as a session signal", () => {
    const result = extractSessionInfo({
      headers: {},
      body: {
        prompt_cache_key: "019f66bc-440e-72d1-b927-4d96fad7dc3a",
      } as Parameters<typeof extractSessionInfo>[0]["body"],
      externalAgentId: CODEX_CLIENT_ID,
    });

    expect(result).toEqual({ sessionId: null, sessionSource: null });
  });

  test("the explicit X-Archestra-Session-Id header still outranks Codex signals", () => {
    const result = extractSessionInfo({
      headers: {
        "x-archestra-session-id": "archestra-session",
        "session-id": "019f66bc-440e-72d1-b927-4d96fad7dc3a",
      },
      body: undefined,
      externalAgentId: CODEX_CLIENT_ID,
    });

    expect(result).toEqual({
      sessionId: "archestra-session",
      sessionSource: "header",
    });
  });
});
