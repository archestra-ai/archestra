import { describe, expect, it } from "vitest";
import { extractCitedQuotes, foldCitationSources } from "./citation-quotes";

const DOC = "178ee2de-983e-4500-97ae-6c40e913ed24";

// The shape the chat model actually produces under QUOTE_CITATION_INSTRUCTION:
// inline [n] markers in prose, one trailing bold Sources label, entries run
// together on one line.
const REAL_ANSWER = [
  "**Current rate limit:** 5,000 requests per minute (set in March) [1], with burst windows of up to 90 seconds tolerated before throttling begins [2].",
  "",
  `**Sources** [1] "The limit was raised to 5,000 per minute in March" — ${DOC}#0 [2] "burst windows of up to 90 seconds are tolerated before throttling begins" — ${DOC}#0`,
].join("\n");

describe("foldCitationSources", () => {
  it("parses the entries and removes the Sources block from the display text", () => {
    const { displayText, entries } = foldCitationSources(REAL_ANSWER);

    expect(entries).toEqual([
      {
        marker: 1,
        quote: "The limit was raised to 5,000 per minute in March",
        ref: `${DOC}#0`,
        documentId: DOC,
      },
      {
        marker: 2,
        quote:
          "burst windows of up to 90 seconds are tolerated before throttling begins",
        ref: `${DOC}#0`,
        documentId: DOC,
      },
    ]);
    expect(displayText).not.toContain(DOC);
    expect(displayText).not.toMatch(/sources/i);
  });

  it("rewrites inline markers with parsed entries as superscript digits", () => {
    const { displayText } = foldCitationSources(REAL_ANSWER);
    expect(displayText).toContain("(set in March) ¹");
    expect(displayText).toContain("throttling begins ²");
    expect(displayText).not.toContain("[1]");
    expect(displayText).not.toContain("[2]");
  });

  it("leaves markers without a parsed entry alone", () => {
    const text = `See item [9] for details [1].\n\nSources [1] "a fact that is quoted" — ${DOC}#3`;
    const { displayText } = foldCitationSources(text);
    expect(displayText).toContain("[9]");
    expect(displayText).toContain("details ¹");
  });

  it("returns the text untouched when nothing parses", () => {
    const text = "Plain answer with a stray [1] marker and no citations.";
    expect(foldCitationSources(text)).toEqual({
      displayText: text,
      entries: [],
    });
  });

  it("handles a Sources heading on its own line and multi-digit markers", () => {
    const text = [
      "A claim [12].",
      "",
      "### Sources:",
      `[12] "a verbatim supporting sentence" — ${DOC}#4`,
    ].join("\n");
    const { displayText, entries } = foldCitationSources(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].marker).toBe(12);
    expect(displayText).toBe("A claim ¹².");
  });

  it("tolerates curly quotes and hyphen dashes", () => {
    const text = `Fact [1].\n\nSources [1] “curly quoted excerpt here” - ${DOC}#0`;
    const { entries } = foldCitationSources(text);
    expect(entries).toEqual([
      {
        marker: 1,
        quote: "curly quoted excerpt here",
        ref: `${DOC}#0`,
        documentId: DOC,
      },
    ]);
  });
});

describe("extractCitedQuotes", () => {
  it("extracts and dedupes quote/ref pairs independent of markers", () => {
    const text = `"a quoted fact" — ${DOC}#0 and again "a quoted fact" — ${DOC}#0`;
    expect(extractCitedQuotes(text)).toEqual([
      { quote: "a quoted fact", ref: `${DOC}#0` },
    ]);
  });
});
