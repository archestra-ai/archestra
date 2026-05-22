import type { FastifyRequest } from "fastify";

import { getAllowedPublicHosts } from "@/config";
import logger from "@/logging";

/**
 * Return the public origin for a request, scoped to OAuth / MCP metadata
 * responses. Operates independently of Fastify's global `trustProxy` option,
 * so callers can honor reverse-proxy headers here without exposing
 * `request.ip` / `request.host` / etc. elsewhere in the app to header
 * spoofing.
 *
 * The host allowlist is the trust mechanism. `getAllowedPublicHosts()` is
 * derived from `ARCHESTRA_FRONTEND_URL` and `NEXT_PUBLIC_ARCHESTRA_API_BASE_URL`
 * — the set of hostnames the operator has declared as legitimate public
 * origins for this deployment. Forwarded values are only honored when the
 * resulting host is in that set.
 *
 * Decision tree:
 *   1. If neither `X-Forwarded-Proto` nor `X-Forwarded-Host` is present, the
 *      direct Host header and socket TLS state are used.
 *   2. Otherwise, the candidate host is the first comma-separated value of
 *      `X-Forwarded-Host` (matching Fastify), or the direct Host header when
 *      `X-Forwarded-Host` is absent.
 *   3. If the allowlist is non-empty and the candidate host is not in it,
 *      forwarded values are dropped and we fall back to the direct origin.
 *   4. An empty allowlist (neither env var set) accepts any host — local-dev
 *      default. Operators are expected to set `NEXT_PUBLIC_ARCHESTRA_API_BASE_URL`
 *      (and/or `ARCHESTRA_FRONTEND_URL`) in production.
 */
export function getPublicRequestOrigin(request: FastifyRequest): string {
  const directProtocol = deriveProtocol(request);
  const directHost = request.headers.host ?? "localhost";
  const direct = `${directProtocol}://${directHost}`;

  const forwardedProto = pickFirstForwarded(
    request.headers["x-forwarded-proto"],
  );
  const forwardedHost = pickFirstForwarded(request.headers["x-forwarded-host"]);
  if (!forwardedProto && !forwardedHost) return direct;

  const protocol = (forwardedProto ?? directProtocol).replace(/:$/, "");

  let candidateHost: string;
  if (forwardedHost) {
    try {
      candidateHost = new URL(`${protocol}://${forwardedHost}`).host;
    } catch {
      return direct;
    }
  } else {
    candidateHost = directHost;
  }

  const allowed = getAllowedPublicHosts();
  if (allowed.size > 0 && !allowed.has(candidateHost.toLowerCase())) {
    if (forwardedHost) {
      logger.warn(
        { forwardedHost: candidateHost, allowed: Array.from(allowed) },
        "getPublicRequestOrigin: forwarded host not in allowlist; using direct origin",
      );
    }
    return direct;
  }

  return `${protocol}://${candidateHost}`;
}

// ===

function pickFirstForwarded(
  value: string | string[] | undefined,
): string | undefined {
  if (!value) return undefined;
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first.split(",")[0].trim();
  return trimmed || undefined;
}

function deriveProtocol(request: FastifyRequest): string {
  const socket = request.socket as { encrypted?: boolean } | undefined;
  return socket?.encrypted ? "https" : "http";
}
