import { describe, expect, test } from "@/test";
import type { OpenAi } from "@/types";
import { openaiToGemini } from "./gemini-openai-translator";

type OpenAiRequest = OpenAi.Types.ChatCompletionsRequest;

// the translator emits `tools: [{ functionDeclarations: [...] }]`; the Gemini
// `tools` field is a wider union, so reach the parameters through this shape.
type SanitizedToolParams = {
  properties: Record<string, { enum?: unknown; description?: string }>;
};
type EmittedTools = Array<{
  functionDeclarations: Array<{ parameters: SanitizedToolParams }>;
}>;

function req(overrides: Partial<OpenAiRequest> = {}): OpenAiRequest {
  return {
    model: "gemini-2.5-pro",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  } as OpenAiRequest;
}

function firstToolParams(tools: unknown): SanitizedToolParams {
  return (tools as EmittedTools)[0].functionDeclarations[0].parameters;
}

describe("openaiToGemini — tool schema sanitization", () => {
  // the OpenAI-compatible Gemini path must run tool parameters through the same
  // sanitizer as the native adapter, or a non-string enum 400s at Gemini.
  test("strips a non-string enum from tool parameters", () => {
    const request = req({
      tools: [
        {
          type: "function",
          function: {
            name: "set_flag",
            description: "toggle a flag",
            parameters: {
              type: "object",
              properties: {
                enabled: { type: "boolean", enum: [true] },
              },
            },
          },
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: minimal tool shape for the test
    } as any);

    const { geminiBody } = openaiToGemini(request);
    const params = firstToolParams(geminiBody.tools);

    expect(params.properties.enabled.enum).toBeUndefined();
    // the dropped literal is folded into the description so the hint survives.
    expect(params.properties.enabled.description).toContain("true");
  });

  test("leaves a string enum untouched", () => {
    const request = req({
      tools: [
        {
          type: "function",
          function: {
            name: "pick",
            description: "pick one",
            parameters: {
              type: "object",
              properties: {
                color: { type: "string", enum: ["red", "green"] },
              },
            },
          },
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: minimal tool shape for the test
    } as any);

    const { geminiBody } = openaiToGemini(request);
    const params = firstToolParams(geminiBody.tools);

    expect(params.properties.color.enum).toEqual(["red", "green"]);
  });
});

describe("openaiToGemini — multimodal user content", () => {
  test("forwards a base64 image as inlineData instead of dropping it", () => {
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

    const { geminiBody } = openaiToGemini(request);

    expect(geminiBody.contents[0].parts).toEqual([
      { text: "describe this" },
      { inlineData: { mimeType: "image/png", data: "AAAABBBB" } },
    ]);
  });

  test("drops an http image URL Gemini cannot inline, keeping the text", () => {
    const request = req({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            {
              type: "image_url",
              image_url: { url: "https://example.com/cat.png" },
            },
          ],
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: minimal multimodal message
    } as any);

    const { geminiBody } = openaiToGemini(request);

    // Gemini's fileData accepts only Files API / gs:// URIs, so a plain web URL
    // is dropped rather than forwarded as an invalid fileData reference.
    expect(geminiBody.contents[0].parts).toEqual([{ text: "look at this" }]);
  });

  test("forwards base64 input_audio as inlineData", () => {
    const request = req({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: { data: "QUJD", format: "wav" },
            },
          ],
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: minimal multimodal message
    } as any);

    const { geminiBody } = openaiToGemini(request);

    expect(geminiBody.contents[0].parts).toEqual([
      { inlineData: { mimeType: "audio/wav", data: "QUJD" } },
    ]);
  });

  test("still emits a plain text part for a string user message", () => {
    const { geminiBody } = openaiToGemini(req());
    expect(geminiBody.contents[0].parts).toEqual([{ text: "hello" }]);
  });

  test("forwards tool-result text into the functionResponse payload", () => {
    const request = req({
      messages: [
        { role: "user", content: "go" },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [{ type: "text", text: "the result" }],
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: minimal tool-result message
    } as any);

    const { geminiBody } = openaiToGemini(request);
    // contents[0] is the user message; contents[1] is the tool result.
    expect(geminiBody.contents[1].parts).toEqual([
      {
        functionResponse: {
          id: "call_1",
          name: "tool_result",
          response: { content: "the result" },
        },
      },
    ]);
  });
});
