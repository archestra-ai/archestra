/**
 * Delimiter used to separate multiple values within a single label key
 * in the labels query parameter. Pipe is used instead of comma because
 * label values themselves may contain commas.
 * Format: key1:val1|val2;key2:val3
 */
export const LABELS_VALUE_DELIMITER = "|";

/**
 * Delimiter used to separate label key:value groups in the labels query parameter.
 * Format: key1:val1|val2;key2:val3
 */
export const LABELS_ENTRY_DELIMITER = ";";

/**
 * Characters reserved for the labels query parameter format.
 * Label keys and values must not contain any of these.
 */
export const LABEL_RESERVED_CHARS: string[] = [
  LABELS_VALUE_DELIMITER,
  LABELS_ENTRY_DELIMITER,
  ":",
];

/**
 * Parse the `labels` query parameter (format `key1:val1|val2;key2:val3`) into a
 * map of key -> values. Returns undefined when no usable filter is present.
 * Semantics for callers: AND across keys, OR within a key's values.
 */
export function parseLabelsParam(
  labels: string | undefined,
): Record<string, string[]> | undefined {
  if (!labels) return undefined;
  const result: Record<string, string[]> = {};
  for (const entry of labels.split(LABELS_ENTRY_DELIMITER)) {
    const colonIdx = entry.indexOf(":");
    if (colonIdx === -1) continue;
    const key = entry.slice(0, colonIdx).trim();
    const values = entry
      .slice(colonIdx + 1)
      .split(LABELS_VALUE_DELIMITER)
      .map((v) => v.trim())
      .filter(Boolean);
    if (key && values.length > 0) {
      result[key] = values;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
