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
| `agent-grok` | `archestra-grok` | OpenAI Chat Completions |
| `agent-kimi` | `archestra-kimi` | OpenAI Chat Completions |

All targets inherit the same tools from `agent-base`:

| Capability | Included tools |
| --- | --- |
| Repository and PR work | Git, GitHub CLI 2.100.0, SSH client, jq, ripgrep |
| Independent code review | Nitpicker, pinned to a revision with reviewer deadlines and OpenTelemetry support |
| Browser automation and recording | Playwright 1.64.0, Chromium, shot-scraper 1.12 |
| Media processing | FFmpeg/ffprobe, H.264 and AAC encoding, subtitle rendering, fonts |
| Project tooling | Node.js 24, pnpm, Python 3, uv/uvx, Rust 1.93 with Cargo, C/C++ build tools, OpenSSL headers, pkg-config, tmux |
| Local database | PostgreSQL 18 with pgvector, from the PostgreSQL project's Debian repository |

These are enough to run the Archestra platform itself from a checkout, without
Docker or Kubernetes. The Rust toolchain is read-only; Cargo's registry and
`cargo install` output go to `~/.cargo`. PostgreSQL ships without a cluster: an
agent runs `initdb` under HOME, and the shared `/var/run/postgresql` socket
directory lets `psql` connect without flags.

`environment.md` tells the agent what this image installs, and that PostgreSQL
is not running. Images built on this one inherit it, so it leaves out anything
they can change, such as the user, sudo, Docker, or the working directory. Every maintained launcher
appends it to the Agent's instructions (`archestra-agent-instructions`), after
the platform's own section on persistent files and forwarded ports. Update it
whenever the image's tools change.

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
`ARCHESTRA_AGENT_RUNTIME_IMAGE_TAG=dev` to build all seven targets locally and
use them for Agent Runtime workspaces.

The native wrappers create client configuration at run time under `/var/run/archestra`. Credentials are never baked into images. On the provider path, the runtime receives a temporary virtual key and routes inference through the Agent-scoped LLM proxy. The upstream provider credential stays in the backend.

Claude Code personal subscriptions use a token from the configured secrets backend. The wrapper sends inference through the Agent-scoped LLM proxy with a personal passthrough key, so token usage appears in proxy logs. The OAuth token remains the provider credential; subscription requests do not count toward metered cost limits. MCP calls use the Agent-scoped gateway and its tool policies.

