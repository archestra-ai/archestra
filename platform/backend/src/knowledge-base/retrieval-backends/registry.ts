import type { KnowledgeRetrievalBackend } from "../retrieval-backend";
import { postgresRetrievalBackend } from "./postgres/postgres-retrieval-backend";

/**
 * The retrieval backend used by ingestion and queries.
 *
 * Keep backend construction here. Add runtime selection only when a second
 * production implementation exists.
 */
export const knowledgeRetrievalBackend: KnowledgeRetrievalBackend =
  postgresRetrievalBackend;
