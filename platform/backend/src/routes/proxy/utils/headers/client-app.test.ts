import { CLAUDE_CLIENT_ID, CODEX_CLIENT_ID } from "@archestra/shared";
import { describe, expect, test } from "vitest";
import { detectClaudeClientId, detectCodexClientId } from "./client-app";

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

describe("detectCodexClientId", () => {
  test("detects Codex from the default originator header", () => {
    expect(detectCodexClientId({ originator: "codex_cli_rs" }, undefined)).toBe(
      CODEX_CLIENT_ID,
    );
  });

  test("detects other first-party Codex originators", () => {
    expect(detectCodexClientId({ originator: "codex-tui" }, undefined)).toBe(
      CODEX_CLIENT_ID,
    );
    expect(detectCodexClientId({ originator: "codex_vscode" }, undefined)).toBe(
      CODEX_CLIENT_ID,
    );
    // The `Codex ` prefix covers versioned first-party originator strings.
    expect(detectCodexClientId({ originator: "Codex 1.2.3" }, undefined)).toBe(
      CODEX_CLIENT_ID,
    );
  });

  test("detects Codex from the client_metadata body shape", () => {
    expect(
      detectCodexClientId(
        {},
        {
          client_metadata: {
            session_id: "019f66bc-440e-72d1-b927-4d96fad7dc3a",
            thread_id: "019f66bc-ffff-72d1-b927-4d96fad7dc3a",
          },
        },
      ),
    ).toBe(CODEX_CLIENT_ID);
  });

  test("falls back to the User-Agent leading token when originator is absent", () => {
    expect(
      detectCodexClientId(
        {
          "user-agent": "codex_cli_rs/0.20.0 (Linux 6.6; x86_64) reqwest",
        },
        undefined,
      ),
    ).toBe(CODEX_CLIENT_ID);
  });

  test("does not attribute third-party clients that reuse the Codex backend", () => {
    // OpenCode sends its own `originator`, not a first-party Codex one.
    expect(
      detectCodexClientId({ originator: "opencode" }, undefined),
    ).toBeUndefined();
    expect(
      detectCodexClientId(
        {
          "user-agent": "opencode/1.0.0 (darwin) node",
        },
        undefined,
      ),
    ).toBeUndefined();
  });

  test("returns undefined when no Codex signal is present", () => {
    expect(detectCodexClientId({}, undefined)).toBeUndefined();
    expect(
      detectCodexClientId({ "user-agent": "OpenAI/Python 1.0" }, undefined),
    ).toBeUndefined();
    // A client_metadata without the Codex UUID session_id shape is not Codex.
    expect(
      detectCodexClientId(
        {},
        { client_metadata: { session_id: "not-a-uuid" } },
      ),
    ).toBeUndefined();
  });
});
