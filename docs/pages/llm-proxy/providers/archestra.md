---
title: Archestra
description: Use another Archestra instance as the upstream model provider
order: 9
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Send this deployment's model calls through another Archestra deployment's Model Router. For example, a team instance can use the models of your central instance. The other deployment decides which models you reach, and applies its own policies to Chat Completions requests.

## Connecting an Upstream

1. On the upstream instance, create a [virtual key](/docs/llm-proxy/authentication#standard-virtual-keys) under **Virtual Keys** and map the provider keys you need.
2. On this instance, go to **Model Providers → Add API Key** and select **Archestra**.
3. Set **Base URL** to `https://<upstream-host>/v1/model-router`.
4. Paste the upstream virtual key into **API Key** and click **Test & Create**.

The models exposed by the upstream key appear under **Models**, with provider-qualified IDs such as `openai:gpt-5.4`. If testing fails, check the upstream URL and key mappings. The Base URL is required because this provider has no default upstream.

Clients calling this instance use `https://<archestra-host>/v1/archestra` with Chat Completions requests. The Archestra provider itself is not available through this instance's Model Router.
