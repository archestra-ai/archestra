---
title: Auto Routing
description: Create auto routers that pick a fast, normal, or smart model for each session of agents, chats and apps, within a daily budget
order: 6
beta: "Set [`ARCHESTRA_AUTO_ROUTING_ENABLED=true`](/docs/admin/deployment/configuration#ARCHESTRA_AUTO_ROUTING_ENABLED) to turn it on."
lastUpdated: 2026-11-10
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

An auto router is a model name, `auto` or `auto:<name>`, that sends each session to a fast, normal, or smart model so that average daily spend stays near a target. Easy sessions run on the cheap model, hard ones on the smart model. An organization can have several routers, each with its own models, budget and decision model, for example one per team or per customer.

## Set It Up

1. Add a Jev API key shared with the whole organization under [Model Providers](/docs/llm-proxy/providers#jev). Jev scores each new session.
2. Go to **LLM → Auto Routing** and click **Create auto router**.
3. Give it a name. The model name clients request is `auto:` followed by the name, such as `auto:support`. The first router is named `auto`.
4. Pick a provider key and model for each of the three tiers. Only keys shared with the whole organization can be used, and each tier can come from a different provider.
5. Pick a daily budget and the decision model.
6. Turn auto routing on under **Settings → LLM**. This switch covers every router of the organization.

Open a router from the list to see its current plan: expected spend against the budget, quality compared with sending everything to the smart model, and how sessions should split across the fast, normal and smart models. Switch to **7 days** or **14 days** to see what the router actually routed in that window: billed spend, sessions and requests, how sessions split, and how much less that cost than sending every request to the smart model at list price. To see which model a single request used and why, open it in **LLM Logs**.

### Daily Budget

The daily budget is the average spend a router aims for, not a cap: spend on a given day can go above or below it. To stop spend at a ceiling, [add a spend limit](/docs/llm-proxy/costs-and-limits/limits#create-a-limit) under **Limits** for the team or virtual keys that use the router. It blocks their requests once spend reaches it.

Pick a preset and Archestra sets the budget from the router's recent traffic, then adjusts it every time the plan is refitted:

- **Cost-efficient:** the most it can spend while the fast model still serves two thirds of sessions.
- **Intelligence:** the least it needs for the smart model to serve two thirds of sessions.
- **Balanced:** halfway in cost between the two.
- **Custom:** a daily budget in USD that you set yourself.

Until enough sessions are scored for a first plan, every session runs on the normal model, whatever the budget. Configure shows what the selected preset costs at today's traffic.

### Decision Model

The decision model reads the start of each session and judges how hard it is. Each router picks a provider that offers decision models, one of its organization-wide keys and a model. Jev is the only such provider today. Changing the decision model starts the router learning again.

### Each Router Learns on Its Own

A router scores, plans and learns only from its own sessions. A new router starts cold: every session runs on its normal model until it has scored enough sessions for a first plan. Changing one router's models, budget or decision model never changes another router's plan.

## Who Can Use a Router

- **Agents and chats:** pick a router in the agent form or the chat model list, where `auto` shows as **Auto** and `auto:support` as **Auto · support**. To route everything without a model of its own, pick a router as the **Default Model for Agents and New Chats** under **Settings → Agents**.
- **Apps:** send the router's name as the model to the [Unified Model API](/docs/llm-proxy/unified-model) with a [virtual key](/docs/llm-proxy/authentication#standard-virtual-keys). Add the router to the key under **Auto routers** in the key's settings first; a key calls only the routers it was given, and gets a 403 error for any other. The request then runs on the provider key of the tier the router picked. A tier is one key and model, so it doesn't fail over to another key the way a [model pool](/docs/llm-proxy/model-pools) does. The key's model list shows the routers it can call. Native provider routes answer a router name with a 400 error.

What to know:

- An agent or chat with an explicit model or pool is never routed. Agent Runtime agents are not routed either.
- A [forked subagent](/docs/agents/subagents#fork-the-agent) of a routed agent is routed by the same router, unless the agent asks for the Fast or Smart model.
- Deleting a router deletes its plans and what it learned. Agents and chats on it go back to their own model.

## How Sessions Are Routed

A session with an explicit session ID is routed once, on its first request, and keeps that model for its whole life. Without one, Archestra infers identity from the opening context; changing that context can trigger a new choice.

The scorer assesses the opening user message with a bounded excerpt of the request's system instructions and the full sorted list of tool names. It does not receive tool descriptions, parameter schemas or tool results. If tool names alone exceed 64 KiB, scoring fails instead of silently omitting tools.

- **Session identity:** the session id if the client sends one. Otherwise the virtual key plus the first user message, initial system instructions and current tool names. Instructions added after the first user message, tool ordering and cache markers do not change this identity. Changing the initial instructions or tool-name list can trigger another scorer call and model choice; send a stable session ID to preserve the choice across those changes.
- **Plans:** a background job builds each router's routing plan from its past sessions. Changing a router triggers a new plan for it within about a minute, and every router is re-planned at least daily. Each plan is versioned.

## Learning From Past Sessions

Only the `auto` router that existed before an organization could have several learns from past traffic; routers you create start cold. For that router, past traffic can supply the sessions a plan needs instead of waiting for `auto` traffic.

1. **Find past sessions.** Runs on its own when you first enable auto routing. Before the router has a plan, its page shows what was found; afterwards, open **⋯ → Score past sessions** in the page header, which counts again when the last count is more than a day old. It reads the last 35 days of proxy logs and counts the sessions a plan can learn from, by API and client. It costs nothing.
2. **Score them.** You start this. Archestra sends the opening prompt and context from each sampled session's logged first request to the Jev scorer, up to the spending limit you set (calls already in flight can take it a few calls over), then fits a plan.

Only sessions with a client-supplied session id that began inside the window are used. Sessions whose content was not logged or is end-to-end encrypted are skipped. After a scorer change the router's page shows a notice offering to score the same sessions again, and a scoring run in progress shows there with a way to cancel it.

## When It Falls Back to the Normal Model

Archestra uses the router's normal model when it cannot make a better choice:

- **Cold start:** the router has fewer than the minimum number of finished sessions. See [`ARCHESTRA_AUTO_ROUTING_MIN_SESSIONS`](/docs/admin/deployment/configuration#ARCHESTRA_AUTO_ROUTING_MIN_SESSIONS).
- **No plan yet**, or the plan is stale because the three models or their prices changed.
- **Scorer error or timeout.** See [`ARCHESTRA_AUTO_ROUTING_SCORER_TIMEOUT_MS`](/docs/admin/deployment/configuration#ARCHESTRA_AUTO_ROUTING_SCORER_TIMEOUT_MS).
- **No user text** in the request to score, as in Bedrock Converse requests.

The session keeps that fallback until it ends. An agent or chat on a router also runs on its normal model, without being routed, while auto routing is off or a tier is unset.

## Inspect a Recorded Decision

See why a request got its model in [Logs](/docs/admin/logs): an auto-routed request is marked **auto→**. Open it, and **Auto routing** shows the router's name, how the scorer rated the task for each tier, the tier it picked and why, and how much cheaper it was than the smart model.

To read the decision programmatically, use [`GET /api/llm-proxy-logs/{logId}/auto-routing`](/docs/reference/api/llm-proxy/logs#tag/llm-proxy-logs/GET/api/llm-proxy-logs/{logId}/auto-routing) to inspect the decision linked to a request you can view in LLM Logs. It returns the router, the chosen model and tier, routing reason, scorer features and version, plan identifier, selection probability, budget multiplier and expected cost. It does not call the scorer again.

A `null` decision means there is no retained decision linked to that request; the request may not have been auto routed, or its decision may have expired. It is not a reconstructed explanation or proof that routing was disabled.

## Savings

The page shows estimated savings against the smart model: what the same tokens would have cost on it. Treat the number as an estimate.

## Long-Context Prices

Some models charge more for long prompts. On a model's settings, add a threshold and four long-context prices. Prompts above the threshold use them. This applies to all traffic of that model, not only auto routing.

## What to Know

- Routing decisions are kept for 90 days. After that, the same session is routed again as a new one.
- Every request still goes through your existing [cost limits](/docs/llm-proxy/costs-and-limits) and guardrails.
- Without a Jev key for the organization, every session uses the router's normal model.
