import { describe, expect, it } from "vitest";
import {
  buildChunkRef,
  type CitedQuote,
  extractCitedQuotes,
  type KbChunkForQuoteCheck,
  readKbChunksFromToolResult,
  verifyQuotes,
} from "./quote-verification";

const REF_A = "3fa85f64-5717-4562-b3fc-2c963f66afa6#0";
const REF_B = "11111111-2222-3333-4444-555555555555#7";
const UNKNOWN_REF = "00000000-0000-0000-0000-000000000000#9";

function answerWith(quote: string, ref: string): string {
  return `Data is kept for a while.\n> "${quote}" — ${ref}\nThat's the policy.`;
}

describe("buildChunkRef", () => {
  it("joins documentId and chunkIndex", () => {
    expect(buildChunkRef("3fa85f64-5717-4562-b3fc-2c963f66afa6", 0)).toBe(
      REF_A,
    );
  });
});

describe("extractCitedQuotes", () => {
  it('parses the documented `> "quote" — ref` convention', () => {
    const quotes = extractCitedQuotes(
      answerWith("retention period is 90 days", REF_A),
    );
    expect(quotes).toEqual<CitedQuote[]>([
      { quote: "retention period is 90 days", ref: REF_A },
    ]);
  });

  it("tolerates curly quotes, dash variants, and a backticked ref", () => {
    const quotes = extractCitedQuotes(
      `Something. “retention period is 90 days” - \`${REF_A}\``,
    );
    expect(quotes).toEqual<CitedQuote[]>([
      { quote: "retention period is 90 days", ref: REF_A },
    ]);
  });

  it("keeps apostrophes and single quotes inside a double-quoted quote", () => {
    // Contractions and possessives must not truncate the quote — only the
    // double-quote delimiter that precedes the citation anchor bounds it.
    const quotes = extractCitedQuotes(
      answerWith("the customer's data isn't deleted", REF_A),
    );
    expect(quotes).toEqual<CitedQuote[]>([
      { quote: "the customer's data isn't deleted", ref: REF_A },
    ]);
  });

  it("keeps embedded double quotes inside the quote body", () => {
    // Source text routinely contains double quotes. An embedded pair must not
    // end the quote early — only the closing delimiter followed by the dash
    // and a ref-shaped anchor terminates it. A truncating parser here is what
    // let a fabricated leading claim slip through as matched.
    const quotes = extractCitedQuotes(
      answerWith('The retention mode is "strict" for all accounts.', REF_A),
    );
    expect(quotes).toEqual<CitedQuote[]>([
      {
        quote: 'The retention mode is "strict" for all accounts.',
        ref: REF_A,
      },
    ]);
  });

  it("parses the numbered Sources-section convention the instruction asks for", () => {
    // The canonical shape: inline [n] markers in the prose, with each
    // quote/ref pair on its own `[n] "quote" — ref` line under a Sources
    // heading. The markers and heading sit outside the match.
    const quotes = extractCitedQuotes(
      `The retention period is 90 days [1] and billing is monthly [2].\n\nSources:\n[1] "retention period is 90 days" — ${REF_A}\n[2] "billing cycles are monthly" — ${REF_B}`,
    );
    expect(quotes).toEqual<CitedQuote[]>([
      { quote: "retention period is 90 days", ref: REF_A },
      { quote: "billing cycles are monthly", ref: REF_B },
    ]);
  });

  it("parses multiple citations on one line independently", () => {
    const quotes = extractCitedQuotes(
      `"first passage here" — ${REF_A} and "second passage here" — ${REF_B}`,
    );
    expect(quotes).toEqual<CitedQuote[]>([
      { quote: "first passage here", ref: REF_A },
      { quote: "second passage here", ref: REF_B },
    ]);
  });

  it("collapses duplicate quote/ref pairs", () => {
    const answer = `${answerWith("retention period is 90 days", REF_A)}\n${answerWith(
      "retention period is 90 days",
      REF_A,
    )}`;
    expect(extractCitedQuotes(answer)).toHaveLength(1);
  });

  it("returns nothing when the answer carries no cited quote", () => {
    expect(extractCitedQuotes("The retention period is 90 days.")).toEqual([]);
  });
});

