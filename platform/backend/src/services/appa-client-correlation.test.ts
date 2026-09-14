import { describe, expect, test } from "vitest";
import {
  collectAppaProtocolToolResults,
  extractAppaSpawnCarrier,
} from "./appa-client-correlation";

describe("APPA shared correlation primitives", () => {
  test("extracts exactly one proxy-issued carrier from user prompt positions", () => {
    const carrier =
      "apc1.call_1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(
      extractAppaSpawnCarrier({
        messages: [{ role: "user", content: carrier }],
      }),
    ).toEqual({ callId: "call_1", carrier });
    expect(
      extractAppaSpawnCarrier({
        messages: [{ role: "user", content: `${carrier}\n${carrier}` }],
      }),
    ).toBeNull();
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

  test("leaves malformed stock result callbacks pending instead of inventing success", () => {
    const cases = [
      {
        interactionType: "anthropic:messages",
        request: {
          messages: [
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "toolu_missing" }],
            },
          ],
        },
      },
      {
        interactionType: "openai:chatCompletions",
        request: {
          messages: [{ role: "tool", tool_call_id: "call_missing" }],
        },
      },
      {
        interactionType: "openai:responses",
        request: {
          input: [{ type: "function_call_output", call_id: "call_missing" }],
        },
      },
    ];

    for (const params of cases) {
      expect(collectAppaProtocolToolResults(params)).toEqual([]);
    }

    expect(
      collectAppaProtocolToolResults({
        interactionType: "openai:responses",
        request: {
          input: [
            {
              type: "function_call_output",
              call_id: "call_empty_but_reported",
              output: "",
            },
          ],
        },
      }),
    ).toEqual([
      { id: "call_empty_but_reported", content: "", claimedCall: undefined },
    ]);
  });
});
