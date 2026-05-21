import type { FastifyRequest } from "fastify";

/**
 * Return the public origin for a request using Fastify's trusted request
 * accessors instead of reading forwarded headers directly.
 *
 * Fastify derives `request.host` and `request.protocol` from the raw Host,
 * X-Forwarded-Host, and X-Forwarded-Proto headers according to the server's
 * `trustProxy` option. That matters because `ARCHESTRA_TRUST_PROXY` can be:
 *
 * - false: ignore all forwarded headers
 * - true: trust forwarded headers from any proxy
 * - an IP/CIDR list: trust forwarded headers only when the remote proxy matches
 *
 * Reading `X-Forwarded-*` manually would either ignore CIDR matching or require
 * duplicating Fastify's proxy-trust implementation. Using these accessors keeps
 * OAuth and MCP metadata generation aligned with the same proxy trust rules
 * that Fastify applies to the rest of the request.
 */
export function getPublicRequestOrigin(request: FastifyRequest): string {
  const host = request.host || "localhost";
  const protocol = (request.protocol || "http").replace(/:$/, "");

  return `${protocol}://${host}`;
}
