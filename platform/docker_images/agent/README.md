# Curated Agent images

These are the maintained container images behind the Agent catalog. Every
image satisfies the same runtime contract: a POSIX shell and `tmux`, a
non-root working directory and the invoking user's Agent-scoped MCP gateway endpoint. Provider-backed runs also receive an Archestra LLM proxy virtual key.

| Target | Agent command | Inference API |
| --- | --- | --- |
| `agent-claude-code` | `archestra-claude-code` | Anthropic Messages |
| `agent-codex` | `archestra-codex` | OpenAI Responses |
| `agent-opencode` | `archestra-opencode` | OpenAI Responses |
| `agent-hermes` | `archestra-hermes` | OpenAI Chat Completions |
| `agent-openclaw` | `archestra-openclaw` | OpenAI Chat Completions or OpenAI Responses |

All targets inherit the same tools from `agent-base`:

| Capability | Included tools |
| --- | --- |
| Repository and PR work | Git, GitHub CLI 2.100.0, SSH client, jq, ripgrep |
| Independent code review | Nitpicker, pinned to a revision with reviewer deadlines and OpenTelemetry support |
| Browser automation and recording | Playwright 1.64.0, Chromium, shot-scraper 1.12 |
| Media processing | FFmpeg/ffprobe, H.264 and AAC encoding, subtitle rendering, fonts |
| Project tooling | Node.js 24, pnpm, Python 3, uv/uvx, C/C++ build tools, tmux |

Browser tools live in `/opt/agent-tools`, with their commands exposed on PATH.
Python scripts importing Playwright can use `/opt/agent-tools/bin/python`;
project-specific Python dependencies belong in their own virtual environment.
The matching Chromium binaries live at `$PLAYWRIGHT_BROWSERS_PATH`
(`/opt/playwright`), outside the writable home/workspace mounts. Projects using
a different Playwright version must install its matching browser into a writable
cache, or prepare it in a derived image.

Skills supply Nitpicker configuration, review procedures, recording scripts,
and delivery behavior. The image contains no repository selection, organization
prompts, promotion workflow, model credentials, or messaging destinations.
Configure these on the Agent and load the relevant skills through its gateway.
Sending generated media to Slack, email, or another service uses the Agent's
authorized integrations; installing recording tools does not grant delivery access.

A fresh runtime starts in `/home/node/workspace` without selecting or cloning a
repository. Name the repository and setup procedure in the Agent's prompt,
task, or assigned skill. A derived image can prepare a checkout before invoking
the maintained launcher when deterministic startup is needed.

Browser dependencies are pinned with hashes in `requirements.lock`; regenerate
it from `requirements.in` using the command in the lock header after reviewing
updates.

On stable platform releases, the templates use the approved `:latest` aliases.
Release candidates and development deployments keep matching fixed tags, so
they do not pull a CLI from an older stable release. Agent Runtime
stores the selected image on each Agent; existing pinned Agents need a one-time
Image edit to follow the stable alias. Floating-tag runs cold-start so a warm
container cannot retain a previous image after its tag moves.

Build a target from `platform/`:

```bash
docker build -f docker_images/agent/Dockerfile --target agent-codex -t agent-codex:dev .
```

Tilt pulls the public GAR images by default. Set
`ARCHESTRA_AGENT_RUNTIME_IMAGE_TAG=dev` to build all five targets locally and
use them for Agent Runtime workspaces.

The native wrappers create client configuration at run time under `/var/run/archestra`. Credentials are never baked into images. On the provider path, the runtime receives a temporary virtual key and routes inference through the Agent-scoped LLM proxy. The upstream provider credential stays in the backend.

Claude Code personal subscriptions use a token from the configured secrets backend. The wrapper sends inference through the Agent-scoped LLM proxy with a personal passthrough key, so token usage appears in proxy logs. The OAuth token remains the provider credential; subscription requests do not count toward metered cost limits. MCP calls use the Agent-scoped gateway and its tool policies.

In delegated runs, Claude Code ends a turn while its background subagents or workflows still run, and starts a new turn when they report back. The wrapper completes the run only after a turn ends with none of them running. Background shells do not keep the run open.

Maintained clients send `ARCHESTRA_AGENT_RUNTIME_TASK_ID` as `X-Archestra-Run-Id` to label one turn. They send `ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID` as both `X-Archestra-Session-Id` and `X-Appa-Session-ID` to keep the conversation together across turns and follow-ups. New wrappers must use the same stable session ID on proxy and MCP gateway requests; see the [runtime image contract](runtime-contract.md#runtime-environment).

All five targets also export their native message and tool history to
`$ARCHESTRA_AGENT_RUNTIME_DIR/readable-transcript.json`. The control plane
validates and persists this provider-neutral artifact independently of the
terminal recording. Custom images can opt into the same completed-run view by
implementing the [runtime image contract](runtime-contract.md#readable-transcript). The same reference covers required tools, input files, steering, and injected environment variables.

Files attached to the initial Chat instruction are written under
`ARCHESTRA_AGENT_RUNTIME_ATTACHMENTS_DIR` before the client
starts. The task names their absolute paths, and
`ARCHESTRA_AGENT_RUNTIME_ATTACHMENTS_MANIFEST` contains their
original names, paths, media types, and sizes.

Native clients receive the provider's own model slug so their built-in model
metadata and capability detection continue to work. The task's single-provider virtual
key makes that slug unambiguous at the Model Router; general multi-provider
keys still require provider-qualified ids.

When an Agent declares `GITHUB_TOKEN`, the launch contract also supplies the
GitHub CLI's canonical `GH_TOKEN` alias and configures the CLI as Git's
credential helper before the Agent command starts. Clone, push, and
pull-request workflows therefore remain non-interactive using the selected
personal or organization credential. GitHub App tokens are projected into a
renewable credential file; the maintained `gh` wrapper rereads it on every
invocation, including Git credential-helper calls. Custom clients that cache
a token must adopt the file contract described in `runtime-contract.md`. GitHub SSH clone URLs are normalized
to that authenticated HTTPS transport, so a catalog Agent does not also need a
separate SSH key.

The five public catalog targets are built for development deployments and
releases. Keep native CLI versions exact and review their published package
scripts before updating them.
