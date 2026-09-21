# Agent Runtime Image Contract

This reference is for custom image authors. For maintained image targets and build commands, see the [image README](README.md).

## Image Requirements

| Requirement | Contract |
| --- | --- |
| Shell | `/bin/sh` must exist. Archestra uses it for the bootstrap and configured command. |
| Workspace files | `python3` must be on `PATH` for reading, writing and transferring workspace files. Archestra sends the helper program with each request, so the image needs no copy of it. Images without `python3` run normally; only file access is refused, with a message that says so. |
| Live terminal | `tmux` must be on `PATH`. The process runs in one tmux session so the run can accept terminal input and a user can attach from the Runs tab. |
| Input attention | Set the tmux user option `@archestra_attention` to `1` when the client needs input. Set `@archestra_attention_label` to a short reason, such as `Permission needed`. Clear both options when work resumes. |
| Command | Set **Command** and **Arguments** to the executable and arguments for the Agent client. If Command is blank, `archestra-runtime-agent` must be on `PATH`. |
| Initialization | An optional `archestra-agent-init` executable is called immediately before the Agent command. Use it for runtime-only setup such as Git credential configuration. |
| Output | Write progress and the final result to stdout or stderr. Archestra streams and retains that output as the run log. Do not print credentials. |
| Completion | Exit `0` only after the turn is complete. Any non-zero exit marks the run failed. The workspace supervisor does not replay an interrupted turn after Pod replacement. |
| Storage | `/home/node` and `/var/run/archestra` are persisted on a workspace PVC. Privileged runtimes also persist `/var/lib/docker` there. Other container paths are ephemeral. Export final deliverables before the workspace's retention deadline. |

The initial task is supplied in `ARCHESTRA_AGENT_RUNTIME_TASK`. The Agent system prompt is supplied in `ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT`. A custom client decides how to combine them. It should read `ARCHESTRA_AGENT_RUNTIME_MODE`: `interactive` means expose its input loop and remain available for follow-ups, while `one_shot` means finish the supplied task and exit. Images that support only unattended work can ignore interactive mode, but they will not provide a useful Chat terminal.

## Failure Reasons

Custom images can publish a user-facing failure before exiting non-zero. Write a versioned JSON envelope to `${ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX}.failure`. The supervisor supplies this turn-specific prefix before initialization and client startup.

```sh
failure="${ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX}.failure"
jq -n \
  --arg code "my_agent.input_missing" \
  --arg message "Select an input file and retry." \
  '{version:1,code:$code,message:$message}' > "$failure.tmp"
mv "$failure.tmp" "$failure"
exit 1
```

Use an atomic rename to publish the complete file. The image owns the code and message. Codes need no platform registration. The backend validates the envelope, appends the runtime exit status, and propagates the message through task results, notifications, and run details.

Version `1` accepts exactly these fields:

| Field | Contract |
| --- | --- |
| `version` | The number `1`. |
| `code` | An image-defined identifier of 1–128 ASCII letters, digits, dots, underscores, or hyphens. |
| `message` | Non-empty plain text, at most 2,000 characters after trimming. Newlines and tabs are allowed; other ASCII control characters are rejected. |

The entire UTF-8 file must not exceed 4,096 bytes. Missing files, malformed JSON, unsupported versions, and invalid fields retain the exit-status-only fallback. A failure envelope never overrides a successful exit. Older platforms ignore this optional file.

Treat `message` as public task output. Image authors must remove credentials and private details before publishing it. Prefer safe messages constructed from structured client errors; never copy raw stderr or provider response bodies. Schema validation cannot detect secrets in otherwise valid text.

The built-in Archestra image reports configuration, startup, and session failures. The maintained Claude Code wrapper publishes its own messages from `StopFailure` events. Delegated API failures end the run. Interactive sessions remain open and request attention. The OpenCode and OpenClaw wrappers also publish safe messages for terminal one-shot errors. OpenCode context compaction remains recoverable. Shared initialization reports proxy connectivity and GitHub setup failures. Codex, Hermes, OpenCode, and OpenClaw publish protocol configuration errors through the same envelope. Native errors without an adapter retain exit-status-only reporting.

