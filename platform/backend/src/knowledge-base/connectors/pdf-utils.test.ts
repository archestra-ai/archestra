import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetDocument } = vi.hoisted(() => ({
  mockGetDocument: vi.fn(),
}));

vi.mock("pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js", () => ({
  default: {
    disableWorker: false,
    getDocument: mockGetDocument,
  },
}));

import {
  describePdfEmptyText,
  describePdfExtractionWarning,
  parsePdfBuffer,
} from "./pdf-utils";

function makePage(params?: { text?: string; textError?: Error }) {
  return {
    getTextContent: params?.textError
      ? vi.fn().mockRejectedValue(params.textError)
      : vi.fn().mockResolvedValue({
          items: params?.text
            ? [{ str: params.text, transform: [1, 0, 0, 1, 0, 10] }]
            : [],
        }),
    cleanup: vi.fn(),
  };
}

function mockDocument(pages: ReturnType<typeof makePage>[]) {
  const destroy = vi.fn();
  const loadingTaskDestroy = vi.fn();
  const document = {
    numPages: pages.length,
    getPage: vi.fn((pageNumber: number) =>
      Promise.resolve(pages[pageNumber - 1]),
    ),
    destroy,
  };
  mockGetDocument.mockReturnValue({
    promise: Promise.resolve(document),
    destroy: loadingTaskDestroy,
  });
  return { destroy, loadingTaskDestroy };
}

function mockRejectedLoadingTask(error: unknown) {
  const destroy = vi.fn();
  mockGetDocument.mockReturnValue({
    promise: Promise.reject(error),
    destroy,
  });
  return { destroy };
}

describe("parsePdfBuffer", () => {
  beforeEach(() => {
    mockGetDocument.mockReset();
  });

  it("returns ok with text and a page count for a digital PDF", async () => {
    const page = makePage({ text: "Hello contract" });
    const { destroy } = mockDocument([page]);

    await expect(parsePdfBuffer(Buffer.from("%PDF"))).resolves.toEqual({
      text: "Hello contract",
      status: "ok",
      pageCount: 1,
    });
    expect(mockGetDocument).toHaveBeenCalledWith({
      data: expect.any(Buffer),
      stopAtErrors: true,
    });
    expect(page.cleanup).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("classifies textless pages without requesting render operator lists", async () => {
    mockDocument([makePage(), makePage()]);

    await expect(parsePdfBuffer(Buffer.from("%PDF"))).resolves.toEqual({
      text: "",
      status: "no_text_layer",
      pageCount: 2,
      textlessPageCount: 2,
    });
  });

  it("returns empty for a PDF with zero pages", async () => {
    mockDocument([]);

    await expect(parsePdfBuffer(Buffer.from("%PDF"))).resolves.toEqual({
      text: "",
      status: "empty",
      pageCount: 0,
    });
  });

  it("returns parse_failed when the document cannot be opened", async () => {
    const { destroy } = mockRejectedLoadingTask(new Error("bad XRef entry"));

    await expect(parsePdfBuffer(Buffer.from("not a pdf"))).resolves.toEqual({
      text: "",
      status: "parse_failed",
      error: "bad XRef entry",
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("returns parse_failed when every page fails extraction", async () => {
    const pages = [
      makePage({ textError: new Error("page worker failed") }),
      makePage({ textError: new Error("font decoder failed") }),
    ];
    mockDocument(pages);

    const result = await parsePdfBuffer(Buffer.from("%PDF"));
    expect(result).toMatchObject({
      text: "",
      status: "parse_failed",
      pageCount: 2,
      failedPageCount: 2,
    });
    expect(result.error).toContain("page 1: page worker failed");
    expect(result.error).toContain("page 2: font decoder failed");
    expect(pages[0].cleanup).toHaveBeenCalledOnce();
    expect(pages[1].cleanup).toHaveBeenCalledOnce();
  });

  it("warns when one page extracts and another page fails", async () => {
    mockDocument([
      makePage({ text: "Readable page" }),
      makePage({ textError: new Error("font decoder failed") }),
    ]);

    const result = await parsePdfBuffer(Buffer.from("%PDF"));
    expect(result).toMatchObject({
      text: "Readable page",
      status: "partial",
      pageCount: 2,
      failedPageCount: 1,
    });
    expect(describePdfExtractionWarning(result)).toContain(
      "1 page failed extraction",
    );
  });

  it("warns for a mixed digital and scanned PDF", async () => {
    mockDocument([makePage({ text: "Digitally generated page" }), makePage()]);

    const result = await parsePdfBuffer(Buffer.from("%PDF"));
    expect(result).toEqual({
      text: "Digitally generated page",
      status: "partial",
      pageCount: 2,
      textlessPageCount: 1,
    });
    const warning = describePdfExtractionWarning(result);
    expect(warning).toContain("1 page yielded no text");
    expect(warning).toContain("may be blank, image-only, or graphics-only");
    expect(warning).not.toContain("incomplete");
  });

  it("conservatively warns for a mixed digital and textless PDF", async () => {
    mockDocument([makePage({ text: "Readable page" }), makePage()]);

    const result = await parsePdfBuffer(Buffer.from("%PDF"));
    expect(result).toEqual({
      text: "Readable page",
      status: "partial",
      pageCount: 2,
      textlessPageCount: 1,
    });
    const warning = describePdfExtractionWarning(result);
    expect(warning).toContain("1 page yielded no text");
    expect(warning).toContain("may be blank, image-only, or graphics-only");
    expect(warning).not.toContain("incomplete");
  });

  it("stringifies non-Error throwables", async () => {
    mockRejectedLoadingTask("string failure");
    const result = await parsePdfBuffer(Buffer.from("not a pdf"));
    expect(result.status).toBe("parse_failed");
    expect(result.error).toBe("string failure");
  });
});

describe("PDF extraction descriptions", () => {
  it("is undefined for a successful extraction", () => {
    expect(
      describePdfEmptyText({ text: "hi", status: "ok", pageCount: 1 }),
    ).toBeUndefined();
  });

  it("names the textless page count", () => {
    const reason = describePdfEmptyText({
      text: "",
      status: "no_text_layer",
      pageCount: 12,
      textlessPageCount: 12,
    });
    expect(reason).toContain("12 textless");
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

  it("names the zero-page case", () => {
    expect(
      describePdfEmptyText({ text: "", status: "empty", pageCount: 0 }),
    ).toContain("no pages");
  });
});
