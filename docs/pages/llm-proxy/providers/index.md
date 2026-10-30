---
title: Model Providers
description: Connect provider API keys and personal subscriptions for Chat and the LLM Proxy
order: 2
lastUpdated: 2026-10-30
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Add each AI provider once. Chat, agents, and every app behind the [LLM Proxy](/docs/llm-proxy) can use it, and none of them sees the key. Paste an OpenAI key, sign in with your ChatGPT subscription, or point at your own vLLM server.

![The Model Providers page, with personal subscription cards above the provider API keys table](/docs/automated_screenshots/platform-supported-llm-providers_model-providers.webp)

## Connect a Provider

Connect with an API key that your company pays for by use, or with a subscription that a person already pays for.

### With an API Key

Paste a key, and Archestra tests it and loads the provider's models.

1. Go to **Model Providers** in the sidebar and click **Add API Key**.
2. Pick the **Provider** and paste the **API Key**.
3. Optionally open **Advanced** to mark the key **Primary**, set a **Base URL** for a proxy or self-hosted endpoint, or add **Extra HTTP headers** that every request to the provider carries.
4. Click **Test & Create**. Archestra calls the provider with the key and syncs its models.

The new key appears in the **Provider API keys** table as **Configured**, and its models appear under **Models**. To choose who can use it, edit the key and add people or teams under its permissions.

