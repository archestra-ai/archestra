/** Public document links must use the ingress origin, not Next.js's bind address. */
export function requestOrigin(request: Request): string {
  const fallback = new URL(request.url).origin;
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const protocol =
    request.headers.get("x-forwarded-proto") ??
    new URL(request.url).protocol.slice(0, -1);
  if (!host || !["http", "https"].includes(protocol)) return fallback;
  try {
    const candidate = new URL(`${protocol}://${host}`);
    // Accept an authority only: no credentials, paths, queries, or fragments.
    if (
      candidate.host !== host ||
      candidate.username ||
      candidate.password ||
      candidate.pathname !== "/" ||
      candidate.search ||
      candidate.hash
    )
      return fallback;
    return candidate.origin;
  } catch {
    return fallback;
  }
}
