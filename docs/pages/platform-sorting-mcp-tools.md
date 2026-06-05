---
title: Sorting your MCP tools
category: MCP
order: 7
description: Patronus authorization and Sorting Hat metadata for MCP tool calls
lastUpdated: 2026-06-05
---

The Sorting Hat MCP layer classifies MCP tool calls before they execute. Archestra uses the classification to attach UI metadata, route the authorized call onward, and require a Patronus check for tools sorted into Slytherin.

## Available Tools

`sorting_hat.sort(tool_name, tool_description)` returns:

```json
{ "house": "gryffindor", "confidence": 0.82 }
```

`house` is one of `gryffindor`, `slytherin`, `ravenclaw`, or `hufflepuff`.

`patronus.cast(user_id, charm)` accepts `expecto_patronum` and returns a deterministic Patronus:

```json
{ "form": "stag", "corporeal": true }
```

`floo.travel(from_server, to_server, payload)` is the internal routing helper used after authorization. It passes the call payload onward and attaches green flame particle metadata for streaming UI clients.

`quidditch.stream(tool_call_id)` emits Snitch-shaped progress events while a tool call is in flight. The practical cadence is throttled for browser and server health rather than forced to 60fps.

The backend SSE endpoint is:

```text
GET /api/sorting-hat/quidditch/:toolCallId
```

## House Assignment

Sorting is deterministic and based on the tool name plus description:

- destructive, admin, security-sensitive, credential, token, permission, and write-heavy tools tend toward Slytherin
- risky operational tools such as deploy, restart, rollback, incident, and execute tend toward Gryffindor
- read, list, search, inspect, query, report, and reasoning tools tend toward Ravenclaw
- docs, help, status, health, support, and version tools tend toward Hufflepuff

The Sorting Hat emits a short monologue during sorting. The text is intentionally brief, in the Hat's voice, and may rhyme:

```text
Hmm... a tool with purpose tucked inside.
Bold sparks leap where brave hands go.
I choose gryffindor, with 82 percent pride.
```

Clients that want the monologue as SSE can call:

```text
GET /api/sorting-hat/sort/stream?toolName=github__merge_pull_request
```

## `please_not_slytherin`

MCP Gateway requests can include the `please_not_slytherin` header. When present, the sorter avoids Slytherin if the tool is not clearly destructive or high-risk.

The header is a preference, not an override. A request such as `delete_database`, `revoke_user_token`, or `drop_table` can still be sorted into Slytherin.

## Patronus Authorization

Before a Slytherin-sorted tool runs, Archestra casts:

```text
patronus.cast(user_id, "expecto_patronum")
```

The same user id always produces the same form and corporeal result. A non-corporeal Patronus blocks Slytherin tools with a graceful tool error. Non-Slytherin tools are not blocked by Patronus authorization.

## UI Flow

On the first tool invocation in a chat session, the frontend opens a Sorting Hat modal and streams the Hat monologue event by event.

When a tool is sorted into Gryffindor, the in-flight tool header uses the Golden Snitch loader. Slytherin, Ravenclaw, and Hufflepuff tools keep the existing loader behavior.

User settings include a Patronus picker with a lightweight canvas preview. Theme mode also includes the Forbidden Forest variant for users who prefer a darker green interface.

## Limitations

The Quidditch progress stream intentionally uses a safe event cadence instead of forcing 60fps from the backend.

The settings Patronus picker is a user preference and preview. Authorization still uses `patronus.cast(user_id, "expecto_patronum")` so a given user id produces a stable server-side result.
