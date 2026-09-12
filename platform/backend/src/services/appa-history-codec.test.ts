import { describe, expect, test } from "vitest";
import { AppaHistoryCodec } from "./appa-history-codec";

describe("AppaHistoryCodec", () => {
  test("preserves Anthropic request and response wire while separating system bootstrap", () => {
    const exchange = AppaHistoryCodec.exchange({
      protocol: "anthropic-messages",
      request: {
        system: [
          {
            type: "text",
            text: "system",
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          { role: "user", content: [{ type: "text", text: "source" }] },
        ],
      },
      response: {
        id: "msg_1",
        content: [{ type: "text", text: "issued", provider_field: "kept" }],
      },
    });

    expect(exchange.bootstrapDigest).toMatch(/^sha256:/);
    expect(exchange.history).toHaveLength(1);
    expect(exchange.inheritedHistory).toHaveLength(2);
    expect(exchange.response.rawResponse).toMatchObject({ id: "msg_1" });
    expect(exchange.response.terminalOmission).toBe(true);
  });

  test("preserves Chat Completions tool history and only accepts one response choice", () => {
    const exchange = AppaHistoryCodec.exchange({
      protocol: "openai-chat-completions",
      request: {
        messages: [
          { role: "developer", content: "rules" },
          { role: "user", content: "source", trace_field: "kept" },
        ],
      },
      response: {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "lookup", arguments: "{}" },
                },
              ],
            },
          },
        ],
      },
    });

    expect(exchange.bootstrapDigest).toMatch(/^sha256:/);
    expect(exchange.inheritedHistory).toHaveLength(2);
    expect(exchange.response.issuedItemsDigest).toMatch(/^sha256:/);
    expect(() =>
      AppaHistoryCodec.response({
        protocol: "openai-chat-completions",
        response: {
          choices: [
            { message: { role: "assistant", content: "a" } },
            { message: { role: "assistant", content: "b" } },
          ],
        },
      }),
    ).toThrow("exactly one choice");
  });

  test("binds Chat tool call and result identities without depending on JSON key order", () => {
    const request = (
      params: {
        callId?: string;
        name?: string;
        arguments?: string;
        resultCallId?: string;
      } = {},
    ) => ({
      messages: [
        { role: "user", content: "source" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: params.callId ?? "call_1",
              type: "function",
              function: {
                name: params.name ?? "lookup",
                arguments: params.arguments ?? '{"a":1,"b":2}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: params.resultCallId ?? "call_1",
          content: [{ type: "text", text: "result", provider_trace: "kept" }],
        },
      ],
    });
    const original = AppaHistoryCodec.request({
      protocol: "openai-chat-completions",
      request: request(),
    });
    const reordered = AppaHistoryCodec.request({
      protocol: "openai-chat-completions",
      request: request({ arguments: '{"b":2,"a":1}' }),
    });
    const response = AppaHistoryCodec.response({
      protocol: "openai-chat-completions",
      response: { choices: [{ message: request().messages[1] }] },
    });

    expect(reordered.history).toEqual(original.history);
    expect(response.items[0]).toEqual(original.history[1]);
    for (const changed of [
      request({ callId: "call_changed" }),
      request({ name: "changed" }),
      request({ arguments: '{"a":2,"b":1}' }),
      request({ resultCallId: "call_changed" }),
    ]) {
      expect(
        AppaHistoryCodec.request({
          protocol: "openai-chat-completions",
          request: changed,
        }).history,
      ).not.toEqual(original.history);
    }
  });

  test("keeps Responses custom wire and compaction evidence without flattening", () => {
    const exchange = AppaHistoryCodec.exchange({
      protocol: "openai-responses",
      request: {
        instructions: "rules",
        input: [
          { type: "message", role: "user", content: "source" },
          { type: "compaction_trigger", reason: "window" },
        ],
      },
      response: {
        id: "resp_1",
        output: [
          {
            id: "ctc_1",
            type: "custom_tool_call",
            call_id: "call_1",
            name: "apply_patch",
            input: "*** Begin Patch",
            provider_field: { opaque: true },
          },
          { type: "compaction", encrypted_content: "ciphertext" },
        ],
      },
    });

    expect(exchange.compactionRequested).toBe(true);
    expect(exchange.response.compactionProduced).toBe(true);
    expect(exchange.inheritedHistory[2]).toMatchObject({
      type: "custom_tool_call",
      extras: { provider_field: { opaque: true } },
    });
  });

  test("binds Anthropic and Responses tool identities and opaque fields", () => {
    const anthropic = (callId: string) =>
      AppaHistoryCodec.request({
        protocol: "anthropic-messages",
        request: {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: callId,
                  name: "lookup",
                  input: { a: 1 },
                  cache_control: { type: "ephemeral" },
                },
              ],
            },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: callId, content: "result" },
              ],
            },
          ],
        },
      });
    const responses = (argumentsText: string) =>
      AppaHistoryCodec.request({
        protocol: "openai-responses",
        request: {
          input: [
            {
              type: "function_call",
              call_id: "call_1",
              name: "lookup",
              arguments: argumentsText,
              provider_extension: { opaque: true },
            },
            {
              type: "function_call_output",
              call_id: "call_1",
              output: '{"b":2,"a":1}',
            },
          ],
        },
      });

    expect(anthropic("call_1").history).not.toEqual(
      anthropic("call_changed").history,
    );
    expect(responses('{"a":1,"b":2}').history).toEqual(
      responses('{"b":2,"a":1}').history,
    );
    expect(responses('{"a":1,"b":2}').history).not.toEqual(
      responses('{"a":2,"b":1}').history,
    );
  });
});
