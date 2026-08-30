# Curated Agent images

These are the maintained container images behind the Agent catalog. Every
image satisfies the same runtime contract: a POSIX shell and `tmux`, a
non-root working directory, an Archestra LLM proxy virtual key, and the
invoking user's Agent-scoped MCP gateway endpoint.

| Target | Agent command | Inference API |
| --- | --- | --- |
| `agent-archestra` | `archestra-runner-agent` | Responses, Chat Completions, or Anthropic Messages |
| `agent-claude-code` | `archestra-claude-code` | Anthropic Messages |
| `agent-codex` | `archestra-codex` | OpenAI Responses |
| `agent-hermes` | `archestra-hermes` | OpenAI Chat Completions |
| `agent-openclaw` | `archestra-openclaw` | OpenAI Chat Completions or OpenAI Responses |

Build a target from `platform/`:

```bash
docker build -f agent_images/Dockerfile --target agent-codex -t agent-codex:dev .
```

Tilt pulls the public GAR images by default. Set
`ARCHESTRA_AGENT_BACKGROUND_EXECUTION_BASE_IMAGE=agent-archestra:dev` to build
all five targets locally and use them for dynamically-created Jobs.

The native wrappers create their client configuration at run time under
`/var/run/archestra`. Provider and MCP credentials are never baked into an
image or written to the workspace. Every model request goes to the Agent-scoped
LLM proxy endpoint and every MCP request goes to the Agent-scoped gateway, so
the platform applies the same model selection, limits, policies, tool grants,
and logs as it does for foreground execution. The pod receives a short-lived
virtual key on the standard provider path; it never receives the upstream
provider credential. The one exception is an optional per-user Claude Code
OAuth token. It is injected only into the official Claude Code target, while a
separate passthrough virtual key authenticates and attributes its proxied
requests.

All maintained clients send the task ID as both `X-Archestra-Execution-Id`
and `X-Archestra-Session-Id` on LLM and MCP requests. Do the same in any new
wrapper so the platform can group interactions and tool calls with the run.

Files attached to the initial Chat instruction are written under
`ARCHESTRA_AGENT_BACKGROUND_EXECUTION_ATTACHMENTS_DIR` before the client
starts. The task names their absolute paths, and
`ARCHESTRA_AGENT_BACKGROUND_EXECUTION_ATTACHMENTS_MANIFEST` contains their
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
a per-user Background execution secret. GitHub SSH clone URLs are normalized
to that authenticated HTTPS transport, so a catalog Agent does not also need a
separate SSH key.

The five public catalog targets are built for development deployments and
releases. Keep native CLI versions exact and review their published package
scripts before updating them.
