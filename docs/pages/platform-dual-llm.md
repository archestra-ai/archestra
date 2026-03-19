---
title: Dual LLM
category: Agents
subcategory: Built-In Agents
order: 8
description: Built-in agents that quarantine untrusted tool output before it reaches the main agent
---

<!-- 
Check ../docs_writer_prompt.md before changing this file.

This document is human-built, shouldn't be updated with AI. Don't change anything here.

Exception:
- Screenshot
-->

Dual LLM is a built-in security workflow for tools that return untrusted content. Instead of letting the main agent read raw output from sources like web pages, email, or user-generated files, Archestra routes that output through two built-in agents with different responsibilities.

## How It Works

The workflow uses:

- **Dual LLM Main Agent**: sees the user request and the Q&A transcript, but never the raw tool output
- **Dual LLM Quarantine Agent**: sees the raw tool output, but can only answer with a numbered option

The main agent asks a constrained multiple-choice question. The quarantine agent picks the best option index. After a few rounds, the main agent produces a short safe summary based only on the answers it received.

This separation limits prompt injection risk because untrusted text never reaches the main agent directly.

## When It Runs

Dual LLM runs when a tool's trusted-data policy is set to `sanitize_with_dual_llm`. The most common cases are:

- Web search or scraping tools
- Email readers
- File or document readers that return user-controlled content
- Any external source where exact raw text is unsafe but a safe summary is still useful

Policy Configuration can recommend this automatically for tools that read from untrusted sources. See [Policy Configuration](/docs/platform-built-in-agents-policy-config).

## Built-In Agent Settings

Both built-in agents are editable:

- **Dual LLM Main Agent**: system prompt, model selection, and max rounds
- **Dual LLM Quarantine Agent**: system prompt and model selection

## What Gets Stored

When Dual LLM runs, Archestra stores the analysis transcript on the log record:

- the question-and-answer conversation between the two built-in agents
- the final sanitized result used in place of the raw tool output

## Relationship to Tool Policies

Dual LLM is not enabled globally. It is one possible trusted-data policy action alongside:

- `mark_as_trusted`
- `mark_as_untrusted`
- `sanitize_with_dual_llm`
- `block_always`

Use Dual LLM when the tool is useful, the source is untrusted, and the agent only needs a safe summary rather than verbatim output.
