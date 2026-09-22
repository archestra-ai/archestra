/** Public document links must use the ingress origin, not Next.js's bind address. */
export function requestOrigin(request: Request): string {
  const fallback = applyConfiguredScheme(new URL(request.url).origin);
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
    return applyConfiguredScheme(candidate.origin);
  } catch {
    return fallback;
  }
}

/**
 * Restore the scheme the operator configured for this host.
 *
 * Next.js always binds plain http, so a TLS-terminating proxy that does not
 * send X-Forwarded-Proto leaves this origin looking like http. A layer-4 route
 * (Gateway API TLSRoute, for example) cannot send that header at all. The
 * connection documents then hand the reader http URLs for a deployment that
 * only answers over https, and the setup they describe stalls.
 *
 * The public URLs the operator configured do record the scheme, so they decide
 * it here. Only a host named in one of them is upgraded, and the host itself is
 * never taken from configuration, so this cannot redirect a reader elsewhere.
 */
function applyConfiguredScheme(origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return origin;
  }
  if (parsed.protocol !== "http:") return origin;

  if (configuredHttpsHosts().has(parsed.host.toLowerCase())) {
    parsed.protocol = "https:";
    return parsed.origin;
  }
  return origin;
}

function configuredHttpsHosts(): Set<string> {
  const hosts = new Set<string>();
  // Read at call time: the server reads these at request time, and tests set
  // them per case.
  const configured = [
    process.env.ARCHESTRA_FRONTEND_URL,
    process.env.ARCHESTRA_API_BASE_URL,
    process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL,
  ];
  for (const entry of configured) {
    for (const raw of entry?.split(",") ?? []) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        const url = new URL(trimmed);
        if (url.protocol === "https:") hosts.add(url.host.toLowerCase());
      } catch {
        // ignore a malformed entry
      }
    }
  }
  return hosts;
}
