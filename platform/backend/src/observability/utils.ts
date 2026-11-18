import {
  HEALTH_PATH,
  MCP_GATEWAY_PREFIX,
  METRICS_PATH,
  READY_PATH,
  WELL_KNOWN_OAUTH_PREFIX,
} from "@/routes/route-paths";

/**
 * Routes that should be excluded from tracing entirely.
 * Used by both Sentry tracesSampler and OTEL FastifyOtelInstrumentation ignorePaths.
 */
export function isNoiseRoute(url: string): boolean {
  return (
    url.startsWith(HEALTH_PATH) ||
    url.startsWith(READY_PATH) ||
    url.startsWith(METRICS_PATH) ||
    url.startsWith(WELL_KNOWN_OAUTH_PREFIX)
  );
}

export function isNoisyMcpGatewayGetRoute(params: {
  method: string;
  url: string;
}): boolean {
  return (
    params.method === "GET" && params.url.startsWith(`${MCP_GATEWAY_PREFIX}/`)
  );
}

/**
 * The LLM proxy log list endpoints (under both their current and legacy
 * paths). Automated clients page through these one request at a time, so they
 * produce far more traces than any one of them is worth.
 */
export function isPolledLogListRoute(params: {
  method: string;
  url: string;
}): boolean {
  if (params.method !== "GET") return false;
  const path = params.url.split("?", 1)[0];
  return POLLED_LOG_LIST_PATHS.has(path);
}

export function isNoisyTransactionName(transactionName: string): boolean {
  return (
    transactionName.startsWith(`GET ${HEALTH_PATH}`) ||
    transactionName.startsWith(`GET ${READY_PATH}`) ||
    transactionName.startsWith(`GET ${METRICS_PATH}`) ||
    transactionName.startsWith(`GET ${WELL_KNOWN_OAUTH_PREFIX}`) ||
    isNoisyMcpGatewayTransactionName(transactionName)
  );
}

/**
 * MCP methods whose response is a stream that stays open until the client
 * disconnects or a proxy closes it. The request's duration is how long the
 * connection lived, not how long the request took.
 */
const LONG_LIVED_MCP_STREAM_METHODS: ReadonlySet<string> = new Set([
  "subscriptions/listen",
]);

/** True for the value of `mcp.method.name` on a long-lived MCP stream. */
export function isLongLivedMcpStream(method: unknown): boolean {
  return (
    typeof method === "string" && LONG_LIVED_MCP_STREAM_METHODS.has(method)
  );
}

/** @public — exported for testability */
export function isNoisyMcpGatewayTransactionName(
  transactionName: string,
): boolean {
  return transactionName.startsWith(`GET ${MCP_GATEWAY_PREFIX}/`);
}

const POLLED_LOG_LIST_PATHS: ReadonlySet<string> = new Set([
  "/api/llm-proxy-logs",
  "/api/llm-proxy-logs/sessions",
  "/api/interactions",
  "/api/interactions/sessions",
]);