The Codex wrapper reads terminal `task_complete.error` events from the main session's structured rollout. Failed delegated turns publish the upstream message after credential redaction and settle as failed. Interactive sessions request attention. Earlier resumed turns, subagent errors, and transient retries cannot fail the current turn. Rebuild maintained Codex images and advance derived-image pins to receive this behavior.

Runtime-owned startup and process failures also publish envelopes. Their messages distinguish credential projection timeouts, interrupted turns after Pod replacement, and processes that exit without reporting a result. Interrupted turns are never replayed automatically.

## Skills

Agent skills are exposed as MCP tools through `ARCHESTRA_MCP_GATEWAY_URL`, authenticated with `ARCHESTRA_MCP_GATEWAY_TOKEN`. A custom client must support MCP `tools/list` and `tools/call`, expose the returned tools to its model, and return tool results to the model. No separate Archestra SDK or skill installation is required.

Pass `ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT` to the model. It includes a bounded preview of accessible skill names and descriptions. The gateway also adds this preview to the `list_skills` tool description. Treat previews as discovery hints; call `list_skills` for the complete current catalog.

Use the gateway's advertised tool names: `list_skills` discovers the Agent's effective catalog; `load_skill` loads instructions or a bundled file by `name` and optional `path`. Names carry the deployment's tool prefix. When the gateway uses tool search, discover these tools there first. The Agent's skill policy, environment, and caller permissions apply to every request.

Bundled text files are returned as text. A `<skill_file encoding="base64">` contains bytes to decode before saving. Preserve resource paths relative to the skill root and provide the runtimes and dependencies its scripts require. Files are not automatically installed in native client skill directories. `/skills` mounts mentioned by sandbox-enabled tools belong to the separate Code Sandbox, not this container.

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
| `ARCHESTRA_AGENT_RUNTIME_CREDENTIALS_FILE` | Managed JSON credential bundle, reread before authenticating. Each entry has `value` and Unix-millisecond `expiresAt`; the bundle is scoped by `taskId`. |
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
| `ARCHESTRA_VIRTUAL_KEY` | Run-scoped virtual key. Provider-backed runs use it as the provider credential at the proxy. Claude Code subscription runs use it as a personal passthrough identity header alongside their own OAuth bearer token. |
| `ANTHROPIC_BEDROCK_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION` | Configure native Bedrock transport for Claude Code using a Bedrock model. |
| `AWS_BEARER_TOKEN_BEDROCK` | The run’s virtual key for the Bedrock proxy. AWS credentials remain server-side. |
| `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` | Native client aliases for the Agent-scoped proxy. |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | Native client aliases for the virtual key on the standard provider path. These are omitted when the official Claude Code image uses its run-scoped subscription token. |
| `ARCHESTRA_MCP_GATEWAY_URL`, `ARCHESTRA_MCP_GATEWAY_TOKEN` | Agent-scoped MCP endpoint and the initiating user's bearer token. |
| `ARCHESTRA_AGENT_RUNTIME_STEER_FIFO` | Turn-boundary steering channel. |
| `ARCHESTRA_AGENT_RUNTIME_IDLE_TIMEOUT_SECONDS` | How long a completed turn may wait for follow-up work before the run exits. |

Send `X-Archestra-Run-Id` and `X-Archestra-Session-Id`, both set to `ARCHESTRA_AGENT_RUNTIME_TASK_ID`, on every LLM proxy and MCP gateway request. This groups model interactions and tool calls with the run in logs and traces. The maintained catalog images configure these headers automatically.

Use the injected proxy and gateway endpoints for custom images. Direct connections bypass platform controls. Custom images receive a standard virtual key: send `ARCHESTRA_VIRTUAL_KEY` as the provider API key to `ARCHESTRA_LLM_PROXY_URL`. The maintained Claude Code subscription mode receives a personal passthrough key instead. Its wrapper sends that key in `X-Archestra-Virtual-Key`, its OAuth bearer token in `Authorization`, and model requests to the proxy URL. The passthrough key authenticates the run's user while the bearer token authenticates to Anthropic.
