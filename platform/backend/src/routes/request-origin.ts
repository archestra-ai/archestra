import type { FastifyRequest } from "fastify";
import config from "@/config";

/**
 * Return the public origin used in OAuth and MCP metadata.
 *
 * Resolution order:
 *
 * 1. `config.publicOrigin` — set when an operator configures
 *    ARCHESTRA_FRONTEND_URL. This is the safe, server-controlled path: it
 *    works behind ingress without ARCHESTRA_TRUST_PROXY because it doesn't
 *    rely on header trust.
 *
 * 2. Fastify's `request.host` / `request.protocol`. These honor
 *    X-Forwarded-Host and X-Forwarded-Proto only when ARCHESTRA_TRUST_PROXY
 *    matches the inbound proxy IP/CIDR — otherwise they reflect the raw Host
 *    and the request's protocol.
 */
export function getPublicRequestOrigin(request: FastifyRequest): string {
  if (config.publicOrigin) {
    return config.publicOrigin;
  }

  const host = request.host || "localhost";
  const protocol = (request.protocol || "http").replace(/:$/, "");
  return `${protocol}://${host}`;
}
