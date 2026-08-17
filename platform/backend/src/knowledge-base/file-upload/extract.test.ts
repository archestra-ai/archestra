import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { OcrConfig } from "@/knowledge-base/kb-llm-client";
import { makeTestPdf } from "@/test/pdf";
import { extractText } from "./extract";

const SCANNED_PDF = join(
  __dirname,
  "../connectors/__fixtures__/scanned-no-text-layer.pdf",
);

/**
 * The contract that matters here is that an unreadable upload FAILS LOUDLY.
 * An empty document embeds to nothing and retrieves nothing, so silently
 * accepting one looks identical to a successful upload right up until the
 * user asks a question and gets no answer.
 */
describe("extractText", () => {
  it("reads a plain text file", async () => {
    const result = await extractText({
      buffer: Buffer.from("hello knowledge", "utf-8"),
      filename: "notes.txt",
    });
    expect(result.text).toBe("hello knowledge");
    expect(result.warning).toBeUndefined();
  });

  it("reads markdown as text", async () => {
    const result = await extractText({
      buffer: Buffer.from("# Title\n\nbody", "utf-8"),
      filename: "README.md",
    });
    expect(result.text).toContain("# Title");
  });

  it("decides by extension, not by a client-supplied content type", async () => {
    // Browsers send application/octet-stream for anything they don't know, so
    // a MIME-driven implementation would reject this readable file.
    const result = await extractText({
      buffer: Buffer.from("a,b\n1,2", "utf-8"),
      filename: "data.csv",
    });
    expect(result.text).toBe("a,b\n1,2");
  });

  it("rejects a file type it cannot read", async () => {
    await expect(
      extractText({
        buffer: Buffer.from([0x00, 0x01]),
        filename: "archive.zip",
      }),
    ).rejects.toThrow(/Cannot read "archive.zip"/);
  });

  it("rejects a file with no extension", async () => {
    await expect(
      extractText({ buffer: Buffer.from("x"), filename: "LICENSE" }),
    ).rejects.toThrow(/Cannot read "LICENSE"/);
  });

  it("rejects a scanned PDF that has no text layer, explaining why", async () => {
    const buffer = await readFile(SCANNED_PDF);
    await expect(extractText({ buffer, filename: "scan.pdf" })).rejects.toThrow(
      /no extractable text layer/,
    );
  });

  it("rejects bytes that claim to be .docx but are not a valid OOXML zip", async () => {
    await expect(
      extractText({
        buffer: Buffer.from("this is not a zip", "utf-8"),
        filename: "report.docx",
      }),
    ).rejects.toThrow(/Cannot read "report.docx"/);
  });
});

describe("scanned PDFs with OCR", () => {
  function mockOcr(text: string): { config: OcrConfig } & {
    connectorId: null;
    deadlineAt: number;
    budget: { remainingPages: number };
  } {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      }),
    });
    return {
      config: {
        modelName: "mock-vision",
        provider: "anthropic",
        llmModel: model as never,
      },
      connectorId: null,
      deadlineAt: Date.now() + 60_000,
      budget: { remainingPages: 10 },
    };
  }

  it("transcribes a scanned PDF when an OCR context is supplied", async () => {
    const result = await extractText({
      buffer: makeTestPdf([null]),
      filename: "scan.pdf",
      ocr: mockOcr("Transcribed clause: net 45 payment terms."),
    });
    expect(result.text).toContain("net 45 payment terms");
  });

  it("accepts a scanned PDF without spending when acceptTextlessPdf is set", async () => {
    const result = await extractText({
      buffer: makeTestPdf([null]),
      filename: "scan.pdf",
      acceptTextlessPdf: true,
    });
    expect(result.text).toBe("");
    expect(result.warning).toContain("transcribed when the file is indexed");
  });

  it("still rejects a scanned PDF with neither OCR nor acceptance", async () => {
    await expect(
      extractText({ buffer: makeTestPdf([null]), filename: "scan.pdf" }),
    ).rejects.toThrow(/no extractable text layer/);
  });
});
