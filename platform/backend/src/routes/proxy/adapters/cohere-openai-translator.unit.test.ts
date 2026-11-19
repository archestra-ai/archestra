import { describe, expect, test } from "vitest";
import type { OpenAi } from "@/types";
import {
  mapCohereFinishReason,
  openaiToCohere,
} from "./cohere-openai-translator";

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

describe("openaiToCohere — output cap", () => {
  test.each([
    [undefined, 32, 32],
    [64, 32, 32],
    [64, null, 64],
    [64, undefined, 64],
  ])("maps max_tokens %s and max_completion_tokens %s to %s", (max_tokens, max_completion_tokens, expected) => {
    const { cohereBody } = openaiToCohere(
      req({ max_tokens, max_completion_tokens }),
    );
    expect(cohereBody.max_tokens).toBe(expected);
  });

  test("omits max_tokens when neither cap is set", () => {
    const { cohereBody } = openaiToCohere(req());
    expect(cohereBody.max_tokens).toBeUndefined();
  });
});

describe("mapCohereFinishReason", () => {
  test.each([
    ["COMPLETE", "stop"],
    ["STOP_SEQUENCE", "stop"],
    ["MAX_TOKENS", "length"],
    // A generation that ran out of time is cut off, not finished.
    ["TIMEOUT", "length"],
    ["TOOL_CALL", "tool_calls"],
    ["ERROR", "content_filter"],
    // Sent by Cohere's older API for a reply it judged toxic.
    ["ERROR_TOXIC", "content_filter"],
  ])("%s → %s", (reason, expected) => {
    expect(mapCohereFinishReason(reason)).toBe(expected);
  });
});
