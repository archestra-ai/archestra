export const SUPPORTED_KNOWLEDGE_FILE_EXTENSIONS = [
  "txt",
  "md",
  "csv",
  "json",
  "xml",
  "pdf",
] as const;

export const SUPPORTED_KNOWLEDGE_FILE_MIME_TYPES = [
  "application/csv",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/vnd.ms-excel",
  "application/xml",
  "text/xml",
  "application/pdf",
] as const;

export const KNOWLEDGE_FILE_ACCEPT_ATTRIBUTE =
  SUPPORTED_KNOWLEDGE_FILE_EXTENSIONS.map((extension) => `.${extension}`).join(
    ",",
  );

export const KNOWLEDGE_FILE_SUPPORTED_FORMATS_LABEL =
  "TXT, Markdown, CSV, JSON, XML, and PDF";
