import { describe, expect, test } from "vitest";
import {
  formatSessionReceipt,
  stripSessionReceipts,
} from "@/openappa/session-token";
import { anthropicAdapterFactory } from "./anthropic";
import { makeAnthropicOpenaiAdapterFactory } from "./anthropic-openai";
import type { AnthropicOpenaiContext } from "./anthropic-openai-translator";
import { azureAdapterFactory } from "./azure";
import { azureResponsesAdapterFactory } from "./azure-responses";
import { openaiAdapterFactory } from "./openai";
import { openAiResponsesAdapterFactory } from "./openai-responses";
import { makeResponsesFromChatAdapterFactory } from "./openai-responses-from-chat";

const suffix = "<receipt>";
const receiptCode = "XK7-Q2M9";

function signedPrefix(_text: string): string {
  return formatSessionReceipt(receiptCode);
}

function restoreText(text: string) {
  const restored = stripSessionReceipts(text);
  return {
    text: restored.text,
    sessionIds: restored.codes.length > 0 ? ["parent"] : [],
  };
}

function frames(sse: string): Array<Record<string, unknown>> {
  return sse.split("\n\n").flatMap((frame) => {
    const data = frame.match(/^data: (.+)$/m)?.[1];
    return data && data !== "[DONE]" ? [JSON.parse(data)] : [];
  });
}

function textDelta(content: string, finishReason: string | null = null) {
  return {
    id: "chatcmpl_1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-test",
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
  };
}

