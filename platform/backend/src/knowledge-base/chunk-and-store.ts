import type { TextSearchLanguage } from "@archestra/shared";
import type pino from "pino";
import * as metrics from "@/observability/metrics";
import type { AclEntry } from "@/types";
import { chunkDocument } from "./chunker";
import { buildContextualHeaders } from "./contextual-retrieval";
import { knowledgeRetrievalBackend } from "./retrieval-backends/registry";

/**
 * Split a stored document into chunks and persist them.
 *
 * Every ingestion path has to go through here: chunks — not the document row —
 * are what retrieval searches, and the embedding pass only ever READS chunks
 * (a document with none is marked `failed` and surfaced on its connector run).
 * So a path that stores a document without chunking it cannot silently look
 * indexed while remaining impossible to retrieve.
 *
 * Callers replacing a document's content must delete its existing chunks first;
 * this appends.
 */
export async function chunkAndStoreDocument(params: {
  documentId: string;
  title: string;
  content: string;
  mediaContent?: { mimeType: string; data: string };
  metadata?: Record<string, unknown>;
  connectorType: string;
  connectorId: string;
  organizationId: string;
  ftsLanguage: TextSearchLanguage;
  acl: AclEntry[];
  log: pino.Logger;
}): Promise<void> {
  const {
    documentId,
    title,
    content,
    mediaContent,
    metadata,
    connectorType,
    connectorId,
    organizationId,
    ftsLanguage,
    acl,
    log,
  } = params;

  // For media (image) documents: create a single chunk whose content is the
  // data URL. The embedding pipeline detects this prefix and routes to the
  // multimodal embedding API instead of text embedding.
  if (mediaContent) {
    const dataUrl = `data:${mediaContent.mimeType};base64,${mediaContent.data}`;
    await knowledgeRetrievalBackend.insertChunks([
      {
        documentId,
        content: dataUrl,
        chunkIndex: 0,
        metadataSuffixSemantic: null,
        metadataSuffixKeyword: null,
        // A media chunk's content is a base64 data URL, not prose: there is
        // nothing for a stemmer to stem and no document context worth
        // indexing against it. It is retrieved by multimodal vector search.
        contextualHeader: null,
        ftsLanguage,
        acl,
      },
    ]);
    metrics.rag.reportChunksCreated(connectorType, 1);
    log.debug({ documentId }, "Image document stored as single media chunk");
    return;
  }

  const chunks = await chunkDocument({ title, content, metadata });

  if (chunks.length === 0) return;

  // Best-effort and non-fatal: a document indexes without context rather than
  // failing the sync. The returned array is aligned with the chunk list: in
  // document mode every entry is the same; in chunk mode each passage can
  // carry its own header.
  const contextualHeaders = await buildContextualHeaders({
    title,
    content,
    chunks: chunks.map((chunk) => chunk.content),
    organizationId,
    connectorId,
  });

  await knowledgeRetrievalBackend.insertChunks(
    chunks.map((chunk, index) => ({
      documentId,
      content: chunk.content,
      chunkIndex: chunk.chunkIndex,
      metadataSuffixSemantic: chunk.metadataSuffixSemantic,
      metadataSuffixKeyword: chunk.metadataSuffixKeyword,
      contextualHeader: contextualHeaders[index] ?? null,
      ftsLanguage,
      acl,
    })),
  );

  metrics.rag.reportChunksCreated(connectorType, chunks.length);

  log.debug(
    {
      documentId,
      chunkCount: chunks.length,
      contextualizedChunkCount: contextualHeaders.filter(
        (header) => header !== null,
      ).length,
      ftsLanguage,
    },
    "Document chunked and stored",
  );
}