describe("readKbChunksFromToolResult", () => {
  const CHUNK: KbChunkForQuoteCheck = {
    ref: REF_A,
    content: "TITLE: Data Policy\n\nThe retention period is 90 days.",
  };

  it("reads chunks from structuredContent (the shape the tool emits)", () => {
    // query_knowledge_sources returns structuredSuccessResult(output, ...) and
    // run_tool passes structuredContent through, so this is the real path for
    // both direct calls and dispatches.
    const result = {
      structuredContent: { results: [CHUNK], totalChunks: 1 },
      content: [{ type: "text", text: "ignored when structured is present" }],
    };
    expect(readKbChunksFromToolResult(result)).toEqual([CHUNK]);
  });

  it("falls back to the first text content part parsed as JSON", () => {
    const result = {
      content: [{ type: "text", text: JSON.stringify({ results: [CHUNK] }) }],
    };
    expect(readKbChunksFromToolResult(result)).toEqual([CHUNK]);
  });

  it("skips result items missing a string ref or content", () => {
    const result = {
      structuredContent: {
        results: [CHUNK, { ref: REF_B }, { content: "no ref" }, null, 3],
      },
    };
    expect(readKbChunksFromToolResult(result)).toEqual([CHUNK]);
  });

  it("returns [] for results that carry no readable chunks", () => {
    expect(
      readKbChunksFromToolResult({
        content: [{ type: "text", text: "not json" }],
      }),
    ).toEqual([]);
    expect(
      readKbChunksFromToolResult({
        content: [{ type: "text", text: '{"foo":1}' }],
      }),
    ).toEqual([]);
    expect(readKbChunksFromToolResult({ structuredContent: {} })).toEqual([]);
    expect(readKbChunksFromToolResult({})).toEqual([]);
  });
});

