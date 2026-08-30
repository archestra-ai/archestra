import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePdfBuffer } from "@/knowledge-base/connectors/pdf-utils";
import {
  assertGoldenMatchesCorpus,
  DEFAULT_CORPUS_PATH,
  DEFAULT_GOLDEN_PATH,
  FixtureError,
  loadCorpus,
  loadGolden,
  materializeCorpusContent,
  resolveAssetPath,
} from "./fixtures";
import { normalizeForEvidence } from "./metrics";
import { ocrOutputContainsExpected } from "./ocr-validation";
import {
  EVALUATION_POLICY_VERSION,
  KNOWLEDGE_EVALUATION_COMPONENTS,
} from "./schema";

describe("committed in-platform fixtures", () => {
  const corpus = loadCorpus(DEFAULT_CORPUS_PATH);
  const golden = loadGolden(DEFAULT_GOLDEN_PATH);

  it("has unique, focused documents and a valid golden set", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(24);
    expect(golden.length).toBeGreaterThanOrEqual(20);
    expect(new Set(corpus.map((document) => document.id)).size).toBe(
      corpus.length,
    );
    expect(() => assertGoldenMatchesCorpus(golden, corpus)).not.toThrow();
  });

  it("keeps the checked-in provenance manifest aligned with the suite", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(path.dirname(DEFAULT_CORPUS_PATH), "manifest.json"),
        "utf8",
      ),
    ) as {
      version: number;
      documents: number;
      queries: number;
      externalBenchmark: boolean;
    };
    expect(manifest).toMatchObject({
      version: EVALUATION_POLICY_VERSION,
      documents: corpus.length,
      queries: golden.length,
      externalBenchmark: false,
    });
  });

  it("includes graded, negative, metric-only, multilingual, and no-answer coverage", () => {
    expect(golden.some((query) => (query.judgments?.length ?? 0) > 1)).toBe(
      true,
    );
    expect(golden.some((query) => (query.forbidden?.length ?? 0) > 0)).toBe(
      true,
    );
    expect(golden.some((query) => query.gateMode === "metric-only")).toBe(true);
    expect(golden.some((query) => query.language === "es")).toBe(true);
    expect(golden.some((query) => query.answerability === "no-answer")).toBe(
      true,
    );
  });

  it("covers every configurable retrieval and ranking capability", () => {
    const covered = new Set(golden.flatMap((query) => query.requires));
    expect(covered).toEqual(
      expect.objectContaining(
        new Set([
          "text-embedding",
          "image-embedding",
          "ocr",
          "hybrid-search",
          "bm25",
          "reranker",
          "cross-encoder-reranker",
          "llm-reranker",
          "query-expansion",
          "contextual-retrieval",
          "context-expansion",
        ]),
      ),
    );
  });

  it("assigns every query-driven Knowledge component to a golden scenario", () => {
    const covered = new Set(golden.map((query) => query.component));
    expect([...KNOWLEDGE_EVALUATION_COMPONENTS]).toEqual(
      expect.arrayContaining(["chunking", ...covered]),
    );
    expect([...covered].sort()).toEqual(
      KNOWLEDGE_EVALUATION_COMPONENTS.filter(
        (component) => component !== "chunking",
      ).sort(),
    );
  });

  it("keeps evidence in its expected fixed document", () => {
    const byId = new Map(
      corpus.map((document) => [
        document.id,
        normalizeForEvidence(materializeCorpusContent(document)),
      ]),
    );
    const failures: string[] = [];
    for (const query of golden) {
      for (const expected of query.expected) {
        for (const evidence of expected.evidence ?? []) {
          if (
            !byId.get(expected.doc)?.includes(normalizeForEvidence(evidence))
          ) {
            failures.push(
              `${query.id}: ${JSON.stringify(evidence)} not found in ${expected.doc}`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("ships valid base64 PNG and image-only PDF assets", async () => {
    const image = corpus.find((document) => document.kind === "image");
    const pdf = corpus.find((document) => document.kind === "ocr-pdf");
    expect(image).toBeDefined();
    expect(pdf).toBeDefined();
    if (!image || !pdf) throw new Error("binary fixture rows are missing");
    const imageBytes = Buffer.from(
      fs.readFileSync(resolveAssetPath(image), "utf8").trim(),
      "base64",
    );
    const pdfBytes = Buffer.from(
      fs.readFileSync(resolveAssetPath(pdf), "utf8").trim(),
      "base64",
    );
    expect(imageBytes.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(pdfBytes.subarray(0, 8).toString("ascii")).toBe("%PDF-1.7");
    await expect(parsePdfBuffer(pdfBytes)).resolves.toMatchObject({
      status: "no_text_layer",
      pageCount: 1,
      textlessPageCount: 1,
    });
  });

  it("matches OCR reference codes across model-added punctuation and spacing", () => {
    expect(
      ocrOutputContainsExpected({
        output: "Contract reference: OCR - NEBULA - 772",
        expected: "OCR-NEBULA-772",
      }),
    ).toBe(true);
  });
});

describe("fixture loaders", () => {
  it("rejects a query that can run without its expected document", () => {
    const corpus = loadCorpus();
    const golden = loadGolden().slice(0, 1);
    golden[0] = {
      ...golden[0],
      expected: [{ doc: "multimodal-lobster" }],
    };
    expect(() => assertGoldenMatchesCorpus(golden, corpus)).toThrow(
      /requires image-embedding/,
    );
  });

  it("rejects malformed JSONL with its line number", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-eval-fixtures-"));
    const filePath = path.join(dir, "golden.jsonl");
    fs.writeFileSync(
      filePath,
      '{"id":"ok","query":"q","component":"text-embedding","expected":[{"doc":"d"}]}\n{"id":"bad"}\n',
    );
    expect(() => loadGolden(filePath)).toThrow(/golden.jsonl:2/);
  });

  it("rejects invalid no-answer gates and conflicting relevance labels", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-eval-fixtures-"));
    const filePath = path.join(dir, "golden.jsonl");
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({
        id: "invalid-no-answer",
        query: "q",
        component: "keyword-ranking",
        expected: [],
        answerability: "no-answer",
        gateMode: "pass-fail",
      })}\n`,
    );
    expect(() => loadGolden(filePath)).toThrow(/must remain metric-only/);

    fs.writeFileSync(
      filePath,
      `${JSON.stringify({
        id: "conflict",
        query: "q",
        component: "text-embedding",
        expected: [{ doc: "a" }],
        judgments: [{ doc: "a", relevance: 0 }],
      })}\n`,
    );
    expect(() => loadGolden(filePath)).toThrow(/positive relevance grade/);
  });

  it("rejects asset traversal", () => {
    const image = loadCorpus().find((document) => document.kind === "image");
    if (!image) throw new Error("image fixture row is missing");
    expect(() =>
      resolveAssetPath({ ...image, asset: "../outside.png" }),
    ).toThrow(FixtureError);
  });
});
