---
title: Triggers & Channels
description: Start agent runs from webhooks, A2A calls, email, Slack, Microsoft Teams, and Telegram
order: 7
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Run your agents where your team already works. An agent can answer messages in Slack, Microsoft Teams, and Telegram. It can also reply to email, and run when your code sends it a request. It keeps the same tools, skills, and [Guardrails](/docs/agents/guardrails) everywhere.

| Where | How the Agent Is Chosen |
| --- | --- |
| [Slack](/docs/agents/triggers-and-channels/slack), [Microsoft Teams](/docs/agents/triggers-and-channels/ms-teams), [Telegram](/docs/agents/triggers-and-channels/telegram) | You assign an agent to each channel or direct message. |
| [Incoming Email](/docs/agents/triggers-and-channels/email) | Each agent gets its own email address. |
| [Webhook (A2A)](/docs/agents/triggers-and-channels/webhook-a2a) | Each agent gets its own endpoint. |

<span id="assigning-channels"></span>

## Add a Channel to an Agent

A channel is one place where people message the agent: a Slack or Microsoft Teams channel, a Telegram group, or a direct message. The agent you add it to answers the messages sent to the bot there.

![An agent's Messaging Channels tab with Slack, Teams, and Telegram channels and an email address](/docs/automated_screenshots/agents-triggers-and-channels_agent-channels.webp)

1. Connect the provider first. Each provider's page shows how.
2. Open the agent's **Messaging Channels** tab and click **Add channel**.
3. To change the channel's instructions or reply behavior, click **Settings** on it.
