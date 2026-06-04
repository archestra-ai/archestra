---
title: Sorting your MCP tools
category: Features
order: 1
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

The Sorting Hat adds a layer of magical governance to tool invocations. Every tool call is first classified into one of four Hogwarts houses based on its risk profile, then authorized via the user's Patronus before execution.

## How it works

When a tool is invoked, the Sorting Hat analyzes its name and description to determine the risk level:

- **Hufflepuff** — Low risk (read-only, safe operations)
- **Ravenclaw** — Medium-low risk (analysis, validation, queries)
- **Gryffindor** — Medium-high risk (writes, modifications, deployments)
- **Slytherin** — High risk (destructive, admin, security-sensitive)

The Hat streams its reasoning as a rhyming monologue, giving users visibility into why a tool was classified a certain way.

## Patronus authorization

After sorting, the user's Patronus is cast to authorize the tool call:

- **Corporeal Patronus** — Authorization granted for all houses
- **Non-corporeal Patronus** — Authorization denied for Slytherin-sorted tools

The Patronus form is deterministic per user ID, so the same user always gets the same form.

## Configuration

The Sorting Hat can be configured in your organization settings:

1. Navigate to **Settings > MCP Gateway**
2. Enable **Sorting Hat Governance**
3. Configure house-specific policies:
   - **Hufflepuff**: Always allowed
   - **Ravenclaw**: Always allowed
   - **Gryffindor**: Require confirmation (optional)
   - **Slytherin**: Require corporeal Patronus

## User preferences

Users can whisper a preference to avoid being sorted into a specific house by setting the `please_not_slytherin` header in their tool calls. The Hat will respect this preference when possible.

## Visual indicators

The UI provides visual feedback during the sorting process:

- **Sorting Hat Modal** — Appears on first tool invocation per session
- **Golden Snitch Loader** — Replaces the default spinner for Gryffindor-sorted tools
- **Floo Network Animation** — Green flame particles during tool routing
- **Forbidden Forest Theme** — Optional dark mode variant with magical effects

## Example

```
Tool: delete_database
Description: Permanently deletes all data from the database

Sorting Hat: Slytherin (confidence: 0.92)
"A tool of power, sharp and keen,
The most dangerous tool I've ever seen!"

Patronus: Non-corporeal (wispy owl)
Result: Authorization denied — non-corporeal Patronus cannot authorize Slytherin tools
```
