import { resolvePublicScheme, servesHttps } from "@archestra/shared";
import type { FastifyRequest } from "fastify";
import {
  getMCPGatewayOauthAllowedPublicHosts,
  getMCPGatewayOauthPublicHostSchemes,
} from "@/config";
import logger from "@/logging";

/**
 * Return the public origin for a request — used to build the OAuth
 * protected-resource metadata URL. Scoping origin derivation to OAuth lets MCP
 * gateway OAuth work out of the box without the (too-broad) ARCHESTRA_TRUST_PROXY,
 * while always validating the forwarded host to prevent X-Forwarded-Host spoofing.
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
  // Get the direct origin from the request first
  const directProtocol = deriveProtocol(request);
  const directHost = request.headers.host ?? "localhost";

  // Get the forwarded origin from the request headers
  const forwardedProto = pickFirstForwarded(
    request.headers["x-forwarded-proto"],
  );
  const forwardedHost = pickFirstForwarded(request.headers["x-forwarded-host"]);
  if (!forwardedProto && !forwardedHost)
    return resolveOrigin(directHost, directProtocol);
  const protocol = (forwardedProto ?? directProtocol).replace(/:$/, "");

  // Build a candidate host from the forwarded origin
  let candidateHost: string;
  if (forwardedHost) {
    try {
      candidateHost = new URL(`${protocol}://${forwardedHost}`).host;
    } catch {
      return resolveOrigin(directHost, directProtocol);
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
        {
          forwardedHost: candidateHost,
          allowed: Array.from(allowed),
          fix: ALLOWLIST_FIX_HINT,
        },
        "getPublicRequestOrigin: forwarded host not in allowlist; using direct origin",
      );
    }
    return resolveOrigin(directHost, directProtocol);
  }

  return resolveOrigin(candidateHost, protocol);
}

// ===

const ALLOWLIST_FIX_HINT =
  "name this host in ARCHESTRA_API_BASE_URL (comma-separated list) or ARCHESTRA_FRONTEND_URL";

/**
 * Apply the scheme the operator configured for this host, then return the origin.
 *
 * A host the operator published over https must never be advertised over http:
 * an OAuth client following an http metadata URL either fails outright or is
 * downgraded. The backend itself always sees plain http behind a TLS-terminating
 * proxy, and a layer-4 route (Gateway API TLSRoute, for example) cannot set
 * X-Forwarded-Proto at all, so the request alone can never prove the scheme.
 * The configured public URL can, so it wins.
 *
 * A host that appears in no configured public URL keeps the scheme observed on
 * the request and is logged: that combination is a misconfiguration, and an
 * http OAuth origin is the symptom operators report.
 */
function resolveOrigin(host: string, protocol: string): string {
  const configured = getMCPGatewayOauthPublicHostSchemes();
  const scheme = resolvePublicScheme({
    host,
    observedScheme: protocol,
    schemes: configured,
  });
  if (scheme !== "http") return `${scheme}://${host}`;

  // Only a deployment that published at least one https origin can be serving
  // this over TLS, so an all-http configuration (local development, plain-http
  // installs) is left alone rather than warned about on every OAuth challenge.
  if (!configured.has(host.toLowerCase()) && servesHttps(configured)) {
    logger.warn(
      {
        host,
        configured: Array.from(configured.keys()),
        fix: ALLOWLIST_FIX_HINT,
      },
      "getPublicRequestOrigin: advertising an http OAuth origin for a host that is not a configured public URL",
    );
  }
  return `http://${host}`;
}

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
