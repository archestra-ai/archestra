/** Most ids a list endpoint accepts per request. */
const ID_CHUNK_SIZE = 250;

/** Reads rows by id in parallel chunks, results in chunk order. */
export async function fetchInIdChunks<T>(
  ids: readonly string[],
  fetchChunk: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += ID_CHUNK_SIZE) {
    chunks.push(ids.slice(start, start + ID_CHUNK_SIZE));
  }
  return (await Promise.all(chunks.map(fetchChunk))).flat();
}
