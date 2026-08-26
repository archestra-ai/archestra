# runner-agent

The agent loop that runs inside an Archestra Runner, and the default image a
Runner starts from.

It is deliberately thin. The model, the tool set, the policies and the budget
are all resolved by the platform behind the LLM proxy and MCP gateway this
process talks to — the loop's job is to keep a conversation going, print it
legibly for anyone attached to the tmux session, and take direction from a
human without losing its place.

## How a session is steered

The runtime writes one line per message into a FIFO (`ARCHESTRA_RUNNER_STEER_FIFO`).
The loop reads it continuously but only *consumes* messages at a turn boundary,
so a steer can never be spliced into the middle of a tool call. When the agent
has nothing left to do it parks on that channel, which is what makes a session
that idles for days cost almost nothing.

## The image contract

A Runner image must provide `tmux` and a POSIX shell — the runtime makes tmux
PID 1, and that is what makes a session attachable. An image that also puts
`archestra-runner-agent` on `PATH` can be started with no command at all;
anything else supplies its own command in the agent's runner configuration.

## Environment

All of it is injected by the runtime; nothing is guessed, and a missing value
fails at startup rather than silently pointing the agent somewhere else.

| Variable | Meaning |
| --- | --- |
| `ARCHESTRA_RUNNER_ID`, `ARCHESTRA_RUNNER_NAME` | Identity of this session |
| `ARCHESTRA_LLM_PROXY_URL`, `ANTHROPIC_API_KEY` | The proxy and the session's personal virtual key |
| `ARCHESTRA_MCP_GATEWAY_URL`, `ARCHESTRA_MCP_GATEWAY_TOKEN` | Tool access, as the invoking user |
| `ARCHESTRA_RUNNER_TASK` | Initial instruction, when started with one |
| `ARCHESTRA_RUNNER_STEER_FIFO` | Where steer messages arrive |
| `ARCHESTRA_RUNNER_MODEL`, `ARCHESTRA_RUNNER_MAX_STEPS` | Model and step cap |
