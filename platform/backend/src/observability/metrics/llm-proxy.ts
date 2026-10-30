import client from "prom-client";

export function initializeLlmProxyMetrics(): void {
  if (client.register.getSingleMetric("llm_proxy_request_duration_seconds"))
    return;
  new client.Histogram({
    name: "llm_proxy_request_duration_seconds",
    help: "Logical LLM proxy requests, from handler entry through completion including streaming and preflight",
    labelNames: [
      "provider",
      "operation",
      "stream",
      "outcome",
      "error_origin",
      "status_code",
    ],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1800],
  });
}

export function reportLlmProxyRequest(params: {
  provider: string;
  operation: string;
  stream: boolean;
  outcome: string;
  errorOrigin: string;
  statusCode: number;
  durationSeconds: number;
}): void {
  const histogram = client.register.getSingleMetric(
    "llm_proxy_request_duration_seconds",
  ) as client.Histogram | undefined;
  histogram?.observe(
    {
      provider: params.provider,
      operation: params.operation,
      stream: String(params.stream),
      outcome: params.outcome,
      error_origin: params.errorOrigin,
      status_code: String(params.statusCode),
    },
    params.durationSeconds,
  );
}
