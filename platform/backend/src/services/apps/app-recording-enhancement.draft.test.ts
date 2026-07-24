import { beforeEach, describe, expect, test, vi } from "vitest";

// The LLM boundary is mocked; the loop logic (per-field independence, partial
// fallback, empty-transcript short-circuit) is exercised for real.
vi.mock("@/logging");
vi.mock("@/utils/generate-tagged-text", () => ({
  generateTaggedText: vi.fn(),
}));
vi.mock("@/clients/llm-client", () => ({
  createLLMModel: vi.fn(() => ({})),
}));
vi.mock("@/utils/llm-resolution", () => ({
  resolveAgentLlmOrDefault: vi.fn(async () => ({
    provider: "anthropic",
    modelName: "claude",
    apiKey: "key",
    baseUrl: null,
  })),
}));

import { generateTaggedText } from "@/utils/generate-tagged-text";
import { draftRecordingEnhancement } from "./app-recording-enhancement";

const mockGenerate = vi.mocked(generateTaggedText);

/** Answer each tagged field from a map; a value of Error rejects that field. */
function fieldsBy(map: Record<string, string | null | Error>) {
  mockGenerate.mockImplementation(async (params: { tag: string }) => {
    const value = map[params.tag];
    if (value instanceof Error) throw value;
    return value ?? null;
  });
}

const baseParams = {
  appName: "AI Slop Police",
  conversationId: "conv-1",
  chatModel: null,
  agent: null,
  messages: [{ role: "user", parts: [{ type: "text", text: "build me x" }] }],
  organizationId: "org-1",
  userId: "user-1",
};

describe("draftRecordingEnhancement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("a failed field never discards a build prompt that generated cleanly", async () => {
    // The exact regression the old Promise.all had: one field rejecting sank
    // all four, so a flaky category/response call threw away a good prompt.
    fieldsBy({
      build_prompt: "Build me an AI slop detector",
      description: "Roasts robotic Slack messages.",
      closing_response: new Error("content filter"),
      category: new Error("429 rate limited"),
    });

    const result = await draftRecordingEnhancement(baseParams);

    expect(result.prompt).toBe("Build me an AI slop detector");
    expect(result.description).toBe("Roasts robotic Slack messages.");
    expect(result.response).toBeNull();
    expect(result.category).toBeNull();
  });

  test("returns the description partial when no candidate produces a build prompt", async () => {
    fieldsBy({
      build_prompt: null,
      description: "Roasts robotic Slack messages.",
      closing_response: null,
      category: null,
    });

    const result = await draftRecordingEnhancement(baseParams);

    // A missing prompt no longer throws the good description away.
    expect(result.prompt).toBeNull();
    expect(result.description).toBe("Roasts robotic Slack messages.");
  });

  test("accepts an over-length build prompt after asking the model to shorten it to fit", async () => {
    const tooLong = `${"word ".repeat(300).trim()}.`; // > the 256-word ceiling
    const shortened = "Build me a Slack bot that roasts robotic messages.";
    mockGenerate.mockImplementation(
      async (params: { tag: string; prompt: string }) => {
        if (params.tag === "build_prompt") {
          // The shorten re-ask is fed the over-length text with a "too long"
          // instruction; distinguish the two calls by that.
          return params.prompt.includes("too long") ? shortened : tooLong;
        }
        return null;
      },
    );

    const result = await draftRecordingEnhancement(baseParams);

    // The model-shortened rewrite is used — no hard trim needed.
    expect(result.prompt).toBe(shortened);
    // Two calls for the field: the draft, then the shorten re-ask.
    const buildPromptCalls = mockGenerate.mock.calls.filter(
      ([p]) => (p as { tag: string }).tag === "build_prompt",
    );
    expect(buildPromptCalls).toHaveLength(2);
  });

  test("hard-trims to the limit only as a last resort, when even the shortened prompt is over", async () => {
    const stillTooLong = `${"word ".repeat(300).trim()}.`;
    mockGenerate.mockImplementation(async (params: { tag: string }) =>
      params.tag === "build_prompt" ? stillTooLong : null,
    );

    const result = await draftRecordingEnhancement(baseParams);

    // Never blocked and never over the limit: the clamp is the last resort.
    expect(result.prompt).not.toBeNull();
    expect(
      (result.prompt ?? "").split(" ").filter(Boolean).length,
    ).toBeLessThanOrEqual(256);
  });

  test("short-circuits to an empty draft without calling the model when the transcript is empty", async () => {
    const result = await draftRecordingEnhancement({
      ...baseParams,
      messages: [],
    });

    expect(result).toEqual({
      description: null,
      prompt: null,
      response: null,
      category: null,
    });
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
