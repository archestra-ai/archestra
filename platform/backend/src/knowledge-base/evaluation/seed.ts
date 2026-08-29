import { createHash } from "node:crypto";
import fs from "node:fs";
import { chunkAndStoreDocument } from "@/knowledge-base/chunk-and-store";
import { embeddingService } from "@/knowledge-base/embedder";
import { extractText } from "@/knowledge-base/file-upload/extract";
import {
  OCR_RUN_PAGE_BUDGET,
  type OcrRunContext,
} from "@/knowledge-base/pdf-ocr";
import logger from "@/logging";
import KbChunkModel from "@/models/kb-chunk";
import KbDocumentModel from "@/models/kb-document";
import KnowledgeBaseModel from "@/models/knowledge-base";
import KnowledgeBaseConnectorModel from "@/models/knowledge-base-connector";
import {
  active,
  type EvaluationContext,
  inactiveCapabilityReasons,
  setCapability,
  unavailable,
} from "./capabilities";
import { materializeCorpusContent, resolveAssetPath } from "./fixtures";
import { ocrOutputContainsExpected } from "./ocr-validation";
import type { CorpusDocument } from "./schema";

export const EVAL_ACL = ["org:*"] as const;
const EVAL_FTS_LANGUAGE = "english" as const;

export interface SeededCorpus {
  knowledgeBaseId: string;
  connectorId: string;
  documentIds: Map<string, string>;
  documents: number;
  chunks: number;
  textDocuments: number;
  imageDocuments: number;
  ocrDocuments: number;
  contextualizedChunks: number;
  wallMs: number;
  warnings: string[];
}

/** Create only the isolated KB/connector shell so cleanup is always possible. */
export async function createEvalFixture(params: {
  context: EvaluationContext;
  runId: string;
}): Promise<SeededCorpus> {
  const suffix = params.runId.slice(0, 8);
  const knowledgeBase = await KnowledgeBaseModel.create({
    organizationId: params.context.organizationId,
    name: `__kb-eval-${suffix}`,
  });
  const connector = await KnowledgeBaseConnectorModel.create({
    organizationId: params.context.organizationId,
    name: `__kb-eval-corpus-${suffix}`,
    connectorType: "web_crawler",
    config: { type: "web_crawler", startUrl: "https://kb-eval.invalid" },
    ftsLanguage: EVAL_FTS_LANGUAGE,
  });
  const assigned = await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
    connector.id,
    knowledgeBase.id,
  );
  if (!assigned) {
    throw new Error("could not assign the evaluation connector to its KB");
  }
  return {
    knowledgeBaseId: knowledgeBase.id,
    connectorId: connector.id,
    documentIds: new Map(),
    documents: 0,
    chunks: 0,
    textDocuments: 0,
    imageDocuments: 0,
    ocrDocuments: 0,
    contextualizedChunks: 0,
    wallMs: 0,
    warnings: [],
  };
}

