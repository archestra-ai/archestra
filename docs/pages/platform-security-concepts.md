---
title: Security Concepts
category: LLM Proxy
order: 5
description: Archestra's context-aware security model for agentic tool use
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This is the parent page for the Security Concepts section. It exists to give an overview and link to the child pages. Keep it short.
-->

Most platforms try to make agents safer by writing better prompts or by asking another LLM "is this safe?" at runtime. Both fail under prompt injection, because the model itself is the thing being attacked.

Archestra takes a different approach. Security is enforced **at the LLM Proxy**, before a request reaches the model and before a tool call leaves the gateway. The decisions are deterministic, auditable, and depend on the **live context of the conversation** — not a static allowlist.

That gives you three properties most agentic stacks do not have:

- **Context-aware enforcement.** The same tool can be allowed in one turn and blocked in the next, based on what data has already entered the context. After an agent reads an email from outside your domain, `send_email` to external recipients can automatically require approval — without any change to the agent itself.
- **Sensitive context never leaks.** Untrusted tool output (web pages, emails, issue trackers) is quarantined before it reaches the agent's tool-calling loop. A prompt injection hidden in a fetched page cannot instruct the agent to exfiltrate secrets, because the injected instructions never enter the agent that holds the tools.
- **Deterministic by default, LLM-assisted where it helps.** Allow/block decisions come from stored policies you can read and audit. An LLM is used to *propose* sensible defaults from tool metadata, not to make the final security call at runtime.

## In this section

- **[The Lethal Trifecta](/docs/platform-lethal-trifecta)** — the threat model. Why combining private data access, exposure to untrusted content, and the ability to communicate externally produces an exploitable agent, and why prompt-engineering alone cannot fix it.

- **[AI Tool Guardrails](/docs/platform-ai-tool-guardrails)** — the enforcement layer. Tool call policies and tool result policies that inspect the actual arguments and the actual returned data, then decide whether the call runs and how the result is treated (safe, sensitive, dual-LLM, blocked). Evaluated against the running context, not a static list.

- **[Tool Policy Configuration Agent](/docs/platform-built-in-agents-policy-config)** — the bootstrap. A built-in agent that reads tool metadata and proposes default call and result policies so you do not start from a blank screen for every new tool.

- **[Dual LLM Agent](/docs/platform-dual-llm)** — the quarantine. Untrusted tool output is routed through an isolated model that has no tool access. The main agent only ever sees a constrained, structured answer ("does this email contain a request? 0/1"), so injected instructions cannot reach the tool-calling loop.

If you are new to the model, read them in order. The trifecta explains *what* you are defending against; guardrails are the *primary* control plane; the configuration agent and Dual LLM are the supporting mechanisms that make the primary control plane practical at scale.
