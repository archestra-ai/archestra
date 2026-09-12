# Agent Runtime Image Contract

This reference is for custom image authors. For maintained image targets and build commands, see the [image README](README.md).

## Image Requirements

| Requirement | Contract |
| --- | --- |
| Shell | `/bin/sh` must exist. Archestra uses it for the bootstrap and configured command. |
| Live terminal | `tmux` must be on `PATH`. The process runs in one tmux session so the run can accept terminal input and a user can attach from the Runs tab. |
| Input attention | Set the tmux user option `@archestra_attention` to `1` when the client needs input. Set `@archestra_attention_label` to a short reason, such as `Permission needed`. Clear both options when work resumes. |
| Command | Set **Command** and **Arguments** to the executable and arguments for the Agent client. If Command is blank, `archestra-runtime-agent` must be on `PATH`. |
| Initialization | An optional `archestra-agent-init` executable is called immediately before the Agent command. Use it for runtime-only setup such as Git credential configuration. |
| Output | Write progress and the final result to stdout or stderr. Archestra streams and retains that output as the run log. Do not print credentials. |
| Completion | Exit `0` only after the turn is complete. Any non-zero exit marks the run failed. The workspace supervisor does not replay an interrupted turn after Pod replacement. |
| Storage | `/home/node` and `/var/run/archestra` are persisted on a workspace PVC. Privileged runtimes also persist `/var/lib/docker` there. Other container paths are ephemeral. Export final deliverables before the workspace's retention deadline. |

The initial task is supplied in `ARCHESTRA_AGENT_RUNTIME_TASK`. The Agent system prompt is supplied in `ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT`. A custom client decides how to combine them. It should read `ARCHESTRA_AGENT_RUNTIME_MODE`: `interactive` means expose its input loop and remain available for follow-ups, while `one_shot` means finish the supplied task and exit. Images that support only unattended work can ignore interactive mode, but they will not provide a useful Chat terminal.

## Readable Transcript

The maintained Archestra Agent, Claude Code, Codex, OpenCode, Hermes, and OpenClaw images export their native message and tool history as a readable transcript. A custom image can provide the same completed-run experience by writing `$ARCHESTRA_AGENT_RUNTIME_DIR/readable-transcript.json` (normally `/var/run/archestra/readable-transcript.json`) before its process exits.

The file must be a JSON object using version 1 of this contract:

```json
{
  "version": 1,
  "provider": "custom-agent",
  "entries": [
    {
      "type": "message",
      "role": "user",
      "text": "Inspect the application configuration.",
      "timestamp": "2026-09-07T10:00:00Z"
    },
    {
      "type": "message",
      "role": "assistant",
      "text": "I will read the configuration file."
    },
    {
      "type": "tool_call",
      "name": "read_file",
      "input": "{\"path\":\"config.json\"}",
      "toolCallId": "call-1"
    },
    {
      "type": "tool_result",
      "text": "{\"enabled\":true}",
      "toolCallId": "call-1",
      "isError": false
    }
  ]
}
```

`provider` is a non-empty identifier for the client that produced the file. `entries` preserves chronological order and accepts these entry types:

- `message` requires `role` (`user` or `assistant`) and `text`.
- `tool_call` requires `name`. `input` is an optional string; serialize
structured arguments as JSON. `toolCallId` is optional but recommended.
- `tool_result` requires `text`. Use the matching `toolCallId` when available
and set `isError` to `true` for failed calls.
- Every entry may include an ISO 8601 `timestamp`.

Write to a temporary file in the runtime directory and rename it into place so Archestra never reads a partial document. Invalid files and files larger than 16 MiB are ignored; the retained terminal replay remains available. The normalized artifact should contain only user-visible messages and tool activity, not credentials, private reasoning, or raw provider events.

## Input Files

Files attached to initial runs or API/A2A follow-ups are staged before the Agent command starts. Each turn uses its own subdirectory under `ARCHESTRA_AGENT_RUNTIME_ATTACHMENTS_DIR`. Earlier attachments remain intact. The task text lists the absolute path of every attached file, and `ARCHESTRA_AGENT_RUNTIME_ATTACHMENTS_MANIFEST` points to a JSON array containing each file's original name, absolute path, media type, and size. Filenames are reduced to safe path segments and collisions are renamed.

The files are task inputs, not shell keystrokes and not model-provider attachments. The Agent reads them from disk with its normal file or shell tools. Kubernetes holds the Agent entrypoint until every file and the manifest have been written. If the control plane restarts during staging, reconciliation finishes the same durable inputs before releasing the command.

