---
title: Dual LLM Agent
category: LLM Proxy
subcategory: Security Concepts
order: 5
description: Built-in agents that quarantine untrusted tool output before it reaches the main agent
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This document is human-built, shouldn't be updated with AI. Don't change anything here.

Exception:
- Screenshot
-->

Dual LLM is a built-in security workflow for tools that return untrusted content. It is one strategy Archestra uses to reduce [lethal trifecta](/docs/platform-lethal-trifecta) risk. Instead of letting the main agent read raw output from sources like web pages, email, or user-generated files, Archestra routes that output through two built-in agents with different responsibilities.

For a deeper explanation of the security pattern itself, see the [Dual LLM overview](https://archestra.ai/blog/dual-llm).

## How It Works

The workflow uses:

- **Dual LLM Main Agent**: sees the user request and the Q&A transcript, but never the raw tool output
- **Dual LLM Quarantine Agent**: sees the raw tool output, but can only answer with a constrained multiple-choice response

The main agent asks a constrained multiple-choice question. The quarantine agent picks the best option index. After a few rounds, the main agent produces a short safe summary based only on the answers it received.

This separation limits prompt injection risk because untrusted text never reaches the main agent directly.

## When It Runs

Dual LLM runs when a tool's tool result policy is set to `Dual LLM`. The most common cases are:

- Web search or scraping tools
- Email readers
- File or document readers that return user-controlled content
- Any external source where exact raw text is unsafe but a safe summary is still useful

The Tool Policy Configuration Agent can recommend this automatically for tools that read from untrusted sources. See [Tool Policy Configuration Agent](/docs/platform-built-in-agents-policy-config).
