export function readHeader(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const normalizedName = name.toLowerCase();
  // Fastify lowercases production request headers. Keep the fallback for the
  // case-preserving header records accepted by this reusable adapter boundary.
  const value =
    headers[normalizedName] ??
    Object.entries(headers).find(
      ([headerName]) => headerName.toLowerCase() === normalizedName,
    )?.[1];
  // These client-identification signals are single-valued, not authority headers.
  return Array.isArray(value) ? value[0] : value;
}

/** Normalize the model-provided question header for a client's tab UI. */
export function questionHeader(header: unknown, maxLength: number): string {
  const trimmed = typeof header === "string" ? header.trim() : "";
  return trimmed.length > 0
    ? trimmed.slice(0, maxLength).trimEnd()
    : "Question";
}
