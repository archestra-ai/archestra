// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  describeModelOrigin,
  formatRequestCost,
  formatSessionSpan,
  formatUsageCost,
  identiconHue,
  initialsOf,
  isFreeTierModel,
  sessionTitleOf,
  shortModelName,
} from "./logs-table-format";

describe("shortModelName", () => {
  it.each([
    ["claude-opus-4-1-20250805", "Opus 4.1"],
    ["claude-sonnet-4-20250514", "Sonnet 4"],
    ["claude-3-5-sonnet-20241022", "Sonnet 3.5"],
    ["anthropic/claude-opus-4.8", "Opus 4.8"],
    // Bedrock: region + vendor prefix, version suffix, then a date.
    ["us.anthropic.claude-sonnet-4-20250514-v1:0", "Sonnet 4"],
    ["gpt-5.4-mini", "GPT-5.4 mini"],
    ["gpt-4o-2024-08-06", "GPT-4o"],
    ["text-embedding-3-small", "Embedding 3 small"],
    ["gemini-2.5-pro", "Gemini 2.5 Pro"],
    ["meta-llama/llama-3.3-70b-instruct:free", "Llama 3.3 70B"],
    // An Ollama size tag is part of the name, unlike `:free`.
    ["qwen2.5:7b", "Qwen2.5 7B"],
    ["mistral-large-latest", "Mistral large"],
  ])("%s → %s", (model, expected) => {
    expect(shortModelName(model)).toBe(expected);
  });
});

describe("describeModelOrigin", () => {
  it("names the maker from the model id, whichever provider served it", () => {
    expect(
      describeModelOrigin({
        model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
        interactionType: "bedrock:converse",
      }),
    ).toEqual({ kind: "maker", provider: "anthropic", name: "Anthropic" });
    expect(
      describeModelOrigin({
        model: "gemini-2.5-pro",
        interactionType: null,
      }),
    ).toEqual({ kind: "maker", provider: "gemini", name: "Google" });
  });

  it("falls back to an aggregator that served an unrecognised model", () => {
    expect(
      describeModelOrigin({
        model: "some-lab/mystery-7b",
        interactionType: "openrouter:chatCompletions",
      }),
    ).toEqual({ kind: "aggregator", provider: "openrouter" });
  });

  it("does not credit a first-party provider with a model it did not make", () => {
    // OpenAI's endpoint serving an unknown id is not evidence OpenAI made it.
    expect(
      describeModelOrigin({
        model: "llama-3.3-70b-instruct",
        interactionType: "openai:chatCompletions",
      }),
    ).toEqual({ kind: "unknown", name: "Meta" });
  });

  it.each([
    ["qwen/qwen3-coder", "Qwen"],
    ["acme-labs/widget-1", "Acme"],
    ["my-finetune", "Self-hosted"],
  ])("guesses a vendor for %s instead of 'Unknown provider'", (model, name) => {
    expect(describeModelOrigin({ model, interactionType: null })).toEqual({
      kind: "unknown",
      name,
    });
  });
});

describe("isFreeTierModel", () => {
  it("recognises OpenRouter's :free variants only", () => {
    expect(isFreeTierModel("meta-llama/llama-3.3-70b-instruct:free")).toBe(
      true,
    );
    expect(isFreeTierModel("freebie-model")).toBe(false);
  });
});

describe("formatUsageCost", () => {
  it.each([
    [0, "$0"],
    // Sub-cent spend must not read as free.
    [0.00004, "<$0.01"],
    [0.01, "$0.01"],
    [12.345, "$12.35"],
    [1234, "$1.2K"],
  ])("%s → %s", (value, expected) => {
    expect(formatUsageCost(value)).toBe(expected);
  });
});

describe("formatRequestCost", () => {
  it("keeps sub-cent requests distinguishable instead of all reading <$0.01", () => {
    expect(formatRequestCost(0.00501)).toBe("$0.005");
    expect(formatRequestCost(0.0012)).toBe("$0.0012");
    expect(formatRequestCost(0.0612)).toBe("$0.061");
  });

  it("shows whole cents from ten cents up", () => {
    expect(formatRequestCost(0.4812)).toBe("$0.48");
    expect(formatRequestCost(12.5)).toBe("$12.50");
  });

  it("floors dust and reads zero as zero", () => {
    expect(formatRequestCost(0.00002)).toBe("<$0.0001");
    expect(formatRequestCost(0)).toBe("$0");
  });
});

describe("formatSessionSpan", () => {
  const start = "2026-08-23T16:00:00.000Z";
  it.each([
    ["2026-08-23T16:00:00.250Z", "250ms"],
    ["2026-08-23T16:00:42.000Z", "42s"],
    ["2026-08-23T16:10:30.000Z", "10m"],
    ["2026-08-23T18:00:00.000Z", "2h"],
    ["2026-08-23T18:05:00.000Z", "2h 5m"],
    ["2026-08-25T19:00:00.000Z", "2d 3h"],
  ])("%s → %s", (end, expected) => {
    expect(formatSessionSpan(start, end)).toBe(expected);
  });
});

describe("initialsOf", () => {
  it.each([
    ["Priya Raman", "PR"],
    ["ci-runner", "CR"],
    ["Ada", "A"],
    ["  ", "?"],
  ])("%s → %s", (name, expected) => {
    expect(initialsOf(name)).toBe(expected);
  });
});

describe("identiconHue", () => {
  it("is stable for a seed and lands on one of 12 evenly spaced hues", () => {
    const seeds = Array.from({ length: 200 }, (_, i) => `agent-${i}`);
    const hues = new Set(seeds.map(identiconHue));
    expect(identiconHue("agent-1")).toBe(identiconHue("agent-1"));
    for (const hue of hues) {
      expect((hue - 18) % 30).toBe(0);
      expect(hue).toBeGreaterThanOrEqual(18);
      expect(hue).toBeLessThan(360);
    }
    // Spread, not a single colour for everyone.
    expect(hues.size).toBe(12);
  });
});

describe("sessionTitleOf", () => {
  it("prefers a generated title over the message preview", () => {
    expect(
      sessionTitleOf({
        claudeCodeTitle: "Fix checkout latency",
        lastUserMessagePreview: "hello",
      }),
    ).toBe("Fix checkout latency");
  });

  it("strips coding-client harness markup from the preview", () => {
    expect(
      sessionTitleOf({
        lastUserMessagePreview:
          'The user sent a new message while you were working:\n<pasted_content id="eea9">\nReview of 30966b628: three low items\n</pasted_content>',
      }),
    ).toBe("Review of 30966b628: three low items");
    expect(
      sessionTitleOf({
        lastUserMessagePreview:
          "<system-reminder>\nContents of AGENTS.md …\n</system-reminder>\nWhy is CI red?",
      }),
    ).toBe("Why is CI red?");
  });

  it("returns null when the preview is only markup", () => {
    expect(
      sessionTitleOf({
        lastUserMessagePreview: "<system-reminder>\nContents of AGENTS.md …",
      }),
    ).toBeNull();
  });
});

describe("sessionTitleOf markdown", () => {
  it("drops Markdown and HTML-entity syntax from the preview", () => {
    expect(
      sessionTitleOf({
        lastUserMessagePreview:
          "> Four concurrent clients: **860 → 178 events/sec**, about `79%` lower.&#x20;Too high &amp; slow.",
      }),
    ).toBe(
      "Four concurrent clients: 860 → 178 events/sec, about 79% lower. Too high & slow.",
    );
  });
});
