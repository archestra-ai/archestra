import { CLAUDE_CLIENT_ID } from "@archestra/shared";
import { describe, expect, test } from "vitest";
import { detectClaudeClientId } from "./client-app";

describe("detectClaudeClientId", () => {
  test("detects Claude from an x-anthropic-billing-header system block", () => {
    const result = detectClaudeClientId({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.195.1ff; cc_entrypoint=claude-vscode;",
        },
      ],
    });
    expect(result).toBe(CLAUDE_CLIENT_ID);
  });

  test("detects Claude for an unknown but present cc_entrypoint", () => {
    const result = detectClaudeClientId({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_entrypoint=some-future-app;",
        },
      ],
    });
    expect(result).toBe(CLAUDE_CLIENT_ID);
  });

  test("detects Claude from a string system prompt", () => {
    const result = detectClaudeClientId({
      system:
        "You are Claude.\nx-anthropic-billing-header: cc_version=1; cc_entrypoint=claude-code;",
    });
    expect(result).toBe(CLAUDE_CLIENT_ID);
  });

  test("ignores a billing header with an empty cc_entrypoint", () => {
    const result = detectClaudeClientId({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=1; cc_entrypoint=;",
        },
      ],
    });
    expect(result).toBeUndefined();
  });

  test("detects Claude from the unified metadata.user_id JSON format", () => {
    const result = detectClaudeClientId({
      metadata: {
        user_id: JSON.stringify({
          device_id: "abc",
          account_uuid: "",
          session_id: "86ce5c03-16a6-43a5-b890-e64322431a74",
        }),
      },
    });
    expect(result).toBe(CLAUDE_CLIENT_ID);
  });

  test("detects Claude from the legacy metadata.user_id string format", () => {
    const result = detectClaudeClientId({
      metadata: {
        user_id:
          "user_abc_account_456_session_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      },
    });
    expect(result).toBe(CLAUDE_CLIENT_ID);
  });

  test("returns undefined for a non-Claude request", () => {
    expect(
      detectClaudeClientId({
        system: "You are a helpful assistant.",
        metadata: { user_id: "plain-user-id" },
      }),
    ).toBeUndefined();
    expect(detectClaudeClientId(undefined)).toBeUndefined();
    expect(detectClaudeClientId({})).toBeUndefined();
  });
});
