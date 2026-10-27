import { describe, expect, test } from "vitest";
import { openCodeReviewQuestion } from "@/proxy/plugins/appa-plugin-archestra/adapters/opencode-review";
import { anthropicAdapterFactory } from "./anthropic";
import { openaiAdapterFactory } from "./openai";
import { openAiResponsesAdapterFactory } from "./openai-responses";

describe.each([
  ["chat", openaiAdapterFactory],
  ["responses", openAiResponsesAdapterFactory],
  ["anthropic", anthropicAdapterFactory],
] as const)("%s OpenCode-family review transport", (kind, factory) => {
  test.each([
    false,
    true,
  ])("preserves exact native input and binding ID (full review: %s)", (full) => {
    const question = openCodeReviewQuestion(
      {
        question: "Canonical policy review",
        shortQuestion: "Run bash?",
        callPreview: "command: Inspect for the complete value",
        header: "Tool call",
        options: [
          { label: "Allow", preview: "Coverage: only this call" },
          { label: "Deny" },
          { label: "Inspect" },
        ],
        remedy_offer_ids: ["offer-test"],
      },
      full
        ? `Exact arguments:\n${JSON.stringify({ command: `echo "${"λ\\n".repeat(3000)}"` })}`
        : undefined,
    );
    const input = {
      questions: [
        {
          question,
          header: "Tool call",
          options: [{ label: "Allow", description: "Approve this call" }],
        },
      ],
    };
    const calls = [
      {
        id: "original",
        wireId: "aq2_bound",
        name: "question",
        arguments: JSON.stringify(input),
      },
    ];
    const original = {
      id: "response",
      object: "response",
      created_at: 0,
      model: "fixture",
      status: "completed",
      type: "message",
      role: "assistant",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      content: [
        { type: "tool_use", id: "original", name: "ask_user", input: {} },
      ],
      output: [
        {
          type: "function_call",
          id: "item",
          call_id: "original",
          name: "ask_user",
          arguments: "{}",
          status: "completed",
        },
      ],
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "original",
                type: "function",
                function: { name: "ask_user", arguments: "{}" },
              },
            ],
          },
        },
      ],
    };
    const rewritten = factory
      .createResponseAdapter(original as never)
      .withRewrittenToolCalls?.(calls);
    const read = factory
      .createResponseAdapter(rewritten as never)
      .getToolCalls();
    expect(read).toMatchObject([
      { id: "aq2_bound", name: "question", arguments: input },
    ]);

    const stream = factory.createStreamAdapter();
    const frames = (stream.formatToolCallsSSE?.(calls) ?? []).flatMap((frame) =>
      String(frame)
        .split("\n")
        .filter((line) => line.startsWith("data: ") && !line.endsWith("[DONE]"))
        .map((line) => JSON.parse(line.slice(6))),
    );
    if (kind === "chat") {
      expect(frames[0].choices[0].delta.tool_calls[0]).toMatchObject({
        id: "aq2_bound",
        function: { name: "question", arguments: JSON.stringify(input) },
      });
    } else if (kind === "responses") {
      expect(
        frames.find((frame) => frame.type === "response.output_item.done").item,
      ).toMatchObject({
        call_id: "aq2_bound",
        name: "question",
        arguments: JSON.stringify(input),
      });
    } else {
      expect(
        frames.find((frame) => frame.type === "content_block_start")
          .content_block,
      ).toMatchObject({ id: "aq2_bound", name: "question" });
      expect(
        JSON.parse(
          frames
            .filter((frame) => frame.delta?.partial_json)
            .map((frame) => frame.delta.partial_json)
            .join(""),
        ),
      ).toEqual(input);
    }
  });
});
