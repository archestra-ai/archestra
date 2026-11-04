import { SupportedProviders } from "@archestra/shared/model-constants";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { FastifyInstance } from "fastify";

/** Record proxy authentication and validation failures that never reach a handler. */
export function registerLlmProxyDenialLog(fastify: FastifyInstance): void {
  const enteredHandlers = new WeakSet<object>();
  fastify.addHook("onRoute", (route) => {
    if (!isLlmProxyPath(route.url)) return;
    const handler = route.handler;
    route.handler = function (request, reply) {
      enteredHandlers.add(request);
      return handler.call(this, request, reply);
    };
  });
  fastify.addHook("onResponse", (request, reply, done) => {
    const kind = denialKind(reply.statusCode);
    if (!kind || !isLlmProxyPath(request.url) || enteredHandlers.has(request)) {
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

function isLlmProxyPath(url: string): boolean {
  return ["model-router", "unified-model", ...SupportedProviders].some(
    (prefix) => url === `/v1/${prefix}` || url.startsWith(`/v1/${prefix}/`),
  );
}

function denialKind(
  status: number,
): "authentication" | "authorization" | "validation" | null {
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if ([400, 413, 415, 422].includes(status)) return "validation";
  return null;
}
