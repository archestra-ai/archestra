/**
 * Remove structured inline file bodies from an audit copy of provider traffic.
 * Text and remote file references remain auditable. This is not a content/DLP
 * filter: extracted text, tool arguments, and command output are still logged.
 */
export function redactFilePayloads<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(redactFilePayloads) as T;
  }
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      redactFilePayloads(child),
    ]),
  );

  // OpenAI Chat Completions and Responses (including compatible providers).
  if (result.type === "image_url" && isRecord(result.image_url)) {
    if (isDataUrl(result.image_url.url)) {
      result.image_url.url = OMITTED_FILE_PAYLOAD;
    }
  }
  if (result.type === "input_image" && isDataUrl(result.image_url)) {
    result.image_url = OMITTED_FILE_PAYLOAD;
  }
  if (result.type === "file" && isRecord(result.file)) {
    redactField(result.file, "file_data");
  }
  if (result.type === "input_file") {
    redactField(result, "file_data");
  }
  if (result.type === "input_audio" && isRecord(result.input_audio)) {
    redactField(result.input_audio, "data");
  }

  // Native Ollama messages carry base64 images alongside message content.
  if (typeof result.role === "string" && Array.isArray(result.images)) {
    result.images = result.images.map(() => OMITTED_FILE_PAYLOAD);
  }

  // MCP tool results and UI file parts can appear in approval history.
  if (
    (result.type === "image" || result.type === "audio") &&
    typeof result.mimeType === "string"
  ) {
    redactField(result, "data");
  }
  if (result.type === "resource" && isRecord(result.resource)) {
    redactField(result.resource, "blob");
  }
  if (result.type === "file" && isDataUrl(result.url)) {
    result.url = OMITTED_FILE_PAYLOAD;
  }

  // Anthropic image/PDF blocks. A document's explicit text source is also a
  // file body; ordinary text message blocks are deliberately left intact.
  if (
    (result.type === "image" || result.type === "document") &&
    isRecord(result.source) &&
    (result.source.type === "base64" || result.source.type === "text")
  ) {
    redactField(result.source, "data");
  }

  // Gemini input files and generated images use the same inlineData shape.
  if (isRecord(result.inlineData)) {
    redactField(result.inlineData, "data");
  }

  // Bedrock Converse carries both image and document bodies under source.
  for (const kind of ["image", "document"]) {
    const file = result[kind];
    if (isRecord(file) && isRecord(file.source)) {
      redactField(file.source, "bytes");
    }
  }

  return result as T;
}

const OMITTED_FILE_PAYLOAD = "[Ephemeral file payload omitted]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDataUrl(value: unknown): boolean {
  return (
    typeof value === "string" && value.slice(0, 5).toLowerCase() === "data:"
  );
}

function redactField(record: Record<string, unknown>, key: string): void {
  if (record[key] !== undefined && record[key] !== null) {
    record[key] = OMITTED_FILE_PAYLOAD;
  }
}
