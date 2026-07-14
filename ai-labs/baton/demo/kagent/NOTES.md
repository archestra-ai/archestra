# Kagent wiring facts (spike, 2026-07-14)

Verified against a live `kind` + Kagent install. These values are consumed by
`manifests/` and `run-demo.sh`.

## Versions

- kind node image: default for kind (control-plane came up clean); pin later if needed.
- Kagent Helm charts (OCI, ghcr.io): **0.9.11**
  - CRDs: `oci://ghcr.io/kagent-dev/kagent/helm/kagent-crds --version 0.9.11`
  - main: `oci://ghcr.io/kagent-dev/kagent/helm/kagent --version 0.9.11`
  - There is **no classic Helm repo** (`kagent.dev/helm` and the github.io URL both 404). OCI only.

## Sidecar injection — SUPPORTED ✅

The Agent CRD exposes `spec.declarative.deployment.extraContainers` (`[]Object`,
a standard k8s Container). Its own doc string: *"additional containers to run
alongside the main agent container. Useful for sidecars such as token proxies,
log shippers, or **security agents**."* baton-proxy rides here — no fallback needed.

Also available on `spec.declarative.deployment`: `env` (`[]Object`, env on the
main agent container), `labels`, `annotations`, `replicas`, `volumes`.

## ModelConfig → point the agent at the sidecar

`ModelConfig.spec`:
- `provider: OpenAI` (enum includes OpenAI, Anthropic, Ollama, AzureOpenAI, Gemini, …)
- `spec.openAI.baseUrl` — *"Base URL for the OpenAI API (overrides default)"* → set to `http://localhost:8730/v1` (the sidecar).
- `model` (required) — the OpenRouter model id, e.g. `anthropic/claude-sonnet-4.5` (pick a current OpenRouter id at run time).
- `apiKeySecret` + `apiKeySecretKey` — name/key of a Secret in the same namespace holding the OpenRouter key.

The agent's `spec.declarative.modelConfig` is the string name of the ModelConfig.

## k8s tool names (for the contracts) — from the live tool server

The k8s tools are an MCP server: `remotemcpserver/kagent-tool-server` at
`http://kagent-tools.kagent:8084/mcp` (STREAMABLE_HTTP). Enumerated via
`tools/list`. The demo uses this subset:

- **Injection vector (suspicious output):** `k8s_get_pod_logs`
- **Trusted readers:** `k8s_get_resources`, `k8s_describe_resource`, `k8s_get_events`
- **Guarded sinks (require trusted flow):** `k8s_delete_resource`, `k8s_apply_manifest`, `k8s_patch_resource`
- (other mutators exist: `k8s_create_resource`, `k8s_scale`, `k8s_execute_command`, `k8s_annotate_resource` — left unregistered on purpose)

## Invoke path (for run-demo.sh)

A2A server (when `spec.declarative.deployment.a2aConfig` is set): served on the
kagent controller HTTP port (default 8083) at
`<controller>:8083/api/a2a/<agent-namespace>/<agent-name>`. Port-forward the
controller service and POST an A2A message to drive the agent.

## Streaming

The chart has a `streaming` value (A2A/SSE through the cluster router). For the
LLM leg: the proxy forces `stream:false` upstream (rewrites the request field)
and returns one buffered JSON response — so the agent's OpenAI client may ask
for streaming and the proxy still gates the whole response. Whether Kagent's
ADK runtime accepts the buffered (non-SSE) reply is the one fact that still
needs a real agent turn to confirm — pending an `OPENROUTER_API_KEY`.

## Open item

The full end-to-end run (`run-demo.sh` step "drive the agent") needs a valid
`OPENROUTER_API_KEY`; not available in the spike environment. Controller +
tool-server + CRDs verified up; manifests and script are written against the
facts above.