You can also set a key through an environment variable, `ARCHESTRA_CHAT_<PROVIDER>_API_KEY` (for example [`ARCHESTRA_CHAT_OPENAI_API_KEY`](/docs/admin/deployment/configuration#ARCHESTRA_CHAT_OPENAI_API_KEY)). It is the fallback when no stored key applies.

<span id="turning-providers-off"></span>

To hide a provider your company does not use, go to **Settings → LLM → Model providers** and switch **Available** off. It leaves every picker, and nobody can add a key for it. Its existing keys keep working. On the same page, you can give a provider a display name.

<span id="personal-subscriptions"></span>

### With a Subscription

Already pay for ChatGPT, GitHub Copilot, Microsoft 365 Copilot, or SuperGrok? Use it instead of a metered API key. On **Model Providers**, click **Connect** on the provider's card and sign in.

These credentials belong to one person and cannot be shared. An agent that uses one always runs on the chatting user's own subscription. A user who has not connected sees a sign-in prompt in chat. If the vendor rejects the sign-in later, click **Connect** again; the credential keeps its model and agent selections.

- **ChatGPT**: first turn on **Enable device code authorization for Codex** in ChatGPT under **Settings → Security**. It is off by default, and ChatGPT blocks the sign-in until you turn it on. If the backend's outbound traffic is restricted, also allow [its hosts](#chatgpt-subscription-egress).
- **GitHub Copilot** and **Microsoft 365 Copilot** have their own pages: [GitHub Copilot](/docs/llm-proxy/providers/github-copilot), [Microsoft 365 Copilot](/docs/llm-proxy/providers/microsoft-365-copilot).

ChatGPT and SuperGrok use bills $0 in Costs. GitHub Copilot and Microsoft 365 Copilot use counts as metered. See [Subscription vs Metered Cost](/docs/llm-proxy/costs-and-limits#subscription-vs-metered-cost).

<span id="which-key-a-request-uses"></span>

### Which Key Pays for a Chat

When several keys exist for one provider, the most specific one wins. Your team shares an OpenAI key, and you add your own. Your chats now run on yours, so your use stops counting against the team's key.

Chat and agents take the first match:

| Order | Key | Example |
| --- | --- | --- |
| 1 | The key picked in the conversation | You switch a chat to the research team's key. |
| 2 | The key set on the agent | A support agent always bills the support team's key. |
| 3 | Your own key | You added a personal Anthropic key. |
| 4 | A key shared with your teams | Platform Engineering shares one OpenAI key. |
| 5 | A key shared with the organization | The company default key. |
| 6 | The `ARCHESTRA_CHAT_<PROVIDER>_API_KEY` environment variable | The key set at install time. |

When one level has several keys, the **Primary** key wins, then the oldest one.

- A subscription is used only by the person who connected it, even when an agent or a conversation picks it. Anyone else uses their own subscription, or gets a sign-in prompt.
- For vLLM, Ollama, and Azure, each key points at its own server. A key whose server does not host the model you picked is skipped for one that does.
- Clients that call the proxy pick their key through their [authentication method](/docs/llm-proxy/authentication).

## Supported Providers

Each provider has its own proxy URL, `https://<archestra-host>/v1/<path>`, with the provider's own API. A client that works with the provider works with the proxy. Providers marked **Router** also work through the [Model Router](/docs/llm-proxy/model-router). A linked name has a setup page.

| Provider | Path | APIs | Router | Notes |
| --- | --- | --- | --- | --- |
| [Amazon Bedrock](/docs/llm-proxy/providers/bedrock) | `bedrock` | Converse, InvokeModel | Yes | API key, AWS access keys, or IAM role |
| [Anthropic](/docs/llm-proxy/providers/anthropic) | `anthropic` | Messages | Yes | Also Claude on Microsoft Foundry and Vertex AI |
| [Archestra](/docs/llm-proxy/providers/archestra) | `archestra` | Chat Completions | No | Another Archestra instance as the upstream |
| [Azure AI Foundry](/docs/llm-proxy/providers/azure) | `azure` | Chat Completions, Responses, Embeddings | Yes | API key or Microsoft Entra ID |
| Cerebras | `cerebras` | Chat Completions | Yes | |
| Cohere | `cohere` | Chat | Yes | |
| DeepSeek | `deepseek` | Chat Completions | Yes | |
| [GitHub Copilot](/docs/llm-proxy/providers/github-copilot) | `github-copilot` | Chat Completions, Responses | Yes | Personal sign-in or organization GitHub App |
| [Google Gemini](/docs/llm-proxy/providers/gemini) | `gemini` | Generate Content, Embeddings | Yes | Google AI Studio or Vertex AI |
| Groq | `groq` | Chat Completions | Yes | |
| Jev | `jev` | Decisions | No | Scores content, such as a tool call. It does not chat. See [Jev](#jev). |
| Kimi (Moonshot AI) | `kimi` | Chat Completions | Yes, Chat Completions only | Kimi API Platform keys. China endpoint: set [`ARCHESTRA_KIMI_BASE_URL`](/docs/admin/deployment/configuration#ARCHESTRA_KIMI_BASE_URL) to `https://api.moonshot.cn/v1` |
| Kimi Code | `kimi-code` | Chat Completions | Yes, Chat Completions only | Kimi Code membership keys (`sk-kimi-...`), which use the plan's quota. China endpoint: set the key's Base URL to `https://api.kimi.com/coding/v1` |
| [Microsoft 365 Copilot](/docs/llm-proxy/providers/microsoft-365-copilot) | `microsoft-365-copilot` | Chat Completions | No | Personal sign-in only, no tools |
| MiniMax | `minimax` | Chat Completions | Yes | Text only |
| Mistral AI | `mistral` | Chat Completions, Embeddings | Yes | |
| [Ollama](/docs/llm-proxy/providers/ollama) | `ollama`, `ollama-native` | Chat Completions, Embeddings, native Chat | `ollama` only | No key needed |
| OpenAI | `openai` | Chat Completions, Responses, Embeddings | Yes | ChatGPT subscription through **Connect** |
| [OpenAI-compatible servers](/docs/llm-proxy/providers/openai-compatible) | `vllm` | Chat Completions, Embeddings | Yes | vLLM, llama.cpp, LM Studio, SGLang, and others |
| OpenRouter | `openrouter` | Chat Completions, Embeddings | Yes | See [OpenRouter Free Models](#openrouter-free-models) |
| Perplexity | `perplexity` | Chat Completions, Responses | Yes | `sonar` models take no tools; vendor-prefixed models such as `anthropic/claude-opus-5` do |
| xAI (Grok) | `xai` | Chat Completions, Responses | Yes | SuperGrok subscription through **Connect** |
| Zhipu AI | `zhipuai` | Chat Completions, Embeddings | Yes | |

Each provider's default endpoint can be changed with its `ARCHESTRA_<PROVIDER>_BASE_URL` variable, listed under [LLM Provider Configuration](/docs/admin/deployment/configuration#llm-providers).

### OpenRouter Free Models

OpenRouter's `:free` model variants cost nothing, though they still need an OpenRouter API key. The providers behind them may use your requests to train models, so do not send sensitive data. The `openrouter/free` model picks a free model for each request. When you add an OpenRouter key and the organization has no default model, Archestra makes `openrouter/free` the default.

### Jev

[Jev](https://typesafe.ai) is TypeSafe's decision model. It scores content, such as a tool call, and does not chat. Send requests to `https://<archestra-host>/v1/jev/decisions` with `Authorization: Bearer <your-api-key>`.

To use Jev through OpenRouter, set the key's base URL to `https://openrouter.ai/api/alpha/decisions`. To change the default endpoint, set [`ARCHESTRA_JEV_BASE_URL`](/docs/admin/deployment/configuration#ARCHESTRA_JEV_BASE_URL).

### ChatGPT Subscription Egress

If you restrict the backend's outbound traffic, allow HTTPS (port 443) to these hosts. Without them, ChatGPT sign-in and chats fail. Allowing `api.openai.com` does not cover them.

| Host | Used for | Setting |
| --- | --- | --- |
| `auth.openai.com` | Sign-in and token refresh | [`ARCHESTRA_OPENAI_CODEX_ISSUER`](/docs/admin/deployment/configuration#ARCHESTRA_OPENAI_CODEX_ISSUER) |
| `chatgpt.com` | Chat requests and model lists, at `/backend-api/codex` | [`ARCHESTRA_OPENAI_CODEX_API_BASE_URL`](/docs/admin/deployment/configuration#ARCHESTRA_OPENAI_CODEX_API_BASE_URL) |

- Allow them by hostname, not IP address. Both are served from a CDN, so their addresses are shared and can change.
- If you change either setting, allow the host and port it points to instead.
- People who sign in also need browser access to the sign-in host to enter the code.

<span id="model-context-and-output-limits"></span>

## Model Pricing, Limits, and Modalities

Archestra fills in each model's prices, context window, and input types for you. It syncs them from the provider and a public model registry. A self-hosted or very new model can have gaps. Set any value yourself, because each one changes how Archestra treats the model:

| Detail | What it changes |
| --- | --- |
| **Pricing** | The cost Archestra records for each request. Wrong prices give wrong [cost reports and budgets](/docs/llm-proxy/costs-and-limits). |
| **Context window** | When chat compacts a long conversation. |
| **Max output tokens** | How long one answer can be. Without it, a turn asks for 8,192 tokens, which can cut a long answer short. |
| **Modalities** | Which files chat sends to the model, and which models you can pick for [embedding](/docs/knowledge/settings#embedding-model) and [OCR](/docs/knowledge/settings#document-ocr). A file the model cannot read goes to the conversation's **Files** panel instead. |

For an OpenAI connection to a gateway, model refreshes import its published output-token limits. Limits stay with each connection, so gateways can use the same model name with different limits. These connection limits are applied to requests but are not shown on the **Models** page, which shows the shared model values and manual overrides.

A manual **Max output tokens** value can lower a connection's budget but cannot exceed its published limit. If no limit is available, set **Max output tokens** yourself.

To change one, go to **Models**, edit the model, and open its **Pricing**, **Limits**, or **Modalities** tab. Your values stay through model refreshes. Clear a field to use the synced value again.
