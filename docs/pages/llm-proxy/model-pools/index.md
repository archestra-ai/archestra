---
title: Model Pools
description: Serve one model from several providers, with load balancing and failover
order: 5
lastUpdated: 2026-11-24
beta: "Model Pools are in Beta."
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Model pools allow clients to reach for a single model, such as `claude-sonnet-5-5`, but under the hood, Archestra will route them from different providers.

Here are some of the common use cases for model pools:

| Goal | How it works |
| --- | --- |
| Survive a provider outage | An Anthropic key, with a Bedrock key as the fallback. |
| Get past a rate limit | Keys from two or three provider accounts sharing traffic. |
| Fall back to another model | `claude-sonnet-5-5` on Anthropic, with `gpt-6.1-sol` on OpenAI as the fallback in case Anthropic fails. |
| Use reserved capacity first | An Azure AI Foundry provisioned deployment, with a pay-as-you-go deployment as the fallback while it's rate limited. |
| Use your subscription first | Your personal GitHub Copilot connection, with a shared OpenAI key as the fallback. |

## Create a Pool

A model pool comprises a few moving parts: models, members and orders.

When creating a pool, we pick a model which will serve as what we would like to provide to the client. From there, we can define members, which are effectively a group of providers that serve the selected model.

Each member has an order: requests go to order 1 and move to order 2 when order 1 can't answer. Members with the same order share its traffic.

For example, a `claude-sonnet-5-5` pool with three members:

| Order | Provider key | Model | Traffic |
| --- | --- | --- | --- |
| 1 | Anthropic, team A account | `claude-sonnet-5-5` | 50% |
| 1 | Anthropic, team B account | `claude-sonnet-5-5` | 50% |
| 2 | AWS Bedrock | `us.anthropic.claude-sonnet-5-5` | When order 1 can't answer |

