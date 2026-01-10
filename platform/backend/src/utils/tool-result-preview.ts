export type LengthEstimate = {
  length: number;
  isEstimated: boolean;
};

function extractTextValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.text === "string") {
      return candidate.text;
    }
  }

  return null;
}

function extractBinaryLength(value: unknown): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const data =
    typeof candidate.data === "string"
      ? candidate.data
      : typeof candidate.image_data === "string"
        ? candidate.image_data
        : null;

  return data ? data.length : null;
}

function extractNestedContent(value: Record<string, unknown>): unknown | null {
  const nested = value.content ?? value.output ?? value.result;
  return nested === undefined ? null : nested;
}

function appendPreview(
  current: string,
  addition: string,
  maxLength: number,
): string {
  if (current.length >= maxLength) {
    return current;
  }

  const remaining = maxLength - current.length;
  return current + addition.slice(0, remaining);
}

export function estimateToolResultContentLength(
  content: unknown,
): LengthEstimate {
  if (typeof content === "string") {
    return { length: content.length, isEstimated: false };
  }

  if (Array.isArray(content)) {
    let length = 0;
    let isEstimated = false;

    for (const item of content) {
      if (typeof item === "string") {
        length += item.length;
        continue;
      }

      const text = extractTextValue(item);
      if (text !== null) {
        length += text.length;
        isEstimated = true;
        continue;
      }

      const binaryLength = extractBinaryLength(item);
      if (binaryLength !== null) {
        length += binaryLength;
        isEstimated = true;
        continue;
      }

      if (typeof item === "number" || typeof item === "boolean") {
        length += String(item).length;
        isEstimated = true;
        continue;
      }

      isEstimated = true;
    }

    return { length, isEstimated };
  }

  if (content && typeof content === "object") {
    const candidate = content as Record<string, unknown>;
    const nestedContent = extractNestedContent(candidate);
    if (nestedContent !== null && nestedContent !== content) {
      const nestedEstimate = estimateToolResultContentLength(nestedContent);
      return { length: nestedEstimate.length, isEstimated: true };
    }

    const text = extractTextValue(content);
    if (text !== null) {
      return { length: text.length, isEstimated: true };
    }

    const binaryLength = extractBinaryLength(content);
    if (binaryLength !== null) {
      return { length: binaryLength, isEstimated: true };
    }

    return { length: 0, isEstimated: true };
  }

  return { length: 0, isEstimated: true };
}

export function previewToolResultContent(
  content: unknown,
  maxLength: number,
): string {
  if (maxLength <= 0) {
    return "";
  }

  if (typeof content === "string") {
    return content.slice(0, maxLength);
  }

  if (Array.isArray(content)) {
    let preview = "";

    for (const item of content) {
      if (preview.length >= maxLength) {
        break;
      }

      const text = extractTextValue(item);
      if (text !== null) {
        preview = appendPreview(preview, text, maxLength);
        continue;
      }

      const binaryLength = extractBinaryLength(item);
      if (binaryLength !== null) {
        preview = appendPreview(preview, "[binary content omitted]", maxLength);
        continue;
      }

      if (typeof item === "string") {
        preview = appendPreview(preview, item, maxLength);
        continue;
      }

      if (typeof item === "number" || typeof item === "boolean") {
        preview = appendPreview(preview, String(item), maxLength);
        continue;
      }

      preview = appendPreview(preview, "[object]", maxLength);
    }

    return preview;
  }

  if (content && typeof content === "object") {
    const candidate = content as Record<string, unknown>;
    const nestedContent = extractNestedContent(candidate);
    if (nestedContent !== null && nestedContent !== content) {
      return previewToolResultContent(nestedContent, maxLength);
    }

    const text = extractTextValue(content);
    if (text !== null) {
      return text.slice(0, maxLength);
    }

    const binaryLength = extractBinaryLength(content);
    if (binaryLength !== null) {
      return "[binary content omitted]";
    }

    return "[object]";
  }

  return String(content).slice(0, maxLength);
}
