# Lobster Env staging evaluation

This image runs the temporary Archestra-native coding Agent alongside the
existing task environment on `frontend.archestra.dev`. It is not part of the
public Agent catalog and is not published by release builds.

Configure one organization Agent with:

- name: `Lobster Env`
- image: `europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/agent-lobster-env:latest`
- command: `archestra-lobster-env`
- inference API: OpenAI Responses
- model: an OpenAI model backed by each user's connected ChatGPT subscription
- tool access: all tools, so the runtime receives the Agent-scoped MCP gateway
- required per-user deployment credential: `GITHUB_TOKEN`
- Environment: the staging coding Environment, with GitHub and any package
  registries needed by repository checks allowed by its egress policy

Give the Slack channel's foreground coordinator access to this Agent as a
subagent. The staging deployment maps `:lobster:` reactions to explicit durable
delegation requests. A channel instruction can pin the temporary evaluation:

> When a message says the user explicitly requested isolated Background
> execution, delegate it to Lobster Env as a durable task. Acknowledge only
> after the task starts; do not implement it in the foreground.

The image clones public main, configures the private mirror as its push target,
creates one branch per execution, and appends `system-prompt.md` to Codex's
developer instructions. The existing task environment remains independent and
can be removed only after the staging evaluation is approved.
