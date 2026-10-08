---
title: Built-in Subagents
description: The system subagents Archestra seeds into every organization, and what each one does
order: 1
lastUpdated: 2026-08-26
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra ships built-in subagents for its own background jobs, such as chat titles and long-chat summaries. Most run on their own. You can change each one's model and instructions, but you cannot delete them.

What to know:

- Change them only when you must. Archestra tunes their instructions for their jobs. Changed instructions can make them act in ways you do not expect.
- With no model set, a subagent uses the model of the work it serves, such as the chat's model. The organization's default model is the fallback.

<span id="context-compaction-subagent"></span><span id="chat-title-generation-subagent"></span><span id="app-runtime-llm-agent"></span>

## Built-In Subagents

| Subagent | What It Does |
| --- | --- |
| **OpenAPPA Configuration Agent** | Explains your [Guardrails](/docs/agents/guardrails) policy, and changes it when you ask. It shows each change before it publishes. |
| **Context Compaction Subagent** | Summarizes older history when a chat nears the model's context limit. Recent turns stay word for word, and the full history stays visible. |
| **Chat Title Generation Subagent** | Names each chat in three to six words. |
| **App Runtime LLM Agent** | Serves `archestra.llm.complete()` for [MCP Apps](/docs/chat/apps). Apps cannot pick a model, so set one here. |
