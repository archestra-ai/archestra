import type { FastifyRequest } from "fastify";

import { getMCPGatewayOauthAllowedPublicHosts } from "@/config";
import logger from "@/logging";

/**
 * Return the public origin for a request — the origin an external client
 * reached us on, rather than the one our socket was accepted on. Deriving it
 * here lets the MCP gateway and A2A work out of the box without the (too-broad)
 * ARCHESTRA_TRUST_PROXY, while always validating the forwarded host against the
 * configured-public-hosts allowlist to prevent X-Forwarded-Host spoofing. The
 * origin-derivation logic is adapted from Fastify.
 *
 * MUST BE USED ONLY to build URLs we hand to external clients as "dial this":
 * MCP OAuth metadata (the MCP gateway and the shareable-App connector) and the
 * A2A AgentCard. It is deliberately not a general request-origin accessor —
 * anything security-sensitive must not key off a client-supplied header.
 */
export function getPublicRequestOrigin(request: FastifyRequest): string {
  const result = computePublicRequestOrigin(request);
  const directProtocol = deriveProtocol(request);
  const directHost = request.headers.host ?? "localhost";
  const direct = `${directProtocol}://${directHost}`;
  logger.info(
    { direct, result },
    "getPublicRequestOrigin: direct and returned result",
  );
  return result;
}

function computePublicRequestOrigin(request: FastifyRequest): string {
  // Get the direct origin from the request firs
  const directProtocol = deriveProtocol(request);
  const directHost = request.headers.host ?? "localhost";
  const direct = `${directProtocol}://${directHost}`;

  // Get the forwarded origin from the request headers
  const forwardedProto = pickFirstForwarded(
    request.headers["x-forwarded-proto"],
  );
  const forwardedHost = pickFirstForwarded(request.headers["x-forwarded-host"]);
  if (!forwardedProto && !forwardedHost) return direct;
  const protocol = (forwardedProto ?? directProtocol).replace(/:$/, "");

  // Build a candidate host from the forwarded origin
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

  // The allowlist applies regardless of ARCHESTRA_TRUST_PROXY. This function
  // reads the raw X-Forwarded-Host header rather than request.hostname, so
  // Fastify's trusted-proxy gating never filters it: honoring trustProxy here
  // would accept a forwarded host from ANY client, including one whose socket
  // peer is not a trusted proxy at all. A deployment that terminates TLS at a
  // proxy names its public host in ARCHESTRA_API_BASE_URL (or
  // ARCHESTRA_FRONTEND_URL), which is what the allowlist is built from.

  // Check if the candidate host is in the allowed list
  const allowed = getMCPGatewayOauthAllowedPublicHosts();
  if (!allowed.has(candidateHost.toLowerCase())) {
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
