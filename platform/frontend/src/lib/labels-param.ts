import {
  LABELS_ENTRY_DELIMITER,
  LABELS_VALUE_DELIMITER,
} from "@archestra/shared";

export function parseLabelsParam(
  labels: string | null,
): Record<string, string[]> | null {
  if (!labels) return null;
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
  return Object.keys(result).length > 0 ? result : null;
}
