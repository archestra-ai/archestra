---
title: Auto Routing
description: Let Archestra pick a fast, normal, or smart model for each agent session, from apps, agents, and chats
order: 6
alpha: "Set [`ARCHESTRA_AUTO_ROUTING_ENABLED=true`](/docs/admin/deployment/configuration#ARCHESTRA_AUTO_ROUTING_ENABLED) to turn it on."
lastUpdated: 2026-10-29
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Pick **Auto** as an agent's or a chat's model, or send `auto` from an app, and Archestra picks a fast, normal, or smart model for each session so that average daily spend stays near your target. Easy sessions run on the cheap model, hard ones on the smart model. Neither the agent's instructions nor the app code change.

## Set It Up

The three tiers are your organization's default models: the default model is the normal tier.

1. Add a Jev API key under [Model Providers](/docs/llm-proxy/providers#jev). Jev scores each new session.
2. Go to **Settings → Agents**. Under **Default Model for Agents and New Chats**, pick the default key and model, then the **Fast model** and **Smart model**.
3. Go to **LLM → Auto Routing**, check the three tiers it shows, and set a daily budget in USD.
4. Turn auto routing on and save.

The **Auto** entry then appears in agent and chat model pickers. Each tier can come from a different provider.

## Use Auto

Auto runs in one of two ways:

- **Agents and chats:** in the agent form, open the key list next to the model and pick **Auto**. In chat, open the model button, go to the key tab, and pick **Auto**. A chat on an agent set to Auto starts on Auto.
- **Apps:** send `auto` as the model to the [Model Router](/docs/llm-proxy/model-router) with a [virtual key](/docs/llm-proxy/authentication#standard-virtual-keys). `auto` appears in a key's model list only when the key can reach all three tiers. Native provider routes answer `auto` from an app with a 400 error.

What to know:

- Auto takes the place of a [model pool](/docs/llm-proxy/model-pools). Picking a pool, a key, or a model leaves Auto.
- The **Auto** entry is shown to people with [`llmProxy:read`](/docs/reference/permissions#llmProxy:read).
- A [forked subagent](/docs/agents/subagents#fork-the-agent) of an Auto agent is routed too, unless the agent asks for the Fast or Smart model.

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
- **No user text** in the request to score.

The session keeps that fallback until it ends. An agent or chat set to Auto also runs on the normal model, without being routed, while auto routing is off, a tier is unset, or the person has no key for one of the tiers.

## Savings

The page shows estimated savings against the smart model: what the same tokens would have cost on it. Treat the number as an estimate.

## Long-Context Prices

Some models charge more for long prompts. On a model's settings, add a threshold and four long-context prices. Prompts above the threshold use them. This applies to all traffic of that model, not only auto routing.

## What to Know

- Routing decisions are kept for 90 days. After that, the same session is routed again as a new one.
- Every request still goes through your existing [cost limits](/docs/llm-proxy/costs-and-limits) and guardrails.
- Without a Jev key for the organization, every session uses the normal model.
