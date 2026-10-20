import { parsePublicHostSchemes, resolvePublicScheme } from "@archestra/shared";

/** Public document links must use the ingress origin, not Next.js's bind address. */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  return (
    originFromHeaders(request.headers, url.protocol.slice(0, -1)) ??
    applyConfiguredScheme(url.origin)
  );
}

/**
 * The public origin the request's headers name (the forwarded host and
 * protocol, else the Host header), or null when they name none. A server
 * render, which has the headers but no request URL, reads the origin the
 * browser shows as `window.location.origin` this way.
 */
export function originFromHeaders(
  headers: { get(name: string): string | null },
  observedProtocol = "http",
): string | null {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  const protocol = headers.get("x-forwarded-proto") ?? observedProtocol;
  if (!host || !["http", "https"].includes(protocol)) return null;
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
      return null;
    return applyConfiguredScheme(candidate.origin);
  } catch {
    return null;
  }
}

/**
 * Whether the request's headers say which scheme the browser used, so the
 * origin they name is the one the page shows as `window.location.origin`: a
 * forwarded protocol, a loopback host, or a host the operator named in a
 * public URL (its scheme is configured). Behind a TLS-terminating proxy that
 * sends no X-Forwarded-Proto the scheme is a guess, and a setup prepared for
 * a guessed origin is one the page cannot use.
 */
export function originSchemeKnown(headers: {
  get(name: string): string | null;
}): boolean {
  const host = (
    headers.get("x-forwarded-host") ?? headers.get("host")
  )?.toLowerCase();
  if (!host) return false;
  const protocol = headers.get("x-forwarded-proto");
  if (protocol === "http" || protocol === "https") return true;
  const hostname = host.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  if (["localhost", "127.0.0.1", "::1"].includes(hostname)) return true;
  return parsePublicHostSchemes([
    process.env.ARCHESTRA_FRONTEND_URL,
    process.env.ARCHESTRA_API_BASE_URL,
    process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL,
  ]).has(host);
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

  parsed.protocol = `${resolvePublicScheme({
    host: parsed.host,
    observedScheme: parsed.protocol.replace(/:$/, ""),
    // Read at call time: the server reads these at request time, and tests set
    // them per case.
    schemes: parsePublicHostSchemes([
      process.env.ARCHESTRA_FRONTEND_URL,
      process.env.ARCHESTRA_API_BASE_URL,
      process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL,
    ]),
  })}:`;
  return parsed.origin;
}

/**
 * Where the client's config points. Setup writes URLs under the connection base
 * URL the user picked (`base`, e.g. https://host/v1), which can be another host
 * than this page; without it, assume this origin.
 */
export interface DeploymentTarget {
  /** The connection page origin, for links. */
  origin: string;
  /** Connection base URL, e.g. https://host/v1. */
  base: string;
  /** Origin of the base URL: proxy, gateway and skills all live on it. */
  host: string;
}

export function deploymentTarget(
  origin: string,
  base: string | null,
): DeploymentTarget {
  try {
    const url = new URL(base ?? "");
    if (url.protocol === "http:" || url.protocol === "https:") {
      const path = url.pathname.replace(/\/+$/, "");
      return { origin, base: `${url.origin}${path}`, host: url.origin };
    }
  } catch {
    // fall through to this origin
  }
  return { origin, base: `${origin}/v1`, host: origin };
}
