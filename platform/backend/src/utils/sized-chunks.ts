/**
 * Cut rows into consecutive chunks of at most `maxRows` rows and `maxBytes`
 * of the size `sizeOf` reports for each row. A row larger than the byte
 * budget travels alone rather than being skipped.
 */
export function* sizedChunks<T>(
  rows: Iterable<T>,
  limits: { maxRows: number; maxBytes: number },
  sizeOf: (row: T) => number,
): Generator<T[]> {
  let chunk: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = sizeOf(row);
    if (
      chunk.length > 0 &&
      (bytes + size > limits.maxBytes || chunk.length >= limits.maxRows)
    ) {
      yield chunk;
      chunk = [];
      bytes = 0;
    }
    chunk.push(row);
    bytes += size;
  }
  if (chunk.length > 0) yield chunk;
}
