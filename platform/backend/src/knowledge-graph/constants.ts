/**
 * Supported document MIME types for knowledge graph ingestion
 * These are text-based formats that can be meaningfully indexed
 */
export const SUPPORTED_DOCUMENT_TYPES = [
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "application/json",
  "text/csv",
  "text/xml",
  "application/xml",
  "text/html",
  "text/yaml",
  "application/x-yaml",
  // Common code files
  "text/javascript",
  "application/javascript",
  "text/typescript",
  "text/x-python",
  "text/x-java",
  "text/x-c",
  "text/x-cpp",
];

/**
 * File extensions that map to supported document types
 * Used as fallback when MIME type is generic or missing
 */
export const SUPPORTED_EXTENSIONS = [
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".csv",
  ".xml",
  ".html",
  ".htm",
  ".yaml",
  ".yml",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".py",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".rs",
  ".go",
  ".rb",
  ".php",
  ".sh",
  ".bash",
  ".sql",
  ".graphql",
  ".css",
  ".scss",
  ".less",
];

/**
 * Maximum document size for ingestion (10MB)
 * Documents larger than this will be skipped to prevent memory issues
 */
export const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Maximum concurrent document ingestions to prevent overwhelming LightRAG service
 */
export const MAX_CONCURRENT_INGESTIONS = 3;
