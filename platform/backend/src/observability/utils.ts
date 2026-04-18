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

export function isNoisyTransactionName(transactionName: string): boolean {
  return (
    transactionName.startsWith(`GET ${HEALTH_PATH}`) ||
    transactionName.startsWith(`GET ${READY_PATH}`) ||
    transactionName.startsWith(`GET ${METRICS_PATH}`) ||
    transactionName.startsWith(`GET ${WELL_KNOWN_OAUTH_PREFIX}`) ||
    isNoisyMcpGatewayTransactionName(transactionName)
  );
}

export function isNoisyMcpGatewayTransactionName(
  transactionName: string,
): boolean {
  return transactionName.startsWith(`GET ${MCP_GATEWAY_PREFIX}/`);
}