describe("verifyQuotes", () => {
  const chunks = [
    {
      ref: REF_A,
      content:
        "TITLE: Data Policy\n\nThe retention period is 90 days for all accounts.",
    },
    { ref: REF_B, content: "Unrelated content about billing cycles." },
  ];

  it("matches a verbatim quote against the cited chunk (ignoring the TITLE prefix)", () => {
    const result = verifyQuotes({
      answerText: answerWith("retention period is 90 days", REF_A),
      chunks,
    });
    expect(result.matched).toBe(1);
    expect(result.checked).toBe(1);
    expect(result.wrongRef).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.unverifiable).toEqual([]);
    expect(result.unparseable).toBe(false);
  });

  it("matches through whitespace, smart-quote, and case differences", () => {
    const result = verifyQuotes({
      answerText: answerWith("The  Retention   Period  is  90  Days", REF_A),
      chunks,
    });
    expect(result.matched).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it("flags a quote that appears in no returned chunk as a failure", () => {
    const result = verifyQuotes({
      answerText: answerWith("retention period is 30 days", REF_A),
      chunks,
    });
    expect(result.matched).toBe(0);
    expect(result.failed).toEqual<CitedQuote[]>([
      { quote: "retention period is 30 days", ref: REF_A },
    ]);
  });

  const embeddedQuoteChunks = [
    {
      ref: REF_A,
      content:
        'TITLE: Data Policy\n\nThe retention mode is "strict" for all accounts.',
    },
  ];

  it("matches a verbatim quote that itself contains double quotes", () => {
    const result = verifyQuotes({
      answerText: answerWith(
        'The retention mode is "strict" for all accounts.',
        REF_A,
      ),
      chunks: embeddedQuoteChunks,
    });
    expect(result.matched).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it("catches a fabrication ahead of an embedded double quote", () => {
    // Reviewer regression: with a truncating parser, only `for all accounts.`
    // (the tail after the embedded quote) was extracted — a genuine substring
    // of the chunk — and the fabricated `relaxed` reported matched. The full
    // quote, embedded quotes included, must be what gets verified.
    const result = verifyQuotes({
      answerText: answerWith(
        'The retention mode is "relaxed" for all accounts.',
        REF_A,
      ),
      chunks: embeddedQuoteChunks,
    });
    expect(result.matched).toBe(0);
    expect(result.failed).toEqual<CitedQuote[]>([
      {
        quote: 'The retention mode is "relaxed" for all accounts.',
        ref: REF_A,
      },
    ]);
  });

  it("classifies an unresolved ref whose quote exists elsewhere as wrong_ref, not matched", () => {
    // Reviewer regression: the old fallback searched all chunks and reported
    // `matched`, so a wrong citation was undetectable. The quote is real, the
    // pointer is not — a mis-citation, reported as its own outcome.
    const result = verifyQuotes({
      answerText: answerWith("retention period is 90 days", UNKNOWN_REF),
      chunks,
    });
    expect(result.matched).toBe(0);
    expect(result.wrongRef).toEqual<CitedQuote[]>([
      { quote: "retention period is 90 days", ref: UNKNOWN_REF },
    ]);
    expect(result.failed).toEqual([]);
  });

  it("flags an unresolved ref whose quote exists nowhere as a failure", () => {
    const result = verifyQuotes({
      answerText: answerWith("retention period is 30 days", UNKNOWN_REF),
      chunks,
    });
    expect(result.matched).toBe(0);
    expect(result.wrongRef).toEqual([]);
    expect(result.failed).toHaveLength(1);
  });

  it("verifies a short quote against its resolved cited chunk", () => {
    // #7161's motivating example is exactly `"90 days"`. Scoped to the one
    // cited chunk, a short quote is meaningful evidence — it must be checked,
    // not silently skipped with no log or metric.
    const result = verifyQuotes({
      answerText: answerWith("90 days", REF_A),
      chunks,
    });
    expect(result.checked).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it("flags a short fabricated quote against its resolved cited chunk", () => {
    const result = verifyQuotes({
      answerText: answerWith("30 days", REF_A),
      chunks,
    });
    expect(result.checked).toBe(1);
    expect(result.matched).toBe(0);
    expect(result.failed).toEqual<CitedQuote[]>([
      { quote: "30 days", ref: REF_A },
    ]);
  });

  it("reports a short quote with an unresolved ref as unverifiable", () => {
    // Too short to search across all chunks (it would match almost anything),
    // and there is no cited chunk to scope it to — but its existence is still
    // recorded rather than silently dropped.
    const result = verifyQuotes({
      answerText: answerWith("90 days", UNKNOWN_REF),
      chunks,
    });
    expect(result.checked).toBe(1);
    expect(result.matched).toBe(0);
    expect(result.wrongRef).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.unverifiable).toEqual<CitedQuote[]>([
      { quote: "90 days", ref: UNKNOWN_REF },
    ]);
  });

  it("reports unparseable when chunks were returned but no quote was cited", () => {
    const result = verifyQuotes({
      answerText: "The retention period is 90 days, per the policy.",
      chunks,
    });
    expect(result.unparseable).toBe(true);
    expect(result.checked).toBe(0);
  });

  it("scopes matching to the cited chunk: a quote from a different chunk fails", () => {
    // The quote belongs to REF_B's content but is cited against REF_A, which
    // resolves — so the claim is checked against REF_A only and fails.
    const result = verifyQuotes({
      answerText: answerWith("Unrelated content about billing cycles", REF_A),
      chunks,
    });
    expect(result.matched).toBe(0);
    expect(result.failed).toHaveLength(1);
  });

  const apostropheChunks = [
    {
      ref: REF_A,
      content:
        "TITLE: Data Policy\n\nThe retention window is 90 days for every customer's stored records.",
    },
  ];

  it("matches a verbatim quote that contains an apostrophe", () => {
    const result = verifyQuotes({
      answerText: answerWith(
        "the retention window is 90 days for every customer's stored records",
        REF_A,
      ),
      chunks: apostropheChunks,
    });
    expect(result.matched).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it("catches a fabrication that precedes an apostrophe in the quote", () => {
    // The wrong number sits before the possessive apostrophe. The full quote
    // must be checked, not just the substring after the apostrophe — that tail
    // ("s stored records") is a genuine substring of the chunk and would let
    // the fabrication pass.
    const result = verifyQuotes({
      answerText: answerWith(
        "the retention window is 30 days for every customer's stored records",
        REF_A,
      ),
      chunks: apostropheChunks,
    });
    expect(result.matched).toBe(0);
    expect(result.failed).toHaveLength(1);
  });
});
