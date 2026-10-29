import type { FastifyRequest } from "fastify";
import type { AutoRoutingRequestContext } from "@/types/auto-routing";

/** Set by the Model Router when it routed an "auto" request; read when the interaction is recorded. */
export function setAutoRoutingContext(
  request: FastifyRequest,
  context: AutoRoutingRequestContext,
): void {
  (request as RequestWithAutoRouting).autoRouting = context;
}

export function autoRoutingContext(
  request: FastifyRequest,
): AutoRoutingRequestContext | undefined {
  return (request as RequestWithAutoRouting).autoRouting;
}

// === Internal types ===

interface RequestWithAutoRouting extends FastifyRequest {
  autoRouting?: AutoRoutingRequestContext;
}
