# Curated Agent images

These are the maintained container images behind the Agent catalog. Every
image satisfies the same runtime contract: a POSIX shell and `tmux`, a
non-root working directory and the invoking user's Agent-scoped MCP gateway endpoint. Provider-backed runs also receive an Archestra LLM proxy virtual key.

| Target | Agent command | Inference API |
| --- | --- | --- |
| `agent-archestra` | `archestra-runtime-agent` | Responses, Chat Completions, or Anthropic Messages |
| `agent-claude-code` | `archestra-claude-code` | Anthropic Messages |
| `agent-codex` | `archestra-codex` | OpenAI Responses |
| `agent-opencode` | `archestra-opencode` | OpenAI Responses |
| `agent-hermes` | `archestra-hermes` | OpenAI Chat Completions |
| `agent-openclaw` | `archestra-openclaw` | OpenAI Chat Completions or OpenAI Responses |

Build a target from `platform/`:

```bash
docker build -f agent_images/Dockerfile --target agent-codex -t agent-codex:dev .
```

Tilt pulls the public GAR images by default. Set
`ARCHESTRA_AGENT_RUNTIME_BASE_IMAGE=agent-archestra:dev` to build
all six targets locally and use them for Agent Runtime workspaces.

The native wrappers create client configuration at run time under `/var/run/archestra`. Credentials are never baked into images. On the provider path, the runtime receives a temporary virtual key and routes inference through the Agent-scoped LLM proxy. The upstream provider credential stays in the backend.

Claude Code personal subscriptions use a token from the configured secrets backend and connect directly to Anthropic. Those inference calls bypass proxy logs, limits, and guardrails. MCP calls still use the Agent-scoped gateway and its tool policies.

Maintained clients send the task ID as both `X-Archestra-Run-Id` and `X-Archestra-Session-Id` on proxy and MCP gateway requests. Do the same in any new
wrapper so the platform can group interactions and tool calls with the run.

All six targets also export their native message and tool history to
`$ARCHESTRA_AGENT_RUNTIME_DIR/readable-transcript.json`. The control plane
validates and persists this provider-neutral artifact independently of the
terminal recording. Custom images can opt into the same completed-run view by
implementing the [runtime image contract](runtime-contract.md#readable-transcript). The same reference covers required tools, input files, steering, and injected environment variables.

Files attached to the initial Chat instruction are written under
`ARCHESTRA_AGENT_RUNTIME_ATTACHMENTS_DIR` before the client
starts. The task names their absolute paths, and
`ARCHESTRA_AGENT_RUNTIME_ATTACHMENTS_MANIFEST` contains their
original names, paths, media types, and sizes.

The generic Archestra loop receives a provider-qualified model id. Native
clients receive the provider's own model slug so their built-in model metadata
and capability detection continue to work. The task's single-provider virtual
key makes that slug unambiguous at the Model Router; general multi-provider
keys still require provider-qualified ids.

When an Agent declares `GITHUB_TOKEN`, the launch contract also supplies the
GitHub CLI's canonical `GH_TOKEN` alias and configures the CLI as Git's
credential helper before the Agent command starts. Clone, push, and
pull-request workflows therefore remain non-interactive while the token stays
a per-user Agent Runtime secret. GitHub SSH clone URLs are normalized
to that authenticated HTTPS transport, so a catalog Agent does not also need a
separate SSH key.

The six public catalog targets are built for development deployments and
releases. Keep native CLI versions exact and review their published package
scripts before updating them.
