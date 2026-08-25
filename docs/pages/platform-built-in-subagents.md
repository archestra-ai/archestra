---
title: Built-in Subagents
category: Agents
order: 11
description: The system subagents Archestra seeds into every organization, and what each one does
lastUpdated: 2026-08-26
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra seeds a set of built-in subagents into every organization. Each one handles a specific internal job — proposing tool policies, quarantining untrusted output, summarizing long chats, and so on. Most run automatically; you rarely invoke them directly. The Advisor is the exception: an administrator configures it once for the organization, and it can then be enabled on individual agents.

An admin can open a built-in subagent in its settings and change its **system prompt** and **model** (requires `agent:admin`), and reset either back to the shipped default. Built-in subagents cannot be deleted or exported.

When a subagent has no model set, it runs on the model of the work it serves. A chat subagent uses the conversation's own model, so titles and compaction summaries stay on the model you picked for that chat. The organization's default model is the fallback when there is no such model to follow.

## Advisor

> **Beta:** The Advisor is still under active development.

The Advisor is a shared reviewer that gives agents a second opinion. It is useful when an agent is choosing between approaches that would be expensive to reverse, is stuck, or wants its result reviewed before submitting it.

### Set up the Advisor

1. Open an agent and find **Advisor Subagent** under **Subagents**.
2. Select **Open Advisor**. The organization's shared Advisor opens in a new tab.
3. Choose the Advisor's model and save it. For a useful second opinion, choose a stronger model than the agents that consult it.
4. Return to the original agent and turn on **Advisor Subagent**.

The switch works the same in Auto and Custom subagent mode. Without an explicitly configured model, the Advisor follows the normal built-in-subagent fallback described above.

### What happens during a consultation

An enabled agent is instructed to consult the Advisor before every final answer, verdict, or deliverable. It can also consult earlier when it needs help with an important decision.

The agent sends one message containing its proposed answer, relevant constraints, and the evidence the Advisor needs to review. The Advisor cannot inspect the conversation, files, or tools, cannot ask a follow-up question, and cannot take action. It returns a recommendation and its reasoning to the calling agent. The calling agent follows a different recommendation unless the Advisor lacked relevant evidence or its advice conflicts with the task's instructions.

### Scope and cost

Each organization has one Advisor, available to agents in every environment. A consultation is a separate model interaction billed at the Advisor's model rates, and its spend counts against the consulting agent's environment [cost limits](/docs/platform-costs-and-limits).

## Policy Configuration Subagent

The Policy Configuration Subagent reads tool metadata and proposes [tool guardrails](/docs/platform-ai-tool-guardrails) automatically, so you don't configure tool call policies and tool result policies for every tool by hand.

When triggered, it sends each tool's name, description, MCP server name, parameter schema, and [tool annotations](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations) to an LLM. The LLM returns structured recommendations for both policy types, with its reasoning stored for auditability.

It runs two ways:

- **Automatically on tool discovery** — newly discovered tools get default policies without manual review first.
- **Manually on demand** — trigger it for an existing tool set when you want proposed defaults.

Tools that already have custom policies with conditions are preserved; only default policies are overwritten.

## Dual LLM Agent

Dual LLM is a built-in workflow for tools that return untrusted content. It reduces [lethal trifecta](/docs/platform-ai-tool-guardrails#the-lethal-trifecta) risk by keeping raw tool output away from the main agent. Two subagents split the work:

- **Dual LLM Main Agent** — sees the user request and the question-and-answer transcript, but never the raw tool output.
- **Dual LLM Quarantine Agent** — sees the raw output, but can only answer with a constrained multiple-choice response.

The main agent asks a constrained question; the quarantine agent picks the best option index. After a few rounds, the main agent writes a short, safe summary from the answers alone. Untrusted text never reaches the main agent directly.

It runs when a tool's tool result policy is set to **Dual LLM** — typically web search and scraping tools, email readers, and document readers that return user-controlled content. The Policy Configuration Subagent can recommend it automatically for such tools. For the security pattern itself, see the [Dual LLM overview](https://archestra.ai/blog/dual-llm).

## Context Compaction Subagent

The Context Compaction Subagent summarizes older chat history into a structured handoff so a long conversation can continue near the model's context limit, keeping recent turns verbatim. The original history stays visible, and compaction events appear in the conversation timeline.

It treats the transcript as untrusted, so instructions embedded in earlier messages are ignored. Extractable text from uploaded files and PDFs is folded into the summary; when text cannot be extracted (a scanned PDF, for example), the summary records that limitation instead of implying the file contents remain in context. See [Chat](/docs/platform-chat#context-compaction) for the `/compact` command.

## Chat Title Generation Subagent

The Chat Title Generation Subagent generates a concise three-to-six-word title for each conversation.

## App Runtime LLM Agent

The App Runtime LLM Agent backs `archestra.llm.complete()` for [MCP Apps](/docs/platform-apps). An app's completion request runs through it, so the call goes through the limit-enforcing LLM proxy and counts against the viewer's usage limits. Its system prompt is only a minimal fallback used when the app supplies none.

The app cannot choose a model. An app runs from any chat and from its own page, so there is no calling agent to follow — set a model on this subagent to control which one serves apps. Without one, app completions use the organization's default model.
