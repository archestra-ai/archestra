import { describe, expect, test } from "vitest";
import {
  estimateBedrockPromptTokens,
  isBedrockPromptOverBudget,
} from "./bedrock-prompt-budget";

const MODEL = "global.anthropic.claude-sonnet-4-6";

describe("Bedrock prompt budget", () => {
  test("counts Converse text, system content, and structured tool results", () => {
    const short = {
      system: [{ text: "Be concise." }],
      messages: [{ role: "user", content: [{ text: "Hello" }] }],
    };
    const withToolResult = {
      ...short,
      messages: [
        ...short.messages,
        {
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: "call-1",
                content: [{ json: { result: "large ".repeat(200) } }],
              },
            },
          ],
        },
      ],
    };
    expect(estimateBedrockPromptTokens(withToolResult, MODEL)).toBeGreaterThan(
      estimateBedrockPromptTokens(short, MODEL),
    );
    expect(isBedrockPromptOverBudget(short, MODEL, 100)).toBe(false);
    expect(isBedrockPromptOverBudget(withToolResult, MODEL, 100)).toBe(true);
  });

  test("allows prompts above 85% of the window and catches clear overflow", () => {
    const request = (tokens: number) => ({
      inferenceConfig: { maxTokens: 1 },
      messages: [{ role: "user", content: [{ text: "a ".repeat(tokens) }] }],
    });
    expect(isBedrockPromptOverBudget(request(175_000), MODEL, 200_000)).toBe(
      false,
    );
    expect(isBedrockPromptOverBudget(request(210_000), MODEL, 200_000)).toBe(
      true,
    );
  });

  test("does not count encoded binary media as text", () => {
    const request = {
      messages: [
        {
          role: "user",
          content: [
            { image: { format: "png", source: { bytes: "a".repeat(5000) } } },
          ],
        },
      ],
    };
    expect(isBedrockPromptOverBudget(request, MODEL, 100)).toBe(false);
    expect(isBedrockPromptOverBudget(request, MODEL, null)).toBe(false);
  });
});
