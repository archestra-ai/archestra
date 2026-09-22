/**
 * The scheme of a public origin comes from what the operator configured, not
 * from the request.
 *
 * Archestra serves plain http inside the cluster, so a TLS-terminating proxy
 * that does not send `X-Forwarded-Proto` leaves every self-referential URL
 * looking like http. A layer-4 route, such as a Gateway API `TLSRoute`, cannot
 * send that header at all, so the request can never prove the scheme. The
 * public URLs the operator configured do record it.
 *
 * The backend applies this to MCP gateway OAuth metadata and the frontend to
 * the connection documents. Both read their own environment, and share the
 * parsing and the upgrade rule here so the two cannot drift.
 */

/**
 * Build a host-to-scheme map from configured public URLs.
 *
 * Each entry may hold several comma-separated URLs. Malformed values and
 * blanks are ignored. https wins when one host appears under both schemes,
 * because a host reachable over https must never be advertised over http.
 */
export function parsePublicHostSchemes(
  entries: (string | undefined | null)[],
): Map<string, string> {
  const schemes = new Map<string, string>();
  for (const entry of entries) {
    for (const raw of entry?.split(",") ?? []) {
      const candidate = raw.trim();
      if (!candidate) continue;
      try {
        const url = new URL(candidate);
        const host = url.host.toLowerCase();
        const scheme = url.protocol.replace(/:$/, "");
        if (scheme === "https" || !schemes.has(host)) schemes.set(host, scheme);
      } catch {
        // ignore a malformed entry
      }
    }
  }
  return schemes;
}

/**
 * Return the scheme to advertise for a host, given the observed one.
 *
 * A host configured over https always resolves to https. Any other host keeps
 * the scheme observed on the request, so plain-http and local deployments are
 * unaffected.
 */
export function resolvePublicScheme(params: {
  host: string;
  observedScheme: string;
  schemes: Map<string, string>;
}): string {
  const { host, observedScheme, schemes } = params;
  if (observedScheme !== "http") return observedScheme;
  return schemes.get(host.toLowerCase()) === "https" ? "https" : observedScheme;
}

/** True when at least one configured public URL uses https. */
export function servesHttps(schemes: Map<string, string>): boolean {
  for (const scheme of schemes.values()) if (scheme === "https") return true;
  return false;
}
