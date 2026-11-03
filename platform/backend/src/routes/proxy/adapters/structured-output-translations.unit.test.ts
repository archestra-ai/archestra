import { describe, expect, test } from "vitest";
import { ChatCompletionRequestSchema } from "@/types/llm-providers/openai/api";
import { openaiToAnthropic } from "./anthropic-openai-translator";
import { openaiToConverse } from "./bedrock-openai-translator";
import { openaiToCohere } from "./cohere-openai-translator";
import { openaiToGemini } from "./gemini-openai-translator";

const formats = [
  { type: "json_object" },
  {
    type: "json_schema",
    json_schema: {
      name: "status_result",
      strict: true,
      schema: {
        type: "object",
        properties: { status: { type: "string", enum: ["ready"] } },
        required: ["status"],
        additionalProperties: false,
      },
    },
  },
];

for (const [provider, translate] of [
  ["anthropic", openaiToAnthropic],
  ["bedrock", openaiToConverse],
  ["cohere", openaiToCohere],
  ["gemini", openaiToGemini],
] as const) {
  describe(`${provider} OpenAI-compatible translation`, () => {
    for (const stream of [false, true]) {
      test.each(
        formats,
      )(`rejects unsupported $type constraints (stream: ${stream})`, (format) => {
        const request = ChatCompletionRequestSchema.parse({
          model: "synthetic-model",
          messages: [{ role: "user", content: "Reply OK." }],
          response_format: format,
          stream,
        });
        expect(() => translate(request)).toThrowError(
          expect.objectContaining({ statusCode: 400 }),
        );
      });
    }
    test("continues to accept the unconstrained text format", () => {
      const request = ChatCompletionRequestSchema.parse({
        model: "synthetic-model",
        messages: [{ role: "user", content: "Reply OK." }],
        response_format: { type: "text" },
      });
      expect(() => translate(request)).not.toThrow();
    });
  });
}
