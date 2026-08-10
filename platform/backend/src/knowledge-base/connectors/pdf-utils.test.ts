import { beforeEach, describe, expect, it, vi } from "vitest";

// pdf-parse's bundled 2018 pdf.js build carries global state that makes
// repeated in-process parses of the same bytes non-deterministic (the same
// buffer can parse or throw "bad XRef entry" depending on module system and
// parse order). Mock the library boundary and pin OUR status mapping instead.
const mockPdfParse = vi.hoisted(() => vi.fn());
vi.mock("pdf-parse/lib/pdf-parse.js", () => ({ default: mockPdfParse }));

import { describePdfEmptyText, parsePdfBuffer } from "./pdf-utils";

describe("parsePdfBuffer", () => {
  beforeEach(() => {
    mockPdfParse.mockReset();
  });

  it("returns ok with the text and page count for a digital PDF", async () => {
    mockPdfParse.mockResolvedValue({ text: "Hello contract", numpages: 3 });
    const result = await parsePdfBuffer(Buffer.from("%PDF"));
    expect(result).toEqual({
      text: "Hello contract",
      status: "ok",
      pageCount: 3,
    });
  });

  it("returns no_text_layer when pages exist but yield no text", async () => {
    // The scanned/image-only shape: the parse succeeds and reports pages,
    // but the text layer is absent (whitespace-only extraction).
    mockPdfParse.mockResolvedValue({ text: " \n ", numpages: 12 });
    const result = await parsePdfBuffer(Buffer.from("%PDF"));
    expect(result).toEqual({
      text: "",
      status: "no_text_layer",
      pageCount: 12,
    });
  });

  it("returns empty for a PDF with zero pages", async () => {
    mockPdfParse.mockResolvedValue({ text: "", numpages: 0 });
    const result = await parsePdfBuffer(Buffer.from("%PDF"));
    expect(result).toEqual({ text: "", status: "empty", pageCount: 0 });
  });

  it("returns parse_failed with the error when the parser throws", async () => {
    mockPdfParse.mockRejectedValue(new Error("bad XRef entry"));
    const result = await parsePdfBuffer(Buffer.from("not a pdf"));
    expect(result).toEqual({
      text: "",
      status: "parse_failed",
      error: "bad XRef entry",
    });
  });

  it("stringifies non-Error throwables", async () => {
    mockPdfParse.mockRejectedValue("string failure");
    const result = await parsePdfBuffer(Buffer.from("not a pdf"));
    expect(result.status).toBe("parse_failed");
    expect(result.error).toBe("string failure");
  });
});

describe("describePdfEmptyText", () => {
  it("is undefined for a successful extraction", () => {
    expect(
      describePdfEmptyText({ text: "hi", status: "ok", pageCount: 1 }),
    ).toBeUndefined();
  });

  it("names the scanned case with the page count", () => {
    const reason = describePdfEmptyText({
      text: "",
      status: "no_text_layer",
      pageCount: 12,
    });
    expect(reason).toContain("12 page(s)");
    expect(reason).toContain("no extractable text layer");
  });

  it("includes the parse error", () => {
    const reason = describePdfEmptyText({
      text: "",
      status: "parse_failed",
      error: "bad xref",
    });
    expect(reason).toContain("could not be parsed");
    expect(reason).toContain("bad xref");
  });

  it("names the empty case", () => {
    expect(
      describePdfEmptyText({ text: "", status: "empty", pageCount: 0 }),
    ).toContain("no pages");
  });
});
