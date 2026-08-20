import type { TextSearchLanguage } from "@archestra/shared";
import type pino from "pino";
import { KbChunkModel } from "@/models";
import * as metrics from "@/observability/metrics";
import type { AclEntry } from "@/types";
import { chunkDocument } from "./chunker";
import { buildDocumentContext } from "./contextual-retrieval";

/**
 * Split a stored document into chunks and persist them.
 *
 * Every ingestion path has to go through here: chunks — not the document row —
 * are what retrieval searches, and the embedding pass only ever READS chunks
 * (a document with none is marked `completed` with `chunkCount: 0`). So a path
 * that stores a document without chunking it produces a document that looks
 * fully indexed and can never be retrieved.
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
    await KbChunkModel.insertMany([
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
  // failing the sync. Generated once here and copied onto every chunk.
  const contextualHeader = await buildDocumentContext({
    title,
    content,
    organizationId,
    connectorId,
  });

  await KbChunkModel.insertMany(
    chunks.map((chunk) => ({
      documentId,
      content: chunk.content,
      chunkIndex: chunk.chunkIndex,
      metadataSuffixSemantic: chunk.metadataSuffixSemantic,
      metadataSuffixKeyword: chunk.metadataSuffixKeyword,
      contextualHeader,
      ftsLanguage,
      acl,
    })),
  );

  metrics.rag.reportChunksCreated(connectorType, chunks.length);

  log.debug(
    {
      documentId,
      chunkCount: chunks.length,
      contextualHeader: contextualHeader !== null,
      ftsLanguage,
    },
    "Document chunked and stored",
  );
}
