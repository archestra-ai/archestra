import { describe, expect, it } from "vitest";
import {
  buildChunkRef,
  type CitedQuote,
  extractCitedQuotes,
  type KbChunkForQuoteCheck,
  readKbChunksFromToolOutput,
  verifyQuotes,
} from "./quote-verification";

const REF_A = "3fa85f64-5717-4562-b3fc-2c963f66afa6#0";
const REF_B = "11111111-2222-3333-4444-555555555555#7";

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

describe("readKbChunksFromToolOutput", () => {
  const CHUNK: KbChunkForQuoteCheck = {
    ref: REF_A,
    content: "TITLE: Data Policy\n\nThe retention period is 90 days.",
  };

  it("reads chunks from the real tool output (JSON string content)", () => {
    // The shape query_knowledge_sources actually reaches the AI SDK step as:
    // buildArchestraToolOutput collapses the result to a JSON string `content`.
    const output = {
      content: JSON.stringify({ results: [CHUNK], totalChunks: 1 }),
      _meta: {},
    };
    expect(readKbChunksFromToolOutput(output)).toEqual([CHUNK]);
  });

  it("reads chunks from the structuredContent fallback", () => {
    const output = { structuredContent: { results: [CHUNK] } };
    expect(readKbChunksFromToolOutput(output)).toEqual([CHUNK]);
  });

  it("skips result items missing a string ref or content", () => {
    const output = {
      content: JSON.stringify({
        results: [CHUNK, { ref: REF_B }, { content: "no ref" }, null, 3],
      }),
    };
    expect(readKbChunksFromToolOutput(output)).toEqual([CHUNK]);
  });

  it("returns [] for output that carries no readable results", () => {
    expect(readKbChunksFromToolOutput({ content: "not json" })).toEqual([]);
    expect(readKbChunksFromToolOutput({ content: '{"foo":1}' })).toEqual([]);
    expect(readKbChunksFromToolOutput({})).toEqual([]);
    expect(readKbChunksFromToolOutput(null)).toEqual([]);
    expect(readKbChunksFromToolOutput("string")).toEqual([]);
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
    expect(result.failed).toEqual([]);
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

  it("falls back to all chunks when the cited ref does not resolve", () => {
    const result = verifyQuotes({
      answerText: answerWith(
        "retention period is 90 days",
        "00000000-0000-0000-0000-000000000000#9",
      ),
      chunks,
    });
    // Ref is wrong, but the quote is genuinely in a returned chunk, so it is
    // not a fabrication.
    expect(result.matched).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it("does not count a quote shorter than the length floor", () => {
    const result = verifyQuotes({
      answerText: answerWith("90 days", REF_A),
      chunks,
    });
    expect(result.checked).toBe(0);
    expect(result.matched).toBe(0);
    expect(result.failed).toEqual([]);
    expect(result.unparseable).toBe(false);
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
    // resolves — so the fallback-to-all-chunks path is not taken and it fails.
    const result = verifyQuotes({
      answerText: answerWith("Unrelated content about billing cycles", REF_A),
      chunks,
    });
    expect(result.matched).toBe(0);
    expect(result.failed).toHaveLength(1);
  });
});
