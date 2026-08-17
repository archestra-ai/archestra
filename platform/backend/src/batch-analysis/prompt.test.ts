import { describe, expect, test } from "@/test";
import type { BatchAnalysisColumn } from "@/types";
import {
  BATCH_ANALYSIS_RESULT_TAG,
  buildBatchAnalysisSystemPrompt,
  buildBatchAnalysisUserPrompt,
  isQuoteGrounded,
  NOT_FOUND_VALUE,
  parseBatchAnalysisResult,
} from "./prompt";

const columns: BatchAnalysisColumn[] = [
  {
    key: "effective_date",
    name: "Effective date",
    prompt: "When does it take effect?",
    format: "date",
  },
  {
    key: "has_sso",
    name: "SSO supported",
    prompt: "Is SSO supported?",
    format: "boolean",
  },
];

describe("buildBatchAnalysisUserPrompt", () => {
  test("includes every column key and its format instruction", () => {
    const prompt = buildBatchAnalysisUserPrompt({
      label: "Vendor questionnaire",
      sourceText: "Effective 2026-01-01. SSO is supported via SAML.",
      columns,
      truncated: false,
    });

    expect(prompt).toContain("key: effective_date");
    expect(prompt).toContain("key: has_sso");
    expect(prompt).toContain("YYYY-MM-DD");
    expect(prompt).toContain('exactly "yes" or "no"');
    expect(prompt).toContain("Vendor questionnaire");
    expect(prompt).toContain("Effective 2026-01-01");
  });

  test("tells the model when the source was truncated", () => {
    const full = buildBatchAnalysisUserPrompt({
      label: "doc",
      sourceText: "text",
      columns,
      truncated: false,
    });
    const cut = buildBatchAnalysisUserPrompt({
      label: "doc",
      sourceText: "text",
      columns,
      truncated: true,
    });

    expect(full).not.toContain("truncated");
    // A model answering from a partial source must know it is partial, or an
    // absent clause reads as "not present" rather than "not shown".
    expect(cut).toContain("truncated");
  });

  test("system prompt names the result tag and forbids outside knowledge", () => {
    const system = buildBatchAnalysisSystemPrompt();
    expect(system).toContain(`<${BATCH_ANALYSIS_RESULT_TAG}>`);
    expect(system).toContain("Never use outside knowledge");
    expect(system).toContain(NOT_FOUND_VALUE);
  });
});

describe("parseBatchAnalysisResult", () => {
  test("parses values and quotes", () => {
    const result = parseBatchAnalysisResult(
      JSON.stringify({
        effective_date: { value: "2026-01-01", quote: "Effective 2026-01-01" },
        has_sso: { value: "yes", quote: "SSO is supported" },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers.get("effective_date")).toEqual({
      value: "2026-01-01",
      quote: "Effective 2026-01-01",
    });
    expect(result.answers.get("has_sso")?.value).toBe("yes");
  });

  test("coerces non-string scalars rather than rejecting them", () => {
    // A model answering a number column with a JSON number is answering
    // correctly; refusing that would fail a good response on a technicality.
    const result = parseBatchAnalysisResult(
      JSON.stringify({ seats: { value: 250, quote: null } }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers.get("seats")).toEqual({ value: "250", quote: null });
  });

  test("strips a markdown code fence around the JSON", () => {
    const result = parseBatchAnalysisResult(
      '```json\n{"a": {"value": "x"}}\n```',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers.get("a")?.value).toBe("x");
  });

  test("normalizes an empty answer to the not-found sentinel", () => {
    const result = parseBatchAnalysisResult(
      JSON.stringify({ a: { value: "   ", quote: "  " } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers.get("a")).toEqual({
      value: NOT_FOUND_VALUE,
      quote: null,
    });
  });

  test("rejects malformed JSON instead of guessing", () => {
    const result = parseBatchAnalysisResult("{not json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not valid JSON");
  });

  test("rejects a structurally wrong envelope", () => {
    const result = parseBatchAnalysisResult(
      JSON.stringify({ a: "just a string" }),
    );
    expect(result.ok).toBe(false);
  });

  test("rejects empty output", () => {
    expect(parseBatchAnalysisResult("   ").ok).toBe(false);
  });
});

describe("isQuoteGrounded", () => {
  const sourceText =
    "The agreement renews annually.\nEither party may terminate with 30 days notice.";

  test("accepts a quote that appears verbatim", () => {
    expect(isQuoteGrounded({ quote: "renews annually", sourceText })).toBe(
      true,
    );
  });

  test("accepts a quote whose whitespace was reflowed", () => {
    // Models routinely re-wrap a passage across line breaks without changing a
    // word; that is still a faithful quote.
    expect(
      isQuoteGrounded({
        quote: "annually.   Either party",
        sourceText,
      }),
    ).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isQuoteGrounded({ quote: "RENEWS ANNUALLY", sourceText })).toBe(
      true,
    );
  });

  test("rejects a quote that is not in the source", () => {
    // The whole point: a plausible-sounding sentence the document never
    // contained is a fabrication, and this is what catches it.
    expect(
      isQuoteGrounded({
        quote: "Either party may terminate with 90 days notice.",
        sourceText,
      }),
    ).toBe(false);
  });

  test("rejects an empty quote", () => {
    expect(isQuoteGrounded({ quote: "   ", sourceText })).toBe(false);
  });
});
