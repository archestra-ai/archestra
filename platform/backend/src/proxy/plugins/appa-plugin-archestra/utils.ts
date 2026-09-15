/**
 * Reads a case-insensitive header from an incoming HTTP headers record.
 */
export function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = Object.entries(headers).find(
    ([headerName]) => headerName.toLowerCase() === name.toLowerCase(),
  )?.[1];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Checks if a value is a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function hasReportedResultContent(
  value: Record<string, unknown>,
  field: "content" | "output",
): boolean {
  return Object.hasOwn(value, field) && value[field] !== null;
}
