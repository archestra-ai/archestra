import { describe, expect, it } from "vitest";
import { ChatCompletionResponseSchema } from "./api";

describe("github-copilot ChatCompletionResponseSchema", () => {
  // GitHub Copilot's non-streaming completions are OpenAI-shaped but omit the
  // top-level `created` and `object` fields; the response must still serialize
  // (it previously 500'd on the stricter OpenAI response schema).
  it("accepts a non-streaming response missing created/object", () => {
    const result = ChatCompletionResponseSchema.safeParse({
      id: "chatcmpl-Dqz9PlJXiBJeFr08tCJz1Ns4vzy0x",
      model: "gpt-4o-2024-11-20",
      system_fingerprint: "fp_23ef75ba80",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello from copilot" },
          finish_reason: "stop",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("still accepts a standard response with created/object", () => {
    const result = ChatCompletionResponseSchema.safeParse({
      id: "chatcmpl-x",
      object: "chat.completion",
      created: 1781520491,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});
