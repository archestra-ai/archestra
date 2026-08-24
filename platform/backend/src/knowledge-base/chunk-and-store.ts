import type { TextSearchLanguage } from "@archestra/shared";
import type pino from "pino";
import * as metrics from "@/observability/metrics";
import type { AclEntry } from "@/types";
import { chunkDocument } from "./chunker";
import { buildContextualHeaders } from "./contextual-retrieval";
import { stitchChunkContents } from "./parent-passage";
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

  // Context is generated per PASSAGE, not per stored chunk. Under parent/child
  // indexing the stored chunks are children, and a child is a slice of its
  // parent — the context that explains one slice explains all of them. Asking
  // per child would multiply the generation calls by the child-to-parent ratio
  // to produce near-identical text, so the passages are contextualized and each
  // child inherits its parent's header. Without parent/child indexing every
  // chunk is its own passage and this is exactly the previous behaviour.
  //
  // Best-effort and non-fatal: a document indexes without context rather than
  // failing the sync. The returned array is aligned with the passage list: in
  // document mode every entry is the same; in chunk mode each passage can
  // carry its own header.
  const passages = collectPassages(chunks);
  const passageHeaders = await buildContextualHeaders({
    title,
    content,
    chunks: passages.texts,
    organizationId,
    connectorId,
  });

  await knowledgeRetrievalBackend.insertChunks(
    chunks.map((chunk, index) => ({
      documentId,
      content: chunk.content,
      chunkIndex: chunk.chunkIndex,
      parentIndex: chunk.parentIndex,
      metadataSuffixSemantic: chunk.metadataSuffixSemantic,
      metadataSuffixKeyword: chunk.metadataSuffixKeyword,
      contextualHeader: passageHeaders[passages.passageOfChunk[index]] ?? null,
      ftsLanguage,
      acl,
    })),
  );

  metrics.rag.reportChunksCreated(connectorType, chunks.length);

  log.debug(
    {
      documentId,
      chunkCount: chunks.length,
      passageCount: passages.texts.length,
      contextualizedPassageCount: passageHeaders.filter(
        (header) => header !== null,
      ).length,
      ftsLanguage,
    },
    "Document chunked and stored",
  );
}

// ===== Internal helpers =====

/**
 * The passages the chunks came from, and which passage each chunk belongs to.
 *
 * Single-pass chunks are each their own passage; children are grouped by their
 * parent ordinal and their texts stitched back into the passage they were cut
 * from, so what gets contextualized is the same text a search hit will return.
 */
function collectPassages(
  chunks: Array<{ content: string; parentIndex: number | null }>,
): { texts: string[]; passageOfChunk: number[] } {
  const texts: string[] = [];
  const passageOfChunk: number[] = [];
  const positionByParent = new Map<number, number>();

  for (const chunk of chunks) {
    if (chunk.parentIndex === null) {
      passageOfChunk.push(texts.length);
      texts.push(chunk.content);
      continue;
    }

    const existing = positionByParent.get(chunk.parentIndex);
    if (existing === undefined) {
      const position = texts.length;
      positionByParent.set(chunk.parentIndex, position);
      passageOfChunk.push(position);
      texts.push(chunk.content);
      continue;
    }

    passageOfChunk.push(existing);
    texts[existing] = stitchChunkContents([texts[existing], chunk.content]);
  }

  return { texts, passageOfChunk };
}
