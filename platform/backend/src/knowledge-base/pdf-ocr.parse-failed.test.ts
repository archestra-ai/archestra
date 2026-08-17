import { MockLanguageModelV3 } from "ai/test";
import { vi } from "vitest";

// The pinned 2018 pdf.js build cannot be made to fail a SINGLE page
// deterministically from a synthetic fixture (it recovers or classifies the
// page textless), so — like the gdrive connector test — the parse itself is
// stubbed here and everything downstream (subsetting, transcription, merge,
// status recomputation) runs for real against a real buffer.
vi.mock("./connectors/pdf-utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./connectors/pdf-utils")>();
  return {
    ...actual,
    parsePdfBuffer: vi.fn(),
  };
});

import { expect, test } from "@/test";
import { makeTestPdf } from "@/test/pdf";
import { parsePdfBuffer } from "./connectors/pdf-utils";
import type { OcrConfig } from "./kb-llm-client";
import { extractPdfText } from "./pdf-ocr";

test("a document whose only readable pages are scans is transcribed even when its other pages failed parsing", async () => {
  // Real 2-page buffer so pdf-lib can subset page 2; the stubbed parse says
  // page 1 FAILED extraction and page 2 is textless — overall parse_failed.
  vi.mocked(parsePdfBuffer).mockResolvedValueOnce({
    text: "",
    status: "parse_failed",
    pageCount: 2,
    failedPageCount: 1,
    textlessPageCount: 1,
    error: "page 1: font decoder failed",
    pages: [
      { pageNumber: 1, status: "failed" },
      { pageNumber: 2, status: "textless" },
    ],
  });
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: "Recovered scanned page" }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  const config: OcrConfig = {
    modelName: "mock-vision",
    provider: "anthropic",
    llmModel: model as never,
  };

  const result = await extractPdfText({
    buffer: makeTestPdf(["unused", null]),
    ocr: {
      config,
      connectorId: null,
      deadlineAt: Date.now() + 60_000,
      budget: { remainingPages: 10 },
    },
  });

  // The scan was recovered; the failed page stays failed, so the document is
  // an honest partial instead of an unindexable parse failure.
  expect(result.status).toBe("partial");
  expect(result.text).toBe("Recovered scanned page");
  expect(result.failedPageCount).toBe(1);
  expect(result.ocr).toMatchObject({ transcribedPageCount: 1 });
});
