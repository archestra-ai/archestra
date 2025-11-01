# Website Documentation Updates

This document outlines the changes that need to be made to the archestra-ai/website repository.

## Files to Update

### 1. app/app/docs/content/platform-deployment.md

#### OTEL Section Updates
Add/update the following information about OTEL tracing:

**New Trace Attributes:**
- `agent.name` - The name of the agent handling the request
- `agent.<label_key>` - Custom agent labels (e.g., `agent.environment=production`, `agent.team=data-science`)
- `route.category` - The category of the route (e.g., `llm-proxy`, `mcp-gateway`)
- `llm.provider` - The LLM provider being used (typed as `openai`, `gemini`, or `anthropic`)

**Service Name Configuration:**
The service name is now explicitly configured to avoid display issues in trace viewers. The service name should appear as "Archestra Platform API" without any appended values.

**Local Development with Grafana:**
For local OTEL testing, you can now start Grafana using Tilt:
```bash
# Start Grafana (manual startup mode)
tilt up grafana
```

Grafana will be available at http://localhost:3001 with:
- Jaeger datasource pre-configured for viewing traces
- Prometheus datasource available for metrics (when Prometheus is added)
- Anonymous access enabled for ease of use in development

#### Prometheus Section Updates
Add information about the new metrics labels:

**Enhanced LLM Metrics Labels:**
Both `llm_request_duration_seconds` and `llm_tokens_total` metrics now include:
- `agent` - The agent ID
- `agent_name` - The agent name (new!)
- `provider` - The LLM provider
- `status_code` - The HTTP status code (for duration metric)
- `type` - Token type: `input` or `output` (for tokens metric)

Example PromQL queries:
```promql
# Total tokens by agent name
sum(rate(llm_tokens_total[5m])) by (agent_name, type)

# Request duration by agent name and provider
histogram_quantile(0.95, sum(rate(llm_request_duration_seconds_bucket[5m])) by (agent_name, provider, le))
```

### 2. app/app/docs/content/platform-agents.md

#### New Section: Agent Labels and Observability

Add a new section (perhaps under a "Observability" heading) with the following content:

---

## Agent Labels and Observability

Agent labels are a powerful feature that can be used to organize and categorize your agents. Beyond organization, labels also play a crucial role in observability.

### Trace Attributes

When you add labels to an agent, those labels are automatically added as attributes to every trace for requests handled by that agent. This makes it easy to filter and analyze traces in your observability tools.

For example, if you add these labels to an agent:
- `environment`: `production`
- `team`: `data-science`
- `cost-center`: `research`

Every trace for that agent will have these attributes:
- `agent.environment=production`
- `agent.team=data-science`
- `agent.cost-center=research`

### Prometheus Metrics

Agent labels also enhance your Prometheus metrics. The `agent_name` label is included in all LLM-related metrics, making it easy to monitor usage and performance per agent:

```promql
# View token usage by agent
sum(rate(llm_tokens_total{agent_name="my-agent"}[5m])) by (type)

# Monitor request latency for specific agents
histogram_quantile(0.95,
  rate(llm_request_duration_seconds_bucket{agent_name=~"production-.*"}[5m])
)
```

### Best Practices for Labels

- Use labels to categorize agents by environment (`dev`, `staging`, `prod`)
- Add team ownership labels for better resource tracking
- Include cost center or project labels for budget allocation
- Keep label keys consistent across agents for easier querying

---

## Summary of Changes

The changes enhance the platform's observability in three key ways:

1. **Centralized Tracing Logic**: A new `sprinkleTraceAttributes` utility function in `backend/src/routes/proxy/utils/tracing.ts` that strongly types trace attributes and makes it easy to add consistent attributes across all proxy routes.

2. **Agent-Aware Traces and Metrics**: All traces now include `agent.name` and custom `agent.<label>` attributes. Prometheus metrics include the `agent_name` label.

3. **Local Development Tools**: Grafana is now available in the Tilt development environment for easy local testing of OTEL exports and trace visualization.

These improvements make it much easier to:
- Filter traces by agent name or custom labels
- Analyze LLM usage patterns per agent
- Debug issues related to specific agents or agent configurations
- Monitor costs and usage across different teams or projects