/** Ingest applicable fixtures through the production OCR/chunk/embed path. */
export async function ingestCorpus(params: {
  context: EvaluationContext;
  seeded: SeededCorpus;
  corpus: CorpusDocument[];
  embedDocuments?: boolean;
  skipContextualRetrieval?: boolean;
  control?: {
    beforeDocument?: (progress: {
      index: number;
      total: number;
      documentId: string;
    }) => Promise<void> | void;
  };
}): Promise<void> {
  const { context, seeded, corpus } = params;
  const embedDocuments = params.embedDocuments ?? true;
  if (embedDocuments && !context.embedding) {
    throw new Error(
      "text embedding is not configured; no corpus can be queried",
    );
  }
  const started = Date.now();
  const log = logger.child({
    component: "kb-eval",
    run: seeded.knowledgeBaseId,
  });
  const ocr: OcrRunContext | null = context.ocr
    ? {
        config: context.ocr,
        connectorId: seeded.connectorId,
        deadlineAt: Date.now() + 10 * 60_000,
        budget: { remainingPages: OCR_RUN_PAGE_BUDGET },
        log,
        connectorType: "kb-eval",
      }
    : null;

  for (const [index, document] of corpus.entries()) {
    await params.control?.beforeDocument?.({
      index,
      total: corpus.length,
      documentId: document.id,
    });
    const inactive = inactiveCapabilityReasons(
      document.requires.filter(
        (requirement) =>
          requirement !== "bm25" &&
          (embedDocuments || requirement !== "text-embedding"),
      ),
      context.capabilities,
    );
    if (inactive.length > 0) continue;

    try {
      const prepared = await prepareDocument({ document, context, ocr });
      if (!prepared) continue;
      const created = await KbDocumentModel.create({
        organizationId: context.organizationId,
        connectorId: seeded.connectorId,
        sourceId: document.id,
        title: document.title,
        content: prepared.content,
        contentHash: createHash("sha256")
          .update(prepared.hashInput)
          .digest("hex"),
        sourceUrl: document.sourceUrl ?? null,
        acl: [...EVAL_ACL],
      });
      await chunkAndStoreDocument({
        documentId: created.id,
        title: document.title,
        content: prepared.content,
        ...(prepared.mediaContent
          ? { mediaContent: prepared.mediaContent }
          : {}),
        connectorType: "kb-eval",
        connectorId: seeded.connectorId,
        organizationId: context.organizationId,
        ftsLanguage: EVAL_FTS_LANGUAGE,
        acl: [...EVAL_ACL],
        log,
        skipContextualRetrieval: params.skipContextualRetrieval,
        contextualRetrievalMode: context.contextualRetrievalMode,
        ...(context.reranker ? { rerankerConfig: context.reranker } : {}),
      });
      if (embedDocuments && context.embedding) {
        await embeddingService.processDocument(created.id, context.embedding);
      }

      const stored = await KbDocumentModel.findById(created.id);
      const chunks = await KbChunkModel.findByDocument(created.id);
      const embeddedChunkCount =
        embedDocuments && context.embedding
          ? await KbChunkModel.countEmbeddedByDocument(
              created.id,
              context.embedding.dimensions,
            )
          : 0;
      if (
        !stored ||
        chunks.length === 0 ||
        (embedDocuments &&
          (stored.embeddingStatus !== "completed" || embeddedChunkCount === 0))
      ) {
        throw new Error(
          `embedding did not complete (status=${stored?.embeddingStatus ?? "missing"}, chunks=${chunks.length}, embedded=${embeddedChunkCount})`,
        );
      }
      if (
        embedDocuments &&
        document.kind === "image" &&
        embeddedChunkCount !== chunks.length
      ) {
        throw new Error(
          "the configured multimodal model skipped the image chunk",
        );
      }

      seeded.documentIds.set(document.id, created.id);
      seeded.documents++;
      seeded.chunks += chunks.length;
      seeded.contextualizedChunks += chunks.filter(
        (chunk) => chunk.contextualHeader !== null,
      ).length;
      if (document.kind === "text") seeded.textDocuments++;
      else if (document.kind === "image") seeded.imageDocuments++;
      else seeded.ocrDocuments++;

      if (
        document.requires.includes("contextual-retrieval") &&
        !chunks.some((chunk) => chunk.contextualHeader !== null)
      ) {
        setCapability(
          context,
          "contextual-retrieval",
          unavailable(
            "enabled, but the production contextual-retrieval call produced no stored header",
          ),
        );
      }
      if (
        document.requires.includes("context-expansion") &&
        chunks.length < 2
      ) {
        setCapability(
          context,
          "context-expansion",
          unavailable(
            "the fixed expansion fixture produced fewer than two chunks",
          ),
        );
      }
    } catch (error) {
      const message = `${document.id}: ${summarize(error)}`;
      if (document.kind === "image") {
        setCapability(context, "image-embedding", unavailable(message));
        seeded.warnings.push(`image scenario unavailable: ${message}`);
        continue;
      }
      if (document.kind === "ocr-pdf") {
        setCapability(context, "ocr", unavailable(message));
        seeded.warnings.push(`OCR scenario unavailable: ${message}`);
        continue;
      }
      throw new Error(`failed to ingest fixed text fixture ${message}`);
    }
  }
  seeded.wallMs += Date.now() - started;
}

