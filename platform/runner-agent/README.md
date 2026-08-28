# Background execution agent

The agent loop that runs inside an Archestra Agent's Background execution
deployment, and the default image used when no custom command is configured.

It is deliberately thin. The model, remote tool set, policies and budget are
all resolved by the platform behind the LLM proxy and MCP gateway this process
talks to. The loop keeps a conversation going, exposes a command tool rooted in
the isolated execution workspace, prints activity legibly for anyone attached
to the tmux session, and takes direction from a human without losing its place.

The local command tool lets the built-in catalog Agent clone repositories, edit
files, and run verification inside its own pod. It does not bypass the gateway
for remote tools or the LLM proxy for inference.

## How a session is steered

The runtime writes one line per message into a FIFO
(`ARCHESTRA_AGENT_BACKGROUND_EXECUTION_STEER_FIFO`).
The loop reads it continuously but only *consumes* messages at a turn boundary,
so a steer can never be spliced into the middle of a tool call. When the agent
has nothing left to do it parks on that channel, which is what makes a session
that idles for days cost almost nothing.

## The image contract

An Agent Background execution image must provide `tmux` and a POSIX shell — the runtime makes tmux
PID 1, and that is what makes a session attachable. An image that also puts
`archestra-runner-agent` on `PATH` can be started with no command at all;
anything else supplies its own command in the Agent's Background execution
configuration.

## Environment

All of it is injected by the runtime; nothing is guessed, and a missing value
fails at startup rather than silently pointing the agent somewhere else.

| Variable | Meaning |
| --- | --- |
| `ARCHESTRA_AGENT_BACKGROUND_EXECUTION_AGENT_ID`, `ARCHESTRA_AGENT_BACKGROUND_EXECUTION_AGENT_NAME` | Agent identity for this run |
| `ARCHESTRA_AGENT_BACKGROUND_EXECUTION_TASK_ID` | Durable execution id, attached to LLM and MCP requests for log and trace correlation |
| `ARCHESTRA_LLM_PROXY_URL`, `ARCHESTRA_LLM_PROXY_PROTOCOL`, `ARCHESTRA_VIRTUAL_KEY` | The Agent-scoped proxy, its Responses, Chat Completions, or Anthropic Messages wire protocol, and the execution's short-lived personal virtual key |
| `ARCHESTRA_MCP_GATEWAY_URL`, `ARCHESTRA_MCP_GATEWAY_TOKEN` | Tool access, as the invoking user |
| `ARCHESTRA_AGENT_BACKGROUND_EXECUTION_TASK` | Initial instruction, when started with one |
| `ARCHESTRA_AGENT_BACKGROUND_EXECUTION_ATTACHMENTS_DIR`, `ARCHESTRA_AGENT_BACKGROUND_EXECUTION_ATTACHMENTS_MANIFEST` | Files attached to the initial instruction and their JSON metadata |
| `ARCHESTRA_AGENT_BACKGROUND_EXECUTION_STEER_FIFO` | Where steer messages arrive |
| `ARCHESTRA_AGENT_BACKGROUND_EXECUTION_MODEL`, `ARCHESTRA_AGENT_BACKGROUND_EXECUTION_NATIVE_MODEL`, `ARCHESTRA_AGENT_BACKGROUND_EXECUTION_MAX_STEPS` | Provider-qualified model for the generic runner, native model slug for catalog CLIs, and step cap |

The runtime also exposes the virtual key through the conventional
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_AUTH_TOKEN` names for
maintained third-party Agent images. Those aliases all point to Archestra,
never to an upstream provider credential. The optional Claude Code subscription
path is an explicit exception implemented only by that maintained wrapper.
