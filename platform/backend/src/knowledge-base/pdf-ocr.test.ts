import { MockLanguageModelV3 } from "ai/test";
import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { InteractionModel } from "@/models";
import { expect, test, vi } from "@/test";
import { makeTestPdf } from "@/test/pdf";
import { normalizeInteractionResponse } from "@/types";
import {
  describePdfEmptyText,
  describePdfExtractionWarning,
} from "./connectors/pdf-utils";
import type { OcrConfig } from "./kb-llm-client";
import {
  buildOcrInteraction,
  extractPdfText,
  type OcrRunContext,
} from "./pdf-ocr";

/**
 * The only mocked boundary is the vision model itself (the network); the PDF
 * parse, the page subsetting, the observability wrapper, and the interaction
 * write all run for real.
 */
function mockModel(respond: (pageText: string) => string | Error): {
  model: MockLanguageModelV3;
  calls: string[];
} {
  const calls: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const userMessage = options.prompt.findLast((m) => m.role === "user");
      const textPart = userMessage?.content.find(
        (part) => part.type === "text",
      );
      const label = textPart && "text" in textPart ? textPart.text : "?";
      calls.push(label);
      const out = respond(label);
      if (out instanceof Error) throw out;
      return {
        content: [{ type: "text" as const, text: out }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: {
            total: 100,
            noCache: 100,
            cacheRead: 0,
            cacheWrite: 0,
          },
          outputTokens: { total: 20, text: 20, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  return { model, calls };
}

function ocrContext(
  model: MockLanguageModelV3,
  overrides: Partial<Omit<OcrRunContext, "config">> = {},
): OcrRunContext {
  const ocrConfig: OcrConfig = {
    modelName: "mock-vision",
    provider: "anthropic",
    llmModel: model as never,
  };
  return {
    config: ocrConfig,
    connectorId: null,
    deadlineAt: Date.now() + 60_000,
    budget: { remainingPages: 1_000 },
    ...overrides,
  };
}

test("returns the parse untouched when no OCR context is given", async () => {
  const result = await extractPdfText({ buffer: makeTestPdf([null]) });
  expect(result.status).toBe("no_text_layer");
  expect(result.ocr).toBeUndefined();
});

test("does not call the model for a document that extracted cleanly", async () => {
  const { model, calls } = mockModel(() => "unused");
  const result = await extractPdfText({
    buffer: makeTestPdf(["A digital page"]),
    ocr: ocrContext(model),
  });
  expect(result.status).toBe("ok");
  expect(result.ocr).toBeUndefined();
  expect(calls).toHaveLength(0);
});

test("transcribes every page of a fully scanned document", async () => {
  const { model, calls } = mockModel((label) =>
    label.includes("page 1") ? "First scanned page" : "Second scanned page",
  );
  const result = await extractPdfText({
    buffer: makeTestPdf([null, null]),
    filename: "contract.pdf",
    ocr: ocrContext(model),
  });
  expect(calls).toHaveLength(2);
  expect(result.status).toBe("ok");
  expect(result.text).toBe("First scanned page\n\nSecond scanned page");
  expect(result.textlessPageCount).toBeUndefined();
  expect(result.ocr).toMatchObject({
    transcribedPageCount: 2,
    failedPageCount: 0,
    skippedPageCount: 0,
  });
  expect(result.pages).toEqual([
    { pageNumber: 1, status: "text", text: "First scanned page" },
    { pageNumber: 2, status: "text", text: "Second scanned page" },
  ]);
});

test("targets only the textless pages of a mixed document and merges in page order", async () => {
  const { model, calls } = mockModel(() => "Recovered scan");
  const result = await extractPdfText({
    buffer: makeTestPdf([null, "Digital middle page", null]),
    ocr: ocrContext(model),
  });
  expect(calls).toHaveLength(2);
  expect(calls.every((c) => c.includes("page 1") || c.includes("page 3"))).toBe(
    true,
  );
  expect(result.status).toBe("ok");
  expect(result.text).toBe(
    "Recovered scan\n\nDigital middle page\n\nRecovered scan",
  );
});

test("keeps a page textless when the model reports no readable text", async () => {
  const { model } = mockModel((label) =>
    label.includes("page 1") ? "Readable scan" : "[NO TEXT]",
  );
  const result = await extractPdfText({
    buffer: makeTestPdf([null, null]),
    ocr: ocrContext(model),
  });
  expect(result.status).toBe("partial");
  expect(result.text).toBe("Readable scan");
  expect(result.textlessPageCount).toBe(1);
  expect(result.ocr).toMatchObject({
    transcribedPageCount: 1,
    failedPageCount: 1,
  });
  expect(describePdfExtractionWarning(result)).toContain(
    "OCR transcribed 1 of 2 textless page(s)",
  );
});

test("keeps the original status and reason when no page can be transcribed", async () => {
  const { model } = mockModel(() => new Error("model unavailable"));
  const result = await extractPdfText({
    buffer: makeTestPdf([null]),
    ocr: ocrContext(model),
  });
  expect(result.status).toBe("no_text_layer");
  expect(result.text).toBe("");
  expect(result.ocr).toMatchObject({
    transcribedPageCount: 0,
    failedPageCount: 1,
  });
  const reason = describePdfEmptyText(result);
  expect(reason).toContain("no extractable text layer");
  expect(reason).toContain(
    "OCR could not transcribe any of the 1 textless page(s)",
  );
  expect(reason).toContain("model unavailable");
});

test("stops at the per-document page cap and says so", async () => {
  config.kb.ocrMaxPagesPerDocument = 1;
  const { model, calls } = mockModel(() => "Only page transcribed");
  const result = await extractPdfText({
    buffer: makeTestPdf([null, null, null]),
    ocr: ocrContext(model),
  });
  expect(calls).toHaveLength(1);
  expect(result.status).toBe("partial");
  expect(result.textlessPageCount).toBe(2);
  expect(result.ocr).toMatchObject({
    transcribedPageCount: 1,
    skippedPageCount: 2,
    skippedBy: "document-page-cap",
  });
  expect(describePdfExtractionWarning(result)).toContain(
    "per-document OCR page cap",
  );
});

test("spends and respects the run-wide page budget", async () => {
  const { model, calls } = mockModel(() => "Budgeted page");
  const context = ocrContext(model, { budget: { remainingPages: 1 } });
  const result = await extractPdfText({
    buffer: makeTestPdf([null, null]),
    ocr: context,
  });
  expect(calls).toHaveLength(1);
  expect(context.budget.remainingPages).toBe(0);
  expect(result.ocr).toMatchObject({
    transcribedPageCount: 1,
    skippedPageCount: 1,
    skippedBy: "run-page-budget",
  });

  const second = await extractPdfText({
    buffer: makeTestPdf([null]),
    ocr: context,
  });
  expect(second.status).toBe("no_text_layer");
  expect(second.ocr).toMatchObject({
    transcribedPageCount: 0,
    skippedPageCount: 1,
  });
  expect(calls).toHaveLength(1);
});

test("schedules nothing past the run deadline", async () => {
  const { model, calls } = mockModel(() => "unused");
  const result = await extractPdfText({
    buffer: makeTestPdf([null, null]),
    ocr: ocrContext(model, { deadlineAt: Date.now() - 1 }),
  });
  expect(calls).toHaveLength(0);
  expect(result.status).toBe("no_text_layer");
  expect(result.ocr).toMatchObject({
    transcribedPageCount: 0,
    skippedPageCount: 2,
    skippedBy: "sync-deadline",
  });
  expect(describePdfEmptyText(result)).toContain("sync run's time budget");
});

test("records a metered interaction whose request carries no PDF payload", async () => {
  const { model } = mockModel(() => "Ledger of 2019 invoices");
  const result = await extractPdfText({
    buffer: makeTestPdf([null]),
    filename: "ledger.pdf",
    ocr: ocrContext(model),
  });
  expect(result.text).toBe("Ledger of 2019 invoices");

  // Interaction recording is fire-and-forget; wait for the row, then read it
  // back through the model so the at-rest encryption is undone.
  const stored = await vi.waitFor(async () => {
    const [found] = await db
      .select({ id: schema.interactionsTable.id })
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.source, "knowledge:ocr"));
    expect(found).toBeDefined();
    return found;
  });
  const row = await InteractionModel.findById(stored.id);
  if (!row) throw new Error("interaction row disappeared");

  const request = JSON.stringify(row.request);
  expect(request).toContain("content not stored");
  expect(request).toContain('page 1 of \\"ledger.pdf\\"');
  // A stored page would be megabytes of base64; metadata is a few hundred bytes.
  expect(request.length).toBeLessThan(2_000);
  const response = JSON.stringify(row.response);
  expect(response).toContain("Ledger of 2019 invoices");
  expect(row.inputTokens).toBe(100);
  expect(row.outputTokens).toBe(20);
});

test.for([
  "anthropic:messages",
  "gemini:generateContent",
  "bedrock:converse",
  "openai:chatCompletions",
] as const)("builds a %s response the stored-interaction read schema accepts", (type) => {
  const interaction = buildOcrInteraction({
    res: {
      text: "Transcribed text",
      usage: { inputTokens: 5, outputTokens: 7 },
    },
    type,
    pageNumber: 3,
    name: "scan.pdf",
    byteLength: 1234,
    model: "vision-model",
  });
  // normalizeInteractionResponse returns the body unchanged iff it conforms
  // to the type's provider schema; a mismatch becomes the malformed sentinel.
  expect(normalizeInteractionResponse(type, interaction.response)).toEqual(
    interaction.response,
  );
  expect(JSON.stringify(interaction.response)).toContain("Transcribed text");
  expect(interaction.inputTokens).toBe(5);
  expect(interaction.outputTokens).toBe(7);
});