describe("stream text suffix seam", () => {
  test("Chat Completions places the receipt on the first text delta", () => {
    const adapter = openaiAdapterFactory.createStreamAdapter();
    let firstText = "";
    adapter.setTextSuffix?.((text) => {
      firstText = text;
      return text === "answer" ? suffix : "";
    });

    const first = adapter.processChunk(textDelta("answer") as never);
    const contents = frames(String(first.sseData)).map(
      (frame) =>
        (frame.choices as Array<{ delta: { content?: string } }>)[0].delta
          .content,
    );

    expect(firstText).toBe("answer");
    expect(contents).toEqual([suffix, `\n\nanswer`]);
    expect(adapter.state.text).toBe("answer");
    expect(adapter.toProviderResponse().choices[0].message.content).toBe(
      "answer",
    );
  });

  test("Anthropic places the receipt on the first text delta", () => {
    const adapter = anthropicAdapterFactory.createStreamAdapter();
    adapter.setTextSuffix?.(() => suffix);
    adapter.processChunk({
      type: "message_start",
      message: { usage: {} },
    } as never);
    adapter.processChunk({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    } as never);
    const delta = adapter.processChunk({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "answer" },
    } as never);
    const output = String(delta.sseData);

    expect(output).toContain(`"text":"${suffix}"`);
    expect(output).toContain(`"text":"\\n\\nanswer"`);
    expect(adapter.toProviderResponse().content).toContainEqual(
      expect.objectContaining({ type: "text", text: "answer" }),
    );
  });

  test("Anthropic binds a multipart receipt to its final text block", () => {
    const adapter = anthropicAdapterFactory.createStreamAdapter();
    adapter.setTextSuffix?.(signedPrefix);
    let sse = "";
    const process = (chunk: unknown) => {
      sse += String(adapter.processChunk(chunk as never).sseData ?? "");
    };

    process({ type: "message_start", message: { usage: {} } });
    process({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    process({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "first" },
    });
    process({ type: "content_block_stop", index: 0 });
    process({
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    });
    process({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "second" },
    });
    process({ type: "content_block_stop", index: 1 });
    process({ type: "message_stop" });

    const textByBlock = new Map<number, string>();
    for (const frame of frames(sse)) {
      if (frame.type !== "content_block_delta") continue;
      const delta = frame.delta as { type: string; text?: string };
      if (delta.type !== "text_delta") continue;
      const index = frame.index as number;
      textByBlock.set(index, `${textByBlock.get(index) ?? ""}${delta.text}`);
    }

    expect(restoreText(textByBlock.get(0) ?? "")).toEqual({
      text: "first",
      sessionIds: ["parent"],
    });
    expect(restoreText(textByBlock.get(1) ?? "")).toEqual({
      text: "second",
      sessionIds: [],
    });
    expect(adapter.state.text).toBe("firstsecond");
    expect(adapter.toProviderResponse().content).toContainEqual(
      expect.objectContaining({ type: "text", text: "firstsecond" }),
    );
  });

  test.each([
    ["OpenAI", openAiResponsesAdapterFactory],
    ["Azure", azureResponsesAdapterFactory],
  ])("%s Responses keeps output terminal events and completed response consistent", (_provider, factory) => {
    const adapter = factory.createStreamAdapter();
    adapter.setTextSuffix?.(() => suffix);
    const first = adapter.processChunk({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      sequence_number: 1,
      delta: "answer",
    } as never);
    expect(frames(String(first.sseData)).map((frame) => frame.delta)).toEqual([
      suffix,
      `\n\nanswer`,
    ]);
    for (const chunk of [
      {
        type: "response.output_text.done",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        sequence_number: 2,
        text: "answer",
      },
      {
        type: "response.content_part.done",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        sequence_number: 3,
        part: { type: "output_text", text: "answer", annotations: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        sequence_number: 4,
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "answer", annotations: [] }],
        },
      },
    ]) {
      expect(adapter.processChunk(chunk as never).sseData).toBeNull();
    }
    adapter.processChunk({
      type: "response.completed",
      sequence_number: 5,
      response: {
        id: "resp_1",
        object: "response",
        model: "gpt-test",
        status: "completed",
        output: [
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "answer", annotations: [] }],
          },
        ],
      },
    } as never);

    expect(
      (
        adapter.toProviderResponse().output[0] as {
          content: Array<{ text: string }>;
        }
      ).content[0].text,
    ).toBe("answer");
  });

  test("does not emit a suffix for an aborted or tool-only Responses turn", () => {
    const aborted = openAiResponsesAdapterFactory.createStreamAdapter();
    aborted.setTextSuffix?.(() => suffix);
    aborted.processChunk({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      sequence_number: 1,
      delta: "partial",
    } as never);
    expect(String(aborted.formatEndSSE())).not.toContain(suffix);

    const tools = openAiResponsesAdapterFactory.createStreamAdapter();
    tools.setTextSuffix?.(() => suffix);
    tools.processChunk({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: {
        id: "fc_1",
        call_id: "call_1",
        type: "function_call",
        name: "run_tool",
        arguments: "{}",
        status: "in_progress",
      },
    } as never);
    const completed = tools.processChunk({
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "resp_tools",
        object: "response",
        model: "gpt-test",
        output: [],
      },
    } as never);

    expect(completed.isToolCallChunk).toBe(true);
    expect(
      `${tools.getRawToolCallEvents().join("")}${tools.formatEndSSE()}`,
    ).not.toContain(suffix);
  });

  test("emits subagent trajectory start prefix when OpenAI stream begins with tool calls", () => {
    const adapter = openaiAdapterFactory.createStreamAdapter();
    const banner = "▄█▄▄▄█▄\n██▄█▄██  started subagent ABC-1234";
    adapter.setTextSuffix?.(() => banner);
    const result = adapter.processChunk({
      id: "chunk_1",
      model: "gpt-test",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "read", arguments: "" },
              },
            ],
          },
        },
      ],
    } as never);
    expect(result.sseData).toContain("started subagent ABC-1234");
    expect(adapter.toProviderResponse().choices[0].message.content).toContain(
      "started subagent ABC-1234",
    );
  });

  test("emits subagent trajectory start prefix when Anthropic stream begins with tool calls", () => {
    const adapter = anthropicAdapterFactory.createStreamAdapter();
    const banner = "▄█▄▄▄█▄\n██▄█▄██  started subagent ABC-1234";
    adapter.setTextSuffix?.(() => banner);
    adapter.processChunk({
      type: "message_start",
      message: { id: "msg_1", model: "claude-test", usage: {} },
    } as never);
    const result = adapter.processChunk({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "call_1", name: "read" },
    } as never);
    expect(result.sseData).toContain("started subagent ABC-1234");
  });

  test("carries the trajectory prefix when a Responses stream begins with tool calls", () => {
    for (const [name, factory] of [
      ["OpenAI Responses", openAiResponsesAdapterFactory],
      ["Azure Responses", azureResponsesAdapterFactory],
    ] as const) {
      const adapter = factory.createStreamAdapter();
      const banner = "▄█▄▄▄█▄\n██▄█▄██  started subagent ABC-1234";
      adapter.setTextSuffix?.(() => banner);
      adapter.processChunk({
        type: "response.created",
        sequence_number: 0,
        response: { id: "resp_1" },
      } as never);
      const held = adapter.processChunk({
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: 1,
        item: {
          id: "fc_1",
          call_id: "call_spawn",
          type: "function_call",
          name: "spawn_agent",
          arguments: "",
          status: "in_progress",
        },
      } as never);
      expect(held.isToolCallChunk).toBe(true);
      expect(adapter.state.text).toContain("started subagent ABC-1234");
      adapter.processChunk({
        type: "response.completed",
        sequence_number: 2,
        response: {
          id: "resp_1",
          object: "response",
          status: "completed",
          model: "test-model",
          output: [
            {
              id: "fc_1",
              call_id: "call_spawn",
              type: "function_call",
              name: "spawn_agent",
              arguments: "{}",
              status: "completed",
            },
          ],
        },
      } as never);

      const released =
        adapter.formatToolCallsSSE?.([
          {
            id: "call_spawn",
            name: "spawn_agent",
            arguments: "{}",
          },
        ]) ?? [];
      const events = released.map(
        (frame) =>
          JSON.parse(String(frame).replace(/^data: /, "")) as {
            type: string;
            output_index?: number;
            item_id?: string;
            item?: { id?: string; call_id?: string };
            response?: {
              output: Array<{
                id?: string;
                call_id?: string;
                type: string;
              }>;
            };
          },
      );
      const completed = events.find(
        (event) => event.type === "response.completed",
      );
      const completedCallIndex = completed?.response?.output.findIndex(
        (item) => item.type === "function_call",
      );
      const completedCall =
        completed?.response?.output[completedCallIndex ?? -1];
      const callFrames = events.filter(
        (event) => event.type !== "response.completed",
      );

      expect(JSON.stringify(completed), name).toContain(
        "started subagent ABC-1234",
      );
      expect(completedCallIndex, name).toBe(1);
      if (!completedCall) throw new Error(`${name} omitted the completed call`);
      expect(completedCall.id, name).toBe("fc_1");
      for (const frame of callFrames) {
        expect(frame.output_index, name).toBe(completedCallIndex);
        expect(frame.item_id ?? frame.item?.id, name).toBe(completedCall.id);
        if (frame.item?.call_id) {
          expect(frame.item.call_id, name).toBe(completedCall.call_id);
        }
      }
    }
  });

  test.each([
    ["OpenAI", openaiAdapterFactory],
    ["Azure", azureAdapterFactory],
  ])("%s Chat suppresses a suffix for a truncated turn", (_provider, factory) => {
    const chat = factory.createStreamAdapter();
    chat.setTextSuffix?.(() => suffix);
    chat.processChunk(textDelta("partial") as never);
    chat.processChunk(textDelta("", "length") as never);
    expect(String(chat.formatEndSSE())).not.toContain(suffix);
  });

  test("suppresses suffixes for truncated Anthropic and converted Claude turns", () => {
    const anthropic = anthropicAdapterFactory.createStreamAdapter();
    anthropic.setTextSuffix?.(() => suffix);
    anthropic.processChunk({
      type: "message_start",
      message: { usage: {} },
    } as never);
    anthropic.processChunk({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    } as never);
    anthropic.processChunk({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "partial" },
    } as never);
    anthropic.processChunk({ type: "content_block_stop", index: 0 } as never);
    anthropic.processChunk({
      type: "message_delta",
      delta: { stop_reason: "max_tokens" },
    } as never);
    const anthropicEnd = anthropic.processChunk({
      type: "message_stop",
    } as never);
    expect(String(anthropicEnd.sseData)).not.toContain(suffix);

    const routedClaude = makeAnthropicOpenaiAdapterFactory({
      chatcmplId: "chatcmpl_partial",
      createdUnix: 1,
      requestedModel: "claude-test",
    }).createStreamAdapter();
    routedClaude.setTextSuffix?.(() => suffix);
    routedClaude.processChunk({
      type: "message_start",
      message: { usage: {} },
    } as never);
    routedClaude.processChunk({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "partial" },
    } as never);
    routedClaude.processChunk({
      type: "message_delta",
      delta: { stop_reason: "max_tokens" },
    } as never);
    routedClaude.processChunk({ type: "message_stop" } as never);
    expect(String(routedClaude.formatEndSSE())).not.toContain(suffix);

    const responsesFromChat = makeResponsesFromChatAdapterFactory(
      openaiAdapterFactory,
      {
        responseId: "resp_partial",
        createdUnix: 1,
        requestedModel: "gpt-test",
      },
    ).createStreamAdapter();
    responsesFromChat.setTextSuffix?.(() => suffix);
    responsesFromChat.processChunk(textDelta("partial") as never);
    responsesFromChat.processChunk(textDelta("", "length") as never);
    expect(String(responsesFromChat.formatEndSSE())).not.toContain(suffix);
  });

  test.each([
    ["OpenAI", openAiResponsesAdapterFactory],
    ["Azure", azureResponsesAdapterFactory],
  ])("%s Responses does not synthesize a footer once failure is known", (_provider, factory) => {
    const adapter = factory.createStreamAdapter();
    adapter.setTextSuffix?.(() => suffix);
    adapter.processChunk({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      sequence_number: 1,
      delta: "partial",
    } as never);
    expect(
      adapter.processChunk({
        type: "response.output_text.done",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        sequence_number: 2,
        text: "partial",
      } as never).sseData,
    ).toBeNull();

    const failed = adapter.processChunk({
      type: "response.failed",
      sequence_number: 3,
      response: {
        id: "resp_1",
        model: "gpt-test",
        error: { message: "failed" },
      },
    } as never);
    expect(String(failed.sseData)).toContain("partial");
    expect(String(adapter.formatEndSSE())).not.toContain(suffix);
  });

  test.each([
    ["OpenAI", openAiResponsesAdapterFactory],
    ["Azure", azureResponsesAdapterFactory],
  ])("%s Responses binds the footer to its final text part", (_provider, factory) => {
    const adapter = factory.createStreamAdapter();
    adapter.setTextSuffix?.(signedPrefix);
    let sse = String(
      adapter.processChunk({
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        sequence_number: 1,
        delta: "first",
      } as never).sseData,
    );
    adapter.processChunk({
      type: "response.output_text.done",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      sequence_number: 2,
      text: "first",
    } as never);
    adapter.processChunk({
      type: "response.content_part.done",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      sequence_number: 3,
      part: { type: "output_text", text: "first", annotations: [] },
    } as never);
    sse += String(
      adapter.processChunk({
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        content_index: 1,
        sequence_number: 4,
        delta: "second",
      } as never).sseData,
    );
    for (const chunk of [
      {
        type: "response.output_text.done",
        item_id: "msg_1",
        output_index: 0,
        content_index: 1,
        sequence_number: 5,
        text: "second",
      },
      {
        type: "response.content_part.done",
        item_id: "msg_1",
        output_index: 0,
        content_index: 1,
        sequence_number: 6,
        part: { type: "output_text", text: "second", annotations: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        sequence_number: 7,
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "first", annotations: [] },
            { type: "output_text", text: "second", annotations: [] },
          ],
        },
      },
    ]) {
      expect(adapter.processChunk(chunk as never).sseData).toBeNull();
    }
    adapter.processChunk({
      type: "response.completed",
      sequence_number: 8,
      response: {
        id: "resp_1",
        object: "response",
        model: "gpt-test",
        status: "completed",
        output: [
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "first", annotations: [] },
              { type: "output_text", text: "second", annotations: [] },
            ],
          },
        ],
      },
    } as never);

    const output = frames(sse);
    const textDeltas = output.filter(
      (frame) => frame.type === "response.output_text.delta",
    ) as Array<{ delta: string }>;

    expect(textDeltas.map((frame) => frame.delta)).toEqual([
      signedPrefix("first"),
      "\n\nfirst",
      "second",
    ]);
    expect(restoreText(`${textDeltas[0].delta}${textDeltas[1].delta}`)).toEqual(
      {
        text: "first",
        sessionIds: ["parent"],
      },
    );
    expect(JSON.stringify(adapter.toProviderResponse())).not.toContain(
      "protected session",
    );
  });

  test("canonical conversion wrappers preserve their own terminal wire shape", () => {
    const anthropicContext: AnthropicOpenaiContext = {
      chatcmplId: "chatcmpl_1",
      createdUnix: 1,
      requestedModel: "claude-test",
    };
    const routedClaude =
      makeAnthropicOpenaiAdapterFactory(anthropicContext).createStreamAdapter();
    routedClaude.setTextSuffix?.(signedPrefix);
    routedClaude.processChunk({
      type: "message_start",
      message: { usage: {} },
    } as never);
    const routedFirst = routedClaude.processChunk({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "first" },
    } as never);
    const routedSecond = routedClaude.processChunk({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "second" },
    } as never);
    const routedOutput = frames(
      `${routedFirst.sseData}${routedSecond.sseData}${routedClaude.formatEndSSE()}`,
    );
    const routedText = routedOutput
      .map(
        (frame) =>
          (frame.choices as Array<{ delta: { content?: string } }>)[0]?.delta
            .content ?? "",
      )
      .join("");
    expect(restoreText(routedText)).toEqual({
      text: "firstsecond",
      sessionIds: ["parent"],
    });
    expect(JSON.stringify(routedClaude.toProviderResponse())).not.toContain(
      "protected session",
    );

    const responsesFromChat = makeResponsesFromChatAdapterFactory(
      openaiAdapterFactory,
      { responseId: "resp_1", createdUnix: 1, requestedModel: "gpt-test" },
    ).createStreamAdapter();
    responsesFromChat.setTextSuffix?.(signedPrefix);
    responsesFromChat.processChunk(textDelta("first") as never);
    responsesFromChat.processChunk(textDelta("second") as never);
    responsesFromChat.processChunk(textDelta("", "stop") as never);
    const output = frames(String(responsesFromChat.formatEndSSE()));
    expect(output.map((frame) => frame.type)).toContain("response.completed");
    const completed = output.at(-1)?.response as {
      output: Array<{ content: Array<{ text: string }> }>;
    };
    expect(restoreText(completed.output[0].content[0].text)).toEqual({
      text: "firstsecond",
      sessionIds: ["parent"],
    });
    expect(
      JSON.stringify(responsesFromChat.toProviderResponse()),
    ).not.toContain("protected session");
  });
});
