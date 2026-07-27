import { beforeEach, describe, expect, it, vi } from "vitest";

// generateText is the model boundary; mock it so the retry policy (headroom on
// truncation vs correction turn on disobedience) is exercised deterministically.
vi.mock("@/logging");
vi.mock("ai", () => ({ generateText: vi.fn() }));

import { generateText } from "ai";
import { generateTaggedText } from "./generate-tagged-text";

const mockGen = vi.mocked(generateText);
type GenResult = Awaited<ReturnType<typeof generateText>>;
type GenParams = Parameters<typeof generateTaggedText>[0];

/** Minimal generateText result: only text + finishReason are read. */
function res(text: string, finishReason: "stop" | "length"): GenResult {
  return { text, finishReason } as unknown as GenResult;
}

const MODEL = {} as unknown as GenParams["model"];

/** Run one draft with the fixed inputs the mocked responses answer. */
function runDraft() {
  return generateTaggedText({
    model: MODEL,
    tag: "x",
    system: "sys",
    prompt: "the ask",
    maxOutputTokens: 100,
  });
}

describe("generateTaggedText retry policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries a `length` truncation with DOUBLE the room and a fresh prompt, not a correction turn", async () => {
    // Truncated mid-answer (no closing tag), then the full answer with headroom.
    mockGen
      .mockResolvedValueOnce(res("<x>the ans", "length"))
      .mockResolvedValueOnce(res("<x>the answer</x>", "stop"));

    const result = await runDraft();

    expect(result).toBe("the answer");
    expect(mockGen).toHaveBeenCalledTimes(2);
    // First call: the caller's ceiling. Second: doubled, and STILL a fresh
    // `prompt` (re-ask with more room), never a same-budget `messages` turn.
    expect(mockGen.mock.calls[0][0].maxOutputTokens).toBe(100);
    expect(mockGen.mock.calls[1][0].maxOutputTokens).toBe(200);
    expect(mockGen.mock.calls[1][0].prompt).toBe("the ask");
    expect(mockGen.mock.calls[1][0].messages).toBeUndefined();
  });

  it("sends a same-budget correction turn when the model finished but skipped the tag", async () => {
    mockGen
      .mockResolvedValueOnce(res("no tag here, sorry", "stop"))
      .mockResolvedValueOnce(res("<x>fixed</x>", "stop"));

    const result = await runDraft();

    expect(result).toBe("fixed");
    // Correction turn: same budget, and a messages array showing it its reply.
    expect(mockGen.mock.calls[1][0].maxOutputTokens).toBe(100);
    expect(Array.isArray(mockGen.mock.calls[1][0].messages)).toBe(true);
    expect(mockGen.mock.calls[1][0].prompt).toBeUndefined();
  });

  it("returns null when even the headroom retry truncates again", async () => {
    mockGen
      .mockResolvedValueOnce(res("<x>trunc", "length"))
      .mockResolvedValueOnce(res("<x>still trunc", "length"));

    expect(await runDraft()).toBeNull();
  });
});
