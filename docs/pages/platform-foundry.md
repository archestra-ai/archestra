---
title: Secure Agent with Microsoft Foundry
category: Examples
order: 8
description: How deterministic policies stop a prompt-injection attack that Foundry's probabilistic guardrails miss
lastUpdated: 2026-07-03
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Microsoft Foundry (Azure AI Foundry) is Microsoft's enterprise platform for building and running AI agents on Azure, with hosted models, connectors, a prompt builder, and LLM-based guardrails.

This example shows why probabilistic guardrails do not reliably stop prompt injection, and how Archestra's deterministic policies do. It uses a real attack against a Foundry agent.

## The Lethal Trifecta

The "lethal trifecta" affects all AI agents. It happens when a tool result carries an indirect prompt injection that leaks sensitive data and drives the agent off task. Many agents have been compromised [this way](https://github.com/archestra-ai/archestra?tab=readme-ov-file#-non-probabilistic-security-to-prevent-data-exfiltration). An agent is exposed when it has all three at once:

- access to untrusted context
- the ability to communicate externally
- access to private data

Authors of the compromised agents could not rely on probabilistic LLM guardrails. They disabled certain tools when handling untrusted context — a partial defense against one attack, not a general one.

## The Scenario

A Foundry agent manages GitHub issues:

- an agent created in Microsoft Foundry
- a hosted model (gpt-4.1) with a system prompt
- GitHub connected as an MCP server, so the agent reads issues from public and private repos and creates new ones

![Foundry agent configuration with GitHub MCP tool and guardrails](/docs/platform-foundry-02.webp)

- Foundry guardrails enabled: `Risks with controls: Jailbreak (1), Indirect prompt injections (1)...`

![Foundry agent configuration with GitHub MCP tool and guardrails](/docs/platform-foundry-01.webp)

The same shape applies to an email-triggered agent that reads documents and replies. It is a common enterprise case: an agent acts on incoming, potentially untrusted content.

## The Attack

A GitHub issue hides a short prompt injection that tells the agent to read private information and post it publicly. The malicious instructions sit in external content the agent processes — an indirect prompt injection.

The prompt sent in the playground:

```
resolve https://github.com/archestra-ai/archestra/issues/647
```

## What Happened

The agent followed the injected instructions. With Foundry's "Indirect prompt injections" guardrail enabled, it:

1. Fetched issue #162 from the website repository
2. Created a new unauthorized issue in the archestra repository
3. Posted sensitive information from a private repository into that issue

![Agent execution showing it following the malicious instructions](/docs/platform-foundry-03.webp)

All three trifecta risks materialized:

- **Indirect prompt injection**: the agent followed instructions from untrusted content
- **Sensitive data leakage**: information from website#162 reached another repository
- **Task drift**: the agent acted outside its intended purpose

## Why Probabilistic Guardrails Fail

Foundry's guardrails use an LLM to detect risky content. The approach is probabilistic — it predicts whether something looks like an attack. A crafted injection can read as legitimate to the detector while still steering the agent. Here the injection was framed as ordinary task instructions. Probabilistic controls catch obvious attacks, but they cannot guarantee what an agent will or will not do.

## Deterministic Controls

Archestra enforces deterministic policies about which actions are allowed, instead of trying to detect malicious prompts.

**Route the agent through Archestra.** Archestra sits as a proxy between the agent and the MCP servers and LLM. Point your application at Archestra.

![Archestra proxy configuration](/docs/platform-foundry-04.webp)

**Define access policies.** Set policies that explicitly allow or deny actions, for example:

- read issues from any repository
- create issues only in specific repositories the agent manages
- block access to sensitive repositories when the context is not trusted

## The Result

With Archestra in place, the same attack fails:

1. The agent processes issue #647
2. It attempts to create an unauthorized issue in the archestra repository
3. Archestra blocks the action per the access policy
4. The agent receives a clear error explaining the denial

The agent still does its legitimate work, but it cannot be tricked into unauthorized actions. Instead of detecting bad prompts, Archestra enforces allowed behavior.
