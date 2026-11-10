export function grokToolName(name: string): string {
  return `grokx${Array.from(Buffer.from(name), (byte) =>
    /[A-Za-z0-9-]/.test(String.fromCharCode(byte))
      ? String.fromCharCode(byte)
      : `_${byte.toString(16).padStart(2, "0")}`,
  ).join("")}`;
}

export function grokCanonicalToolName(name: string): string | undefined {
  if (!name.startsWith("grokx")) return;
  const encoded = name.slice(5);
  if (!/^(?:[A-Za-z0-9-]|_[0-9a-f]{2})+$/.test(encoded)) return;
  const bytes = encoded.match(/[A-Za-z0-9-]|_[0-9a-f]{2}/g);
  if (!bytes) return;
  const decoded = Buffer.from(
    bytes.map((byte) =>
      byte.startsWith("_")
        ? Number.parseInt(byte.slice(1), 16)
        : byte.charCodeAt(0),
    ),
  ).toString("utf8");
  return grokToolName(decoded) === name ? decoded : undefined;
}

/** Discovery hint only: decoding a remembered native name grants no tool identity. */
export function grokCatalogToolHint(name: string): string | undefined {
  const separator = name.lastIndexOf("__");
  return separator > 0
    ? grokCanonicalToolName(name.slice(separator + 2))
    : undefined;
}
