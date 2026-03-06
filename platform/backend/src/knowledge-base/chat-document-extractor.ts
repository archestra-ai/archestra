/**
 * Extract and ingest documents from chat messages into the knowledge base.
 *
 * NOTE: Chat document auto-ingestion is temporarily disabled during the
 * migration from LightRAG to the built-in pgvector RAG stack. It will be
 * re-implemented once the document processing pipeline (chunker + embedder)
 * is in place.
 *
 * @param _messages - Array of messages from the chat request
 * @param _agentId - The agent ID to look up the assigned knowledge base
 */
export async function extractAndIngestDocuments(
  _messages: unknown[],
  _agentId: string,
): Promise<void> {
  // No-op: chat document auto-ingestion will be re-implemented with pgvector
  // once the document processing pipeline (chunker + embedder) is ready.
}
