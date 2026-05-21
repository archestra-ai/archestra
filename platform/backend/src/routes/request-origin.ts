import type { FastifyRequest } from "fastify";
import config from "@/config";

/**
 * Return the public origin used in OAuth and MCP metadata.
 *
 * Resolution order:
 *
 * 1. ARCHESTRA_TRUST_PROXY is set → use Fastify's `request.host` /
 *    `request.protocol`. The operator has vouched for the inbound proxy, so
 *    Fastify resolves X-Forwarded-Host / X-Forwarded-Proto into these
 *    accessors, giving an accurate per-request origin (useful for multi-host
 *    ingress).
 *
 * 2. ARCHESTRA_FRONTEND_URL is set (and proxy trust is off) → use
 *    `config.publicOrigin`. No trusted header source is available, so fall
 *    back to the server-controlled origin instead of a client-supplied raw
 *    Host.
 *
 * 3. Neither is set → use raw `request.host`. Only safe for direct dev /
 *    Docker access where the caller hits the backend directly; production
 *    deployments behind ingress should set one of the two env vars.
 *
 * TODO: revisit this logic to merge and test ARCHESTRA_FRONTEND_URL as the
 * canonical origin without breaking too many tests (today many tests assert
 * the raw-Host fallback path, which prevents ARCHESTRA_FRONTEND_URL from
 * always taking precedence).
 */
export function getPublicRequestOrigin(request: FastifyRequest): string {
  const trustProxyEnabled = config.api.trustProxy !== false;

  if (!trustProxyEnabled && config.publicOrigin) {
    return config.publicOrigin;
  }

  const host = request.host || "localhost";
  const protocol = (request.protocol || "http").replace(/:$/, "");
  return `${protocol}://${host}`;
}
