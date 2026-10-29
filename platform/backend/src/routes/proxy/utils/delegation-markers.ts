import type { FastifyRequest } from "fastify";
import type { AppaDelegationMarker } from "@/openappa/delegation";

/**
 * Delegation markers a route collected from the wire the client sent, before
 * translating it for the provider. The Model Router's Chat Completions
 * translation can join a message's text parts, leaving a marker mid-text, so
 * the handler prefers these over a collection from the translated body.
 */
export function setCollectedDelegationMarkers(
  request: FastifyRequest,
  markers: AppaDelegationMarker[],
): void {
  (request as RequestWithDelegationMarkers).llmProxyDelegationMarkers = markers;
}

export function collectedDelegationMarkers(
  request: FastifyRequest,
): AppaDelegationMarker[] | undefined {
  return (request as RequestWithDelegationMarkers).llmProxyDelegationMarkers;
}

// === Internal types ===

interface RequestWithDelegationMarkers extends FastifyRequest {
  llmProxyDelegationMarkers?: AppaDelegationMarker[];
}