Delegated Claude Code assignments stay open until registered background work finishes and the main agent handles its result. This includes shells, subagents and native scheduled monitors. Stop background servers and delete recurring monitors when the assignment is done. Unregistered detached processes are not detected. See the [background-work contract](runtime-contract.md#background-work-in-maintained-images) for lifecycle and failure rules. Codex and OpenCode adapters are not included.

`tests/claude-background-work.py` exercises the pinned Claude binary and retained tmux runtime with scripted model and MCP HTTP endpoints. Image builds run all six short cases. For the ten-minute check, run `BackgroundWorkTest.test_background_review_keeps_turn_open` inside a maintained Claude image with `ARCHESTRA_TEST_BACKGROUND_SECONDS=600`.

Maintained clients send `ARCHESTRA_AGENT_RUNTIME_TASK_ID` as `X-Archestra-Run-Id` to label one turn. They send `ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID` as both `X-Archestra-Session-Id` and `X-Appa-Session-ID` to keep the conversation together across turns and follow-ups. New wrappers must use the same stable session ID on proxy and MCP gateway requests; see the [runtime image contract](runtime-contract.md#runtime-environment).

All seven targets also export their native message and tool history to
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

Initialization also reads the credential's GitHub account (`GET /user`) on
every turn and sets the global Git author to its name and
`<id>+<login>@users.noreply.github.com`, so commits in any repository link to
that account. A rejected credential stops the run with
`github_credential_rejected` before the client starts. Tokens without a user
profile, such as GitHub App installation tokens, and an unreachable API leave
the author unset and do not block the run.

Grok Build differs from the other clients in three ways:

- Grok sends its first prompt before its MCP tools load. The wrapper sends
  the task only after the session's own record (`events.jsonl`) shows the
  gateway connected with its tools; a failed tools/list fails the run.
  Delegated and interactive runs both use the native terminal, so terminal
  steering reaches the running turn. Plain runs, which have no terminal, use
  Grok's Agent Client Protocol server (`grok agent stdio`) instead.
- Grok drops every MCP tool whose name contains `__`, and every gateway tool
  does. `archestra-grok-mcp` connects Grok to the gateway over stdio and shows
  `__` as `--` in tool names.
- Grok offers the model MCP tools only through its `search_tool` and `use_tool`
  pair, so a model request would declare no gateway tool and the LLM proxy
  could deliver no remedy for a blocked call. `archestra-grok-llm` listens on
  loopback between Grok and the proxy: it declares the gateway tools the bridge
  listed (as the gateway sent them, attestation included) in place of the pair,
  shows earlier `use_tool` calls as the gateway calls they made, and turns the
  model's gateway calls back into `use_tool` calls for Grok to run. The proxy
  sees the same wire as from Hermes; Grok runs the same tools as before.
- Title, summary and suggestion calls use the Agent's model through the proxy.
  Telemetry, auto-update, remote configuration and xAI-hosted tools are off.
- A turn the model itself ended early (output limit, request limit, refusal,
  cancellation) fails with `grok_turn_failed`. A turn the provider or the CLI
  broke fails with the retriable `grok_unavailable`. A plain run whose ACP
  server sent a malformed reply fails with `grok_turn_failed` and quotes the
  reason `protocol_error` in its message.

Kimi Code differs from the other clients in these ways:

- Kimi waits for its MCP catalog before its first model request, but a gateway
  whose initialize or tools/list fails is only logged, and the turn runs
  without the gateway's tools. `archestra-kimi-mcp` connects Kimi to the
  gateway over stdio, relays every message unchanged, and records the answer
  Kimi's own catalog request received. The task is sent, and each prompt runs
  (a `UserPromptSubmit` hook), only when that record shows the catalog loaded;
  otherwise the run fails with `mcp_startup`.
- Kimi shows the model a gateway tool as `mcp__archestra__<tool>`, with each
  run of underscores in a name part shortened to one (`archestra_yell`), and
  shortens names longer than 64 characters with a hash. Descriptions reach the
  model unchanged, so the LLM proxy resolves each tool by its attestation
  marker; calls reach the gateway under the gateway's own names.
- Agent Runtime steers by typing a message and Enter. While a turn runs, Kimi
  queues that message for the next turn and offers Ctrl-S to send it now. In a
  delegated run `archestra-kimi-tui-start` presses Ctrl-S while a turn runs, so
  the message reaches the running turn. An interactive session keeps Kimi's
  queue, and the person chooses when to steer.
- The provider is `type = "kimi"` for a Kimi key (the Moonshot (Kimi)
  provider), which adds Kimi's thinking switch, and `type = "openai"` for any other Chat
  Completions provider. Kimi Code matches thinking support by model name only
  for its own catalog, so the launcher declares it for `k3`, `k3.1` and
  `kimi-for-coding` models; K3.1 Pro refuses a request without thinking.
- Kimi ends a turn cut off by the output limit as completed. The `Stop` hook,
  which Kimi runs before it records the turn's end, reads the last step's
  finish reason and fails such a turn with `kimi_turn_failed`. A failed turn is
  classified by the error code Kimi records: only connection errors, rate
  limits, an overloaded provider and server errors give the retriable
  `kimi_unavailable`; a rejected credential or model, an overflowing context,
  the step limit, a filtered response or a cancelled turn give
  `kimi_turn_failed`. Plain runs use print mode (`kimi -p`), which has the same
  outcomes.
- The working directory is trusted so the TUI does not stop on its folder-trust
  dialog and the repository's own `AGENTS.md` and skills load. Kimi would then
  also start the repository's MCP servers (`.mcp.json`, `.kimi-code/mcp.json`),
  with the run's credentials in their environment, so the image patches Kimi
  to read MCP servers only from its user `mcp.json`
  (`patches/kimi-user-mcp-only.py`).
- Telemetry, auto-update, the feedback survey and session titles are off. The binding header reaches the proxy through
  `KIMI_CODE_CUSTOM_HEADERS`, never through a file.

The seven public catalog targets are built for development deployments and
releases. Keep native CLI versions exact and review their published package
scripts before updating them.

The daily `agent-runtime` job in `.github/workflows/update-client-versions.yml`
proposes those updates as one pull request on `automation/agent-runtime-clis`.
It runs `pnpm --dir backend update:agent-runtime-clis`, which picks each CLI's
newest stable release that has been public for 7 days, and refreshes the
OpenClaw lockfile. The pull request does not merge itself: merge it once the
`Validate agent-*` builds pass. A new catalog target fails that script until it
is registered there. Every CLI's own update check is off in the image, so an
older session never stops on an update prompt.

Hermes no longer publishes to PyPI. The image builds a GitHub release from
source, the way upstream's own image does: Python, uv, and every package come
from the versions locked in that checkout. Its pin is a `hermes_version` and
`hermes_commit` pair, and the build fails unless the tag resolves to that commit.