For **Turn boundary** steering, read newline-delimited messages from the FIFO at `ARCHESTRA_AGENT_RUNTIME_STEER_FIFO` and consume them only between model turns. For **Terminal input**, Archestra sends keystrokes to the tmux session; the process must expose an interactive input loop. A custom client that supports neither mode can still run one-shot tasks, but cannot accept useful follow-up instructions.

## Runtime Environment

Archestra supplies the applicable variables below when launching a run. You do not need to set them manually for the maintained runtime images. For Claude Code with Bedrock or Vertex AI, configure the platform provider and select a supported Claude model. Archestra handles the runtime connection and authentication automatically.

| Variable | Purpose |
| --- | --- |
| `ARCHESTRA_AGENT_RUNTIME_AGENT_ID`, `ARCHESTRA_AGENT_RUNTIME_AGENT_NAME` | Durable Agent identity. |
| `ARCHESTRA_AGENT_RUNTIME_TASK_ID` | Durable run identifier. |
| `ARCHESTRA_AGENT_RUNTIME_DIR` | Runtime-owned control and artifact directory. Defaults to `/var/run/archestra`. |
| `ARCHESTRA_AGENT_RUNTIME_MODE` | `interactive` for a Chat-owned live terminal; `one_shot` for unattended delegation that must exit when complete. |
| `ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID`, `ARCHESTRA_AGENT_RUNTIME_CONTINUE` | Stable workspace identity and `1` when restoring a saved client session for a follow-up. |
| `ARCHESTRA_AGENT_RUNTIME_TASK`, `ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT` | Initial task and Agent instructions. |
| `ARCHESTRA_AGENT_RUNTIME_ATTACHMENTS_DIR` | Parent directory containing each turn's attached files. |
| `ARCHESTRA_AGENT_RUNTIME_ATTACHMENTS_MANIFEST` | JSON manifest containing each input file's name, path, media type, and size. |
| `ARCHESTRA_AGENT_RUNTIME_MODEL` | Provider-qualified model ID for generic clients. |
| `ARCHESTRA_AGENT_RUNTIME_NATIVE_STATE_DIR` | Optional image-wrapper override for isolated Codex, Hermes, or OpenClaw conversation state. Control files and terminal recording remain in the runtime directory. |
| `ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL` | Provider-native model slug for clients that configure their provider separately. |
| `ARCHESTRA_AGENT_RUNTIME_MODEL_CONTEXT_LENGTH`, `ARCHESTRA_AGENT_RUNTIME_MODEL_OUTPUT_LENGTH` | Known context and output limits for native client configuration. |
| `ARCHESTRA_LLM_PROXY_URL`, `ARCHESTRA_LLM_PROXY_PROTOCOL` | Agent-scoped inference endpoint and its `openai_responses`, `openai_chat`, or `anthropic` protocol. |
| `ARCHESTRA_VIRTUAL_KEY` | Personal virtual key for the run. |
| `ANTHROPIC_BEDROCK_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION` | Configure native Bedrock transport for Claude Code using a Bedrock model. |
| `AWS_BEARER_TOKEN_BEDROCK` | The run’s virtual key for the Bedrock proxy. AWS credentials remain server-side. |
| `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` | Native client aliases for the Agent-scoped proxy. |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | Native client aliases for the virtual key on the standard provider path. These are omitted when the official Claude Code image uses its run-scoped subscription token. |
| `ARCHESTRA_MCP_GATEWAY_URL`, `ARCHESTRA_MCP_GATEWAY_TOKEN` | Agent-scoped MCP endpoint and the initiating user's bearer token. |
| `ARCHESTRA_AGENT_RUNTIME_STEER_FIFO` | Turn-boundary steering channel. |
| `ARCHESTRA_AGENT_RUNTIME_IDLE_TIMEOUT_SECONDS` | How long a completed turn may wait for follow-up work before the run exits. |

Send `X-Archestra-Run-Id` and `X-Archestra-Session-Id`, both set to `ARCHESTRA_AGENT_RUNTIME_TASK_ID`, on every LLM proxy and MCP gateway request. This groups model interactions and tool calls with the run in logs and traces. The maintained catalog images configure these headers automatically.

Use the injected proxy and gateway endpoints for custom images. Direct connections bypass platform controls. The maintained Claude Code subscription mode deliberately connects directly to Anthropic; its MCP calls still use the gateway.
