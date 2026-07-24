import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { extractTaggedText, generateTaggedText } from "./generate-tagged-text";

describe("extractTaggedText", () => {
  it("extracts the content inside the tag", () => {
    expect(extractTaggedText("<x>hello</x>", "x")).toBe("hello");
  });

  it("ignores reasoning or prose outside the tag", () => {
    const raw = "Let me think...\n<x>the answer</x>\nDone.";
    expect(extractTaggedText(raw, "x")).toBe("the answer");
  });

  it("trims surrounding whitespace inside the tag", () => {
    expect(extractTaggedText("<x>\n  spaced  \n</x>", "x")).toBe("spaced");
  });

  it("returns null when the tag is absent", () => {
    expect(extractTaggedText("just a bare sentence", "x")).toBeNull();
  });

  it("returns null when the closing tag is missing", () => {
    expect(extractTaggedText("<x>unterminated", "x")).toBeNull();
  });

  it("returns null when the tag wraps only whitespace", () => {
    expect(extractTaggedText("<x>   </x>", "x")).toBeNull();
  });
});

describe("generateTaggedText", () => {
  it("returns the tagged content from a first attempt that honors the contract", async () => {
    const model = modelReturning({ text: "<x>the answer</x>" });

    const result = await callWith(model);

    expect(result).toBe("the answer");
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  // An untagged-but-complete answer is disobedience: the correction turn shows
  // the model its own reply and re-states the contract, under the same ceiling.
  it("retries an untagged answer with a correction turn at the original ceiling", async () => {
    const model = modelReturning(
      { text: "the answer, untagged" },
      { text: "<x>the answer</x>" },
    );

    const result = await callWith(model);

    expect(result).toBe("the answer");
    expect(model.doGenerateCalls).toHaveLength(2);
    const [, correction] = model.doGenerateCalls;
    expect(correction.maxOutputTokens).toBe(1000);
    expect(correction.prompt.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
  });

  // Truncation is not disobedience: the model ran out of room (a reasoning
  // model can burn the whole budget on hidden thinking), so the retry re-asks
  // the ORIGINAL question with more room rather than paying for the same
  // truncation twice.
  it("retries a length-truncated attempt with more headroom, not a correction", async () => {
    const model = modelReturning(
      { text: "<x>cut off mid-ans", finishReason: "length" },
      { text: "<x>the answer</x>" },
    );

    const result = await callWith(model);

    expect(result).toBe("the answer");
    expect(model.doGenerateCalls).toHaveLength(2);
    const [, headroom] = model.doGenerateCalls;
    expect(headroom.maxOutputTokens).toBe(2000);
    // The original single-turn ask, not the model's truncated reply back at it.
    expect(headroom.prompt.map((message) => message.role)).toEqual([
      "system",
      "user",
    ]);
  });

  // Nothing to double when the caller set no ceiling, so the correction turn
  // stays the fallback.
  it("falls back to the correction turn when truncated with no ceiling set", async () => {
    const model = modelReturning(
      { text: "", finishReason: "length" },
      { text: "<x>the answer</x>" },
    );

    const result = await generateTaggedText({
      model,
      tag: "x",
      system: "be brief",
      prompt: "the question",
    });

    expect(result).toBe("the answer");
    expect(model.doGenerateCalls[1].prompt.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
  });

  it("returns null after one failed retry rather than salvaging raw output", async () => {
    const model = modelReturning(
      { text: "still untagged" },
      { text: "untagged again" },
    );

    expect(await callWith(model)).toBeNull();
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("returns null when the sanitized answer is empty", async () => {
    const model = modelReturning({ text: "<x>...</x>" });

    const result = await generateTaggedText({
      model,
      tag: "x",
      system: "be brief",
      prompt: "the question",
      sanitize: (text) => text.replace(/\./g, ""),
    });

    expect(result).toBeNull();
  });
});

function callWith(model: MockLanguageModelV3) {
  return generateTaggedText({
    model,
    tag: "x",
    system: "be brief",
    prompt: "the question",
    maxOutputTokens: 1000,
  });
}

// A model whose `doGenerate` walks the supplied turns; the last entry repeats so
// an unexpected extra attempt fails on assertions, not on setup.
function modelReturning(
  ...turns: { text: string; finishReason?: "stop" | "length" }[]
): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const turn = turns[Math.min(call, turns.length - 1)];
      call++;
      const unified = turn.finishReason ?? "stop";
      return {
        content: turn.text ? [{ type: "text" as const, text: turn.text }] : [],
        finishReason: { unified, raw: unified },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 2, text: 2, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}
