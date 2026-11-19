import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { FastifyInstance } from "fastify";
import { isLlmProxyPath } from "@/routes/route-paths";
import { hasLlmProxyRequestTelemetry } from "./llm-proxy-request";

/** Record proxy authentication and validation failures that never reach a handler. */
export function registerLlmProxyDenialLog(fastify: FastifyInstance): void {
  fastify.addHook("onResponse", (request, reply, done) => {
    const kind = denialKind(reply.statusCode);
    if (
      !kind ||
      !isLlmProxyPath(request.url) ||
      hasLlmProxyRequestTelemetry(request)
    ) {
      done();
      return;
    }

    // Use the route template, never the raw path, query, body, or credentials.
    const route = request.routeOptions.url ?? "/v1/*";
    const attributes = {
      "archestra.proxy.denial_kind": kind,
      "archestra.proxy.request_id": request.id,
      "http.request.method": request.method,
      "http.route": route,
      "http.response.status_code": reply.statusCode,
      "client.address": request.ip,
    };
    request.log.warn(attributes, "LLM proxy request rejected before handler");
    try {
      logs.getLogger("archestra-llm-proxy").emit({
        eventName: "archestra.llm_proxy.rejected",
        body: "LLM proxy request rejected before handler",
        severityNumber: SeverityNumber.WARN,
        attributes,
      });
    } catch {
      // Logging must never alter the response.
    }
    done();
  });
}

function denialKind(
  status: number,
): "authentication" | "authorization" | "validation" | null {
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if ([400, 413, 415, 422].includes(status)) return "validation";
  return null;
}
