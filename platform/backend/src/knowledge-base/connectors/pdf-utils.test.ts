import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetDocument, IMAGE_OPERATION, GRAPHICS_OPERATION } = vi.hoisted(
  () => ({
    mockGetDocument: vi.fn(),
    IMAGE_OPERATION: 85,
    GRAPHICS_OPERATION: 20,
  }),
);

vi.mock("pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js", () => ({
  default: {
    disableWorker: false,
    getDocument: mockGetDocument,
    OPS: {
      paintImageXObject: IMAGE_OPERATION,
      stroke: GRAPHICS_OPERATION,
    },
  },
}));

import {
  describePdfEmptyText,
  describePdfExtractionWarning,
  parsePdfBuffer,
} from "./pdf-utils";

function makePage(params?: {
  text?: string;
  image?: boolean;
  graphics?: boolean;
  textError?: Error;
  operatorError?: Error;
}) {
  return {
    getTextContent: params?.textError
      ? vi.fn().mockRejectedValue(params.textError)
      : vi.fn().mockResolvedValue({
          items: params?.text
            ? [{ str: params.text, transform: [1, 0, 0, 1, 0, 10] }]
            : [],
        }),
    getOperatorList: params?.operatorError
      ? vi.fn().mockRejectedValue(params.operatorError)
      : vi.fn().mockResolvedValue({
          fnArray: params?.image
            ? [IMAGE_OPERATION]
            : params?.graphics
              ? [GRAPHICS_OPERATION]
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

  it("distinguishes image-only pages from blank pages", async () => {
    mockDocument([makePage({ image: true }), makePage()]);

    await expect(parsePdfBuffer(Buffer.from("%PDF"))).resolves.toEqual({
      text: "",
      status: "no_text_layer",
      pageCount: 2,
      imageOnlyPageCount: 1,
      blankPageCount: 1,
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
      makePage({ operatorError: new Error("operator list failed") }),
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
    expect(result.error).toContain("page 2: operator list failed");
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
    mockDocument([
      makePage({ text: "Digitally generated page" }),
      makePage({ image: true }),
    ]);

    const result = await parsePdfBuffer(Buffer.from("%PDF"));
    expect(result).toEqual({
      text: "Digitally generated page",
      status: "partial",
      pageCount: 2,
      imageOnlyPageCount: 1,
    });
    expect(describePdfExtractionWarning(result)).toContain(
      "1 image-only page had no text layer",
    );
  });

  it("warns for a mixed digital and graphics-only PDF", async () => {
    mockDocument([
      makePage({ text: "Digitally generated page" }),
      makePage({ graphics: true }),
    ]);

    const result = await parsePdfBuffer(Buffer.from("%PDF"));
    expect(result).toEqual({
      text: "Digitally generated page",
      status: "partial",
      pageCount: 2,
      graphicsOnlyPageCount: 1,
    });
    expect(describePdfExtractionWarning(result)).toContain(
      "1 graphics-only page had no text layer",
    );
  });

  it("does not warn for a digital PDF with a genuinely blank page", async () => {
    mockDocument([makePage({ text: "Readable page" }), makePage()]);

    const result = await parsePdfBuffer(Buffer.from("%PDF"));
    expect(result).toEqual({
      text: "Readable page",
      status: "ok",
      pageCount: 2,
      blankPageCount: 1,
    });
    expect(describePdfExtractionWarning(result)).toBeUndefined();
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

  it("names image-only, graphics-only, and blank page counts", () => {
    const reason = describePdfEmptyText({
      text: "",
      status: "no_text_layer",
      pageCount: 12,
      imageOnlyPageCount: 8,
      graphicsOnlyPageCount: 2,
      blankPageCount: 2,
    });
    expect(reason).toContain("8 image-only");
    expect(reason).toContain("2 graphics-only");
    expect(reason).toContain("2 blank");
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
