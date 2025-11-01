# Observability resources (Jaeger, OTEL Collector, Prometheus, Grafana)

local_resource(
  'observability',
  serve_cmd='docker compose -f dev/observability/docker-compose.yml up',
  serve_dir='.',
  labels=['observability'],
  trigger_mode=TRIGGER_MODE_MANUAL,
  auto_init=False
)