/** Build and prove the real BM25 statistics used by queryService. */
export async function prepareBm25(params: {
  context: EvaluationContext;
  connectorId: string;
  force?: boolean;
}): Promise<boolean> {
  if (
    !params.force &&
    params.context.capabilities["hybrid-search"].status !== "active"
  ) {
    return false;
  }
  try {
    await KbChunkModel.refreshBm25Stats();
    const ready = await KbChunkModel.hasBm25Stats(
      [EVAL_FTS_LANGUAGE],
      [params.connectorId],
    );
    if (!ready) {
      setCapability(
        params.context,
        "bm25",
        unavailable(
          "statistics refresh completed but queryService would use ts_rank",
        ),
      );
      return false;
    }
    setCapability(
      params.context,
      "bm25",
      active(
        `real corpus statistics; k1=${params.context.effectiveConfig.bm25K1}, b=${params.context.effectiveConfig.bm25B}, recallCap=${params.context.effectiveConfig.bm25RecallCap}`,
      ),
    );
    return true;
  } catch (error) {
    setCapability(
      params.context,
      "bm25",
      unavailable(`statistics refresh failed: ${summarize(error)}`),
    );
    return false;
  }
}

/** Remove only the uniquely named objects created by this run. */
export async function cleanupEvalFixture(params: {
  organizationId: string;
  seeded: SeededCorpus;
  refreshBm25: boolean;
}): Promise<void> {
  await cleanupEvalFixtureByIds({
    organizationId: params.organizationId,
    knowledgeBaseId: params.seeded.knowledgeBaseId,
    connectorId: params.seeded.connectorId,
    refreshBm25: params.refreshBm25,
  });
}

/** Idempotent crash-recovery cleanup from IDs persisted by the task handler. */
export async function cleanupEvalFixtureByIds(params: {
  organizationId: string;
  knowledgeBaseId: string;
  connectorId: string;
  refreshBm25: boolean;
}): Promise<void> {
  await KbDocumentModel.deleteByConnector(params.connectorId);
  if (await KnowledgeBaseConnectorModel.delete(params.connectorId)) {
    await KnowledgeBaseConnectorModel.purge({
      id: params.connectorId,
      organizationId: params.organizationId,
    });
  }
  if (await KnowledgeBaseModel.delete(params.knowledgeBaseId)) {
    await KnowledgeBaseModel.purge({
      id: params.knowledgeBaseId,
      organizationId: params.organizationId,
    });
  }
  // Remove the deleted fixture's terms from the same derived cache we refreshed
  // before the run, so an administrator leaves no evaluation data behind.
  if (params.refreshBm25) await KbChunkModel.refreshBm25Stats();
}

// ===== Internal helpers =====

async function prepareDocument(params: {
  document: CorpusDocument;
  context: EvaluationContext;
  ocr: OcrRunContext | null;
}): Promise<{
  content: string;
  hashInput: string | Buffer;
  mediaContent?: { mimeType: string; data: string };
} | null> {
  const { document, context, ocr } = params;
  if (document.kind === "text") {
    const content = materializeCorpusContent(document);
    return { content, hashInput: content };
  }

  const assetPath = resolveAssetPath(document);
  const raw = fs.readFileSync(assetPath);
  const buffer = document.asset?.endsWith(".b64")
    ? Buffer.from(raw.toString("utf8").trim(), "base64")
    : raw;
  const assetName = document.asset?.replace(/\.b64$/, "") ?? "fixture";
  if (document.kind === "image") {
    const mimeType = imageMimeType(assetName);
    if (
      context.embedding?.acceptedImageMimeTypes &&
      !context.embedding.acceptedImageMimeTypes.includes(mimeType)
    ) {
      setCapability(
        context,
        "image-embedding",
        unavailable(
          `fixture MIME type ${mimeType} is not accepted by the model`,
        ),
      );
      return null;
    }
    return {
      content: document.content ?? `[image fixture: ${document.title}]`,
      hashInput: buffer,
      mediaContent: { mimeType, data: buffer.toString("base64") },
    };
  }

  if (!ocr) return null;
  const extracted = await extractText({
    buffer,
    filename: assetName,
    ocr,
  });
  const expected = document.content?.trim() ?? "";
  if (!ocrOutputContainsExpected({ output: extracted.text, expected })) {
    throw new Error(
      `real OCR output did not contain expected text ${JSON.stringify(expected)}`,
    );
  }
  return { content: extracted.text, hashInput: buffer };
}

function imageMimeType(asset: string): string {
  const extension = asset.toLowerCase().split(".").pop();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  throw new Error(`unsupported image fixture extension: ${asset}`);
}

function summarize(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
