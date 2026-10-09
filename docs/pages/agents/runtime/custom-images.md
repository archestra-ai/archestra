---
title: Custom Images
description: Run your own coding agent image in Agent Runtime
order: 3
lastUpdated: 2026-10-09
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Run any coding agent in [Agent Runtime](/docs/agents/runtime), not only the built-in ones. Bring a container image with your agent in it. Archestra supplies the rest:

- **The task** and every follow-up.
- **Models** through the LLM Proxy, and **tools and skills** through the MCP Gateway.
- **Persistent storage** and the **live terminal**.

## Use Your Image

1. In the agent's **Runtime** picker, pick **Custom image**.
2. Set **Image**, and set **Command** to your agent's executable and arguments.
3. Set **Inference API** to the protocol your agent speaks: Anthropic Messages, OpenAI Responses, or OpenAI Chat Completions.
4. Start a run.

Your agent reaches models through the supplied LLM Proxy URL and virtual key, and tools and skills through the supplied MCP Gateway.

## What the Image Needs

| Requirement | What to Provide |
| --- | --- |
| Shell and terminal | `/bin/sh` and `tmux` on `PATH`. |
| Output | Progress and results on stdout or stderr. Never print credentials. |
| Exit code | `0` on success, non-zero on failure. |
| Storage | Working files and saved sessions under `/home/node`. Other paths may not survive a pause. |

For the full contract and working examples, see the [image contract](https://github.com/archestra-ai/archestra/blob/main/platform/agent_images/runtime-contract.md) and the [maintained images](https://github.com/archestra-ai/archestra/blob/main/platform/agent_images/README.md).
