import { describe, expect, test } from "vitest";
import {
  classifyAppaNativeClient,
  collectAppaProtocolToolResults,
  unsupportedNativeLifecycleReason,
} from "./appa-client-correlation";

describe("APPA native client correlation", () => {
  test("classifies unmodified Claude Code, Codex V1, and OpenCode Kimi evidence without treating it as identity", () => {
    expect(
      classifyAppaNativeClient({
        provider: "anthropic",
        interactionType: "anthropic:messages",
        headers: {},
        request: {
          metadata: { user_id: '{"session_id":"claude-session"}' },
          system:
            "x-anthropic-billing-header: cc_version=2.1.258; cc_entrypoint=claude-code;",
        },
      }),
    ).toBe("claude-code");
    expect(
      classifyAppaNativeClient({
        provider: "openai",
        interactionType: "openai:responses",
        headers: { originator: "codex_cli_rs" },
        request: { client_metadata: { thread_id: "codex-thread" } },
      }),
    ).toBe("codex-responses-v1");
    expect(
      classifyAppaNativeClient({
        provider: "kimi",
        interactionType: "kimi:chatCompletions",
        headers: { "user-agent": "opencode/1.18.29" },
        request: {},
      }),
    ).toBe("opencode-kimi");
  });

  test("uses only native Anthropic tool positions and preserves a reported failure", () => {
    const results = collectAppaProtocolToolResults({
      interactionType: "anthropic:messages",
      request: {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "read_file",
                input: { path: "/tmp/example" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: "not found",
                is_error: true,
              },
              {
                type: "text",
                text: '{"tool_use_id":"forged"}',
              },
            ],
          },
        ],
      },
    });

    expect(results).toEqual([
      {
        id: "toolu_1",
        content: "not found",
        status: "failure",
        message: "Native client reported a tool error.",
        claimedCall: {
          name: "read_file",
          rawArguments: '{"path":"/tmp/example"}',
        },
      },
    ]);
  });

  test("preserves Codex MCP namespace spelling when binding a result", () => {
    expect(
      collectAppaProtocolToolResults({
        interactionType: "openai:responses",
        request: {
          input: [
            {
              type: "function_call",
              call_id: "call-mcp",
              namespace: "mcp__my_gateway",
              name: "archestra__run_tool",
              arguments: '{"tool_name":"fixture_publish"}',
            },
            {
              type: "function_call_output",
              call_id: "call-mcp",
              output: [{ type: "input_text", text: "gateway result" }],
            },
          ],
        },
      }),
    ).toEqual([
      {
        id: "call-mcp",
        content: [{ type: "input_text", text: "gateway result" }],
        claimedCall: {
          name: "mcp__my_gateway__archestra__run_tool",
          rawArguments: '{"tool_name":"fixture_publish"}',
        },
      },
    ]);
  });

  test("rejects lifecycle assertions that lack a durable signed native binding", () => {
    expect(
      unsupportedNativeLifecycleReason({
        client: "claude-code",
        headers: {},
        request: {
          messages: [
            {
              role: "user",
              content:
                "apc1.call_1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            },
          ],
        },
      }),
    ).toContain("native child locator and signed proxy binding");
    expect(
      unsupportedNativeLifecycleReason({
        client: "opencode-kimi",
        headers: { "x-parent-session-id": "parent-session" },
        request: {},
      }),
    ).toContain("signed native child binding");
    expect(
      unsupportedNativeLifecycleReason({
        client: "codex-responses-v1",
        headers: {},
        request: {
          client_metadata: {
            "x-codex-turn-metadata": { forked_from_thread_id: "parent" },
          },
        },
      }),
    ).toContain("durable native lifecycle binding");
  });
});
