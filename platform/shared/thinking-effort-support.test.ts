import { describe, expect, test } from "vitest";
import { supportsThinkingEffort } from "./thinking-effort-support";

describe("supportsThinkingEffort", () => {
  test.each([
    ["gemini", "gemini-3.6-flash", true],
    ["gemini", "gemini-2.5-flash", false],
    ["openai", "gpt-5.2", true],
    ["openai", "gpt-4o", false],
    ["anthropic", "claude-opus-5", true],
    ["anthropic", "claude-haiku-4-5", false],
  ])("%s/%s -> %s", (provider, modelId, expected) => {
    expect(supportsThinkingEffort(provider, modelId)).toBe(expected);
  });

  test("a model id alone never decides it — the provider gates first", () => {
    // The same id under the wrong provider speaks a different dialect, so the
    // control must not appear for it.
    expect(supportsThinkingEffort("anthropic", "gpt-5.2")).toBe(false);
    expect(supportsThinkingEffort("openai", "claude-opus-5")).toBe(false);
    expect(supportsThinkingEffort("gemini", "gpt-5.2")).toBe(false);
  });

  test.each([
    "bedrock",
    "azure",
    "github-copilot",
    "ollama-native",
    "xai",
    "",
  ])("%s is out until its dialect is wired", (provider) => {
    // Bedrock and Copilot serve some of the very same models, so the false
    // here is the provider's doing, not the id's.
    expect(supportsThinkingEffort(provider, "claude-opus-5")).toBe(false);
    expect(supportsThinkingEffort(provider, "gpt-5.2")).toBe(false);
  });
});
