import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { expect, test } from "@/test";
import type { OcrConfig } from "./kb-llm-client";
import { extractPdfText } from "./pdf-ocr";

/**
 * The issue's Done-when criterion, end to end on the real committed scanned
 * fixture: a PDF with no text layer either produces searchable text (here,
 * via a mocked vision model — the only faked boundary) or a named warning.
 * Kept in its own file: the pinned pdf.js build is only reliable for a single
 * in-process parse of a given buffer.
 */
test("the scanned fixture becomes searchable text when OCR is configured", async () => {
  const fixture = readFileSync(
    join(__dirname, "connectors/__fixtures__/scanned-no-text-layer.pdf"),
  );

  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        {
          type: "text" as const,
          text: "EXECUTED MANUFACTURING AGREEMENT — termination notice period: 90 days.",
        },
      ],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: {
        inputTokens: {
          total: 1500,
          noCache: 1500,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: { total: 30, text: 30, reasoning: 0 },
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
    buffer: fixture,
    filename: "scanned-contract.pdf",
    ocr: {
      config,
      connectorId: null,
      deadlineAt: Date.now() + 60_000,
      budget: { remainingPages: 100 },
    },
  });

  expect(result.status).toBe("ok");
  expect(result.text).toContain("termination notice period: 90 days");
  expect(result.ocr).toMatchObject({ transcribedPageCount: 1 });
  expect(result.pages).toEqual([
    {
      pageNumber: 1,
      status: "text",
      text: "EXECUTED MANUFACTURING AGREEMENT — termination notice period: 90 days.",
    },
  ]);
});
