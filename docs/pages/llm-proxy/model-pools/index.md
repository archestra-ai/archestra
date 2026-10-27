---
title: Model Pools
description: Serve one model name from several provider keys, with load balancing and failover
order: 5
lastUpdated: 2026-10-27
beta: "Set [`ARCHESTRA_LLM_MODEL_POOLS_ENABLED=true`](/docs/admin/deployment/configuration#ARCHESTRA_LLM_MODEL_POOLS_ENABLED) to turn it on."
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

A model pool serves one model name from several provider keys. Clients keep asking for the same name, such as `glm-5.3`. The LLM Proxy picks a member to answer, spreads traffic between members, and moves on to another member when one fails. Clients don't change anything.

Create pools under **LLM > Model Pools**. Each member is a shared provider key and the model ID that key uses for the model. Bedrock, for example, calls `glm-5.3` `us.zai.glm-5.3`.

## Order and Weight

Pools use the same two settings as LiteLLM.

- **Order** is the sequence requests try. The list in the pool form is that sequence: drag a member up or down to change it. Requests go to order 1 first, and to the next order only when every member before it has failed or is cooling down.
- **Weight** splits traffic between members that share an order. Link a member to the one above it to give it the same order. Weights of 3 and 1 send 75% and 25% of requests to each.

A member that is not linked to the one above it is a fallback for every member above it. Switching a member off keeps it in the pool but sends it no traffic.

## How Failover Works

| When                              | What happens                                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A member answers 429 or 5xx       | The request moves to the next member, without retrying the first one.                                                            |
| A member times out or can't connect | The request moves to the next member.                                                                                           |
| A member is silent                | No first chunk in 30 s, or no answer in 3 min plus 1 s per 20 tokens the request allows (at most 30 min), unless it is the last member. |
| A key is refused                  | A 401, 403 or 404 from that key, or a key that can't be loaded, moves the request to the next member.                             |
| The request itself is invalid     | The error goes back to the client. Other members would refuse it too.                                                             |
| After a failure                   | The member cools down for its `Retry-After`, or 30 s without one, and at most 60 s. The pool form shows how long is left.          |
| A conversation continues          | It stays on the same member, to keep the prompt cache warm.                                                                       |
| The answer has started            | Errors go to the client. A pool never switches members mid-answer.                                                                |

## Who Can Use a Pool

A pool is open to any credential that can already reach one of its members:

- a [virtual key](/docs/llm-proxy/authentication#standard-virtual-keys) that maps a member's provider key,
- an OAuth client whose provider keys include a member's key,
- people who connected through Connect, whose keys map a member's key.

To let a virtual key or an OAuth client use a pool without mapping any of its members, add the pool under **Model pools** when you create or edit it. Only client credentials OAuth clients take pools.

## Connect Clients

Ask for the pool's name as the model, on any of these endpoints:

- the [Model Router](/docs/llm-proxy/model-router), `https://<archestra-host>/v1/model-router`,
- the Anthropic API route, `https://<archestra-host>/v1/anthropic`, which Claude Code uses,
- the OpenAI API route, `https://<archestra-host>/v1/openai`.

Choose **Connect** on a pool to copy a request for each endpoint, signed with a virtual key or an OAuth client token.

Claude Code assumes a 200k context window for a model name it doesn't know. Set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the smallest context window among the pool's members.

## Limits in the Beta

- Requests on the Anthropic API route skip Bedrock members. A pool whose members are all on Bedrock doesn't answer there yet.
- OpenCode calls the OpenAI Responses API, which pools don't serve yet.
