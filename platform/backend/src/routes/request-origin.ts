import type { FastifyRequest } from "fastify";

import config, { getMCPGatewayOauthAllowedPublicHosts } from "@/config";
import logger from "@/logging";

/**
 * Return the public origin for a request — used to build the OAuth
 * protected-resource metadata URL. Scoping origin derivation to OAuth lets MCP
 * gateway OAuth work out of the box without the (too-broad) ARCHESTRA_TRUST_PROXY,
 * while still validating the forwarded host to prevent X-Forwarded-Host spoofing.
 * The origin-derivation logic is adapted from Fastify.
 *
 * MUST BE USED ONLY FOR MCP OAUTH (the MCP gateway and the shareable-App connector).
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

  // If trustProxy is set, the candidate is returned as-is.
  // It's needed not to break any existing setups which already ARCHESTRA_TRUST_PROXY=true.
  // Once we are happy with how scoped validation works, we can remove this alongside with the trustProxy.
  if (config.api.trustProxy) {
    return `${protocol}://${candidateHost}`;
  }

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
