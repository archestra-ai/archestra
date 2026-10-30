---
title: Auto Routing
description: Let Archestra pick a fast, normal, or smart model for each session of agents and chats on the organization default, and of apps
order: 6
alpha: "Set [`ARCHESTRA_AUTO_ROUTING_ENABLED=true`](/docs/admin/deployment/configuration#ARCHESTRA_AUTO_ROUTING_ENABLED) to turn it on."
lastUpdated: 2026-10-29
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Turn it on once, and every agent and chat on the organization default model gets a fast, normal, or smart model per session, so that average daily spend stays near your target. Easy sessions run on the cheap model, hard ones on the smart model. Agent makers change nothing, and apps opt in by sending `auto`.

## Set It Up

The three tiers are your organization's default models: the default model is the normal tier.

1. Add a Jev API key under [Model Providers](/docs/llm-proxy/providers#jev). Jev scores each new session.
2. Go to **Settings → Agents**. Under **Default Model for Agents and New Chats**, pick the default key and model, then the **Fast model** and **Smart model**.
3. Go to **LLM → Auto Routing**, check the three tiers it shows, and set a daily budget in USD. The page says how many agents use the organization default.
4. Turn auto routing on and save.

Each tier can come from a different provider.

## What Gets Routed

Routing is the admin's call: whatever runs on the organization default is routed, and everything with a model of its own is not.

- **Agents and chats:** an agent with no model or [model pool](/docs/llm-proxy/model-pools) of its own, and its chats on the default model. In the agent form and the chat model list, **Organization default** names the three tiers while routing is on.
- **Apps:** send `auto` as the model to the [Model Router](/docs/llm-proxy/model-router) with a [virtual key](/docs/llm-proxy/authentication#standard-virtual-keys). `auto` appears in a key's model list only when the key can reach all three tiers. Native provider routes answer `auto` from an app with a 400 error.

What to know:

- An agent or chat with an explicit model or pool is never routed. Agent Runtime agents are not routed either: they stay on the default model.
- A [forked subagent](/docs/agents/subagents#fork-the-agent) of a routed agent is routed too, unless the agent asks for the Fast or Smart model.

## How Sessions Are Routed

A session is routed once, on its first request, and keeps that model for its whole life.

- **Session identity:** the session id if the client sends one. Otherwise the virtual key plus the first user message, so identical first messages under one key share a model.
- **Budget:** the daily budget is an average target, not a cap. Spend on a given day can go above or below it. Hard caps come from [limits](/docs/llm-proxy/costs-and-limits/limits).
- **Plans:** a background job builds a routing plan from past sessions. Changing the settings or the default models triggers a new plan within about a minute, and every organization is re-planned at least daily. Each plan is versioned.

## Learning From Past Sessions

A new plan needs about 1000 finished sessions. Past traffic can supply them instead of waiting for `auto` traffic.

1. **Find past sessions.** Runs on its own when you first enable auto routing, or from the Overview page. It reads the last 35 days of proxy logs and counts the sessions a plan can learn from, by API and client. It costs nothing.
2. **Score them.** You start this. Archestra sends the opening prompt of a sample of those sessions to the Jev scorer, up to the spending limit you set (calls already in flight can take it a few calls over), then fits a plan.

Only sessions with a client-supplied session id that began inside the window are used. Sessions whose content was not logged or is end-to-end encrypted are skipped. After a scorer change the page offers to score the same sessions again.

## When It Falls Back to the Normal Model

Archestra uses the normal model, the organization's default model, when it cannot make a better choice:

- **Cold start:** fewer than the minimum number of finished sessions exist. See [`ARCHESTRA_AUTO_ROUTING_MIN_SESSIONS`](/docs/admin/deployment/configuration#ARCHESTRA_AUTO_ROUTING_MIN_SESSIONS).
- **No plan yet**, or the plan is stale because the three models or their prices changed.
- **Scorer error or timeout.** See [`ARCHESTRA_AUTO_ROUTING_SCORER_TIMEOUT_MS`](/docs/admin/deployment/configuration#ARCHESTRA_AUTO_ROUTING_SCORER_TIMEOUT_MS).
- **No user text** in the request to score, as in Bedrock Converse requests.

The session keeps that fallback until it ends. An agent or chat on the organization default also runs on the normal model, without being routed, while auto routing is off, a tier is unset or on a per-user provider such as GitHub Copilot, or the person has no key for one of the tiers.

## Savings

The page shows estimated savings against the smart model: what the same tokens would have cost on it. Treat the number as an estimate.

## Long-Context Prices

Some models charge more for long prompts. On a model's settings, add a threshold and four long-context prices. Prompts above the threshold use them. This applies to all traffic of that model, not only auto routing.

## What to Know

- Routing decisions are kept for 90 days. After that, the same session is routed again as a new one.
- Every request still goes through your existing [cost limits](/docs/llm-proxy/costs-and-limits) and guardrails.
- Without a Jev key for the organization, every session uses the normal model.
