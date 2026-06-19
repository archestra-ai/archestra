import { describe, expect, test } from "@/test";
import type { OpenAi } from "@/types";
import { openaiToCohere } from "./cohere-openai-translator";

type OpenAiRequest = OpenAi.Types.ChatCompletionsRequest;

function req(overrides: Partial<OpenAiRequest> = {}): OpenAiRequest {
  return {
    model: "command-a-vision-07-2025",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  } as OpenAiRequest;
}

describe("openaiToCohere — multimodal user content", () => {
  test("forwards an image as an image_url block instead of dropping it", () => {
    const request = req({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAAABBBB" },
            },
          ],
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: minimal multimodal message
    } as any);

    const { cohereBody } = openaiToCohere(request);

    expect(cohereBody.messages[0].content).toEqual([
      { type: "text", text: "describe this" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AAAABBBB" },
      },
    ]);
  });

  test("forwards a web image URL unchanged", () => {
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

    const { cohereBody } = openaiToCohere(request);

    expect(cohereBody.messages[0].content).toEqual([
      { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
    ]);
  });

  test("still passes a plain string user message through unchanged", () => {
    const { cohereBody } = openaiToCohere(req());
    expect(cohereBody.messages[0].content).toBe("hello");
  });
});
