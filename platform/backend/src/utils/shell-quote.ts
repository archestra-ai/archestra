/**
 * quote a value for safe interpolation into a POSIX shell command: wrap in
 * single quotes, escaping embedded single quotes via the `'\''` idiom.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
