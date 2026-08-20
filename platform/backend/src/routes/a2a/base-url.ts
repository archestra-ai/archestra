import type { FastifyRequest } from "fastify";

import { getPublicRequestOrigin } from "@/routes/request-origin";

/**
 * Base URL an A2A client should dial this deployment on — the origin the caller
 * actually reached us on, not the one our socket was accepted on.
 *
 * An AgentCard is a discovery document: the client fetches it and then dials
 * `supportedInterfaces[].url`. In the standard single-host deployment the public
 * ingress terminates on the Next.js frontend, which reverse-proxies `/v2` here,
 * so this process sees `Host: 127.0.0.1:9000` — the in-cluster address. Building
 * the card from that raw header advertises an address only reachable from inside
 * the cluster, and every discovery-driven client fails on the follow-up call.
 * `getPublicRequestOrigin` recovers the public host from `X-Forwarded-Host`,
 * validated against the configured public hosts so the header cannot be spoofed
 * into a card we sign off on.
 *
 * The protocol still comes from `X-Forwarded-Proto` alone. The A2A spec requires
 * an absolute HTTPS URL outside local development, so a proxy that forgot the
 * header must not make us advertise a downgrade to http.
 */
export function resolveA2ABaseUrl(request: FastifyRequest): string {
  const { host } = new URL(getPublicRequestOrigin(request));

  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = (
    Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto
  )
    ?.split(",")[0]
    .trim();
  if (proto) {
    return `${proto}://${host}`;
  }

  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  return `${isLocal ? "http" : "https"}://${host}`;
}