Before you start, add provider keys or connect your subscriptions on [Model Providers](/docs/llm-proxy/providers). Creating a pool needs [`llmModel:update`](/docs/reference/permissions#llmModel:update).

:::tabs
@tab Archestra UI
1. Go to **LLM → Model Pools** and click **Create pool**.
2. Under **Model name**, pick or type the name clients ask for.
3. Under **Members**, click **Add member**. Pick a **Provider key**, then the **Model** ID that key uses for this model. If the key has no synced models, type the ID.
4. To share an order's traffic, click **Add member** inside that order and set each member's weight under **Traffic**. To add a fallback, click **Add order**. Drag a member to move it to another order.
5. Click **Create pool**.
6. Add the pool to the virtual key or OAuth client your apps use, or their requests skip it. See [Who Can Use a Pool](#who-can-use-a-pool).

@tab Terraform
Use Terraform if your team already manages infrastructure with it: the pool lives in code, and changes go through review. Otherwise, use the UI.

1. Set up the [Archestra Terraform provider](https://registry.terraform.io/providers/archestra-ai/archestra/latest/docs/guides/getting-started), with your Archestra URL in `ARCHESTRA_BASE_URL` and a [service account key](/docs/reference/api#service-accounts) in `ARCHESTRA_API_KEY`. The key's role needs [`llmModel:update`](/docs/reference/permissions#llmModel:update), plus [`llmVirtualKey:create`](/docs/reference/permissions#llmVirtualKey:create) if Terraform also creates the virtual key.
2. Declare the pool, and add it to the virtual key your apps use:

   ```hcl
   resource "archestra_model_pool" "sonnet" {
     name = "claude-sonnet-5-5" # the model clients ask for
     members = [
       {
         # A shared provider key, such as archestra_model_provider.anthropic.id
         provider_api_key_id = var.anthropic_key_id
         model_id            = "claude-sonnet-5-5"
         priority            = 1 # the member's order
       },
       {
         provider_api_key_id = var.bedrock_key_id
         model_id            = "us.anthropic.claude-sonnet-5-5" # Bedrock's ID for the same model
         priority            = 2
       },
     ]
   }

   resource "archestra_virtual_key" "app" {
     name           = "My app"
     model_pool_ids = [archestra_model_pool.sonnet.id]
   }
   ```
:::

## Selection Strategy

The selection strategy decides which member gets each request. Different strategies forward the request in different manners. Pick it under **Selection strategy** when you create or edit a pool.

| Selection strategy | Picks | Use it when |
| --- | --- | --- |
| **Weighted random** (default) | By weight for each new session, then keeps the session on that member | You want a fixed split. With weights 3 and 1, about 75% of the traffic goes to the first provider key and 25% to the second. |
| **Least tokens used** | The member that used the fewest tokens this minute | Members have similar per-minute token limits, and you want each to stay under its own. |

- A session is a Claude Code conversation, or requests with the same `X-Archestra-Session-Id` header. Keeping it on one member keeps that provider's prompt cache warm.
- Least tokens used ignores weight and picks again on every request.

## When a Member Fails

When a member fails before it starts to answer, the pool sends the request to another member. The failed member [cools down](#cooldowns), so the next requests skip it. The client sees an error only when no member is left, or when the request itself is at fault.

| When the member | What happens | Cooldown |
| --- | --- | --- |
| Is rate limited (`429`), returns a server error (`5xx`), can't be reached, or passes a [timeout](#configure-failover) | The pool [retries](#retries) another member, then moves to the next order. | 30 s, or as long as the provider's `Retry-After` asks, up to 60 s |
| Rejects the key or doesn't have the model (`401`, `403`, `404`) | The request skips the rest of its order and goes to the next order. Retries wouldn't help. | 30 s |
| Is out of credit | The request skips the rest of its order and goes to the next order. | 1 hour |
| Rejects the request as invalid (`400`) | The error goes to the client. Other members would reject it too. | None |
| Fails after it starts to answer | The error goes to the client. A pool never switches members mid-answer. | None |

- When there is no next order, the client gets the last member's error.
- The pool's timeouts never cut off the last member left, since there is nowhere else to go.

### Cooldowns

A cooldown is a pause on a member that just failed, and one failure is enough to start it. While it lasts, the pool sends that member no requests, so a key that is rate limited or down isn't hit again by every request that follows. When the cooldown ends, the member gets requests again.

- How long it lasts depends on the failure, as the table above shows. Change it with **Cooldown time**.
- A member in a cooldown shows **Cooling down** in the pool, with the seconds left.
- If every member is in a cooldown, requests fail until one ends.

### Retries

A retry sends the request to another healthy member after a temporary failure. With the default of 2 retries, a pool with keys A and B in order 1 and key C in order 2 handles a request like this:

| Try | Goes to | If it fails |
| --- | --- | --- |
| First | A | A cools down, and the pool retries. |
| Retry 1 | B, the other member of order 1 | B cools down, and the pool retries. |
| Retry 2 | C, since order 1 has no healthy member left | The client gets C's error. |

- Each retry waits **Initial delay** first, doubling up to **Maximum delay**, or as long as the provider's `Retry-After` asks.
- When the retries run out, the request moves to the next order, which gets its own retries.
- Set **Retries** to 0 to go straight to the next order after the first failure.

## Configure Failover

Failover keeps a pool answering when a member fails: the pool retries another member, then moves to the next order. To change how it does that, edit the pool and go to **Failover**.

| Setting | Default (range) | Change it when |
| --- | --- | --- |
| **Retries** | 2 (0–10) | Requests should fail faster (lower), or ride out bursts of rate limits (higher). |
| **Retries by error type** | Same as **Retries** | Rate limits, server errors, timeouts, or connection errors need their own count. |
| **Initial delay**, **Maximum delay** | 500 ms, 8000 ms | Your provider needs more time between tries. |
| **Stream timeout** | 30 s (up to 30 min) | A model takes longer to send its first chunk, such as a reasoning model. |
| **Timeout** | 3–30 min, scaled to the request's output limit | Answers that aren't streamed time out on a slow model. |
| **Cooldown time** | 30 s, or 1 hour for exhausted credit (up to 1 hour) | Members recover faster or slower. A set value also applies to exhausted credit. |
| **Member overrides** | The pool's values | One member needs its own **Retries**, **Initial delay**, or **Maximum delay**, such as a provider that rate limits more often than the others. |

A client can set the retry count for one request with the `x-archestra-num-retries` header, from `0` to `10`.

## Request Compatibility

Some members can't take a request because their model doesn't support what it needs. A model that reads only text can't take a request with an image, and a conversation longer than a model's context window doesn't fit it. The pool sends that request only to members whose model can take it.

- Skipping a member doesn't count as a failure. It doesn't cool down, and it still gets the requests it can take.
- If no member can take the request, it fails without reaching any provider.

## Who Can Use a Pool

An app uses a pool once you add the pool to its [standard virtual key](/docs/llm-proxy/authentication#standard-virtual-keys) or [OAuth client](/docs/llm-proxy/authentication#oauth-clients). People signed in through [Connect](/docs/get-started/connect) or an identity provider use it when they can already use one of its members' keys.

To add a pool, edit the virtual key or OAuth client and pick the pool under **Model pools**. Setting **Model pools** needs [`llmModel:update`](/docs/reference/permissions#llmModel:update).

## Use a Pool

Clients ask for the pool's name as the model, the same way they ask for any model on the [LLM Proxy](/docs/llm-proxy#start-using-it). A pool named after a model needs no client change.

```bash
curl "https://<archestra-host>/v1/unified-model/chat/completions" \
  -H "Authorization: Bearer $ARCHESTRA_VIRTUAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5-5","messages":[{"role":"user","content":"Hello"}]}'
```

- **Claude Code:** for a pool not named after a Claude model, pick it with `claude --model gpt-6.1-sol`. Set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the smallest context window among the pool's members, since Claude Code assumes 200k for a model name it doesn't know.
- **Chat:** open the model menu, go to **Key**, and pick the pool under **Model pools**.
- **Agents:** in the agent's form, pick the pool under **Model pools** in the key picker. An agent on an [Agent Runtime](/docs/agents/runtime) can't pick a pool. Its requests go through a pool when the agent's model has the pool's name and its provider key is one of the pool's members.

## See Which Member Answered

Open a request in [Logs](/docs/insights/logs) under **Logs → LLM Proxy** to see which member answered it. Under **Model pool**, the request lists every member it tried, in order: the one that answered, any that failed and why, such as **429 · rate limited**, and the ones it didn't need.

- Each try is billed at its member's [token price](/docs/llm-proxy/cost-controls#where-token-prices-come-from). A refused try costs $0.
- To see a failover before a real outage, change the order 1 member's model to an ID that doesn't exist and send a request. The log shows the failed try and the answer from order 2. Then put the model back.

## Mixing Providers

A pool can mix providers, such as Anthropic, Bedrock, and OpenAI. Archestra translates each request to the member's API, so text, images, PDFs, and tool calls work on every member. Features that only one provider has don't.

- Provider-hosted tools, structured output, non-text output, provider cache references, and custom Gemini safety settings fail on a mixed pool. Use a pool on one provider for those.
- Prompt caching hints and thinking blocks are dropped on members that don't speak Anthropic's API, except Claude models on Bedrock. Each member uses its own reasoning defaults, so leave room in the output limit for models that think before answering.
- Responses clients, such as Codex and OpenCode, need every member on OpenAI, Azure AI Foundry, or GitHub Copilot, and must send the full conversation in each request. Bedrock Converse clients need a Bedrock-only pool.
