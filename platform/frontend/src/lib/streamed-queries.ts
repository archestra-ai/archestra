/**
 * The queries whose data the server streamed to this page load. A page's
 * hooks treat such data as fresh even when it settled before they mounted,
 * which a slow device or network makes common: the server's answer is the
 * revalidation, so fetching it again on mount would only repeat the request.
 */
class StreamedQueryRegistry {
  // Query instances, of any data type; a new page load starts empty.
  private queries = new WeakSet<object>();

  mark(query: object) {
    this.queries.add(query);
  }

  has(query: object) {
    return this.queries.has(query);
  }
}

export const streamedQueries = new StreamedQueryRegistry();
