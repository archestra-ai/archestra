# Lobster Env staging evaluation

This staging-only workflow runs alongside the existing task environment on
`frontend.archestra.dev`. It is not part of the public Agent catalog and its
worker images are not published by release builds.

## Agent graph

Configure `Lobster Env` as a foreground organization Agent with no Background
execution deployment. Use `orchestrator-system-prompt.md` as its system prompt
and explicitly assign these four worker Agents as subagents:

- `Lobster Claude Code`
- `Lobster Codex`
- `Lobster Hermes`
- `Lobster OpenClaw`

PotatoAI, `Lobster Env`, and all four workers must use the same Agent
Environment. Delegation is environment-isolated, so moving only part of this
graph to another Environment intentionally makes those targets unavailable.
For the first staging evaluation, keep the complete graph in PotatoAI's current
Environment and apply the repository/package-registry egress policy there.

The channel coordinator delegates an explicitly requested coding task to
`Lobster Env`. Lobster asks which runner to use unless the request already
names one, then delegates to that worker. Nested delegation is intentional:
the foreground router keeps the Slack conversation interactive while the
selected worker's deployment turns the second delegation into a durable task.

Configure each worker as an organization Agent with Background execution:

| Worker | Image | Command | Inference API |
| --- | --- | --- | --- |
| Lobster Claude Code | `europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/agent-lobster-env-claude-code:latest` | `archestra-lobster-claude-code` | Anthropic Messages |
| Lobster Codex | `europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/agent-lobster-env:latest` | `archestra-lobster-env` | OpenAI Responses |
| Lobster Hermes | `europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/agent-lobster-env-hermes:latest` | `archestra-lobster-hermes` | OpenAI Chat Completions |
| Lobster OpenClaw | `europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/agent-lobster-env-openclaw:latest` | `archestra-lobster-openclaw` | OpenAI Chat Completions |

Every worker uses:

- tool access: all tools, so the runtime receives the Agent-scoped MCP gateway
- required per-user deployment credential: `GITHUB_TOKEN`
- Environment: the same Environment as PotatoAI and the Lobster router, with
  GitHub and any package registries needed by repository checks allowed by its
  egress policy

Claude Code additionally declares the per-user `CLAUDE_CODE_OAUTH_TOKEN`
credential and must select an Anthropic model. Codex must explicitly select an
OpenAI model backed by the initiating user's connected ChatGPT subscription;
do not leave its model blank, because the maintained runtime refuses to fall
back to a metered organization key. Hermes and OpenClaw use the provider
key/model configured on their Agent.

Give the Slack channel's foreground coordinator access only to `Lobster Env`
for this workflow. The staging deployment maps `:lobster:` reactions to
explicit delegation requests. The coordinator instructions should include:

> When a message says the user explicitly requested isolated Background
> execution, delegate the full task and Slack context to Lobster Env. Lobster
> may ask which runner to use. Relay that question, and on the requester's next
> reply delegate the full thread back to Lobster Env. Do not choose a runner or
> implement the task yourself.

All four worker images clone public main, configure the private mirror as their
push target, create one branch per execution, and append `system-prompt.md` to
the native client's instructions. The existing task environment remains
independent and can be removed only after the staging evaluation is approved.
