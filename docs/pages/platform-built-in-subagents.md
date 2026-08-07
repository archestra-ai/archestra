---
title: Built-in Subagents
category: Agents
order: 10
description: The system subagents Archestra seeds into every organization, and what each one does
lastUpdated: 2026-08-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra seeds a set of built-in subagents into every organization. Each one handles a specific internal job — proposing tool policies, quarantining untrusted output, summarizing long chats, and so on. Most run automatically; you rarely invoke them directly. The Advisor is the exception: you turn it on per agent.

An admin can open a built-in subagent in its settings and change its **system prompt** and **model** (requires `agent:admin`), and reset either back to the shipped default. Built-in subagents cannot be deleted or exported. When one has no model set, it falls back to the organization's default model.

## Advisor

The Advisor is a stronger model an agent consults at the decisions that shape a task: which approach to take, an error that keeps coming back, whether the work is really done. Everything else stays on the agent's own model.

Turn it on per agent or MCP gateway with **Enable Advisor**, under **Subagents**. It works the same in Auto and Custom mode. Pick the Advisor's model in its own settings — a stronger model than the callers use is the point.

Enabling the Advisor also instructs the agent to consult it before delivering a final answer, and to share the raw evidence behind the answer — samples of skipped input, for example — so the advice reviews the work, not a summary of it. MCP Gateways advertise the Advisor tool without this instruction; the calling model's own prompt decides when to consult.

The Advisor cannot see the conversation, the files, or the tools. It reads only the message the calling model writes, then returns advice. It changes nothing.

Each environment has its own Advisor, created and removed with the environment. An agent reaches only the Advisor in its own environment, so consultations count against that environment's [cost limits](/docs/platform-costs-and-limits). Each consultation is a separate interaction, billed at the Advisor's model rates. The agent consults at decision points rather than on every turn, so a cheap agent model paired with a strong Advisor usually costs less than running the strong model throughout.

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

The App Runtime LLM Agent backs `archestra.llm.complete()` for [MCP Apps](/docs/platform-apps). An app's completion request runs through it, so the call goes through the limit-enforcing LLM proxy and counts against the viewer's usage limits. The app cannot choose a model — the host resolves the organization's default — and the subagent's system prompt is only a minimal fallback used when the app supplies none.
