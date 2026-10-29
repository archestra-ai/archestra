---
title: Skill and Sandbox Metrics
description: Look up skill activations, context tokens, sandbox commands, and runtime status.
order: 6
lastUpdated: 2026-10-28
---

Track skill activations and Code Sandbox command outcomes.

## Metrics

| Metric | Labels | Measures |
| --- | --- | --- |
| <span id="skill_activations_total"></span>`skill_activations_total` | `activation_type` | [Skill](/docs/agents/skills) activations: `slash_command`, `chat_attachment`, [`load_skill`](/docs/reference/archestra-mcp-server#load_skill), or `delegation` |
| <span id="skill_context_tokens_total"></span>`skill_context_tokens_total` | `activation_type` | Tokens that skill activations added to model context |
| <span id="sandbox_commands_total"></span>`sandbox_commands_total`, <span id="sandbox_command_duration_seconds"></span>`sandbox_command_duration_seconds` | `status` | [Code Sandbox](/docs/agents#code-sandbox) commands: `ok`, `script_error`, `timeout`, or `runtime_error` |
| <span id="sandbox_runtime_errors_total"></span>`sandbox_runtime_errors_total` | `code` | Sandbox runtime errors. `engine_unreachable` means the sandbox engine is down. |
| <span id="sandbox_runtime_status"></span>`sandbox_runtime_status` | `status` | `1` for the runtime's current status: `disabled`, `initializing`, `ready`, `error`, or `stopped` |
