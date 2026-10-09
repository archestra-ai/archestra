/** Single-quote a value for bash; safe for arbitrary content. */
export function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Single-quote a value for PowerShell; safe for arbitrary content. */
export function psq(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function indent(block: string, prefix: string): string {
  return block
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join("\n");
}

/**
 * Property access for a key known to be a safe slug; falls back to a quoted
 * index for anything with non-identifier characters. Server/proxy names are
 * already slugs, so this is defensive.
 */
export function psBareOrIndex(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : `${psq(key)}`;
}
