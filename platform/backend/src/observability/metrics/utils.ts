const sanitizeRegexp = /[^a-zA-Z0-9_]/g;

/**
 * Sanitize a label key for Prometheus compatibility.
 * Prometheus label names must match [a-zA-Z_][a-zA-Z0-9_]*
 * - Replace invalid characters with underscores
 * - Prefix with underscore if starts with a digit
 */
export function sanitizeLabelKey(key: string): string {
  let sanitized = key.replace(sanitizeRegexp, "_");
  if (/^[0-9]/.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }
  return sanitized;
}
