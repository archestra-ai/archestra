import { isDbStatementTimeoutError } from "@/database/retry";
import { KbChunkModel } from "@/models";
import type { KnowledgeRetrievalBackend } from "../../retrieval-backend";

/** The built-in retrieval backend. It requires no backend-specific settings. */
export const postgresRetrievalBackend: KnowledgeRetrievalBackend = {
  requiresResultVerification: false,
  insertChunks: (chunks) => KbChunkModel.insertMany(chunks),
  getDocumentChunks: (documentId) => KbChunkModel.findByDocument(documentId),
  countDocumentChunks: (documentId) => KbChunkModel.countByDocument(documentId),
  deleteDocumentChunks: (documentId) =>
    KbChunkModel.deleteByDocument(documentId),
  indexEmbeddings: ({ updates, dimensions }) =>
    KbChunkModel.updateEmbeddings(updates, dimensions),
  vectorSearch: (params) => KbChunkModel.vectorSearch(params),
  keywordSearch: (params) => KbChunkModel.fullTextSearch(params),
  findNeighbors: (params) => KbChunkModel.findNeighbors(params),
  getTextSearchLanguages: (connectorIds) =>
    KbChunkModel.getTextSearchLanguages(connectorIds),
  getPopulatedEmbeddingDimensions: (connectorIds) =>
    KbChunkModel.getPopulatedEmbeddingDimensions(connectorIds),
  hasKeywordStatistics: (languages, connectorIds) =>
    KbChunkModel.hasBm25Stats(languages, connectorIds),
  isSearchTimeout: (error) => isDbStatementTimeoutError(error),
};
