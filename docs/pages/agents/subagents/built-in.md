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

## Advisor

:::beta The Advisor is on by default. It may change before general availability.:::

Give your agents a second opinion before they answer. The Advisor is one shared reviewer for the organization. It helps an agent that is stuck, faces a choice that is hard to reverse, or wants its result checked.

<span id="set-up-the-advisor"></span>

### Turn On the Advisor

1. Open an agent and find **Advisor Subagent** under **Subagents**.
2. Select **Open Advisor**. The organization's shared Advisor opens in a new tab.
3. Choose the Advisor's model and save it. For a useful second opinion, choose a stronger model than the agents that consult it.
4. Return to the original agent and turn on **Advisor Subagent**.

<span id="what-happens-during-a-consultation"></span><span id="scope-and-cost"></span>

### How It Works

- **When:** the agent consults the Advisor before every final answer, and earlier for important decisions.
- **What it sees:** only the one message the agent sends, with its proposed answer and evidence. It cannot read the chat, files, or tools, ask questions, or act.
- **What the agent does:** it follows the Advisor's advice, unless the Advisor lacked evidence or the advice conflicts with the task.
- **Cost:** each consultation is a model call at the Advisor's model rates. It counts toward the consulting agent's environment [cost limits](/docs/llm-proxy/costs-and-limits).

<span id="context-compaction-subagent"></span><span id="chat-title-generation-subagent"></span><span id="app-runtime-llm-agent"></span>

## The Other Built-In Subagents

| Subagent | What It Does |
| --- | --- |
| **OpenAPPA Configuration Agent** | Explains your [Guardrails](/docs/agents/guardrails) policy, and changes it when you ask. It shows each change before it publishes. |
| **Context Compaction Subagent** | Summarizes older history when a chat nears the model's context limit. Recent turns stay word for word, and the full history stays visible. |
| **Chat Title Generation Subagent** | Names each chat in three to six words. |
| **App Runtime LLM Agent** | Serves `archestra.llm.complete()` for [MCP Apps](/docs/chat/apps). Apps cannot pick a model, so set one here. |
