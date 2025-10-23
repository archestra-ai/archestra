# Observability

Archestra provides comprehensive observability features to help monitor and troubleshoot the platform in production environments. This includes Prometheus metrics, health checks, and structured logging.

## Health Check Endpoints

Archestra provides several health check endpoints for different monitoring scenarios:

### Basic Health Check
```
GET /health
```
Returns basic system status information:
```json
{
  "status": "Archestra Platform API",
  "version": "0.0.1"
}
```

### Detailed Health Check
```
GET /health/detailed
```
Comprehensive health check including:
- System information
- Database connectivity
- LLM provider status (OpenAI, Anthropic, Gemini)
- External service dependencies

Example response:
```json
{
  "status": "ok",
  "timestamp": "2025-01-22T10:30:00.000Z",
  "checks": {
    "system": {
      "status": "ok",
      "timestamp": "2025-01-22T10:30:00.000Z",
      "uptime": 3600,
      "version": "0.0.1",
      "name": "Archestra Platform API"
    },
    "database": {
      "status": "ok",
      "message": "Database connection successful"
    },
    "providers": [
      {
        "provider": "openai",
        "status": "ok",
        "message": "OpenAI API key configured"
      },
      {
        "provider": "anthropic",
        "status": "ok",
        "message": "Anthropic API key configured"
      }
    ]
  }
}
```

### Kubernetes Readiness Check
```
GET /ready
```
Returns 200 if the service is ready to handle traffic, 503 if not ready. Used by Kubernetes for readiness probes.

### Kubernetes Liveness Check
```
GET /live
```
Always returns 200 if the process is running. Used by Kubernetes for liveness probes.

## Prometheus Metrics

Archestra exposes Prometheus metrics at the `/metrics` endpoint for comprehensive monitoring.

### Default Metrics
Archestra automatically collects standard Node.js and process metrics:
- CPU usage
- Memory usage
- Garbage collection statistics
- Event loop lag

### Application Metrics

#### HTTP Request Metrics
```
archestra_http_requests_total{method="POST",status_code="200",route="/v1/openai/chat/completions"}
archestra_http_request_duration_seconds{method="POST",status_code="200",route="/v1/openai/chat/completions"}
```

#### LLM Provider Metrics
```
archestra_llm_requests_total{provider="openai",model="gpt-4",status="success"}
archestra_llm_request_duration_seconds{provider="openai",model="gpt-4"}
```

#### Agent Execution Metrics
```
archestra_agent_executions_total{agent_id="abc-123",status="success"}
archestra_agent_execution_duration_seconds{agent_id="abc-123"}
```

#### Tool Invocation Metrics
```
archestra_tool_invocations_total{tool_name="weather-api",agent_id="abc-123",status="success"}
archestra_tool_invocation_duration_seconds{tool_name="weather-api",agent_id="abc-123"}
```

#### MCP Server Metrics
```
archestra_mcp_requests_total{server="filesystem",method="read",status="success"}
archestra_mcp_request_duration_seconds{server="filesystem",method="read"}
```

#### User Activity Metrics
```
archestra_active_users
archestra_user_sessions_total{status="login"}
```

#### System Health Metrics
```
archestra_system_health_status{component="database"}
archestra_system_health_status{component="openai"}
archestra_system_health_status{component="anthropic"}
```

## Configuration

### Environment Variables

The observability features use the existing Archestra configuration. No additional environment variables are required for basic observability functionality.

The following environment variables are used by Archestra (not specific to observability):

```bash
# Database connection
DATABASE_URL=postgresql://...

# API configuration
ARCHESTRA_API_BASE_URL=http://localhost:9000
ARCHESTRA_FRONTEND_URL=http://localhost:3000

# Authentication
ARCHESTRA_AUTH_SECRET=your-secret-key

# Features
FEATURES_MCP_REGISTRY_ENABLED=true
```

### Docker Configuration

For Docker deployments, expose the API port (metrics are served on the same port):

```dockerfile
EXPOSE 9000  # API port (includes metrics endpoint)
```

### Kubernetes Configuration

Example Kubernetes health check configuration:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: archestra-platform
spec:
  template:
    spec:
      containers:
      - name: platform
        ports:
        - containerPort: 9000
        livenessProbe:
          httpGet:
            path: /live
            port: 9000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 9000
          initialDelaySeconds: 5
          periodSeconds: 5
        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "1Gi"
            cpu: "500m"
```

## Monitoring Setup

### Prometheus Configuration

Add the following to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'archestra-platform'
    static_configs:
      - targets: ['archestra-platform:9000']
    metrics_path: '/metrics'
    scrape_interval: 15s
    scrape_timeout: 10s
```

### Grafana Dashboard

Import the following metrics into your Grafana dashboard:

#### Key Metrics to Monitor

1. **Request Rate and Latency**
   - `rate(archestra_http_requests_total[5m])`
   - `histogram_quantile(0.95, rate(archestra_http_request_duration_seconds_bucket[5m]))`

2. **LLM Provider Performance**
   - `rate(archestra_llm_requests_total{status="success"}[5m])`
   - `histogram_quantile(0.95, rate(archestra_llm_request_duration_seconds_bucket[5m]))`

3. **System Health**
   - `archestra_system_health_status`
   - `up`

4. **Error Rates**
   - `rate(archestra_http_requests_total{status_code=~"5.."}[5m]) / rate(archestra_http_requests_total[5m])`

### Alerting Rules

Example Prometheus alerting rules:

```yaml
groups:
  - name: archestra-alerts
    rules:
      - alert: ArchestraHighErrorRate
        expr: rate(archestra_http_requests_total{status_code=~"5.."}[5m]) / rate(archestra_http_requests_total[5m]) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High error rate on Archestra platform"

      - alert: ArchestraDatabaseDown
        expr: archestra_system_health_status{component="database"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Database connectivity lost"

      - alert: ArchestraLLMProviderDown
        expr: archestra_system_health_status{component!="database"} == 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "LLM provider {{ $labels.component }} is down"
```

## Troubleshooting

### Common Issues

1. **Metrics not appearing in Prometheus**
   - Verify the `/metrics` endpoint is accessible
   - Check Prometheus configuration
   - Ensure proper network connectivity

2. **Health checks failing**
   - Review detailed health check endpoint for specific failures
   - Check database connectivity
   - Verify LLM provider API keys are configured

3. **High memory usage**
   - Monitor `process_resident_memory_bytes` and `nodejs_heap_size_used_bytes`
   - Check for memory leaks in custom tools
   - Consider adjusting memory limits in Kubernetes

### Logs

Archestra uses structured logging with Pino. Monitor logs for:
- HTTP request logs with response times
- Database connection errors
- LLM provider API errors
- Tool execution failures

Log format:
```json
{
  "level": 30,
  "time": 1672531200000,
  "msg": "incoming request",
  "reqId": "req-abc123",
  "req": {
    "method": "POST",
    "url": "/v1/openai/chat/completions",
    "headers": {
      "user-agent": "curl/7.68.0"
    }
  },
  "responseTime": 1234
}
```

## Best Practices

1. **Monitor all components**: Set up monitoring for backend, frontend, database, and external services
2. **Set appropriate thresholds**: Configure alerts based on your SLA requirements
3. **Use structured logging**: Leverage Pino's structured logs for better observability
4. **Regular review**: Periodically review metrics and adjust thresholds as needed
5. **Capacity planning**: Use historical metrics to plan for scaling
