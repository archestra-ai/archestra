import { describe, expect, test } from "@/test";
import type { OpenAi } from "@/types";
import { openaiToAnthropic } from "./anthropic-openai-translator";

type OpenAiRequest = OpenAi.Types.ChatCompletionsRequest;

function req(overrides: Partial<OpenAiRequest> = {}): OpenAiRequest {
  return {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  } as OpenAiRequest;
}

describe("openaiToAnthropic — multimodal user content", () => {
  test("forwards a base64 image as an image block instead of dropping it", () => {
    const request = req({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            {
              type: "image_url",
              image_url: { url: "data:image/jpeg;base64,AAAABBBB" },
            },
          ],
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: minimal multimodal message
    } as any);

    const { anthropicBody } = openaiToAnthropic(request);

    expect(anthropicBody.messages[0].content).toEqual([
      { type: "text", text: "describe this" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "AAAABBBB" },
      },
    ]);
  });

  test("forwards an http image URL as a url source block", () => {
    const request = req({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "https://example.com/cat.png" },
            },
          ],
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: minimal multimodal message
    } as any);

    const { anthropicBody } = openaiToAnthropic(request);

    expect(anthropicBody.messages[0].content).toEqual([
      {
        type: "image",
        source: { type: "url", url: "https://example.com/cat.png" },
      },
    ]);
  });

  test("forwards a base64 PDF file as a document block", () => {
    const request = req({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              file: {
                filename: "report.pdf",
                file_data: "data:application/pdf;base64,JVBERi0=",
              },
            },
          ],
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: minimal multimodal message
    } as any);

    const { anthropicBody } = openaiToAnthropic(request);

    expect(anthropicBody.messages[0].content).toEqual([
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "JVBERi0=",
        },
      },
    ]);
  });

  test("still passes a plain string user message through unchanged", () => {
    const { anthropicBody } = openaiToAnthropic(req());
    expect(anthropicBody.messages[0].content).toBe("hello");
  });

  test("forwards images inside a tool result as image blocks", () => {
    const request = req({
      messages: [
        { role: "user", content: "go" },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [
            { type: "text", text: "here is the chart" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,Q0hBUlQ=" },
            },
          ],
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: minimal tool-result message
    } as any);

    const { anthropicBody } = openaiToAnthropic(request);
    // messages[0] is the user turn; messages[1] carries the tool_result.
    expect(anthropicBody.messages[1].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "call_1",
        content: [
          { type: "text", text: "here is the chart" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "Q0hBUlQ=",
            },
          },
        ],
      },
    ]);
  });

  test("falls back to text for a tool result with no convertible media", () => {
    const request = req({
      messages: [
        { role: "user", content: "go" },
        { role: "tool", tool_call_id: "call_1", content: "plain result" },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: minimal tool-result message
    } as any);

    const { anthropicBody } = openaiToAnthropic(request);
    expect(anthropicBody.messages[1].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "call_1",
        content: "plain result",
      },
    ]);
  });
});
