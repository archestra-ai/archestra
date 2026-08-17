/**
 * The file types the knowledge repository can extract text from — the backend
 * dispatches on extension, so this accept-list is the client-side mirror of
 * `knowledge-base/file-upload/extract.ts`. Shared by every surface that
 * uploads into the repository.
 */
export const KNOWLEDGE_FILE_ACCEPT =
  ".pdf,.docx,.txt,.md,.markdown,.csv,.json,.html,.htm";

export const KNOWLEDGE_FILE_TYPES_LABEL = "PDF, DOCX, MD, TXT, CSV, JSON, HTML";
