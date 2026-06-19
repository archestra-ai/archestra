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
});
